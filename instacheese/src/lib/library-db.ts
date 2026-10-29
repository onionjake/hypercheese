import * as MediaLibrary from 'expo-media-library/legacy';
import * as SQLite from 'expo-sqlite';

import { flushLogs, log } from './log';
import { SUPPORTED_EXTENSIONS, assetMtime, extensionOf } from './upload-protocol';

// Local catalog of the device's media library for partial sync: which assets
// exist, which ones the user wants backed up, and what happened last time we
// tried. The sync STATUS here is a display cache only — every sync run still
// asks the server's manifest, so the server stays the source of truth and we
// can never believe something is backed up that the server doesn't have.

export type AssetStatus = 'none' | 'pending' | 'synced' | 'failed';

export interface LibraryAsset {
  id: string;
  filename: string;
  mediaType: string; // 'photo' | 'video'
  uri: string; // library uri, used for thumbnails
  mtime: number; // milliseconds since epoch (assetMtime)
  size: number | null; // bytes, resolved lazily on first sync
  supported: boolean;
  selected: boolean;
  excluded: boolean; // user decided this asset won't be uploaded
  status: AssetStatus;
  error: string | null;
  creationTime: number;
}

// 'unmarked' is the triage view: supported assets the user hasn't decided on
// yet — not marked for upload, not backed up, not marked "won't upload".
// (A checked-but-undecided photo still counts as unmarked; the selection is
// only a working set until a batch action commits it.)
export type AssetFilter = 'unmarked' | 'all' | 'selected' | 'synced' | 'failed' | 'excluded';

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('library.db');
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS assets (
          id TEXT PRIMARY KEY NOT NULL,
          filename TEXT NOT NULL,
          media_type TEXT NOT NULL,
          uri TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER,
          supported INTEGER NOT NULL DEFAULT 1,
          selected INTEGER NOT NULL DEFAULT 0,
          excluded INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'none',
          error TEXT,
          creation_time INTEGER NOT NULL DEFAULT 0,
          last_seen INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_assets_creation ON assets (creation_time DESC);
        CREATE INDEX IF NOT EXISTS idx_assets_selected ON assets (selected);
        CREATE INDEX IF NOT EXISTS idx_assets_status ON assets (status);
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY NOT NULL,
          value TEXT NOT NULL
        );
      `);
      // Catalogs created before the "won't upload" feature lack the column.
      const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(assets)');
      if (!cols.some((c) => c.name === 'excluded')) {
        await db.execAsync('ALTER TABLE assets ADD COLUMN excluded INTEGER NOT NULL DEFAULT 0');
      }
      return db;
    })();
  }
  return dbPromise;
}

function rowToAsset(row: any): LibraryAsset {
  return {
    id: row.id,
    filename: row.filename,
    mediaType: row.media_type,
    uri: row.uri,
    mtime: row.mtime,
    size: row.size,
    supported: !!row.supported,
    selected: !!row.selected,
    excluded: !!row.excluded,
    status: row.status as AssetStatus,
    error: row.error,
    creationTime: row.creation_time,
  };
}

const SCAN_PAGE = 500;
// One statement per this many assets rather than one per asset: awaiting a
// round trip through the async bridge for every row starves the JS thread for
// the length of the transaction, and a full camera roll is tens of thousands
// of rows. (Same trap the upload queue's enqueue() was rewritten out of.)
const SCAN_UPSERT_CHUNK = 200;

const ASSET_UPSERT_ROW = '(?, ?, ?, ?, ?, ?, ?, ?)';
const ASSET_UPSERT_TAIL = `
  ON CONFLICT(id) DO UPDATE SET
    filename = excluded.filename,
    media_type = excluded.media_type,
    uri = excluded.uri,
    supported = excluded.supported,
    creation_time = excluded.creation_time,
    last_seen = excluded.last_seen,
    size = CASE WHEN assets.mtime != excluded.mtime THEN NULL ELSE assets.size END,
    error = CASE WHEN assets.mtime != excluded.mtime THEN NULL ELSE assets.error END,
    status = CASE
      WHEN assets.mtime != excluded.mtime AND assets.excluded = 0
        AND assets.status IN ('pending', 'failed', 'synced') THEN 'pending'
      WHEN assets.mtime != excluded.mtime THEN 'none'
      ELSE assets.status END,
    mtime = excluded.mtime`;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

let scanPromise: Promise<void> | null = null;

// Bring the catalog up to date with the media library. New assets appear
// unselected; assets whose mtime changed get their cached size/status reset
// (the next sync re-checks them against the server); assets deleted from the
// library disappear from the catalog.
//
// Two scans can be asked for at once — the library screen mounting while the
// background reminder task is mid-rescan. They'd share a connection (nested
// BEGINs throw) and each ends by deleting whatever its own generation didn't
// stamp, so a second caller joins the run already in flight instead of
// starting its own. That caller forfeits progress callbacks; only the
// foreground scan passes one, and it is the one that normally starts the run.
export function refreshFromLibrary(onProgress?: (scanned: number) => void): Promise<void> {
  if (!scanPromise) {
    scanPromise = runScan(onProgress).finally(() => {
      scanPromise = null;
    });
  }
  return scanPromise;
}

async function runScan(onProgress?: (scanned: number) => void): Promise<void> {
  const permission = await MediaLibrary.requestPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Photo library permission is required');
  }

  const db = await openDb();
  const generation = Date.now();
  const started = Date.now();
  let after: string | undefined;
  let hasNextPage = true;
  let scanned = 0;
  let pages = 0;

  // The heaviest thing in the app that runs without anyone tapping anything,
  // and until now it was invisible in the log. Persist the marker before the
  // work starts: if the process dies in here the debounced flush never runs,
  // and the export would show the freeze with no hint of what was running.
  log('library', 'scan started');
  await flushLogs().catch(() => {});

  while (hasNextPage) {
    const pageStarted = Date.now();
    const page = await MediaLibrary.getAssetsAsync({
      first: SCAN_PAGE,
      after,
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });
    hasNextPage = page.hasNextPage;
    after = page.endCursor;
    const read = Date.now() - pageStarted;

    const writeStarted = Date.now();
    await db.withTransactionAsync(async () => {
      for (const rows of chunk(page.assets, SCAN_UPSERT_CHUNK)) {
        const values = rows.map(() => ASSET_UPSERT_ROW).join(', ');
        await db.runAsync(
          `INSERT INTO assets (id, filename, media_type, uri, mtime, supported, creation_time, last_seen)
           VALUES ${values}
           ${ASSET_UPSERT_TAIL}`,
          ...rows.flatMap((asset) => [
            asset.id,
            asset.filename,
            asset.mediaType,
            asset.uri,
            assetMtime(asset),
            SUPPORTED_EXTENSIONS.has(extensionOf(asset.filename)) ? 1 : 0,
            Math.round(asset.creationTime || 0),
            generation,
          ])
        );
      }
    });

    scanned += page.assets.length;
    pages++;
    log(
      'library',
      `scan page ${pages}: ${page.assets.length} assets ` +
        `(read ${read}ms, wrote ${Date.now() - writeStarted}ms, ${scanned} total)`
    );
    onProgress?.(scanned);
    // Hand the event loop back between pages so a long scan can't hold off
    // rendering, the watchdog tick, or the upload queue's callbacks.
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  const removed = await db.runAsync('DELETE FROM assets WHERE last_seen != ?', generation);
  log(
    'library',
    `scan complete: ${scanned} assets, ${removed?.changes ?? 0} gone (${Date.now() - started}ms)`
  );
}

const UNMARKED_WHERE = "supported = 1 AND excluded = 0 AND status = 'none'";

const FILTER_WHERE: Record<AssetFilter, string> = {
  unmarked: UNMARKED_WHERE,
  all: '1 = 1',
  selected: 'selected = 1',
  synced: "status = 'synced'",
  failed: "status = 'failed'",
  excluded: 'excluded = 1',
};

// Keyset-paged: `after` is the last asset already shown, and the next page
// starts strictly below it in (creation_time, id) order. An OFFSET would
// drift whenever the filtered set changes between pages — on-screen edits
// (Won't upload in the Unmarked view) and queue settles (Backed up / Failed)
// do that constantly, skipping or repeating photos.
export async function listAssets(
  filter: AssetFilter,
  limit: number,
  after?: Pick<LibraryAsset, 'creationTime' | 'id'>
): Promise<LibraryAsset[]> {
  const db = await openDb();
  const rows = after
    ? await db.getAllAsync(
        `SELECT * FROM assets WHERE (${FILTER_WHERE[filter]})
           AND (creation_time < ? OR (creation_time = ? AND id < ?))
         ORDER BY creation_time DESC, id DESC LIMIT ?`,
        after.creationTime,
        after.creationTime,
        after.id,
        limit
      )
    : await db.getAllAsync(
        `SELECT * FROM assets WHERE ${FILTER_WHERE[filter]}
         ORDER BY creation_time DESC, id DESC LIMIT ?`,
        limit
      );
  return rows.map(rowToAsset);
}

export interface LibraryCounts {
  total: number;
  unmarked: number; // no decision made yet (see UNMARKED_WHERE)
  selected: number;
  synced: number;
  failed: number;
  excluded: number; // marked "won't upload"
  pending: number; // marked for upload but not yet backed up
  backupReady: number; // what "Back up" would commit: staged selection + pending
}

export async function libraryCounts(): Promise<LibraryCounts> {
  const db = await openDb();
  const row = await db.getFirstAsync<any>(`
    SELECT
      COUNT(*) AS total,
      SUM(${UNMARKED_WHERE}) AS unmarked,
      SUM(selected) AS selected,
      SUM(status = 'synced') AS synced,
      SUM(status = 'failed') AS failed,
      SUM(excluded) AS excluded,
      SUM(supported = 1 AND excluded = 0 AND status IN ('pending', 'failed')) AS pending,
      SUM(supported = 1 AND (selected = 1 OR (excluded = 0 AND status IN ('pending', 'failed')))) AS backup_ready
    FROM assets
  `);
  return {
    total: row?.total ?? 0,
    unmarked: row?.unmarked ?? 0,
    selected: row?.selected ?? 0,
    synced: row?.synced ?? 0,
    failed: row?.failed ?? 0,
    excluded: row?.excluded ?? 0,
    pending: row?.pending ?? 0,
    backupReady: row?.backup_ready ?? 0,
  };
}

// The selection is a transient working set: checking boxes stages photos for
// a batch action (Back up / Won't upload) and never changes sync state, so
// clearing it can't hide which photos are queued or awaiting upload.
export async function setSelected(ids: string[], selected: boolean): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const placeholders = ids.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE assets SET selected = ? WHERE id IN (${placeholders})`,
    selected ? 1 : 0,
    ...ids
  );
}

