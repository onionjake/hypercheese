import { sha256 } from 'js-sha256';

// Time-sliced SHA-256 of a big file read in chunks. Kept free of Expo/React
// Native imports so bench/hash/ can run this exact code under Node and check
// it against node:crypto (the server compares the SHA-256 we send: a wrong
// hash fails every big upload).
//
// Since Expo SDK 58 the app hashes files natively with expo-file-system's
// File.digest('SHA-256') (upload-protocol.ts, sha256OfFile); this loop is
// only the fallback for when that is unavailable or fails.
//
// The hash here is pure JS (Hermes has no JIT), so it runs on the JS thread.
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

// The hash is js-sha256. Measured on real Hermes (release APK on an Android
// emulator; bench/hash/RESULTS.md, "Android emulator, Hermes (measured)"):
// js-sha256 4.8 MB/s vs @noble/hashes 2.7 MB/s in memory, and 45.5 s vs
// 68.4 s through this loop for a 128 MiB file. noble's ~3x lead exists only
// under a JIT, which Hermes doesn't have. No maintained pure-JS library beat
// js-sha256 by more than ~15% there.
export const DEFAULT_HASH_SLICING: HashSlicing = {
  readSize: 1024 * 1024,
  sliceSize: 16 * 1024,
  budgetMs: 20,
};

export interface Sha256OfReaderOptions {
  now?: () => number;
  slicing?: HashSlicing;
  // Benchmarks swap in other libraries; the app always uses js-sha256, whose
  // 64-bit byte counter (hBytes) keeps files over 4 GiB correct (bench/hash
  // equivalence covers a 4 GiB+ file).
  createHash?: () => IncrementalHash;
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
  const hash = (options.createHash ?? (() => sha256.create()))();
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
