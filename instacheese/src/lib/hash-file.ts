import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Time-sliced SHA-256 of a big file read in chunks.
// Kept free of Expo/React Native imports so bench/hash/ can run this exact
// code under Node and check it against node:crypto (the server compares the
// SHA-256 we send: a wrong hash fails every big upload).
//
// expo-file-system's FileHandle.readBytes allocates a fresh buffer per call
// (there is no read-into-buffer API); since SDK 58 it is async (the read runs
// off the JS thread; readBytesSync is the old blocking call). The hash itself
// is pure JS (Hermes has no JIT; no native
// streaming SHA-256 is available — expo-crypto only digests a whole buffer).
// The old loop read and hashed 16 MB at a time between yields, freezing the
// JS thread for seconds per chunk on a phone. Now each uninterrupted stretch
// is short: modest reads, hashed in small slices, yielding once the stretch
// has run for budgetMs. The budget is measured on the device, so a slower
// phone simply yields more often; the longest stretch is about budgetMs + one
// slice (+ one read, for a synchronous reader). See bench/hash/RESULTS.md.

export interface IncrementalHash {
  update(data: Uint8Array): unknown;
  hex(): string;
}

export interface HashSlicing {
  // Bytes per readBytes call; also the size of each fresh allocation.
  readSize: number;
  // Bytes hashed between clock checks.
  sliceSize: number;
  // Work this long (ms) before yielding.
  budgetMs: number;
}

// The hash is @noble/hashes (~3x js-sha256 under a JIT; bench/hash). Its
// interpreter speed (node --jitless, a stand-in for Hermes) was lower in the
// bench, but the stretch length is bounded by budgetMs, not by the library:
// a slower hash just yields more often. The upload log records MB/s per file
// so the real Hermes speed shows up in a debug export.
export const DEFAULT_HASH_SLICING: HashSlicing = {
  readSize: 1024 * 1024,
  sliceSize: 16 * 1024,
  budgetMs: 20,
};

export interface Sha256OfReaderOptions {
  now?: () => number;
  slicing?: HashSlicing;
  // Benchmarks swap in other libraries. The app uses @noble/hashes, whose
  // 64-bit length encoding keeps files over 4 GiB correct (bench/hash
  // equivalence covers a 4 GiB+ file).
  createHash?: () => IncrementalHash;
}

function nobleSha256(): IncrementalHash {
  const h = sha256.create();
  return {
    update: (data) => h.update(data),
    hex: () => bytesToHex(h.digest()),
  };
}

export async function sha256OfReader(
  // Returns up to `length` bytes, or none at end of file. The app passes
  // expo-file-system's FileHandle.readBytes, which is async (off the JS
  // thread) since SDK 58; the benchmarks pass a synchronous reader.
  readBytes: (length: number) => Uint8Array | Promise<Uint8Array>,
  // Hash exactly this many bytes. A plain number: exact far past 4 GiB.
  size: number,
  // Lets the event loop run. May resolve at once (in an Android background
  // run, where timers may never fire) — the loop then just keeps going.
  yieldNow: () => Promise<void>,
  // Thrown when the reader runs dry before `size` bytes.
  endedEarly: () => Error,
  options: Sha256OfReaderOptions = {}
): Promise<string> {
  const now = options.now ?? Date.now;
  const { readSize, sliceSize, budgetMs } = options.slicing ?? DEFAULT_HASH_SLICING;
  const hash = (options.createHash ?? nobleSha256)();
  let read = 0;
  let stretchStart = now();
  while (read < size) {
    const chunk = await readBytes(Math.min(readSize, size - read));
    if (chunk.length === 0) throw endedEarly();
    // Never hash past `size`, even if a reader hands back extra bytes.
    const length = Math.min(chunk.length, size - read);
    for (let pos = 0; pos < length; ) {
      const end = Math.min(pos + sliceSize, length);
      hash.update(pos === 0 && end === chunk.length ? chunk : chunk.subarray(pos, end));
      pos = end;
      if (now() - stretchStart >= budgetMs) {
        await yieldNow();
        stretchStart = now();
      }
    }
    read += length;
  }
  return hash.hex();
}