// "Select all" respects "won't upload" — those photos were explicitly opted
// out, so a bulk select never drags them back in. (Tapping an individual
// excluded photo can still select it deliberately.)
export async function setAllSelected(selected: boolean): Promise<void> {
  const db = await openDb();
  if (selected) {
    await db.runAsync('UPDATE assets SET selected = 1 WHERE supported = 1 AND excluded = 0');
  } else {
    await db.runAsync('UPDATE assets SET selected = 0');
  }
}

const MARK_FOR_UPLOAD_SET = `
  SET selected = 0, excluded = 0, error = NULL,
      status = CASE WHEN status = 'synced' THEN 'synced' ELSE 'pending' END`;

// "Back up" commits the working selection: every checked photo becomes
// durably marked for upload (status 'pending' until the queue settles it) and
// the checkboxes clear so the next batch can be staged. Marking for upload
// overrides "won't upload" — it's the newer decision.
export async function markSelectedForUpload(): Promise<void> {
  const db = await openDb();
  await db.runAsync(`UPDATE assets ${MARK_FOR_UPLOAD_SET} WHERE selected = 1 AND supported = 1`);
}

// Single-photo change of mind, e.g. "Mark for upload" on a "won't upload"
// photo's detail dialog.
export async function markForUpload(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const placeholders = ids.map(() => '?').join(',');
  await db.runAsync(
    `UPDATE assets ${MARK_FOR_UPLOAD_SET} WHERE id IN (${placeholders}) AND supported = 1`,
    ...ids
  );
}

