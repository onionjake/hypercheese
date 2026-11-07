import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

// Time-sliced SHA-256 of a big file read through a synchronous reader.
// Kept free of Expo/React Native imports so bench/hash/ can run this exact
// code under Node and check it against node:crypto (the server compares the
// SHA-256 we send: a wrong hash fails every big upload).
//
// expo-file-system's FileHandle.readBytes is a synchronous JSI call on the JS
// thread that allocates a fresh buffer per call (there is no read-into-buffer
// API), and the hash itself is pure JS (Hermes has no JIT). The old loop read
// and hashed 16 MB at a time between yields, freezing the JS thread for
// seconds per chunk on a phone. Now each uninterrupted stretch is short:
// modest reads, hashed in small slices, yielding once the stretch has run for
// budgetMs. The budget is measured on the device, so a slower phone simply
// yields more often; the longest stretch is about budgetMs + one slice + one
// read. See bench/hash/RESULTS.md.

export interface IncrementalHash {
  update(data: Uint8Array): unknown;
  digest(): Uint8Array;
}

export interface HashSlicing {
  // Bytes per readBytes call; also the size of each fresh allocation.
  readSize: number;
  // Bytes hashed between clock checks.
  sliceSize: number;
  // Work this long (ms) before yielding.
  budgetMs: number;
}

// On a phone, Hermes hashes on the order of 5–10 MB/s with @noble/hashes
// (bench/hash), so a 32 KiB slice is a few ms and a 1 MiB read a few ms of
// copying: the longest stretch stays well under 50 ms.
export const DEFAULT_HASH_SLICING: HashSlicing = {
  readSize: 1024 * 1024,
  sliceSize: 32 * 1024,
  budgetMs: 25,
};

export interface Sha256OfReaderOptions {
  now?: () => number;
  slicing?: HashSlicing;
  // Benchmarks swap in other libraries; the app always uses the default.
  createHash?: () => IncrementalHash;
}

export async function sha256OfReader(
  // Synchronously returns up to `length` bytes, or none at end of file.
  readBytes: (length: number) => Uint8Array,
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
  const hash = (options.createHash ?? (() => sha256.create()))();
  let read = 0;
  let stretchStart = now();
  while (read < size) {
    const chunk = readBytes(Math.min(readSize, size - read));
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
  return bytesToHex(hash.digest());
}
