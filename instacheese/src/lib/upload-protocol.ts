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

// The server stores mtime as an opaque string of seconds-since-epoch and, on
// the next manifest, compares it byte-for-byte against what we send. So every
// request touching a given file (manifest, hashes, upload) must send the exact
// same representation, in seconds. Match the web uploader: `lastModified / 1000`
// rendered with String(). Callers hold mtime in milliseconds.
export function mtimeParam(mtimeMs: number): string {
  return String(mtimeMs / 1000);
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
