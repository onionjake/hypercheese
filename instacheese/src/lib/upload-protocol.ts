import * as Crypto from 'expo-crypto';
import { File } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { sha256 } from 'js-sha256';
import { Platform } from 'react-native';

import { CLIENT_VERSION, type Session } from './api';

// Shared pieces of the /files/* upload protocol, used by both the picker
// upload flow (uploader.ts) and the camera-roll sync flow (sync.ts).

// Extensions the server's importer accepts (lib/import.rb).
export const SUPPORTED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'tiff', 'tif', 'png',
  'avi', 'mov', 'mpg', 'mts', 'mp4', 'mkv', 'vob', 'dv', 'wmv',
]);

export function extensionOf(name: string): string {
  const match = name.match(/\.(\w+)$/);
  return match ? match[1].toLowerCase() : '';
}

// Filenames repeat across a big library (iOS wraps around at IMG_9999), so
// prefix the library's stable per-asset id to keep the server's
// (user, device, path) key unique AND stable across picker uploads, full
// syncs, and partial syncs — all three flows must produce the same path for
// the same asset or the server manifest will keep asking us to rehash it.
// Keep the filename last so the extension stays visible to the importer.
export function stablePath(assetId: string, filename: string): string {
  const id = assetId.replace(/[^A-Za-z0-9_-]/g, '_');
  return `${id}/${filename}`;
}

// The server stores mtime as an opaque string of seconds-since-epoch and, on
// the next manifest, compares it byte-for-byte against what we send. So every
// request touching a given file (manifest, hashes, upload) must send the exact
// same representation, in seconds. Match the web uploader: `lastModified / 1000`
// rendered with String(). Callers hold mtime in milliseconds.
export function mtimeParam(mtimeMs: number): string {
  return String(mtimeMs / 1000);
}

// The library mtime as sent to the server, in milliseconds. `||` (not `??`)
// so a zero modificationTime falls back to creationTime — every flow must
// derive the exact same value for the same asset or the manifest will keep
// missing and force a rehash.
export function assetMtime(asset: {
  modificationTime?: number | null;
  creationTime?: number | null;
}): number {
  return Math.round(asset.modificationTime || asset.creationTime || 0);
}

export function authHeaders(session: Session): Record<string, string> {
  if (!session.token) {
    throw new Error('Uploading requires the upgraded HyperCheese server');
  }
  return {
    Authorization: `Bearer ${session.token}`,
    'X-API-Version': '1.0',
  };
}

// The server refreshes device metadata from these query params on every
// manifest, so always send them or they get blanked out.
export function deviceParams(): string {
  return new URLSearchParams({
    os: Platform.OS,
    nickname: `InstaCheese on ${Platform.OS}`,
    client_version: CLIENT_VERSION,
  }).toString();
}

