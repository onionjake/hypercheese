import * as LegacyFileSystem from 'expo-file-system/legacy';
// The classic namespace API (getAssetsAsync paging, plain Asset records)
// lives under /legacy in expo-media-library 57+.
import * as MediaLibrary from 'expo-media-library/legacy';

import { type Session } from './api';
import { log, logError } from './log';
import { uploadAllowed } from './network';
import {
  SUPPORTED_EXTENSIONS,
  assetMtime,
  extensionOf,
  hashAndUpload,
  manifestCheck,
  stablePath,
} from './upload-protocol';

// Camera-roll sync: enumerate the media library directly (no picker, no
// per-pick cache copies) and let the server's manifest decide what needs
// uploading. Files stream straight from their library location one at a
// time, so peak temp disk usage is zero and re-runs skip everything the
// server already has.

const PAGE_SIZE = 200;

export interface SyncCounts {
  scanned: number;
  unsupported: number;
  upToDate: number; // manifest said the server already has it
  deduped: number; // content already on the server under another path/device
  uploaded: number;
  failed: number;
}

export interface SyncStatus {
  phase: 'running' | 'done' | 'cancelled' | 'error';
  activity: string;
  counts: SyncCounts;
  lastError: string | null;
}

export interface SyncHandle {
  cancel(): void;
}

interface Candidate {
  asset: MediaLibrary.Asset;
  path: string;
  mtime: number; // milliseconds since epoch
  size: number;
  localUri: string | null;
}

// Looking up localUri + size for every asset makes re-scans slow on big
// libraries, so remember sizes across runs, keyed by id + mtime (an edited
// asset gets a new mtime and falls out of the cache naturally).
const SIZE_CACHE_URI = `${LegacyFileSystem.documentDirectory}sync-size-cache.json`;
type SizeCache = Record<string, number>;

async function loadSizeCache(): Promise<SizeCache> {
  try {
    return JSON.parse(await LegacyFileSystem.readAsStringAsync(SIZE_CACHE_URI));
  } catch {
    return {};
  }
}

async function saveSizeCache(cache: SizeCache): Promise<void> {
  try {
    await LegacyFileSystem.writeAsStringAsync(SIZE_CACHE_URI, JSON.stringify(cache));
  } catch {
    // cache is an optimization only
  }
}

async function localUriFor(asset: MediaLibrary.Asset): Promise<string> {
  const info = await MediaLibrary.getAssetInfoAsync(asset);
  if (!info.localUri) throw new Error('Original not available on this device');
  return info.localUri;
}

export function startSync(session: Session, onStatus: (status: SyncStatus) => void): SyncHandle {
  let cancelled = false;
  const status: SyncStatus = {
    phase: 'running',
    activity: 'Starting…',
    counts: { scanned: 0, unsupported: 0, upToDate: 0, deduped: 0, uploaded: 0, failed: 0 },
    lastError: null,
  };
  const emit = (activity?: string) => {
    if (activity !== undefined) status.activity = activity;
    onStatus({ ...status, counts: { ...status.counts } });
  };

  // Uploads only on allowed networks (un-metered Wi-Fi unless the user
  // opted in to mobile data). Checked at start and between files, since
  // connectivity can change mid-run.
  const ensureNetwork = async () => {
    const netPermission = await uploadAllowed();
    if (!netPermission.allowed) throw new Error(netPermission.reason ?? 'Uploads paused');
  };

  const run = async () => {
    await ensureNetwork();
    const permission = await MediaLibrary.requestPermissionsAsync();
    if (!permission.granted) {
      status.phase = 'error';
      status.lastError = 'Photo library permission is required to sync';
      emit('Permission denied');
      return;
    }
    log('sync', 'full sync started');

    const sizeCache = await loadSizeCache();
    let after: string | undefined;
    let hasNextPage = true;

    while (hasNextPage && !cancelled) {
      emit(`Scanning library… (${status.counts.scanned})`);
      const page = await MediaLibrary.getAssetsAsync({
        first: PAGE_SIZE,
        after,
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      hasNextPage = page.hasNextPage;
      after = page.endCursor;

      // Resolve sizes so the manifest can be built for this page.
      const candidates: Candidate[] = [];
      for (const asset of page.assets) {
        if (cancelled) break;
        status.counts.scanned++;
        if (!SUPPORTED_EXTENSIONS.has(extensionOf(asset.filename))) {
          status.counts.unsupported++;
          continue;
        }
        const mtime = assetMtime(asset);
        const cacheKey = `${asset.id}:${mtime}`;
        let size = sizeCache[cacheKey];
        let localUri: string | null = null;
        if (size === undefined) {
          try {
            localUri = await localUriFor(asset);
            const stat = await LegacyFileSystem.getInfoAsync(localUri);
            if (!stat.exists || stat.size === undefined) throw new Error('Could not stat file');
            size = stat.size;
            sizeCache[cacheKey] = size;
          } catch (err) {
            status.counts.failed++;
            status.lastError = `${asset.filename}: ${String(err)}`;
            continue;
          }
        }
        candidates.push({
          asset,
          path: stablePath(asset.id, asset.filename),
          mtime,
          size,
          localUri,
        });
        if (status.counts.scanned % 25 === 0) emit(`Scanning library… (${status.counts.scanned})`);
      }
      await saveSizeCache(sizeCache);
      if (cancelled || candidates.length === 0) continue;

      // Manifest for this page: the server answers with what it doesn't have.
      emit(`Checking ${candidates.length} files with the server…`);
      const neededPaths = await manifestCheck(session, candidates);
      const work = candidates.filter((c) => neededPaths.has(c.path));
      status.counts.upToDate += candidates.length - work.length;
      emit();

      // Hash + upload what's needed, strictly one file at a time.
      for (const candidate of work) {
        if (cancelled) break;
        await ensureNetwork();
        try {
          const localUri = candidate.localUri ?? (await localUriFor(candidate.asset));
          const outcome = await hashAndUpload(
            session,
            {
              path: candidate.path,
              mtime: candidate.mtime,
              size: candidate.size,
              localUri,
              cacheKey: `${candidate.asset.id}:${candidate.mtime}:${candidate.size}`,
            },
            (phase) =>
              emit(
                phase === 'hashing'
                  ? `Hashing ${candidate.asset.filename}…`
                  : `Uploading ${candidate.asset.filename}…`
              )
          );
          if (outcome === 'deduped') status.counts.deduped++;
          else status.counts.uploaded++;
          emit();
        } catch (err) {
          status.counts.failed++;
          status.lastError = `${candidate.asset.filename}: ${String(err)}`;
          logError('sync', `failed ${candidate.asset.filename}`, err);
          emit();
        }
      }
    }

    status.phase = cancelled ? 'cancelled' : 'done';
    log('sync', `full sync ${status.phase}`, status.counts);
    emit(cancelled ? 'Cancelled' : 'Sync complete');
  };

  run().catch((err) => {
    status.phase = 'error';
    status.lastError = String(err);
    logError('sync', 'full sync stopped', err);
    emit('Sync stopped');
  });

  return {
    cancel() {
      cancelled = true;
    },
  };
}
