import { File } from 'expo-file-system';
import type { ImagePickerAsset } from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';

import { type Session } from './api';
import {
  SUPPORTED_EXTENSIONS,
  assetMtime,
  extensionOf,
  hashAndUpload,
  manifestCheck,
  stablePath,
} from './upload-protocol';

export type UploadStatus =
  | 'pending'
  | 'checking'
  | 'hashing'
  | 'uploading'
  | 'done'
  | 'already-uploaded'
  | 'unsupported'
  | 'error';

export interface UploadFile {
  key: string;
  asset: ImagePickerAsset;
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
      key: `${asset.assetId ?? asset.uri}-${index}`,
      asset,
      path,
      size,
      mtime: Math.round(mtime),
      status: supported ? 'pending' : 'unsupported',
      error: supported ? undefined : 'File type not supported by the server',
    } as UploadFile;
  });
}

// Uploads the given files (skipping unsupported ones). Safe to call again
// with just the failed files — the server manifest is the source of truth, so
// a retry simply re-runs the protocol for those paths.
export async function uploadFiles(
  session: Session,
  files: UploadFile[],
  onUpdate: (file: UploadFile) => void
): Promise<void> {
  const candidates = files.filter((f) => f.status !== 'unsupported');
  if (candidates.length === 0) return;

  const update = (file: UploadFile, changes: Partial<UploadFile>) => {
    Object.assign(file, changes);
    onUpdate(file);
  };

  candidates.forEach((f) => update(f, { status: 'checking', error: undefined }));

  // Step 1: manifest — the server answers with the paths it doesn't have yet.
  let neededPaths: Set<string>;
  try {
    neededPaths = await manifestCheck(session, candidates);
  } catch (err) {
    candidates.forEach((f) => update(f, { status: 'error', error: String(err) }));
    return;
  }

  candidates
    .filter((f) => !neededPaths.has(f.path))
    .forEach((f) => update(f, { status: 'already-uploaded' }));

  // Steps 2+3: hash and upload one file at a time, so one bad file can't
  // fail the whole batch and per-file status stays accurate.
  for (const file of candidates.filter((f) => neededPaths.has(f.path))) {
    try {
      const outcome = await hashAndUpload(
        session,
        {
          path: file.path,
          mtime: file.mtime,
          size: file.size,
          localUri: file.asset.uri,
          // Only cache hashes under a stable identity; picker temp files
          // without an assetId have none.
          cacheKey: file.asset.assetId
            ? `${file.asset.assetId}:${file.mtime}:${file.size}`
            : null,
        },
        (phase) => update(file, { status: phase })
      );
      update(file, { status: outcome === 'deduped' ? 'already-uploaded' : 'done' });
    } catch (err) {
      update(file, { status: 'error', error: String(err) });
    }
  }
}