export async function postJson<T>(session: Session, path: string, body: unknown): Promise<T> {
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

// Above this size, reading the whole file into memory to hash it risks
// crashing the app, so fall back to chunked reads + an incremental JS hash.
const CHUNKED_HASH_THRESHOLD = 128 * 1024 * 1024;
const HASH_CHUNK_SIZE = 16 * 1024 * 1024;

function base64ToBytes(b64: string): Uint8Array {
  const bin = globalThis.atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256OfFile(uri: string, size?: number): Promise<string> {
  if (size !== undefined && size > CHUNKED_HASH_THRESHOLD) {
    const hash = sha256.create();
    for (let position = 0; position < size; position += HASH_CHUNK_SIZE) {
      const length = Math.min(HASH_CHUNK_SIZE, size - position);
      const chunk = await LegacyFileSystem.readAsStringAsync(uri, {
        encoding: LegacyFileSystem.EncodingType.Base64,
        position,
        length,
      });
      hash.update(base64ToBytes(chunk));
    }
    return hash.hex();
  }
  const bytes = await new File(uri).bytes();
  const digest = await Crypto.digest(Crypto.CryptoDigestAlgorithm.SHA256, bytes);
  return toHex(new Uint8Array(digest));
}

// --- Persistent sha256 cache -------------------------------------------------
// Hashing is the expensive step the manifest exists to avoid, but the server
// can still ask us to rehash (new device after re-login, changed path scheme,
// server-side data loss). Caching hashes keyed by assetId:mtime:size makes any
// rehash a one-time cost per file: if the identity is unchanged, the cached
// hash is the correct answer without re-reading the bytes.

const SHA_CACHE_URI = `${LegacyFileSystem.documentDirectory}sha256-cache.json`;
let shaCache: Record<string, string> | null = null;

async function loadShaCache(): Promise<Record<string, string>> {
  if (!shaCache) {
    try {
      shaCache = JSON.parse(await LegacyFileSystem.readAsStringAsync(SHA_CACHE_URI));
    } catch {
      shaCache = {};
    }
  }
  return shaCache!;
}

async function saveShaCache(): Promise<void> {
  try {
    await LegacyFileSystem.writeAsStringAsync(SHA_CACHE_URI, JSON.stringify(shaCache));
  } catch {
    // cache is an optimization only
  }
}

// cacheKey must change whenever the file content could have changed
// (assetId:mtime:size). Pass null when no stable identity exists (e.g. picker
// results without an assetId) to hash unconditionally.
export async function cachedSha256OfFile(
  cacheKey: string | null,
  uri: string,
  size?: number
): Promise<string> {
  const cache = cacheKey ? await loadShaCache() : null;
  if (cache && cacheKey && cache[cacheKey]) return cache[cacheKey];
  const sha = await sha256OfFile(uri, size);
  if (cache && cacheKey) {
    cache[cacheKey] = sha;
    await saveShaCache();
  }
  return sha;
}

// --- Shared protocol steps ---------------------------------------------------

export interface ProtocolFile {
  path: string;
  mtime: number; // milliseconds since epoch
  size: number;
}

// Step two of the protocol: POST the manifest, get back the set of paths the
// server wants hashed. An empty set means everything is already known.
export async function manifestCheck(
  session: Session,
  files: ProtocolFile[]
): Promise<Set<string>> {
  const needed = await postJson<{ path: string }[]>(
    session,
    `/files/manifest?${deviceParams()}`,
    files.map((f) => ({ path: f.path, mtime: mtimeParam(f.mtime), size: f.size }))
  );
  return new Set(needed.map((n) => n.path));
}

// Steps three and four for a single file: hash it (using the cache when a
// stable cacheKey exists), offer the hash to the server, and upload the bytes
// only if the server doesn't already have that content. Posting hashes
// per-file (not batched) also means two files that happen to share a path can
// never clobber each other's hash. Throws on failure so callers can record
// the file as failed and retry later.
export async function hashAndUpload(
  session: Session,
  file: ProtocolFile & { localUri: string; cacheKey: string | null },
  onPhase?: (phase: 'hashing' | 'uploading') => void
): Promise<'uploaded' | 'deduped'> {
  onPhase?.('hashing');
  const sha = await cachedSha256OfFile(file.cacheKey, file.localUri, file.size);

  const toUpload = await postJson<{ path: string }[]>(session, '/files/hashes', [
    { path: file.path, mtime: mtimeParam(file.mtime), size: file.size, sha256: sha },
  ]);
  if (toUpload.length === 0) return 'deduped';

  onPhase?.('uploading');
  const result = await LegacyFileSystem.uploadAsync(`${session.baseUrl}/files/upload`, file.localUri, {
    httpMethod: 'PUT',
    uploadType: LegacyFileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: {
      ...authHeaders(session),
      'X-Path': file.path,
      'X-MTime': mtimeParam(file.mtime),
      'X-SHA256': sha,
      'X-Size': String(file.size),
    },
  });
  if (result.status < 200 || result.status >= 300) {
    throw new Error(result.body || `Upload failed (${result.status})`);
  }
  return 'uploaded';
}
