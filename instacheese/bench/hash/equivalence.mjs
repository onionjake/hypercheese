// Equivalence test: the shipped sha256OfReader (src/lib/hash-file.ts, with
// the app's js-sha256) must produce exactly node:crypto's SHA-256 for every
// size, read size, slice size and reader behaviour, and keep the
// StaleFileError / background-yield contracts.
//
//   node bench/hash/equivalence.mjs              # includes a > 4 GiB file (~2 min)
//   node bench/hash/equivalence.mjs --skip-big   # everything else (~30 s)
import { createHash } from 'node:crypto';
import { MiB, PATTERN, SyntheticFile, buildShipped, fillFrom, loadShipped, referenceHex } from './common.mjs';

buildShipped();
const { sha256OfReader, DEFAULT_HASH_SLICING } = await loadShipped();
const skipBig = process.argv.includes('--skip-big');

let passed = 0;
const failures = [];
function check(name, actual, expected) {
  if (actual === expected) passed++;
  else failures.push(`${name}: got ${actual}, want ${expected}`);
}

// Seeded PRNG for reproducible "random" sizes and reader behaviour.
let seed = 12345;
const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const randInt = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));

const fgYield = () => new Promise((r) => setImmediate(r));
const ended = () => new Error('ended early');

// A reader over the synthetic content that also checks the loop never asks
// for more than readSize per call or anything past `size` in total.
function reader(size, { readSize = DEFAULT_HASH_SLICING.readSize, short = false, extra = 0, available = size } = {}) {
  const file = new SyntheticFile(available);
  const fn = (length) => {
    if (length > readSize) throw new Error(`asked for ${length} > readSize ${readSize}`);
    if (file.offset + length > size) throw new Error(`asked past size: ${file.offset} + ${length} > ${size}`);
    let n = short && length > 1 ? randInt(1, length) : length;
    const got = file.readBytes(n);
    if (extra && got.length && file.offset === size) {
      // Hand back more than asked on the final read (no real reader does;
      // the loop must still stop at `size`).
      const more = new Uint8Array(got.length + extra);
      more.set(got);
      return more;
    }
    return got;
  };
  return fn;
}

const refCache = new Map();
const ref = (size) => {
  if (!refCache.has(size)) refCache.set(size, referenceHex(size));
  return refCache.get(size);
};

async function hashSize(size, slicing, opts = {}) {
  return sha256OfReader(reader(size, { readSize: slicing?.readSize, ...opts }), size, fgYield, ended, {
    ...(slicing ? { slicing } : {}),
  });
}

// 1. Every size 0..300 (covers 55/56/63/64/65 and the 119/120/128 padding
//    edges), with default and pathological slicings.
const SLICINGS = [
  undefined, // DEFAULT_HASH_SLICING
  { readSize: 1, sliceSize: 1, budgetMs: 0 },
  { readSize: 64, sliceSize: 7, budgetMs: 0 },
  { readSize: 65, sliceSize: 64, budgetMs: 1 },
  { readSize: 1000, sliceSize: 333, budgetMs: 0 },
  { readSize: 4096, sliceSize: 63, budgetMs: 0 },
];
for (let size = 0; size <= 300; size++) {
  for (const s of SLICINGS) check(`size ${size} slicing ${JSON.stringify(s)}`, await hashSize(size, s), ref(size));
}

// 2. Read/slice/threshold boundaries ±1.
const boundaries = [];
for (const k of [16 * 1024, 32 * 1024, 64 * 1024, MiB, 2 * MiB, 16 * MiB, 24 * MiB]) boundaries.push(k - 1, k, k + 1);
boundaries.push(DEFAULT_HASH_SLICING.readSize * 3 + DEFAULT_HASH_SLICING.sliceSize - 1);
for (const size of boundaries) {
  check(`boundary ${size}`, await hashSize(size), ref(size));
  check(`boundary ${size} read 64K+1 slice 1000`, await hashSize(size, { readSize: 65537, sliceSize: 1000, budgetMs: 0 }), ref(size));
}

