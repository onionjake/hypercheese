// SQL side of a Backup-tab tap: runs library-db.ts's real queries (loaded
// from the working tree or the baseline commit) against synthetic catalogs in
// node:sqlite and reports per-operation median/p90 ms plus EXPLAIN QUERY PLAN.
//
//   node bench/tap/sql-bench.mjs --impl=baseline|current [--sizes=5000,20000,60000] [--iters=25]
//
// Writes bench/tap/out/sql-<impl>.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { digest, makeCatalog, openCatalog } from './lib/catalog.mjs';
import { APP_DIR, median, parseArgs, pct } from './lib/load-ts.mjs';

process.removeAllListeners('warning'); // node:sqlite ExperimentalWarning

const args = parseArgs(process.argv.slice(2));
const impl = args.impl ?? 'current';
const sizes = String(args.sizes ?? '5000,20000,60000').split(',').map(Number);
const ITERS = Number(args.iters ?? 25);
const WARMUP = 3;

async function bench(ctx, name, fn, { iters = ITERS, setup, teardown } = {}) {
  const times = [];
  let out;
  for (let i = 0; i < WARMUP + iters; i++) {
    if (setup) await setup(i);
    const t0 = performance.now();
    out = await fn(i);
    const ms = performance.now() - t0;
    if (teardown) await teardown(i);
    if (i >= WARMUP) times.push(ms);
  }
  // One more run with statement capture, for the query plans.
  ctx.shim.capture = [];
  if (setup) await setup(0);
  await fn(0);
  if (teardown) await teardown(0);
  const statements = ctx.shim.capture;
  ctx.shim.capture = null;
  const plans = [];
  for (const s of statements) {
    if (/^\s*(BEGIN|COMMIT|ROLLBACK|PRAGMA)/i.test(s.sql)) continue;
    try {
      const rows = ctx.raw.prepare(`EXPLAIN QUERY PLAN ${s.sql}`).all(...s.params);
      plans.push({ sql: s.sql.replace(/\s+/g, ' ').trim().slice(0, 160), plan: rows.map((r) => r.detail) });
    } catch (e) {
      plans.push({ sql: s.sql.replace(/\s+/g, ' ').trim().slice(0, 160), plan: [`(explain failed: ${e.message})`] });
    }
  }
  const result = {
    name,
    median: median(times),
    p90: pct(times, 90),
    iters,
    digest: out === undefined ? null : digest(out),
    plans,
  };
  ctx.results.push(result);
  console.log(
    `  ${name.padEnd(34)} median ${result.median.toFixed(3).padStart(8)} ms   p90 ${result.p90.toFixed(3).padStart(8)} ms`
  );
  return result;
}

