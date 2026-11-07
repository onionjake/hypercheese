// Synthetic camera-roll catalogs and a loader for library-db.ts against
// node:sqlite. Distributions are ASSUMPTIONS meant to look like a family
// phone a while after InstaCheese was installed (see RESULTS.md).
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadTs } from './load-ts.mjs';
import { createSqliteShim } from './sqlite-shim.mjs';

export function rng(seed) {
  // mulberry32
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const DIST = {
  years: 8, // creation_time spread
  burstDup: 0.02, // share of photos sharing the previous photo's timestamp (burst)
  video: 0.1,
  unsupported: 0.02, // e.g. HEIC/odd formats
  synced: 0.6,
  excluded: 0.075,
  pending: 0.02,
  failed: 0.005, // rest: unmarked ('none')
  selected: 40, // working set of checked photos (absolute count)
  missing: 0.002, // missed by the last scan (missing_since set)
  edited: 0.01, // mtime != creation_time
};

// Rows newest first, as the media library pages them.
export function makeCatalog(n, seed = 42) {
  const r = rng(seed);
  const now = Date.UTC(2026, 10, 1);
  const span = DIST.years * 365 * 86400_000;
  const times = [];
  for (let i = 0; i < n; i++) times.push(now - Math.floor(r() * span));
  times.sort((a, b) => b - a);
  const rows = [];
  let unmarkedIdx = [];
  for (let i = 0; i < n; i++) {
    const creation = i > 0 && r() < DIST.burstDup ? rows[i - 1].creation_time : Math.round(times[i] / 1000) * 1000;
    const id = String(1_000_000 + (n - i)); // MediaStore ids grow with time
    const video = r() < DIST.video;
    const supported = r() < DIST.unsupported ? 0 : 1;
    const d = new Date(creation);
    const stamp = d.toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const filename = (supported ? '' : 'X') + (video ? `PXL_${stamp}.mp4` : `PXL_${stamp}.jpg`);
    const mtime = r() < DIST.edited ? creation + Math.floor(r() * 86400_000) : creation;
    let status = 'none';
    let excluded = 0;
    const s = r();
    if (s < DIST.synced) status = 'synced';
    else if (s < DIST.synced + DIST.excluded) excluded = 1;
    else if (s < DIST.synced + DIST.excluded + DIST.pending) status = 'pending';
    else if (s < DIST.synced + DIST.excluded + DIST.pending + DIST.failed) status = 'failed';
    if (!supported && status !== 'synced') status = 'none';
    const row = {
      id,
      filename,
      media_type: video ? 'video' : 'photo',
      uri: `content://media/external/${video ? 'video' : 'images'}/media/${id}`,
      mtime,
      size: status === 'synced' ? Math.floor(1e6 + r() * 6e6) : null,
      supported,
      selected: 0,
      excluded,
      status,
      error: status === 'failed' ? 'Upload failed: HTTP 502' : null,
      creation_time: creation,
      last_seen: 1,
      failed_at: status === 'failed' ? now - Math.floor(r() * 7200_000) : null,
      failures: status === 'failed' ? 1 + Math.floor(r() * 6) : 0,
      missing_since: r() < DIST.missing ? 1 : null,
    };
    rows.push(row);
    if (supported && !excluded && status === 'none' && row.missing_since === null) unmarkedIdx.push(i);
  }
  // A working set of checked photos, spread through the unmarked pool.
  const step = Math.max(1, Math.floor(unmarkedIdx.length / DIST.selected));
  for (let k = 0; k < DIST.selected && k * step < unmarkedIdx.length; k++) {
    rows[unmarkedIdx[k * step]].selected = 1;
  }
  return rows;
}

// What expo-media-library would hand back for these rows.
export function mediaAssets(rows) {
  return rows.map((row) => ({
    id: row.id,
    filename: row.filename,
    mediaType: row.media_type,
    uri: row.uri,
    creationTime: row.creation_time,
    modificationTime: row.mtime,
  }));
}

export function mediaLibraryMock(assets) {
  return {
    MediaType: { photo: 'photo', video: 'video' },
    SortBy: { creationTime: 'creationTime' },
    getPermissionsAsync: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
    requestPermissionsAsync: async () => ({ granted: true, canAskAgain: true, accessPrivileges: 'all' }),
    getAssetsAsync: async ({ first, after }) => {
      const start = after ? Number(after) : 0;
      const page = assets.slice(start, start + first);
      const end = start + page.length;
      return { assets: page, endCursor: String(end), hasNextPage: end < assets.length };
    },
    getAssetInfoAsync: async () => ({}),
  };
}

export function loadLibraryDb(impl, shim, media) {
  class Stub {}
  return loadTs('src/lib/library-db.ts', impl, {
    'expo-file-system': { Directory: Stub, File: Stub, Paths: { cache: { uri: '' } } },
    'expo-media-library': { MediaSubtype: {}, MediaType: { VIDEO: 'video' }, Asset: Stub },
    'expo-media-library/legacy': media,
    'expo-sqlite': shim,
    'react-native': { Platform: { OS: 'android' } },
    './log': { flushLogs: async () => {}, log() {}, logError() {} },
    './upload-protocol': {
      MEDIA_PERMISSIONS: ['photo', 'video'],
      assetMtime: (a) => Math.round(a.modificationTime || a.creationTime || 0),
      isBackupSupported: (a) => !String(a.filename).startsWith('X'),
      // Hand the event loop back like the app does between scan pages.
      yieldToUI: () => new Promise((resolve) => setImmediate(resolve)),
    },
  });
}

const COLS = [
  'id', 'filename', 'media_type', 'uri', 'mtime', 'size', 'supported', 'selected', 'excluded',
  'status', 'error', 'creation_time', 'last_seen', 'failed_at', 'failures', 'missing_since',
];

// A fresh on-disk catalog (WAL needs a file) opened through library-db.ts
// itself, so its own CREATE TABLE / migrations / indexes are what we test.
export async function openCatalog(impl, rows, { dir } = {}) {
  const tmp = dir ?? mkdtempSync(path.join(os.tmpdir(), 'instacheese-bench-'));
  const shim = createSqliteShim();
  shim.nextPath = path.join(tmp, 'library.db');
  const lib = loadLibraryDb(impl, shim, mediaLibraryMock(mediaAssets(rows)));
  await lib.libraryCounts(); // openDb(): schema + migrations
  const raw = shim.raw;
  if (rows.length) {
    const ins = raw.prepare(
      `INSERT INTO assets (${COLS.join(', ')}) VALUES (${COLS.map(() => '?').join(', ')})`
    );
    raw.exec('BEGIN');
    for (const row of rows) ins.run(...COLS.map((c) => row[c]));
    raw.exec('COMMIT');
    // No ANALYZE: the app never runs it, so the planner works without stats.
    raw.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }
  return {
    lib,
    shim,
    raw,
    dir: tmp,
    close() {
      try {
        raw.close();
      } catch {}
      if (!dir) rmSync(tmp, { recursive: true, force: true });
    },
  };
}

export function digest(value) {
  return createHash('sha1')
    .update(JSON.stringify(value, (k, v) => (v instanceof Set ? [...v].sort() : v)))
    .digest('hex')
    .slice(0, 12);
}
