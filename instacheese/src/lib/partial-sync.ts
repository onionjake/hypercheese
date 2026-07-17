import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';

import { type Session } from './api';
import {
  markStatus,
  selectedForSync,
  setSize,
  type LibraryAsset,
} from './library-db';
import { log, logError } from './log';
import { uploadAllowed } from './network';
import { hashAndUpload, manifestCheck, stablePath } from './upload-protocol';

// Partial sync: run the manifest/hashes/upload protocol over exactly the
// assets the user selected in the library catalog. The server manifest is
// consulted on EVERY run — the local 'synced' status is just a display cache,
// so if the server ever loses a file (or the device re-registers) the next
// run notices and re-uploads.
//
// Failure semantics: only a problem with the file itself (can't read, server
// rejected it) marks it 'failed'. Batch-level problems — network gone, server
// unreachable, not on Wi-Fi — pause the run and leave everything 'pending',
// so "marked for upload but not uploaded yet" stays visible and a later run
// (see backup-manager) retries it.

const BATCH_SIZE = 200;

export interface PartialSyncCounts {
  selected: number;
  checked: number;
  upToDate: number;
  uploaded: number;
  deduped: number;
  failed: number;
}

export interface PartialSyncStatus {
  phase: 'running' | 'done' | 'cancelled' | 'paused' | 'error';
  activity: string;
  counts: PartialSyncCounts;
  lastError: string | null;
}

export interface PartialSyncHandle {
  cancel(): void;
}

// getAssetInfoAsync reads EXIF (including GPS) on Android 10+, which needs
// the ACCESS_MEDIA_LOCATION permission and rejects wholesale without it — a
// build predating that permission can't stat anything through it. The
// catalog's library uri is a plain readable file:// path on Android, so fall
// back to it rather than failing the file. (iOS uris are ph:// and unusable
// here, but iOS never rejects this call over EXIF access.)
async function localUriFor(asset: Pick<LibraryAsset, 'id' | 'uri'>): Promise<string> {
  try {
    const info = await MediaLibrary.getAssetInfoAsync(asset.id);
    if (info.localUri) return info.localUri;
    throw new Error('Original not available on this device');
  } catch (err) {
    if (asset.uri.startsWith('file://')) return asset.uri;
    throw err;
  }
}

interface Candidate {
  asset: LibraryAsset;
  path: string;
  size: number;
  localUri: string | null;
}

// Thrown to stop the run without marking anything failed.
class Paused extends Error {}

export function startPartialSync(
  session: Session,
  onStatus: (status: PartialSyncStatus) => void,
  onAsset?: (id: string, status: 'synced' | 'failed' | 'pending', error?: string) => void
): PartialSyncHandle {
  let cancelled = false;
  const status: PartialSyncStatus = {
    phase: 'running',
    activity: 'Starting…',
    counts: { selected: 0, checked: 0, upToDate: 0, uploaded: 0, deduped: 0, failed: 0 },
    lastError: null,
  };
  const emit = (activity?: string) => {
    if (activity !== undefined) status.activity = activity;
    onStatus({ ...status, counts: { ...status.counts } });
  };

  const settle = async (asset: LibraryAsset, result: 'synced' | 'failed', error?: string) => {
    await markStatus(asset.id, result, error ?? null);
    onAsset?.(asset.id, result, error);
  };

  const ensureNetwork = async () => {
    const permission = await uploadAllowed();
    if (!permission.allowed) throw new Paused(permission.reason ?? 'Uploads paused');
  };

  const run = async () => {
    await ensureNetwork();
    const queue = await selectedForSync();
    status.counts.selected = queue.length;
    log('backup', `run started: ${queue.length} selected`);
    if (queue.length === 0) {
      status.phase = 'done';
      emit('Nothing selected to back up');
      return;
    }

    for (let start = 0; start < queue.length && !cancelled; start += BATCH_SIZE) {
      const batch = queue.slice(start, start + BATCH_SIZE);

      // Resolve missing sizes so the batch manifest can be built.
      const candidates: Candidate[] = [];
      for (const asset of batch) {
        if (cancelled) break;
        status.counts.checked++;
        let size = asset.size;
        let localUri: string | null = null;
        if (size == null) {
          try {
            emit(`Reading ${asset.filename}…`);
            localUri = await localUriFor(asset);
            const stat = await LegacyFileSystem.getInfoAsync(localUri);
            if (!stat.exists || stat.size === undefined) throw new Error('Could not stat file');
            size = stat.size;
            await setSize(asset.id, size);
          } catch (err) {
            status.counts.failed++;
            status.lastError = `${asset.filename}: ${String(err)}`;
            logError('backup', `stat failed for ${asset.filename} (${asset.id})`, err);
            await settle(asset, 'failed', String(err));
            emit();
            continue;
          }
        }
        candidates.push({
          asset,
          path: stablePath(asset.id, asset.filename),
          size,
          localUri,
        });
      }
      if (cancelled || candidates.length === 0) continue;

      // The server's manifest decides what actually needs work. A manifest
      // failure is a batch-level (network/server) problem: pause, leave
      // everything pending for the next run.
      emit(`Checking ${candidates.length} files with the server…`);
      let neededPaths: Set<string>;
      try {
        neededPaths = await manifestCheck(
          session,
          candidates.map((c) => ({ path: c.path, mtime: c.asset.mtime, size: c.size }))
        );
      } catch (err) {
        logError('backup', 'manifest failed, pausing run', err);
        throw new Paused(`Could not reach the server: ${String(err)}`);
      }

      for (const candidate of candidates) {
        if (cancelled) break;
        if (!neededPaths.has(candidate.path)) {
          status.counts.upToDate++;
          await settle(candidate.asset, 'synced');
          emit();
          continue;
        }
        // Connectivity can change mid-run (leave the house, Wi-Fi drops).
        await ensureNetwork();
        try {
          const localUri = candidate.localUri ?? (await localUriFor(candidate.asset));
          const outcome = await hashAndUpload(
            session,
            {
              path: candidate.path,
              mtime: candidate.asset.mtime,
              size: candidate.size,
              localUri,
              cacheKey: `${candidate.asset.id}:${candidate.asset.mtime}:${candidate.size}`,
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
          await settle(candidate.asset, 'synced');
          emit();
        } catch (err) {
          if (err instanceof Paused) throw err;
          status.counts.failed++;
          status.lastError = `${candidate.asset.filename}: ${String(err)}`;
          logError('backup', `failed ${candidate.asset.filename} (${candidate.asset.id})`, err);
          await settle(candidate.asset, 'failed', String(err));
          emit();
        }
      }
    }

    status.phase = cancelled ? 'cancelled' : 'done';
    log('backup', `run ${status.phase}`, status.counts);
    emit(cancelled ? 'Cancelled' : 'Backup complete');
  };

  run().catch((err) => {
    if (err instanceof Paused) {
      status.phase = 'paused';
      status.lastError = null;
      log('backup', `run paused: ${err.message}`, status.counts);
      emit(err.message);
      return;
    }
    status.phase = 'error';
    status.lastError = String(err);
    logError('backup', 'run crashed', err);
    emit('Backup failed');
  });

  return {
    cancel() {
      cancelled = true;
    },
  };
}
