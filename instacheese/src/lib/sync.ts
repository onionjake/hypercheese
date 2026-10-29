import * as LegacyFileSystem from 'expo-file-system/legacy';
// The classic namespace API (getAssetsAsync paging, plain Asset records)
// lives under /legacy in expo-media-library 57+.
import * as MediaLibrary from 'expo-media-library/legacy';

import { type Session } from './api';
import { excludedAssetIds, sweepPairedVideoLeftovers } from './library-db';
import { log, logError } from './log';
import { uploadAllowed, uploadAllowedRecently } from './network';
import {
  MEDIA_PERMISSIONS,
  assetMtime,
  isBackupSupported,
  manifestCheck,
  stablePath,
} from './upload-protocol';
import * as queue from './upload-queue';

// Camera-roll sync: enumerate the media library directly (no picker, no
// per-pick cache copies) and let the server's manifest decide what needs
// uploading. Anything missing is handed to the shared upload queue, so the
// scan finishes fast and the user can leave this screen while the queue
// drains in the background.

const PAGE_SIZE = 200;

export interface SyncCounts {
  scanned: number;
  unsupported: number;
  excluded: number; // marked "won't upload" on the Backup screen
  upToDate: number; // manifest said the server already has it
  queued: number; // handed to the upload queue
  failed: number; // couldn't be read/stat'ed during the scan
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

export function startSync(session: Session, onStatus: (status: SyncStatus) => void): SyncHandle {
  let cancelled = false;
  const status: SyncStatus = {
    phase: 'running',
    activity: 'Starting…',
    counts: { scanned: 0, unsupported: 0, excluded: 0, upToDate: 0, queued: 0, failed: 0 },
    lastError: null,
  };
  const emit = (activity?: string) => {
    if (activity !== undefined) status.activity = activity;
    onStatus({ ...status, counts: { ...status.counts } });
  };

  // The scan talks to the server (manifest), so it follows the same network
  // rule as uploads: un-metered Wi-Fi unless the user opted in to mobile data.
  const ensureNetwork = async () => {
    const netPermission = await uploadAllowed();
    if (!netPermission.allowed) throw new Error(netPermission.reason ?? 'Uploads paused');
  };

  const run = async () => {
    await ensureNetwork();
    // Check before requesting: with partial access a request re-opens the
    // photo selection dialog on every run.
    let permission = await MediaLibrary.getPermissionsAsync(false, MEDIA_PERMISSIONS);
    if (!permission.granted && permission.canAskAgain) {
      permission = await MediaLibrary.requestPermissionsAsync(false, MEDIA_PERMISSIONS);
    }
    if (!permission.granted) {
      status.phase = 'error';
      status.lastError = 'Photo library permission is required to sync';
      emit('Permission denied');
      return;
    }
    log('sync', 'full sync scan started');

    const sizeCache = await loadSizeCache();
    const queueEpoch = queue.currentEpoch();
    // Files the server asked for, including ones already waiting in the
    // queue (which enqueue() doesn't count as newly queued).
    let needed = 0;
    let after: string | undefined;
    let hasNextPage = true;

    while (hasNextPage && !cancelled) {
      // Re-checked as the scan goes: size lookups can download originals
      // from iCloud, and the phone may have left Wi-Fi since the scan began.
      await ensureNetwork();
      emit(`Scanning library… (${status.counts.scanned})`);
      const page = await MediaLibrary.getAssetsAsync({
        first: PAGE_SIZE,
        after,
        mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      hasNextPage = page.hasNextPage;
      after = page.endCursor;
      // "Uploads your whole camera roll" still means minus what the user
      // explicitly said must never be uploaded — re-read per page so a mark
      // made while the scan runs is honoured too.
      const excluded = await excludedAssetIds();

      // Resolve sizes so the manifest can be built for this page.
      const candidates: Candidate[] = [];
      for (const asset of page.assets) {
        if (cancelled) break;
        status.counts.scanned++;
        if (!isBackupSupported(asset)) {
          status.counts.unsupported++;
          continue;
        }
        if (excluded.has(asset.id)) {
          status.counts.excluded++;
          continue;
        }
        const mtime = assetMtime(asset);
        const cacheKey = `${asset.id}:${mtime}`;
        let size = sizeCache[cacheKey];
        if (size === undefined) {
          const netPermission = await uploadAllowedRecently();
          if (!netPermission.allowed) {
            // Keep the sizes this page already resolved (each may have been
            // an iCloud download) so scanning again picks up from here.
            await saveSizeCache(sizeCache);
            throw new Error(
              `${netPermission.reason ?? 'Uploads paused'} — scan again once you're back on Wi-Fi`
            );
          }
          try {
            const localUri = await queue.libraryLocalUri(asset.id, asset.uri);
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
        });
        if (status.counts.scanned % 25 === 0) emit(`Scanning library… (${status.counts.scanned})`);
      }
      await saveSizeCache(sizeCache);
      if (cancelled || candidates.length === 0) continue;

      // Manifest for this page: the server answers with what it doesn't
      // have; that goes straight into the shared upload queue.
      emit(`Checking ${candidates.length} files with the server…`);
      const neededPaths = await manifestCheck(session, candidates);
      const work = candidates.filter((c) => neededPaths.has(c.path));
      status.counts.upToDate += candidates.length - work.length;
      needed += work.length;
      if (work.length > 0) {
        status.counts.queued += await queue.enqueue(
          work.map((c) => ({
            key: queue.assetKey(c.asset.id),
            source: 'sync' as const,
            assetId: c.asset.id,
            thumbUri: c.asset.uri,
            filename: c.asset.filename,
            path: c.path,
            mtime: c.mtime,
            size: c.size,
          })),
          { epoch: queueEpoch }
        );
        queue.kick('sync');
      }
      emit();
    }

    sweepPairedVideoLeftovers({ force: true });
    status.phase = cancelled ? 'cancelled' : 'done';
    log('sync', `full sync scan ${status.phase}`, status.counts);
    emit(
      cancelled
        ? 'Cancelled'
        : status.counts.queued > 0
          ? `Scan complete — ${status.counts.queued} queued for upload`
          : needed > 0
            ? `Scan complete — ${needed} already in the upload queue`
            : 'Scan complete — everything is already on the server'
    );
  };

  run().catch((err) => {
    status.phase = 'error';
    status.lastError = String(err);
    logError('sync', 'full sync scan stopped', err);
    emit('Sync stopped');
  });

  return {
    cancel() {
      cancelled = true;
    },
  };
}
