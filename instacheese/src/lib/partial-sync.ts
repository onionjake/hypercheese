import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';

import { type Session } from './api';
import {
  markStatus,
  selectedForSync,
  setSize,
  type LibraryAsset,
} from './library-db';
import { hashAndUpload, manifestCheck, stablePath } from './upload-protocol';

// Partial sync: run the manifest/hashes/upload protocol over exactly the
// assets the user selected in the library catalog. The server manifest is
// consulted on EVERY run — the local 'synced' status is just a display cache,
// so if the server ever loses a file (or the device re-registers) the next
// run notices and re-uploads. Statuses are written back to the catalog as
// each file settles, which is also what makes retry work: failed files stay
// selected and are simply picked up by the next run.

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
  phase: 'running' | 'done' | 'cancelled' | 'error';
  activity: string;
  counts: PartialSyncCounts;
  lastError: string | null;
}

export interface PartialSyncHandle {
  cancel(): void;
}

async function localUriFor(assetId: string): Promise<string> {
  const info = await MediaLibrary.getAssetInfoAsync(assetId);
  if (!info.localUri) throw new Error('Original not available on this device');
  return info.localUri;
}

interface Candidate {
  asset: LibraryAsset;
  path: string;
  size: number;
  localUri: string | null;
}

export function startPartialSync(
  session: Session,
  onStatus: (status: PartialSyncStatus) => void,
  onAsset?: (id: string, status: 'synced' | 'failed', error?: string) => void
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

  const run = async () => {
    const queue = await selectedForSync();
    status.counts.selected = queue.length;
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
            localUri = await localUriFor(asset.id);
            const stat = await LegacyFileSystem.getInfoAsync(localUri);
            if (!stat.exists || stat.size === undefined) throw new Error('Could not stat file');
            size = stat.size;
            await setSize(asset.id, size);
          } catch (err) {
            status.counts.failed++;
            status.lastError = `${asset.filename}: ${String(err)}`;
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

      // The server's manifest decides what actually needs work.
      emit(`Checking ${candidates.length} files with the server…`);
      let neededPaths: Set<string>;
      try {
        neededPaths = await manifestCheck(
          session,
          candidates.map((c) => ({ path: c.path, mtime: c.asset.mtime, size: c.size }))
        );
      } catch (err) {
        // Manifest failure fails the whole batch; nothing is marked synced.
        status.counts.failed += candidates.length;
        status.lastError = String(err);
        for (const c of candidates) await settle(c.asset, 'failed', String(err));
        emit();
        continue;
      }

      for (const candidate of candidates) {
        if (cancelled) break;
        if (!neededPaths.has(candidate.path)) {
          status.counts.upToDate++;
          await settle(candidate.asset, 'synced');
          emit();
          continue;
        }
        try {
          const localUri = candidate.localUri ?? (await localUriFor(candidate.asset.id));
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
          status.counts.failed++;
          status.lastError = `${candidate.asset.filename}: ${String(err)}`;
          await settle(candidate.asset, 'failed', String(err));
          emit();
        }
      }
    }

    status.phase = cancelled ? 'cancelled' : 'done';
    emit(cancelled ? 'Cancelled' : 'Backup complete');
  };

  run().catch((err) => {
    status.phase = 'error';
    status.lastError = String(err);
    emit('Backup failed');
  });

  return {
    cancel() {
      cancelled = true;
    },
  };
}