// Marking "won't upload" is the opposite decision to selecting: it deselects,
// forgets any failure, and keeps 'synced' (the server still has the file, we
// just won't send it again if the server ever loses it). Un-marking returns
// the asset to the unmarked pool without re-selecting it.
export async function setExcluded(ids: string[], excluded: boolean): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const placeholders = ids.map(() => '?').join(',');
  if (excluded) {
    await db.runAsync(
      `UPDATE assets SET excluded = 1, selected = 0, error = NULL,
         status = CASE WHEN status = 'synced' THEN 'synced' ELSE 'none' END
       WHERE id IN (${placeholders})`,
      ...ids
    );
  } else {
    await db.runAsync(`UPDATE assets SET excluded = 0 WHERE id IN (${placeholders})`, ...ids);
  }
}

// Bulk form of setExcluded(..., true) for the whole current selection — one
// UPDATE instead of an id list that could blow past SQLite's bind limit.
// Returns the affected ids so the caller can pull them from the upload queue.
export async function excludeSelected(): Promise<string[]> {
  const db = await openDb();
  const rows = await db.getAllAsync<{ id: string }>('SELECT id FROM assets WHERE selected = 1');
  await db.runAsync(`
    UPDATE assets SET excluded = 1, selected = 0, error = NULL,
      status = CASE WHEN status = 'synced' THEN 'synced' ELSE 'none' END
    WHERE selected = 1
  `);
  return rows.map((r) => r.id);
}

