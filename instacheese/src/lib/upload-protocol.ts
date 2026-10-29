import * as Crypto from 'expo-crypto';
import { File, FileMode } from 'expo-file-system';
import * as LegacyFileSystem from 'expo-file-system/legacy';
import { sha256 } from 'js-sha256';
import { AppState, Platform } from 'react-native';

import { CLIENT_VERSION, type Session } from './api';
import { log } from './log';

// Shared pieces of the /files/* upload protocol, used by both the picker
// upload flow (uploader.ts) and the camera-roll sync flow (sync.ts).

// Give the event loop back between chunks of heavy work so the UI stays
// responsive. Only in the foreground: in an Android background run JS timers
// may never fire (expo-task-manager's headless keep-alive task ends at once),
// so awaiting one there hung the task — mid-hash, mid-enqueue holding the
// write chain, mid-scan — for the whole WorkManager window. If the app
// leaves the foreground while waiting, stop waiting.
export function yieldToUI(): Promise<void> {
  if (AppState.currentState !== 'active') return Promise.resolve();
  return new Promise((resolve) => {
    let sub: { remove(): void } | null = null;
    const done = () => {
      sub?.remove();
      resolve();
    };
    const timer = setTimeout(done, 0);
    try {
      sub = AppState.addEventListener('change', (state) => {
        if (state !== 'active') {
          clearTimeout(timer);
          done();
        }
      });
    } catch {
      // no AppState events here; the timer alone will do
    }
  });
}

// What every media-library permission check asks for. The default also
// includes audio, which Android 13+ shows as a separate "music and audio"
// prompt — declining it would report the whole permission as denied.
export const MEDIA_PERMISSIONS: ('photo' | 'video')[] = ['photo', 'video'];

// Extensions the server's importer accepts (lib/import.rb).
export const SUPPORTED_EXTENSIONS = new Set([
  'jpg', 'jpeg', 'tiff', 'tif', 'png',
  'avi', 'mov', 'mpg', 'mts', 'mp4', 'mkv', 'vob', 'dv', 'wmv',
]);

// Whether a media-library asset can be backed up: a supported extension,
// and not an iOS slow-motion video. Those have no single original file — the
// library re-encodes the whole clip into a new export on every lookup (minutes
// of encoding, hundreds of MB left behind each time, and a different file
// each run, so its size/hash never settle) — so they're left out.
export function isBackupSupported(asset: {
  filename: string;
  mediaSubtypes?: string[] | null;
}): boolean {
  if (asset.mediaSubtypes?.includes('highFrameRate')) return false;
  return SUPPORTED_EXTENSIONS.has(extensionOf(asset.filename));
}

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
  return `${id}/${headerSafe(filename)}`;
}

// The path travels in the X-Path upload header, and Android's HTTP client
// rejects header values outside printable ASCII — a name like "café.jpg"
// would pass the manifest and hash steps (JSON bodies) and then fail every
// upload attempt. Percent-encode just those characters: ASCII names (every
// path already on a server) are unchanged.
export function headerSafe(name: string): string {
  return name.replace(/[^\x20-\x7e]/gu, (ch) => encodeURIComponent(ch));
}

// A transport-level failure (no connection, timeout) as opposed to the
// server rejecting this particular file. The queue pauses on these instead
// of marking the file failed.
export class NetworkError extends Error {}

// The byte transfer itself died. Unlike a NetworkError on the small JSON
// steps, this can be specific to the file (a proxy that resets uploads over
// some size, a header the client refuses to send), so the queue only treats
// it as connectivity when the device has actually lost the network.
export class UploadInterrupted extends Error {}

// The server (or the proxy in front of it) answered with a 5xx. Not proof
// the file is bad — a restart or a transient storage error look the same —
// so the queue fails the file but schedules an automatic retry.
export class ServerError extends Error {}

// The file no longer matches the size/hash recorded for it (the server
// rejected a size or SHA256 mismatch, or the file ended early) — e.g. the
// photo library handed back a different rendition of the same asset. The
// cached hash is already forgotten; the queue forgets the size and retries.
export class StaleFileError extends Error {}

