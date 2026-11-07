// Raw library throughput, in memory (no reads, no yields): hash `size` bytes
// fed in 32 KiB updates, `runs` times; print one JSON line with medians.
//   node [--jitless] throughput.mjs '{"lib":"js-sha256","size":33554432,"runs":5}'
// Also times one-shot hashes of a 24 MiB buffer for the ≤24 MB path (which
// on the phone is a synchronous native expo-crypto digest) when lib is
// node:crypto.
import { performance } from 'node:perf_hooks';
import { hashers, fillFrom, median, MiB } from './common.mjs';
import { createHash } from 'node:crypto';

const cfg = JSON.parse(process.argv[2]);
const make = (await hashers())[cfg.lib];
const data = new Uint8Array(cfg.size);
fillFrom(data, 0);
const expected = createHash('sha256').update(data).digest('hex');
const SLICE = 32 * 1024;

const rates = [];
for (let r = 0; r < cfg.runs; r++) {
  const t0 = performance.now();
  const h = make();
  for (let pos = 0; pos < data.length; pos += SLICE) h.update(data.subarray(pos, pos + SLICE));
  const hex = h.hex();
  const ms = performance.now() - t0;
  if (hex !== expected) throw new Error(`WRONG HASH from ${cfg.lib}`);
  rates.push(cfg.size / MiB / (ms / 1000));
}

const result = { ...cfg, jitless: process.execArgv.includes('--jitless'), mbPerSec: median(rates), rates };
if (cfg.lib === 'node:crypto') {
  // The ≤24 MB path: File.bytes() (fresh 24 MiB buffer) + one native digest,
  // both on the JS thread on Android.
  const times = [];
  for (let r = 0; r < cfg.runs; r++) {
    const t0 = performance.now();
    const buf = new Uint8Array(24 * MiB);
    fillFrom(buf, 0);
    createHash('sha256').update(buf).digest();
    times.push(performance.now() - t0);
  }
  result.oneShot24MiBMs = median(times);
}
console.log(JSON.stringify(result));
