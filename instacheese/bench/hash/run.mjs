// Runs the hashing benchmarks in fresh child processes (V8 and --jitless),
// writes results/<phase>.json and prints Markdown tables.
//
//   node bench/hash/run.mjs                 # everything (~15 min)
//   node bench/hash/run.mjs --phase before  # pre-fix loop only
//   node bench/hash/run.mjs --phase after   # shipped loop, every library
//   node bench/hash/run.mjs --phase libs    # raw library throughput
//   node bench/hash/run.mjs --phase sweep   # budget/slice/read-size trade-off
//   node bench/hash/run.mjs --quick         # small sizes, 1 run: smoke test
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, MiB, buildShipped } from './common.mjs';

const args = process.argv.slice(2);
const phase = args.includes('--phase') ? args[args.indexOf('--phase') + 1] : 'all';
const quick = args.includes('--quick');
const MB100 = 100 * MiB;
const GB1 = 1024 * MiB;

buildShipped();

function child(script, cfg, jitless) {
  const flags = ['--expose-gc', '--max-old-space-size=4096', ...(jitless ? ['--jitless'] : [])];
  const out = execFileSync(process.execPath, [...flags, join(HERE, script), JSON.stringify(cfg)], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    maxBuffer: 64 * MiB,
  });
  const res = JSON.parse(out.trim().split('\n').pop());
  process.stderr.write(`  done ${script} ${JSON.stringify(cfg).slice(0, 90)}${jitless ? ' --jitless' : ''}\n`);
  return res;
}

// Pure-JS libraries compared inside the shipped loop. js-sha256 and
// node-forge come from the app's node_modules; the rest from bench/hash's.
const PURE_JS = ['js-sha256', '@noble/hashes', '@stablelib/sha256', 'fast-sha256', 'node-forge'];
const ALL_LIBS = [
  ...PURE_JS,
  '@aws-crypto/sha256-js',
  'asmcrypto.js',
  'crypto-js',
  'jssha',
  'hash.js',
  'node:crypto',
];
const results = { file: [], libs: [] };

// Case list: [variant, lib, size, runs, jitless, slicing?]
const fileCases = [];
if (phase === 'all' || phase === 'before') {
  if (quick) fileCases.push(['before', 'js-sha256', 40 * MiB, 1, false], ['before', 'js-sha256', 40 * MiB, 1, true]);
  else
    fileCases.push(
      ['before', 'js-sha256', MB100, 5, false],
      ['before', 'js-sha256', GB1, 3, false],
      ['before', 'js-sha256', MB100, 3, true]
    );
}
if (phase === 'all' || phase === 'after') {
  for (const lib of PURE_JS) {
    if (quick) fileCases.push(['after', lib, 40 * MiB, 1, false], ['after', lib, 8 * MiB, 1, true]);
    else
      fileCases.push(['after', lib, MB100, 5, false], ['after', lib, GB1, 3, false], ['after', lib, MB100, 3, true]);
  }
}
if (phase === 'sweep') {
  // js-sha256 under --jitless (the Hermes stand-in), 32 MiB, 3 runs each.
  for (const [readMiB, sliceKiB, budgetMs] of [
    [1, 64, 25], [1, 32, 25], [1, 16, 20], [1, 16, 10], [1, 8, 10], [4, 16, 20], [0.25, 16, 20],
  ]) {
    fileCases.push(['after', 'js-sha256', 32 * MiB, 3, true, { readSize: readMiB * MiB, sliceSize: sliceKiB * 1024, budgetMs }]);
  }
}
for (const [variant, lib, size, runs, jitless, slicing] of fileCases) {
  results.file.push(child('file-bench.mjs', { variant, lib, size, runs, ...(slicing ? { slicing } : {}) }, jitless));
}

if (phase === 'all' || phase === 'libs') {
  for (const lib of ALL_LIBS) {
    for (const jitless of [false, true]) {
      const size = quick ? 4 * MiB : jitless ? 16 * MiB : 64 * MiB;
      results.libs.push(child('throughput.mjs', { lib, size, runs: quick ? 1 : 5 }, jitless));
    }
  }
}

mkdirSync(join(HERE, 'results'), { recursive: true });
const name = `${phase}${quick ? '-quick' : ''}.json`;
writeFileSync(join(HERE, 'results', name), JSON.stringify({ when: new Date().toISOString(), node: process.version, ...results }, null, 2));

const f1 = (x) => x.toFixed(1);
const slicingLabel = (r) =>
  r.variant === 'before'
    ? '16 MiB chunk, yield per chunk'
    : r.slicing
      ? `read ${r.slicing.readSize / MiB} MiB, slice ${r.slicing.sliceSize / 1024} KiB, budget ${r.slicing.budgetMs} ms`
      : 'default';
const engine = (r) => (r.jitless ? 'V8 --jitless' : 'V8 (JIT)');
if (results.file.length) {
  console.log('\n| variant | library | engine | size | slicing | MB/s | longest block ms | p95 block ms | yields | reads (allocations) | bytes per read |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results.file) {
    const m = r.median;
    console.log(
      `| ${r.variant} | ${r.lib} | ${engine(r)} | ${r.size / MiB} MiB | ${slicingLabel(r)} | ${f1(m.mbPerSec)} | ${f1(m.maxBlockMs)} | ${f1(m.p95BlockMs)} | ${m.yields} | ${m.allocations} | ${m.maxAllocationBytes / MiB} MiB |`
    );
  }
}
if (results.libs.length) {
  console.log('\n| library | engine | MB/s (median) | note |');
  console.log('|---|---|---|---|');
  for (const r of results.libs) {
    const note = r.oneShot24MiBMs !== undefined ? `24 MiB one-shot (alloc+copy+digest): ${f1(r.oneShot24MiBMs)} ms` : '';
    console.log(`| ${r.lib} | ${engine(r)} | ${f1(r.mbPerSec)} | ${note} |`);
  }
}
console.log(`\nwrote results/${name}`);