// No request may hang the queue: React Native's Android client has no
// default timeout, so a stalled connection would block the drain forever.
const REQUEST_TIMEOUT_MS = 2 * 60 * 1000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } catch (err) {
    throw new NetworkError(
      abort.signal.aborted ? 'Request timed out' : `Network error: ${String(err)}`
    );
  } finally {
    clearTimeout(timer);
  }
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
    // Only a session whose upload sign-in failed has no token; the next app
    // start retries it (auth.tsx), and signing out and in always does.
    throw new Error('Upload sign-in missing — restart the app, or sign out and back in');
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
  const res = await fetchWithTimeout(session.baseUrl + path, {
    method: 'POST',
    headers: {
      ...authHeaders(session),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    log('api', `POST ${path} failed (${res.status}): ${text.slice(0, 500)}`);
    // A gateway error on these small JSON steps means the server is down or
    // restarting, nothing about the file: pause rather than fail the batch.
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new NetworkError(`Server unavailable (${res.status})`);
    }
    if (res.status >= 500) throw new ServerError(text || `Request failed (${res.status})`);
    throw new Error(text || `Request failed (${res.status})`);
  }
  try {
    return (await res.json()) as T;
  } catch (err) {
    // The body is read after the timeout is cleared; a dropped connection
    // mid-body is still a transport problem.
    throw new NetworkError(`Could not read the server's response: ${String(err)}`);
  }
}

function toHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

// Above this size, reading the whole file into memory to hash it risks
// running out of memory (the native read and the digest each hold their own
// copy on the Java heap), so fall back to chunked reads + an incremental JS
// hash.
const CHUNKED_HASH_THRESHOLD = 24 * 1024 * 1024;
const HASH_CHUNK_SIZE = 16 * 1024 * 1024;

