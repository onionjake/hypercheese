import { File } from 'expo-file-system';
import type { ImagePickerAsset } from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';

import { log } from './log';
import {
  SUPPORTED_EXTENSIONS,
  assetMtime,
  extensionOf,
  stablePath,
} from './upload-protocol';
import * as queue from './upload-queue';

// Picker flow: turn picked assets into upload-queue items. The queue owns the
// actual uploading, so picking and sharing returns immediately and the user
// can keep using the app while the queue drains.

export type UploadStatus = queue.QueueItemStatus | 'ready' | 'unsupported';

export interface UploadFile {
  key: string; // same key the queue item uses, so status flows back by key
  asset: ImagePickerAsset;
  name: string;
  path: string;
  size: number;
  mtime: number; // milliseconds since epoch
  status: UploadStatus;
  error?: string;
}

function fileNameFor(asset: ImagePickerAsset, index: number): string {
  const fromAsset = asset.fileName || asset.uri.split('/').pop() || '';
  if (fromAsset && extensionOf(fromAsset)) return fromAsset;
  const ext = asset.type === 'video' ? 'mp4' : 'jpg';
  return `${fromAsset || `instacheese-${Date.now()}-${index}`}.${ext}`;
}

// The picker copies each selected asset into a fresh temp file, so the temp
// file's mtime changes on every pick and can't be used to dedupe re-uploads.
// Look up the ORIGINAL asset's timestamps in the media library instead —
// stable across picks, and it's the real photo date, which the server uses
// for the imported item. Returns null (caller falls back to temp-file info)
// when the assetId is missing (e.g. Android photo picker) or library
// permission is denied.
async function originalMtimes(assets: ImagePickerAsset[]): Promise<(number | null)[]> {
  if (!assets.some((a) => a.assetId)) return assets.map(() => null);
  try {
    const perm = await MediaLibrary.getPermissionsAsync();
    if (!perm.granted && perm.canAskAgain) await MediaLibrary.requestPermissionsAsync();
  } catch {
    // proceed; per-asset lookups below have their own fallback
  }
  return Promise.all(
    assets.map(async (asset) => {
      if (!asset.assetId) return null;
      try {
        const info = await MediaLibrary.getAssetInfoAsync(asset.assetId);
        // Same fallback logic as the sync flows (assetMtime) so every flow
        // sends the identical mtime for the same asset.
        return assetMtime(info) || null;
      } catch {
        return null;
      }
    })
  );
}

export async function prepareFiles(assets: ImagePickerAsset[]): Promise<UploadFile[]> {
  const libraryMtimes = await originalMtimes(assets);
  return assets.map((asset, index) => {
    const name = fileNameFor(asset, index);
    let size = asset.fileSize ?? 0;
    let mtime = Date.now();
    try {
      const info = new File(asset.uri).info();
      if (info.exists) {
        size = info.size ?? size;
        mtime = info.modificationTime ?? mtime;
      }
    } catch {
      // fall back to picker-provided values
    }
    mtime = libraryMtimes[index] ?? mtime;
    // Same path scheme as the sync flows: with an assetId the path is unique
    // and stable across picks, so re-picking the same photo matches the
    // server's manifest instead of re-hashing. Bare filenames (no assetId)
    // remain as a fallback but collide on repeated names like IMG_0001.jpg.
    const path = asset.assetId ? stablePath(asset.assetId, name) : name;
    const supported = SUPPORTED_EXTENSIONS.has(extensionOf(name));
    return {
      key: asset.assetId ? queue.assetKey(asset.assetId) : `picker:${asset.uri}`,
      asset,
      name,
      path,
      size,
      mtime: Math.round(mtime),
      status: supported ? 'ready' : 'unsupported',
      error: supported ? undefined : 'File type not supported by the server',
    } as UploadFile;
  });
}

// Queues the given files (skipping unsupported ones) and kicks the drain.
// Safe to call again with just the failed files — the server manifest is the
// source of truth, so a retry simply re-runs the protocol for those paths.
export async function enqueuePicked(files: UploadFile[]): Promise<void> {
  const supported = files.filter((f) => f.status !== 'unsupported');
  if (supported.length === 0) return;
  log('picker', `queueing ${supported.length} picked files`);
  await queue.enqueue(
    supported.map((f) => ({
      key: f.key,
      source: 'picker' as const,
      assetId: f.asset.assetId ?? null,
      localUri: f.asset.uri,
      thumbUri: f.asset.uri,
      filename: f.name,
      path: f.path,
      mtime: f.mtime,
      size: f.size,
    }))
  );
  queue.kick('picker');
}
