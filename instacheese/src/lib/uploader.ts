import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import type { ImagePickerAsset } from 'expo-image-picker';
import * as MediaLibrary from 'expo-media-library';
import { Platform } from 'react-native';

import { CLIENT_VERSION, type Session } from './api';

// Extensions the server's importer accepts (lib/import.rb).
const SUPPORTED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'tiff', 'tif', 'png',
  'avi', 'mov', 'mpg', 'mts', 'mp4', 'mkv', 'vob', 'dv', 'wmv',
]);

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

function extensionOf(name: string): string {
  const match = name.match(/\.(\w+)$/);
  return match ? match[1].toLowerCase() : '';
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
        return info.modificationTime ?? info.creationTime ?? null;
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
    const supported = SUPPORTED_EXTENSIONS.has(extensionOf(name));
    return {
      key: `${asset.assetId ?? asset.uri}-${index}`,
      asset,
      path: name,
      size,
      mtime: Math.round(mtime),
      status: supported ? 'pending' : 'unsupported',
      error: supported ? undefined : 'File type not supported by the server',
    } as UploadFile;
  });
}

// The server stores mtime as an opaque string of seconds-since-epoch and, on
// the next manifest, compares it byte-for-byte against what we send. So every
// request touching a given file (manifest, hashes, upload) must send the exact
// same representation, in seconds. Match the web uploader: `lastModified / 1000`
// rendered with String(). `mtime` is held internally in milliseconds.
function mtimeParam(file: Pick<UploadFile, 'mtime'>): string {
  return String(file.mtime / 1000);
}

function authHeaders(session: Session): Record<string, string> {
  if (!session.token) {
    throw new Error('Uploading requires the upgraded HyperCheese server');
  }
  return {
    Authorization: `Bearer ${session.token}`,
    'X-API-Version': '1.0',
  };
}

async function postJson<T>(session: Session, path: string, body: unknown): Promise<T> {
  const res = await fetch(session.baseUrl + path, {
    method: 'POST',
    headers: {
      ...authHeaders(session),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(text || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

async function sha256OfFile(uri: string): Promise<string> {
  const bytes = await new File(uri).bytes();
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return toHex(new Uint8Array(digest));
}

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
  const manifest = candidates.map((f) => ({ path: f.path, mtime: mtimeParam(f), size: f.size }));
  // The server refreshes device metadata from these query params on every
  // manifest, so always send them or they get blanked out.
  const deviceParams = new URLSearchParams({
    os: Platform.OS,
    nickname: `InstaCheese on ${Platform.OS}`,
    client_version: CLIENT_VERSION,
  });
  let needed: { path: string }[];
  try {
    needed = await postJson<{ path: string }[]>(
      session,
      `/files/manifest?${deviceParams.toString()}`,
      manifest
    );
  } catch (err) {
    candidates.forEach((f) => update(f, { status: 'error', error: String(err) }));
    return;
  }

  const neededPaths = new Set(needed.map((f) => f.path));
  const toHash = candidates.filter((f) => neededPaths.has(f.path));
  candidates
    .filter((f) => !neededPaths.has(f.path))
    .forEach((f) => update(f, { status: 'already-uploaded' }));

  // Step 2: hash the files the server asked about, one at a time.
  const hashes = new Map<string, string>();
  for (const file of toHash) {
    update(file, { status: 'hashing' });
    try {
      hashes.set(file.path, await sha256OfFile(file.asset.uri));
    } catch (err) {
      update(file, { status: 'error', error: `Could not read file: ${String(err)}` });
    }
  }

  const hashed = toHash.filter((f) => hashes.has(f.path));
  if (hashed.length === 0) return;

  let toUpload: { path: string }[];
  try {
    toUpload = await postJson<{ path: string }[]>(
      session,
      '/files/hashes',
      hashed.map((f) => ({
        path: f.path,
        mtime: mtimeParam(f),
        size: f.size,
        sha256: hashes.get(f.path),
      }))
    );
  } catch (err) {
    hashed.forEach((f) => update(f, { status: 'error', error: String(err) }));
    return;
  }

  const uploadPaths = new Set(toUpload.map((f) => f.path));
  hashed
    .filter((f) => !uploadPaths.has(f.path))
    .forEach((f) => update(f, { status: 'already-uploaded' }));

  // Step 3: upload the remaining files one at a time.
  for (const file of hashed.filter((f) => uploadPaths.has(f.path))) {
    update(file, { status: 'uploading' });
    try {
      const result = await LegacyFileSystem.uploadAsync(
        `${session.baseUrl}/files/upload`,
        file.asset.uri,
        {
          httpMethod: 'PUT',
          uploadType: LegacyFileSystem.FileSystemUploadType.BINARY_CONTENT,
          headers: {
            ...authHeaders(session),
            'X-Path': file.path,
            'X-MTime': mtimeParam(file),
            'X-SHA256': hashes.get(file.path)!,
            'X-Size': String(file.size),
          },
        }
      );
      if (result.status >= 200 && result.status < 300) {
        update(file, { status: 'done' });
      } else {
        update(file, { status: 'error', error: result.body || `Upload failed (${result.status})` });
      }
    } catch (err) {
      update(file, { status: 'error', error: String(err) });
    }
  }
}
