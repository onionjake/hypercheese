// Correctness checks for the library-db.ts changes (exit code 1 on failure):
//  1. Fuzzed equivalence: baseline vs current libraryCounts and full keyset
//     pagination of every filter, over catalogs with every mark combination
//     (incl. selected+excluded, unsupported+selected, missing rows, bursts).
//  2. Migration: a catalog created by the baseline code (old indexes), and
//     one predating the excluded/failed_at/failures/missing_since columns,
//     opened by the current code — new indexes built, old one dropped, data
//     and counts intact. Times the one-off index build at 60k rows.
//
//   node bench/tap/check.mjs
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { loadLibraryDb, makeCatalog, mediaAssets, mediaLibraryMock, openCatalog, rng } from './lib/catalog.mjs';
import { createSqliteShim } from './lib/sqlite-shim.mjs';

process.removeAllListeners('warning');
let failures = 0;
const check = (ok, msg) => {
  if (!ok) failures++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
};

async function pageAll(lib, filter, limit) {
  const out = [];
  let after;
  for (;;) {
    const page = await lib.listAssets(filter, limit, after);
    out.push(...page.map((a) => a.id));
    if (page.length < limit) return out;
    after = page[page.length - 1];
  }
}

// 1. fuzz
for (let seed = 1; seed <= 6; seed++) {
  const r = rng(seed * 101);
  const rows = makeCatalog(1500 + seed * 300, seed);
  for (const row of rows) {
    // Scramble marks into every combination, including odd ones.
    row.status = ['none', 'pending', 'synced', 'failed'][Math.floor(r() * 4)];
    row.excluded = r() < 0.2 ? 1 : 0;
    row.selected = r() < 0.15 ? 1 : 0;
    row.supported = r() < 0.1 ? 0 : 1;
    row.missing_since = r() < 0.05 ? 1 : null;
    if (r() < 0.1) row.creation_time = rows[0].creation_time; // many ties
  }
  const a = await openCatalog('baseline', rows);
  const b = await openCatalog('current', rows);
  const ca = await a.lib.libraryCounts();
  const cb = await b.lib.libraryCounts();
  check(JSON.stringify(ca) === JSON.stringify(cb), `seed ${seed}: libraryCounts equal ${JSON.stringify(cb)}`);
  for (const f of ['unmarked', 'all', 'selected', 'synced', 'failed', 'excluded']) {
    for (const limit of [7, 60]) {
      const pa = await pageAll(a.lib, f, limit);
      const pb = await pageAll(b.lib, f, limit);
      check(JSON.stringify(pa) === JSON.stringify(pb) && new Set(pb).size === pb.length,
        `seed ${seed}: listAssets(${f}, ${limit}) paged identically (${pb.length} rows)`);
    }
  }
  const ea = await a.lib.excludedAssetIds();
  const eb = await b.lib.excludedAssetIds();
  check([...ea].sort().join() === [...eb].sort().join(), `seed ${seed}: excludedAssetIds equal (${eb.size})`);
  for (const opts of [{}, { includeSynced: true }, { failedRetryAfterMs: 3600_000 }]) {
    const ma = (await a.lib.markedForSync(opts)).map((x) => x.id).join();
    const mb = (await b.lib.markedForSync(opts)).map((x) => x.id).join();
    check(ma === mb, `seed ${seed}: markedForSync(${JSON.stringify(opts)}) equal`);
  }
  // Empty catalog.
  a.close();
  b.close();
}
{
  const e = await openCatalog('current', []);
  const c = await e.lib.libraryCounts();
  check(Object.values(c).every((v) => v === 0), 'empty catalog: all counts 0');
  e.close();
}

// 2. migrations
function indexes(raw) {
  return raw
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'assets' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((x) => x.name);
}
{
  const rows = makeCatalog(60000);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'instacheese-migrate-'));
  const old = await openCatalog('baseline', rows, { dir });
  const before = await old.lib.libraryCounts();
  check(indexes(old.raw).includes('idx_assets_status'), `baseline catalog has ${indexes(old.raw).join(', ')}`);
  old.raw.close();
  const shim = createSqliteShim();
  shim.nextPath = path.join(dir, 'library.db');
  shim.capture = [];
  const lib = loadLibraryDb('current', shim, mediaLibraryMock(mediaAssets(rows)));
  const t0 = performance.now();
  const after = await lib.libraryCounts();
  const openMs = performance.now() - t0;
  const idx = indexes(shim.raw);
  check(
    idx.join() === 'idx_assets_creation,idx_assets_excluded,idx_assets_marks,idx_assets_selected,idx_assets_status_creation',
    `upgraded 60k catalog indexes: ${idx.join(', ')} (first open incl. index build ${openMs.toFixed(0)} ms on this machine)`
  );
  check(JSON.stringify(before) === JSON.stringify(after), 'upgraded catalog: counts unchanged');
  shim.raw.close();
  // Reopen: no-op migration.
  const shim2 = createSqliteShim();
  shim2.nextPath = path.join(dir, 'library.db');
  const lib2 = loadLibraryDb('current', shim2, mediaLibraryMock([]));
  const t1 = performance.now();
  await lib2.libraryCounts();
  check(true, `second open of the upgraded catalog: ${(performance.now() - t1).toFixed(1)} ms`);
  shim2.raw.close();
  rmSync(dir, { recursive: true, force: true });
}
{
  // A catalog from before "won't upload" (no excluded / failed_at / failures /
  // missing_since columns), as an early build left it.
  const dir = mkdtempSync(path.join(os.tmpdir(), 'instacheese-migrate-'));
  const file = path.join(dir, 'library.db');
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TABLE assets (id TEXT PRIMARY KEY NOT NULL, filename TEXT NOT NULL, media_type TEXT NOT NULL,
      uri TEXT NOT NULL, mtime INTEGER NOT NULL, size INTEGER, supported INTEGER NOT NULL DEFAULT 1,
      selected INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'none', error TEXT,
      creation_time INTEGER NOT NULL DEFAULT 0, last_seen INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX idx_assets_creation ON assets (creation_time DESC);
    CREATE INDEX idx_assets_selected ON assets (selected);
    CREATE INDEX idx_assets_status ON assets (status);
    INSERT INTO assets (id, filename, media_type, uri, mtime, status, selected, creation_time)
      VALUES ('1', 'a.jpg', 'photo', 'u1', 1, 'none', 1, 3), ('2', 'b.jpg', 'photo', 'u2', 1, 'synced', 0, 2),
             ('3', 'c.jpg', 'photo', 'u3', 1, 'pending', 0, 1);
  `);
  raw.close();
  const shim = createSqliteShim();
  shim.nextPath = file;
  const lib = loadLibraryDb('current', shim, mediaLibraryMock([]));
  const c = await lib.libraryCounts();
  check(
    c.total === 3 && c.unmarked === 1 && c.synced === 1 && c.pending === 1 && c.selected === 1 && c.backupReady === 2,
    `pre-"won't upload" catalog migrates: ${JSON.stringify(c)}; indexes ${indexes(shim.raw).join(', ')}`
  );
  shim.raw.close();
  rmSync(dir, { recursive: true, force: true });
}

console.log(failures ? `\n${failures} check(s) FAILED` : '\nall checks passed');
process.exit(failures ? 1 : 0);