export async function markStatus(
  id: string,
  status: AssetStatus,
  error: string | null = null
): Promise<void> {
  const db = await openDb();
  await db.runAsync('UPDATE assets SET status = ?, error = ? WHERE id = ?', status, error, id);
}

export async function setSize(id: string, size: number): Promise<void> {
  const db = await openDb();
  await db.runAsync('UPDATE assets SET size = ? WHERE id = ?', size, id);
}

// Everything the user wants on the server, in the order we'll sync it. Keyed
// off the durable upload decision (status), not the transient checkbox
// selection, so handed-off uploads survive Clear selection and auto-retries
// keep retrying failures after the checkboxes are gone. By default only
// assets still awaiting upload are returned; includeSynced also returns the
// (much larger, ever-growing) already-synced set, so only re-verification
// flows should ask for it.
export async function markedForSync(
  opts: { includeSynced?: boolean } = {}
): Promise<LibraryAsset[]> {
  const db = await openDb();
  const statuses = opts.includeSynced ? "'pending', 'failed', 'synced'" : "'pending', 'failed'";
  const rows = await db.getAllAsync(
    `SELECT * FROM assets
     WHERE supported = 1 AND excluded = 0 AND status IN (${statuses})
     ORDER BY creation_time DESC, id DESC`
  );
  return rows.map(rowToAsset);
}

// Backup decisions belong to the account that made them: a 'pending' mark
// means "upload this to MY account", and 'synced' only says what one server
// has. Called on every sign-in before the upload queue starts; when a
// different account (server + username) signs in on this device, its
// predecessor's marks are dropped so auto-retry can't upload them into the
// new account. "Won't upload" survives — it only ever prevents uploads. A
// catalog from before this existed is adopted by whoever signs in next.
export async function claimCatalog(account: string): Promise<void> {
  const db = await openDb();
  const row = await db.getFirstAsync<{ value: string }>(
    "SELECT value FROM meta WHERE key = 'account'"
  );
  if (row && row.value !== account) {
    const reset = await db.runAsync(
      "UPDATE assets SET status = 'none', error = NULL, selected = 0 WHERE status != 'none' OR selected = 1"
    );
    log('library', `catalog claimed by a different account; reset ${reset.changes} marks`);
  }
  await db.runAsync(
    "INSERT INTO meta (key, value) VALUES ('account', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    account
  );
}