async function runSize(n) {
  const rows = makeCatalog(n);
  const ctx = await openCatalog(impl, rows);
  ctx.results = [];
  const { lib, raw } = ctx;
  const unmarked = rows.filter(
    (r) => r.supported && !r.excluded && r.status === 'none' && r.missing_since === null && !r.selected
  );
  const pending = rows.filter((r) => r.status === 'pending' && r.supported && !r.excluded);
  const indexes = raw
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'assets' ORDER BY name")
    .all()
    .map((r) => r.name);
  console.log(`\n[${impl}] catalog ${n} rows (unmarked ${unmarked.length}, pending ${pending.length}); indexes: ${indexes.join(', ')}`);

  const counts = await lib.libraryCounts();
  const pick = (pool, i) => pool[(i * 7919) % pool.length];
  const restoreRow = (r) =>
    raw
      .prepare('UPDATE assets SET selected = ?, excluded = ?, status = ?, error = ?, failures = ? WHERE id = ?')
      .run(r.selected, r.excluded, r.status, r.error, r.failures, r.id);

  // --- the per-tap path (library.tsx toggle / markWontUpload / markForUploadNow)
  await bench(ctx, 'libraryCounts', () => lib.libraryCounts());
  await bench(ctx, 'tap: setSelected (1 id)', (i) =>
    lib.setSelected([pick(unmarked, i >> 1).id], i % 2 === 0)
  , { teardown: (i) => { if (i % 2 === 0) restoreRow(pick(unmarked, i >> 1)); } });
  await bench(ctx, 'tap: toggle = setSelected+counts', async (i) => {
    await lib.setSelected([pick(unmarked, i >> 1).id], i % 2 === 0);
    return lib.libraryCounts();
  }, { teardown: (i) => { if (i % 2 === 0) restoreRow(pick(unmarked, i >> 1)); } });
  await bench(ctx, "tap: setExcluded (won't upload)", (i) => lib.setExcluded([pick(unmarked, i).id], true), {
    teardown: (i) => restoreRow(pick(unmarked, i)),
  });
  await bench(ctx, 'tap: markForUpload (1 id)', (i) => lib.markForUpload([pick(unmarked, i).id]), {
    teardown: (i) => restoreRow(pick(unmarked, i)),
  });
  await bench(ctx, 'excludeSelected (40 checked)', () => lib.excludeSelected(), {
    iters: Math.min(ITERS, 10),
    teardown: () => {
      for (const r of rows) if (r.selected) restoreRow(r);
    },
  });
  // --- the upload queue's side, running concurrently with the taps
  await bench(ctx, 'settle: markStatus synced', (i) => {
    const r = pick(pending, i);
    return lib.markStatus(r.id, 'synced', null, r.mtime);
  }, { teardown: (i) => restoreRow(pick(pending, i)) });
  await bench(ctx, 'excludedAssetIds (per drain batch)', () => lib.excludedAssetIds());
  await bench(ctx, 'isExcluded', (i) => lib.isExcluded(pick(rows, i).id));
  await bench(ctx, 'markedForSync()', () => lib.markedForSync());
  await bench(ctx, 'markedForSync(auto retry)', () => lib.markedForSync({ failedRetryAfterMs: 3600_000 }));
  await bench(ctx, 'markedForSync(includeSynced)', () => lib.markedForSync({ includeSynced: true }), {
    iters: Math.min(ITERS, 10),
  });
  // --- the grid
  for (const f of ['unmarked', 'all', 'selected', 'synced', 'failed', 'excluded']) {
    await bench(ctx, `listAssets(${f}) page 1`, () => lib.listAssets(f, 60));
  }
  for (const f of ['unmarked', 'all', 'excluded']) {
    // A cursor ~80% of the way down the catalog (deep scroll).
    const deep = rows[Math.floor(rows.length * 0.8)];
    await bench(ctx, `listAssets(${f}) deep page`, () =>
      lib.listAssets(f, 60, { creationTime: deep.creation_time, id: deep.id })
    );
  }

  // --- a full rescan of an unchanged library (runScan), and taps during it
  const scanTimes = [];
  let maxStmt = 0;
  for (let k = 0; k < 3; k++) {
    ctx.shim.capture = [];
    const t0 = performance.now();
    await lib.refreshFromLibrary({ requestPermission: false });
    scanTimes.push(performance.now() - t0);
    maxStmt = Math.max(maxStmt, ...ctx.shim.capture.filter((s) => !/^\s*(BEGIN)/.test(s.sql)).map((s) => s.ms));
    ctx.shim.capture = null;
  }
  // Taps fired while a scan is running share the one connection: measure how
  // long each tap's DB work takes from request to result.
  const tapLat = [];
  const scan = lib.refreshFromLibrary({ requestPermission: false });
  let running = true;
  scan.finally(() => (running = false));
  let i = 0;
  while (running) {
    const t0 = performance.now();
    await lib.setSelected([pick(unmarked, i >> 1).id], i % 2 === 0);
    await lib.libraryCounts();
    tapLat.push(performance.now() - t0);
    i++;
    await new Promise((r) => setImmediate(r));
  }
  await scan;
  for (const r of rows) if (r.selected) restoreRow(r);
  const scanResult = {
    name: 'runScan (unchanged library)',
    median: median(scanTimes),
    maxStatementMs: maxStmt,
    tapDuringScan: { n: tapLat.length, median: median(tapLat), max: Math.max(...tapLat) },
  };
  console.log(
    `  runScan total median ${scanResult.median.toFixed(1)} ms; longest single statement ${maxStmt.toFixed(2)} ms; ` +
      `${tapLat.length} taps during scan: median ${scanResult.tapDuringScan.median.toFixed(2)} ms, max ${scanResult.tapDuringScan.max.toFixed(2)} ms`
  );

  const out = { n, indexes, counts, results: ctx.results, scan: scanResult };
  ctx.close();
  return out;
}

const all = { impl, sqlite: null, node: process.version, sizes: [] };
{
  const { DatabaseSync } = await import('node:sqlite');
  all.sqlite = new DatabaseSync(':memory:').prepare('select sqlite_version() v').get().v;
}
for (const n of sizes) all.sizes.push(await runSize(n));
const outDir = path.join(APP_DIR, 'bench/tap/out');
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, `sql-${impl}.json`), JSON.stringify(all, null, 2));
console.log(`\nwrote bench/tap/out/sql-${impl}.json`);