export async function sha256OfFile(uri: string, size?: number): Promise<string> {
  if (size !== undefined && size > CHUNKED_HASH_THRESHOLD) {
    // Sequential reads through a file handle: its offset is 64-bit on both
    // platforms. (The legacy readAsStringAsync `position` is a 32-bit Int on
    // Android, so every chunk past 2 GiB re-read the same bytes and a long
    // 4K video could never hash correctly.)
    const hash = sha256.create();
    // Read-only: the default (read-write on Android) needs write access a
    // camera-roll original doesn't grant.
    const handle = new File(uri).open(FileMode.ReadOnly);
    try {
      let read = 0;
      while (read < size) {
        const chunk = handle.readBytes(Math.min(HASH_CHUNK_SIZE, size - read));
        if (chunk.length === 0) throw new StaleFileError('File ended before its expected size');
        hash.update(chunk);
        read += chunk.length;
        // readBytes is synchronous; let the event loop breathe between chunks.
        await yieldToUI();
      }
    } finally {
      handle.close();
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

// Rewriting the whole cache after every hash is O(n²) over a first backup of
// a big library (and blocks JS on JSON.stringify each time), so saves are
// debounced. Losing the last few entries to a crash only costs a rehash.
const SHA_CACHE_SAVE_MS = 10_000;
let shaCacheTimer: ReturnType<typeof setTimeout> | null = null;
let shaCacheDirty = false;

function scheduleShaCacheSave(): void {
  if (shaCacheTimer) return;
  shaCacheTimer = setTimeout(() => {
    shaCacheTimer = null;
    flushShaCache();
  }, SHA_CACHE_SAVE_MS);
}

// Write pending cache entries now; the queue calls this when a drain ends.
export async function flushShaCache(): Promise<void> {
  if (shaCacheTimer) {
    clearTimeout(shaCacheTimer);
    shaCacheTimer = null;
  }
  if (!shaCache || !shaCacheDirty) return;
  shaCacheDirty = false;
  try {
    await LegacyFileSystem.writeAsStringAsync(SHA_CACHE_URI, JSON.stringify(shaCache));
  } catch {
    // cache is an optimization only
  }
}

export async function forgetCachedSha256(cacheKey: string | null): Promise<void> {
  if (!cacheKey) return;
  const cache = await loadShaCache();
  delete cache[cacheKey];
  delete cache[`${cacheKey}:v2`];
  shaCacheDirty = true;
  scheduleShaCacheSave();
}

// cacheKey must change whenever the file content could have changed
// (assetId:mtime:size). Pass null when no stable identity exists (e.g. picker
// results without an assetId) to hash unconditionally.
export async function cachedSha256OfFile(
  cacheKey: string | null,
  uri: string,
  size?: number
): Promise<string> {
  // Hashes of files over 2 GiB cached by older builds are wrong on Android
  // (see sha256OfFile); key those under a new version so they're redone.
  const key = cacheKey && size !== undefined && size >= 2 ** 31 ? `${cacheKey}:v2` : cacheKey;
  const cache = key ? await loadShaCache() : null;
  if (cache && key && cache[key]) return cache[key];
  const sha = await sha256OfFile(uri, size);
  if (cache && key) {
    cache[key] = sha;
    shaCacheDirty = true;
    scheduleShaCacheSave();
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
  log('manifest', `sent ${files.length}, server wants ${needed.length}`);
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
  onPhase?: (phase: 'hashing' | 'uploading') => void,
  onProgress?: (bytesSent: number, bytesTotal: number) => void,
  // Runs right before the bytes go out; throw to stop. Hashing a big video
  // can take minutes, and the network rules must hold at the moment the
  // transfer starts, not just when the file was picked up.
  beforeUpload?: () => Promise<void>
): Promise<'uploaded' | 'deduped'> {
  // Log the start of each phase, not just the outcome — a process death
  // mid-transfer otherwise leaves no trace of which file (or phase) it died in.
  onPhase?.('hashing');
  log('upload', `hashing ${file.path} (${file.size} bytes)`);
  const sha = await cachedSha256OfFile(file.cacheKey, file.localUri, file.size);

  const toUpload = await postJson<{ path: string }[]>(session, '/files/hashes', [
    { path: file.path, mtime: mtimeParam(file.mtime), size: file.size, sha256: sha },
  ]);
  if (toUpload.length === 0) {
    log('upload', `deduped ${file.path} (${file.size} bytes)`);
    return 'deduped';
  }

  await beforeUpload?.();
  onPhase?.('uploading');
  log('upload', `uploading ${file.path}`);
  const task = LegacyFileSystem.createUploadTask(
    `${session.baseUrl}/files/upload`,
    file.localUri,
    {
      httpMethod: 'PUT',
      uploadType: LegacyFileSystem.FileSystemUploadType.BINARY_CONTENT,
      // In-process session on iOS. A background NSURLSession would keep a
      // transfer going after the app is suspended, but it can't read
      // Photos-library originals (it runs in a system daemon outside the
      // sandbox), never fails while the connection or server is down (the
      // drain would hang with no way to stop it), and retries over cellular
      // regardless of the Wi-Fi-only setting. A transfer cut off by
      // suspension is retried automatically instead (see the queue).
      sessionType: LegacyFileSystem.FileSystemSessionType.FOREGROUND,
      headers: {
        ...authHeaders(session),
        'X-Path': file.path,
        'X-MTime': mtimeParam(file.mtime),
        'X-SHA256': sha,
        'X-Size': String(file.size),
        // Explicit, or iOS's CFNetwork defaults a bodied request to
        // application/x-www-form-urlencoded, and Rack would try to parse the
        // media bytes as form data (failing with a 400) before the action
        // runs. Rails has no parser for octet-stream, so the body reaches
        // request.body untouched.
        'Content-Type': 'application/octet-stream',
      },
    },
    onProgress
      ? (data) => onProgress(data.totalBytesSent, data.totalBytesExpectedToSend)
      : undefined
  );
  let result: Awaited<ReturnType<typeof task.uploadAsync>>;
  try {
    result = await task.uploadAsync();
  } catch (err) {
    // Connection dropped, timed out, or the OS cancelled the transfer.
    throw new UploadInterrupted(`Upload interrupted: ${String(err)}`);
  }
  if (!result) {
    throw new UploadInterrupted('Upload did not complete');
  }
  if (result.status < 200 || result.status >= 300) {
    log('upload', `PUT ${file.path} failed (${result.status}): ${(result.body || '').slice(0, 500)}`);
    if (result.status >= 500) throw new ServerError(result.body || `Upload failed (${result.status})`);
    if (result.status === 400 && /Size mismatch|SHA256 mismatch/.test(result.body || '')) {
      await forgetCachedSha256(file.cacheKey);
      throw new StaleFileError(result.body);
    }
    throw new Error(result.body || `Upload failed (${result.status})`);
  }
  log('upload', `uploaded ${file.path} (${file.size} bytes)`);
  return 'uploaded';
}
