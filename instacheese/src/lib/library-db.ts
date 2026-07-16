import * as MediaLibrary from 'expo-media-library/legacy';
import * as SQLite from 'expo-sqlite';

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
  status: AssetStatus;
  error: string | null;
  creationTime: number;
}

export type AssetFilter = 'all' | 'selected' | 'synced' | 'failed';

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
          status TEXT NOT NULL DEFAULT 'none',
          error TEXT,
          creation_time INTEGER NOT NULL DEFAULT 0,
          last_seen INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_assets_creation ON assets (creation_time DESC);
        CREATE INDEX IF NOT EXISTS idx_assets_selected ON assets (selected);
        CREATE INDEX IF NOT EXISTS idx_assets_status ON assets (status);
      `);
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
    status: row.status as AssetStatus,
    error: row.error,
    creationTime: row.creation_time,
  };
}

// Bring the catalog up to date with the media library. New assets appear
// unselected; assets whose mtime changed get their cached size/status reset
// (the next sync re-checks them against the server); assets deleted from the
// library disappear from the catalog.
export async function refreshFromLibrary(
  onProgress?: (scanned: number) => void
): Promise<void> {
  const permission = await MediaLibrary.requestPermissionsAsync();
  if (!permission.granted) {
    throw new Error('Photo library permission is required');
  }

  const db = await openDb();
  const generation = Date.now();
  let after: string | undefined;
  let hasNextPage = true;
  let scanned = 0;

  while (hasNextPage) {
    const page = await MediaLibrary.getAssetsAsync({
      first: 500,
      after,
      mediaType: [MediaLibrary.MediaType.photo, MediaLibrary.MediaType.video],
      sortBy: [[MediaLibrary.SortBy.creationTime, false]],
    });
    hasNextPage = page.hasNextPage;
    after = page.endCursor;

    await db.withTransactionAsync(async () => {
      for (const asset of page.assets) {
        const supported = SUPPORTED_EXTENSIONS.has(extensionOf(asset.filename)) ? 1 : 0;
        await db.runAsync(
          `INSERT INTO assets (id, filename, media_type, uri, mtime, supported, creation_time, last_seen)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
               WHEN assets.mtime != excluded.mtime AND assets.selected = 1 THEN 'pending'
               WHEN assets.mtime != excluded.mtime THEN 'none'
               ELSE assets.status END,
             mtime = excluded.mtime`,
          asset.id,
          asset.filename,
          asset.mediaType,
          asset.uri,
          assetMtime(asset),
          supported,
          Math.round(asset.creationTime || 0),
          generation
        );
      }
    });

    scanned += page.assets.length;
    onProgress?.(scanned);
  }

  await db.runAsync('DELETE FROM assets WHERE last_seen != ?', generation);
}

const FILTER_WHERE: Record<AssetFilter, string> = {
  all: '1 = 1',
  selected: 'selected = 1',
  synced: "status = 'synced'",
  failed: "status = 'failed'",
};

export async function listAssets(
  filter: AssetFilter,
  limit: number,
  offset: number
): Promise<LibraryAsset[]> {
  const db = await openDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM assets WHERE ${FILTER_WHERE[filter]}
     ORDER BY creation_time DESC, id DESC LIMIT ? OFFSET ?`,
    limit,
    offset
  );
  return rows.map(rowToAsset);
}

export interface LibraryCounts {
  total: number;
  selected: number;
  synced: number;
  failed: number;
  pending: number; // selected but not yet backed up
}

export async function libraryCounts(): Promise<LibraryCounts> {
  const db = await openDb();
  const row = await db.getFirstAsync<any>(`
    SELECT
      COUNT(*) AS total,
      SUM(selected) AS selected,
      SUM(status = 'synced') AS synced,
      SUM(status = 'failed') AS failed,
      SUM(selected = 1 AND status IN ('pending', 'failed')) AS pending
    FROM assets
  `);
  return {
    total: row?.total ?? 0,
    selected: row?.selected ?? 0,
    synced: row?.synced ?? 0,
    failed: row?.failed ?? 0,
    pending: row?.pending ?? 0,
  };
}

// Selecting an asset queues it (unless the server already has it); deselecting
// forgets any failure but keeps 'synced' — the server still has the file.
export async function setSelected(ids: string[], selected: boolean): Promise<void> {
  if (ids.length === 0) return;
  const db = await openDb();
  const placeholders = ids.map(() => '?').join(',');
  if (selected) {
    await db.runAsync(
      `UPDATE assets SET selected = 1,
         status = CASE WHEN status = 'synced' THEN 'synced' ELSE 'pending' END
       WHERE id IN (${placeholders})`,
      ...ids
    );
  } else {
    await db.runAsync(
      `UPDATE assets SET selected = 0, error = NULL,
         status = CASE WHEN status = 'synced' THEN 'synced' ELSE 'none' END
       WHERE id IN (${placeholders})`,
      ...ids
    );
  }
}

export async function setAllSelected(selected: boolean): Promise<void> {
  const db = await openDb();
  if (selected) {
    await db.runAsync(`
      UPDATE assets SET selected = 1,
        status = CASE WHEN status = 'synced' THEN 'synced' ELSE 'pending' END
      WHERE supported = 1
    `);
  } else {
    await db.runAsync(`
      UPDATE assets SET selected = 0, error = NULL,
        status = CASE WHEN status = 'synced' THEN 'synced' ELSE 'none' END
    `);
  }
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

// Everything the user wants on the server, in the order we'll sync it.
export async function selectedForSync(): Promise<LibraryAsset[]> {
  const db = await openDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM assets WHERE selected = 1 AND supported = 1
     ORDER BY creation_time DESC, id DESC`
  );
  return rows.map(rowToAsset);
}
