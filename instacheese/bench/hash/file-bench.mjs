// One benchmark case in this process: hash a synthetic file of `size` bytes
// with `variant`, `runs` times, and print one JSON line of results.
//   node [--jitless] --expose-gc file-bench.mjs '{"variant":"after","lib":"@noble/hashes","size":104857600,"runs":3}'
//
// Variants:
//   before — a faithful copy of the pre-fix sha256OfFile loop
//            (16 MiB readBytes, one update per chunk, yield after each chunk).
//   after  — the shipped sha256OfReader from src/lib/hash-file.ts, with `lib`
//            injected as the hasher (the app uses js-sha256).
import { performance } from 'node:perf_hooks';
import { SyntheticFile, hashers, loadShipped, referenceHex, median, MiB } from './common.mjs';

const cfg = JSON.parse(process.argv[2]);
const libs = await hashers();
const createHashFn = libs[cfg.lib];
if (!createHashFn) throw new Error(`unknown lib ${cfg.lib}`);
const { sha256OfReader, DEFAULT_HASH_SLICING } = await loadShipped();

const HASH_CHUNK_SIZE = 16 * MiB; // the old constant

// Pre-fix loop, verbatim apart from the injected reader/hasher/yield.
async function beforeLoop(handle, size, yieldToUI, createHash) {
  const hash = createHash();
  let read = 0;
  while (read < size) {
    const chunk = handle.readBytes(Math.min(HASH_CHUNK_SIZE, size - read));
    if (chunk.length === 0) throw new Error('File ended before its expected size');
    hash.update(chunk);
    read += chunk.length;
    await yieldToUI();
  }
  return hash.hex();
}

function instrumentedYield() {
  // A "block" is the time the JS thread runs without yielding: from the
  // previous resume (or the start) to the next yield (or the end).
  const stats = { blocks: [], peakArrayBuffers: 0, last: 0 };
  const sample = () => {
    const ab = process.memoryUsage().arrayBuffers;
    if (ab > stats.peakArrayBuffers) stats.peakArrayBuffers = ab;
  };
  const yieldNow = async () => {
    stats.blocks.push(performance.now() - stats.last);
    sample();
    await new Promise((r) => setImmediate(r));
    stats.last = performance.now();
  };
  return { stats, yieldNow, sample };
}

const expected = referenceHex(cfg.size);
const runs = [];
for (let r = 0; r < cfg.runs; r++) {
  globalThis.gc?.();
  const file = new SyntheticFile(cfg.size);
  const { stats, yieldNow, sample } = instrumentedYield();
  const t0 = performance.now();
  stats.last = t0;
  const hex =
    cfg.variant === 'before'
      ? await beforeLoop(file, cfg.size, yieldNow, createHashFn)
      : await sha256OfReader((n) => file.readBytes(n), cfg.size, yieldNow, () => new Error('ended early'), {
          now: () => performance.now(),
          slicing: { ...DEFAULT_HASH_SLICING, ...(cfg.slicing ?? {}) },
          createHash: createHashFn,
        });
  const t1 = performance.now();
  stats.blocks.push(t1 - stats.last);
  sample();
  if (hex !== expected) throw new Error(`WRONG HASH ${cfg.variant}/${cfg.lib}: ${hex} != ${expected}`);
  const sorted = [...stats.blocks].sort((a, b) => a - b);
  runs.push({
    seconds: (t1 - t0) / 1000,
    mbPerSec: cfg.size / MiB / ((t1 - t0) / 1000),
    maxBlockMs: sorted[sorted.length - 1],
    p95BlockMs: sorted[Math.floor(sorted.length * 0.95)],
    yields: stats.blocks.length - 1,
    allocations: file.allocations,
    maxAllocationBytes: file.maxAllocation,
    peakArrayBuffersMiB: stats.peakArrayBuffers / MiB,
  });
}

const pick = (k) => median(runs.map((r) => r[k]));
console.log(
  JSON.stringify({
    ...cfg,
    jitless: process.execArgv.includes('--jitless'),
    median: {
      mbPerSec: pick('mbPerSec'),
      seconds: pick('seconds'),
      maxBlockMs: pick('maxBlockMs'),
      p95BlockMs: pick('p95BlockMs'),
      yields: pick('yields'),
      allocations: pick('allocations'),
      maxAllocationBytes: pick('maxAllocationBytes'),
      peakArrayBuffersMiB: pick('peakArrayBuffersMiB'),
    },
    runs,
  })
);