// 3. Random sizes up to 40 MiB, default slicing and random slicings.
for (let i = 0; i < 40; i++) {
  const size = i < 20 ? randInt(0, 70_000) : randInt(0, 40 * MiB);
  check(`random ${size}`, await hashSize(size), ref(size));
  const s = { readSize: randInt(1, 3 * MiB), sliceSize: randInt(1, 200_000), budgetMs: randInt(0, 30) };
  check(`random ${size} ${JSON.stringify(s)}`, await hashSize(size, size > 2 * MiB ? { ...s, readSize: Math.max(s.readSize, 4096), sliceSize: Math.max(s.sliceSize, 512) } : s), ref(size));
}

// 4. Readers that return fewer bytes than asked (short reads) or more, and
//    files longer than the recorded size.
for (let i = 0; i < 20; i++) {
  const size = randInt(0, 5 * MiB);
  check(`short reads ${size}`, await hashSize(size, undefined, { short: true }), ref(size));
  check(`over-long final read ${size}`, await hashSize(size, undefined, { extra: randInt(1, 999) }), ref(size));
  // The file grew past the recorded size: hash exactly `size` bytes, as before.
  check(`file longer than size ${size}`, await hashSize(size, undefined, { available: size + randInt(1, 3 * MiB) }), ref(size));
}

// 5. File shorter than `size`: endedEarly()'s error (StaleFileError in the
//    app) is what comes out, and nothing past the file is hashed.
for (const [size, available] of [[100, 0], [100, 99], [30 * MiB, 30 * MiB - 1], [30 * MiB, 7 * MiB]]) {
  const sentinel = new Error('sentinel');
  try {
    await sha256OfReader(reader(size, { available }), size, fgYield, () => sentinel);
    failures.push(`early end ${available}/${size}: no error`);
  } catch (err) {
    check(`early end ${available}/${size} throws endedEarly()`, err, sentinel);
  }
}

// 6. Background: yieldNow resolves at once (yieldToUI outside the
//    foreground). With a clock that forces a yield after every slice, the
//    hash must still finish without ever needing a macrotask (timer).
{
  const size = 3 * MiB + 17;
  let macrotaskRan = false;
  setImmediate(() => (macrotaskRan = true));
  let t = 0;
  let yields = 0;
  const hex = await sha256OfReader(
    reader(size),
    size,
    () => {
      yields++;
      return Promise.resolve();
    },
    ended,
    { now: () => (t += 1000) }
  );
  check('background: correct hash', hex, ref(size));
  check('background: yielded on every slice', yields >= size / DEFAULT_HASH_SLICING.sliceSize - 1, true);
  check('background: finished without any macrotask', macrotaskRan, false);
}

// 7. > 4 GiB through the real loop: past js-sha256's 32-bit byte counter
//    (it carries into hBytes) and past 2 GiB offsets. No disk, ~1 MiB RAM
//    for the pattern plus one 1 MiB read at a time.
if (!skipBig) {
  const size = 2 ** 32 + MiB + 13;
  const t0 = Date.now();
  const expected = referenceHex(size);
  const actual = await sha256OfReader(reader(size), size, fgYield, ended);
  check(`> 4 GiB (${size} bytes)`, actual, expected);
  console.log(`  > 4 GiB case: ${((Date.now() - t0) / 1000).toFixed(0)} s, sha256 ${actual}`);
}

// Sanity: the synthetic content really is what node:crypto hashed.
{
  const buf = new Uint8Array(PATTERN.length * 2 + 5);
  fillFrom(buf, 0);
  check('pattern self-check', createHash('sha256').update(buf).digest('hex'), referenceHex(buf.length));
}

console.log(`${passed} checks passed, ${failures.length} failed`);
for (const f of failures.slice(0, 20)) console.log('  FAIL', f);
process.exit(failures.length ? 1 : 0);
