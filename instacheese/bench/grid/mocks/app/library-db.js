'use strict';
// In-memory stand-in for src/lib/library-db.ts with the same paging order
// (creation_time DESC, id DESC) and filter meanings the screen relies on.
const { hop } = require('./io');

const db = { rows: [] };

function seed(n) {
  db.rows = [];
  const base = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    const id = `asset-${String(i).padStart(5, '0')}`;
    db.rows.push({
      id,
      filename: `IMG_${String(i).padStart(5, '0')}.${i % 7 === 3 ? 'mp4' : 'jpg'}`,
      mediaType: i % 7 === 3 ? 'video' : 'photo',
      uri: `file:///storage/emulated/0/DCIM/Camera/IMG_${i}.jpg`,
      mtime: base - i * 60000,
      size: null,
      supported: i % 23 !== 5,
      selected: false,
      excluded: false,
      status: 'none',
      error: null,
      creationTime: base - i * 60000,
    });
  }
}

const FILTERS = {
  all: () => true,
  unmarked: (a) => a.supported && !a.excluded && a.status === 'none',
  selected: (a) => a.selected,
  synced: (a) => a.status === 'synced',
  failed: (a) => a.status === 'failed',
  excluded: (a) => a.excluded,
};

function rowCopy(a) {
  return { ...a };
}

async function listAssets(filter, limit, after) {
  await hop();
  const f = FILTERS[filter];
  const out = [];
  for (const a of db.rows) {
    if (!f(a)) continue;
    if (after && !(a.creationTime < after.creationTime || (a.creationTime === after.creationTime && a.id < after.id)))
      continue;
    out.push(rowCopy(a));
    if (out.length >= limit) break;
  }
  return out;
}

async function libraryCounts() {
  await hop();
  const c = { total: 0, unmarked: 0, selected: 0, synced: 0, failed: 0, excluded: 0, pending: 0, backupReady: 0 };
  for (const a of db.rows) {
    c.total++;
    if (FILTERS.unmarked(a)) c.unmarked++;
    if (a.selected) c.selected++;
    if (a.status === 'synced') c.synced++;
    if (a.status === 'failed') c.failed++;
    if (a.excluded) c.excluded++;
    if (a.status === 'pending') c.pending++;
    if ((a.selected && !a.excluded) || a.status === 'pending') c.backupReady++;
  }
  return c;
}

const byId = (id) => db.rows.find((a) => a.id === id);

async function setSelected(ids, selected) {
  await hop();
  ids.forEach((id) => {
    const a = byId(id);
    if (a) a.selected = selected;
  });
}
async function setAllSelected(selected) {
  await hop();
  db.rows.forEach((a) => (a.selected = selected && a.supported));
}
async function markSelectedForUpload() {
  await hop();
  db.rows.forEach((a) => {
    if (a.selected) {
      a.selected = false;
      if (a.status !== 'synced') a.status = 'pending';
    }
  });
}
async function markForUpload(ids) {
  await hop();
  ids.forEach((id) => {
    const a = byId(id);
    if (a) {
      a.excluded = false;
      a.selected = false;
      if (a.status !== 'synced') a.status = 'pending';
    }
  });
}
async function setExcluded(ids, excluded) {
  await hop();
  ids.forEach((id) => {
    const a = byId(id);
    if (a) {
      a.excluded = excluded;
      a.selected = false;
      if (a.status !== 'synced') a.status = 'none';
    }
  });
}
async function excludeSelected() {
  await hop();
  const ids = db.rows.filter((a) => a.selected).map((a) => a.id);
  await setExcluded(ids, true);
  return ids;
}
async function refreshFromLibrary(opts = {}) {
  await hop();
  opts.onProgress?.(db.rows.length);
}

module.exports = {
  __esModule: true,
  __db: db,
  __seed: seed,
  listAssets,
  libraryCounts,
  setSelected,
  setAllSelected,
  markSelectedForUpload,
  markForUpload,
  setExcluded,
  excludeSelected,
  refreshFromLibrary,
};
