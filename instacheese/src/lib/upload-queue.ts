import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as MediaLibrary from 'expo-media-library/legacy';
import * as SQLite from 'expo-sqlite';
import { AppState } from 'react-native';

import { type Session } from './api';
import { libraryCounts, markStatus, markedForSync, setSize } from './library-db';
import { log, logError } from './log';
import { onNetworkChange, uploadAllowed } from './network';
import { hashAndUpload, manifestCheck, stablePath } from './upload-protocol';

// The consolidated upload queue shared by all three upload flows (picker
// shares, backup selections, full-library sync). Screens only ever enqueue
// work here and observe progress — this module owns the single drain loop, so
// uploads keep going no matter which screen is open, and the background task
// (background-upload.ts) drains the same queue when the app isn't.
//
// The queue is persistent (SQLite): items survive an app restart or the OS
// killing the process mid-upload, and the next drain — foreground or
// background — picks up exactly where things left off. The server manifest
// stays the source of truth, so re-draining an item that actually made it up
// resolves to 'exists' without re-sending any bytes.

const BATCH_SIZE = 200;
const RETRY_INTERVAL_MS = 15 * 60 * 1000;
// Finished rows stick around so the queue screen can show what happened, but
// not forever.
const FINISHED_TTL_MS = 24 * 60 * 60 * 1000;

export type QueueSource = 'picker' | 'backup' | 'sync';

export type QueueItemStatus =
  | 'queued'
  | 'checking'
  | 'hashing'
  | 'uploading'
  | 'done'
  | 'exists' // server already had it (manifest hit or hash dedup)
  | 'failed';

export interface QueueItem {
  key: string;
  source: QueueSource;
  assetId: string | null;
  localUri: string | null; // known readable uri; library items resolve lazily
  thumbUri: string | null;
  filename: string;
  path: string;
  mtime: number; // milliseconds since epoch
  size: number | null;
  status: QueueItemStatus;
  error: string | null;
}

export interface NewQueueItem {
  key: string;
  source: QueueSource;
  assetId?: string | null;
  localUri?: string | null;
  thumbUri?: string | null;
  filename: string;
  path: string;
  mtime: number;
  size?: number | null;
}

export interface QueueCurrent {
  key: string;
  filename: string;
  phase: 'checking' | 'hashing' | 'uploading';
  bytesSent: number;
  bytesTotal: number;
}

export interface QueueSummary {
  state: 'idle' | 'running' | 'paused';
  reason: string | null; // why paused, when paused
  remaining: number; // queued + in flight
  failed: number;
  finished: number; // done + exists rows still in the table
  total: number;
  current: QueueCurrent | null;
}

// Stable queue key: one row per media-library asset no matter which flow
// enqueued it; picker temp files without an assetId key on their pick uri.
export function assetKey(assetId: string): string {
  return `asset:${assetId}`;
}

// --- Storage -----------------------------------------------------------------

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;

async function openDb(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const db = await SQLite.openDatabaseAsync('upload-queue.db');
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS uploads (
          key TEXT PRIMARY KEY NOT NULL,
          source TEXT NOT NULL,
          asset_id TEXT,
          local_uri TEXT,
          thumb_uri TEXT,
          filename TEXT NOT NULL,
          path TEXT NOT NULL,
          mtime INTEGER NOT NULL,
          size INTEGER,
          status TEXT NOT NULL DEFAULT 'queued',
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_uploads_status ON uploads (status);
      `);
      return db;
    })();
  }
  return dbPromise;
}

function rowToItem(row: any): QueueItem {
  return {
    key: row.key,
    source: row.source as QueueSource,
    assetId: row.asset_id,
    localUri: row.local_uri,
    thumbUri: row.thumb_uri,
    filename: row.filename,
    path: row.path,
    mtime: row.mtime,
    size: row.size,
    status: row.status as QueueItemStatus,
    error: row.error,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// expo-sqlite's withTransactionAsync is NOT exclusive: two concurrent
// transactions on the shared connection nest their BEGINs and throw. Every
// caller that opens a transaction goes through this chain so transactions
// never overlap (plain single-statement writes are safe to interleave).
let writeChain: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const run = writeChain.then(fn, fn);
  writeChain = run.catch(() => {});
  return run;
}

// --- State + events ----------------------------------------------------------

let session: Session | null = null;
let runPromise: Promise<void> | null = null;
let stopRequested = false;
let pendingKick = false; // a kick arrived while a drain was winding down
let pausedReason: string | null = null;
let current: QueueCurrent | null = null;

interface Counts {
  remaining: number;
  failed: number;
  finished: number;
  total: number;
}
let counts: Counts = { remaining: 0, failed: 0, finished: 0, total: 0 };

type SummaryListener = (summary: QueueSummary) => void;
type ItemListener = (item: QueueItem) => void;
const summaryListeners = new Set<SummaryListener>();
const itemListeners = new Set<ItemListener>();

function buildSummary(): QueueSummary {
  return {
    state: runPromise ? 'running' : pausedReason ? 'paused' : 'idle',
    reason: runPromise ? null : pausedReason,
    remaining: counts.remaining,
    failed: counts.failed,
    finished: counts.finished,
    total: counts.total,
    current: current ? { ...current } : null,
  };
}

export function getSummary(): QueueSummary {
  return buildSummary();
}

function broadcastSummary(): void {
  const summary = buildSummary();
  summaryListeners.forEach((fn) => fn(summary));
}

function emitItem(item: QueueItem): void {
  itemListeners.forEach((fn) => fn(item));
}

async function refreshCounts(): Promise<void> {
  const db = await openDb();
  const row = await db.getFirstAsync<any>(`
    SELECT
      COUNT(*) AS total,
      SUM(status IN ('queued', 'checking', 'hashing', 'uploading')) AS remaining,
      SUM(status = 'failed') AS failed,
      SUM(status IN ('done', 'exists')) AS finished
    FROM uploads
  `);
  counts = {
    total: row?.total ?? 0,
    remaining: row?.remaining ?? 0,
    failed: row?.failed ?? 0,
    finished: row?.finished ?? 0,
  };
}

async function refreshAndBroadcast(): Promise<void> {
  await refreshCounts();
  broadcastSummary();
}

// The summary a new subscriber sees may predate any DB read, so refresh the
// counts and re-broadcast right after subscribing.
export function subscribeSummary(fn: SummaryListener): () => void {
  summaryListeners.add(fn);
  fn(buildSummary());
  refreshAndBroadcast().catch(() => {});
  return () => summaryListeners.delete(fn);
}

export function subscribeItems(fn: ItemListener): () => void {
  itemListeners.add(fn);
  return () => itemListeners.delete(fn);
}

export function setSession(s: Session): void {
  session = s;
}

// --- Queue operations ----------------------------------------------------------

// Insert or revive items. Re-enqueueing resets a waiting or failed item to
// 'queued'; the item currently being uploaded is left alone, and a row that
// already FINISHED with an unchanged mtime keeps its result — resetting it
// would wipe visible progress on every "Back up" press for no benefit.
// (Finished rows are pruned after FINISHED_TTL_MS, after which the photo gets
// re-verified against the server manifest again.) Returns how many items
// were NEWLY queued — upserts onto rows that were already waiting don't
// count, so callers (the sync scan) don't double-report.
export function enqueue(items: NewQueueItem[]): Promise<number> {
  if (items.length === 0) return Promise.resolve(0);
  return serialized(async () => {
    const db = await openDb();
    const now = Date.now();
    const activeKey = current?.key;
    const accepted = items.filter((i) => i.key !== activeKey);
    if (accepted.length === 0) return 0;

    const existing = new Map<string, any>();
    for (const keys of chunk(accepted.map((i) => i.key), 400)) {
      const placeholders = keys.map(() => '?').join(',');
      const rows = await db.getAllAsync<any>(
        `SELECT * FROM uploads WHERE key IN (${placeholders})`,
        ...keys
      );
      rows.forEach((r) => existing.set(r.key, r));
    }
    const isFreshlyFinished = (item: NewQueueItem) => {
      const prev = existing.get(item.key);
      return (
        !!prev && (prev.status === 'done' || prev.status === 'exists') && prev.mtime === item.mtime
      );
    };
    // Rows already waiting in the queue aren't "newly added".
    const wasActive = (key: string) => {
      const prev = existing.get(key);
      return !!prev && ['queued', 'checking', 'hashing', 'uploading'].includes(prev.status);
    };
    const toQueue = accepted.filter((i) => !isFreshlyFinished(i));
    const skipped = accepted.filter(isFreshlyFinished);

    await db.withTransactionAsync(async () => {
      for (const item of toQueue) {
        await db.runAsync(
          `INSERT INTO uploads (key, source, asset_id, local_uri, thumb_uri, filename, path, mtime, size, status, error, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             source = excluded.source,
             asset_id = excluded.asset_id,
             local_uri = excluded.local_uri,
             thumb_uri = excluded.thumb_uri,
             filename = excluded.filename,
             path = excluded.path,
             mtime = excluded.mtime,
             size = excluded.size,
             status = 'queued',
             error = NULL,
             updated_at = excluded.updated_at`,
          item.key,
          item.source,
          item.assetId ?? null,
          item.localUri ?? null,
          item.thumbUri ?? null,
          item.filename,
          item.path,
          item.mtime,
          item.size ?? null,
          now,
          now
        );
      }
    });

    for (const item of toQueue) {
      emitItem({
        key: item.key,
        source: item.source,
        assetId: item.assetId ?? null,
        localUri: item.localUri ?? null,
        thumbUri: item.thumbUri ?? null,
        filename: item.filename,
        path: item.path,
        mtime: item.mtime,
        size: item.size ?? null,
        status: 'queued',
        error: null,
      });
    }
    // Screens that just (re-)enqueued a finished item still hear its real
    // status, e.g. a re-picked photo shows "Already uploaded" immediately.
    for (const item of skipped) {
      emitItem(rowToItem(existing.get(item.key)));
    }
    await refreshAndBroadcast();
    return toQueue.filter((i) => !wasActive(i.key)).length;
  });
}

// Everything marked for backup in the library catalog that isn't known to be
// on the server yet. With includeSynced, locally-'synced' assets are queued
// too — the server manifest re-verifies them for free, which is how a manual
// "Back up" notices server-side data loss or a device re-registration (the
// local 'synced' status is only a display cache). Auto-retries skip them to
// stay cheap.
export async function enqueueBackupPending(
  opts: { includeSynced?: boolean } = {}
): Promise<number> {
  const assets = await markedForSync();
  const pending = opts.includeSynced ? assets : assets.filter((a) => a.status !== 'synced');
  return enqueue(
    pending.map((a) => ({
      key: assetKey(a.id),
      source: 'backup' as const,
      assetId: a.id,
      thumbUri: a.uri,
      filename: a.filename,
      path: stablePath(a.id, a.filename),
      mtime: a.mtime,
      size: a.size,
    }))
  );
}

// Drop items that haven't finished (or started uploading bytes) — used when a
// backup selection is un-checked. Scoped to a source when given, so
// un-checking a backup photo can't cancel an upload the picker or a full sync
// queued for the same asset. The item currently uploading is never removed;
// the drain also re-checks row existence before each file, so removal takes
// effect even for items already read into the active batch.
export async function removeQueued(keys: string[], source?: QueueSource): Promise<void> {
  if (keys.length === 0) return;
  const db = await openDb();
  const remove = keys.filter((k) => k !== current?.key);
  if (remove.length === 0) return;
  for (const batch of chunk(remove, 400)) {
    const placeholders = batch.map(() => '?').join(',');
    await db.runAsync(
      `DELETE FROM uploads
       WHERE status IN ('queued', 'checking', 'failed') AND key IN (${placeholders})
       ${source ? 'AND source = ?' : ''}`,
      ...batch,
      ...(source ? [source] : [])
    );
  }
  await refreshAndBroadcast();
}

// Forget the queue entirely. Called on sign-out so the next account on this
// device can never drain (upload) the previous account's photos.
export async function clearAll(): Promise<void> {
  stopRequested = true;
  pendingKick = false;
  session = null;
  const db = await openDb();
  await db.runAsync('DELETE FROM uploads');
  pausedReason = null;
  await refreshAndBroadcast();
}

export async function retryFailed(): Promise<void> {
  const db = await openDb();
  const failed = await db.getAllAsync('SELECT * FROM uploads WHERE status = ?', 'failed');
  await db.runAsync(
    `UPDATE uploads SET status = 'queued', error = NULL, updated_at = ? WHERE status = 'failed'`,
    Date.now()
  );
  for (const row of failed) {
    emitItem({ ...rowToItem(row), status: 'queued', error: null });
  }
  await refreshAndBroadcast();
  kick('retry-failed');
}

export async function clearFinished(): Promise<void> {
  const db = await openDb();
  await db.runAsync(`DELETE FROM uploads WHERE status IN ('done', 'exists')`);
  await refreshAndBroadcast();
}

// Active/queued first, then failures, then what already finished.
export async function listItems(limit = 500): Promise<QueueItem[]> {
  const db = await openDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM uploads
     ORDER BY CASE
       WHEN status IN ('checking', 'hashing', 'uploading') THEN 0
       WHEN status = 'queued' THEN 1
       WHEN status = 'failed' THEN 2
       ELSE 3 END,
       rowid
     LIMIT ?`,
    limit
  );
  return rows.map(rowToItem);
}

// --- Drain engine --------------------------------------------------------------

// getAssetInfoAsync reads EXIF (including GPS) on Android 10+, which needs
// the ACCESS_MEDIA_LOCATION permission and rejects wholesale without it — a
// build predating that permission can't stat anything through it. The
// library uri is a plain readable file:// path on Android, so fall back to
// it rather than failing the file. (iOS uris are ph:// and unusable here,
// but iOS never rejects this call over EXIF access.) Shared with the sync
// scan so both flows resolve originals identically.
export async function libraryLocalUri(
  assetId: string,
  fallbackUri: string | null
): Promise<string> {
  try {
    const info = await MediaLibrary.getAssetInfoAsync(assetId);
    if (info.localUri) return info.localUri;
    throw new Error('Original not available on this device');
  } catch (err) {
    if (fallbackUri?.startsWith('file://')) return fallbackUri;
    throw err;
  }
}

// A persisted localUri can go stale — picker items keep an ImagePicker
// temp-cache path the OS may purge — so verify it still exists before use
// and otherwise re-resolve from the media library via the assetId.
async function resolveLocalUri(item: QueueItem): Promise<string> {
  if (item.localUri) {
    try {
      const info = await LegacyFileSystem.getInfoAsync(item.localUri);
      if (info.exists) return item.localUri;
    } catch {
      // fall through to the media library
    }
  }
  if (!item.assetId) throw new Error('File is no longer available');
  return libraryLocalUri(item.assetId, item.thumbUri);
}

// Removal (deselect) can happen after the drain read a row into its
// in-memory batch — always re-check the row still exists before spending
// work on it or recording an outcome.
async function stillWanted(key: string): Promise<boolean> {
  const db = await openDb();
  const row = await db.getFirstAsync('SELECT 1 FROM uploads WHERE key = ?', key);
  return !!row;
}

async function setItemStatus(item: QueueItem, status: QueueItemStatus): Promise<void> {
  item.status = status;
  const db = await openDb();
  await db.runAsync(
    'UPDATE uploads SET status = ?, updated_at = ? WHERE key = ?',
    status,
    Date.now(),
    item.key
  );
  emitItem({ ...item });
}

function setCurrent(item: QueueItem, phase: QueueCurrent['phase']): void {
  current = {
    key: item.key,
    filename: item.filename,
    phase,
    bytesSent: 0,
    bytesTotal: item.size ?? 0,
  };
  broadcastSummary();
}

let lastProgressBroadcast = 0;
function onUploadProgress(bytesSent: number, bytesTotal: number): void {
  if (!current) return;
  current.bytesSent = bytesSent;
  current.bytesTotal = bytesTotal;
  const now = Date.now();
  if (now - lastProgressBroadcast >= 300) {
    lastProgressBroadcast = now;
    broadcastSummary();
  }
}

// Terminal state for one item; mirrors the outcome into the library catalog
// so backup badges stay truthful. Failures are only mirrored for
// backup-selected items — a failed picker share or sync upload of a photo the
// user never selected shouldn't show up in the Backup screen's Failed count
// (which it couldn't retry anyway).
async function settle(item: QueueItem, status: 'done' | 'exists' | 'failed', error?: string) {
  item.error = error ?? null;
  const db = await openDb();
  await db.runAsync(
    'UPDATE uploads SET status = ?, error = ?, updated_at = ? WHERE key = ?',
    status,
    item.error,
    Date.now(),
    item.key
  );
  item.status = status;
  if (item.assetId) {
    if (status !== 'failed') {
      await markStatus(item.assetId, 'synced', null);
    } else if (item.source === 'backup') {
      await markStatus(item.assetId, 'failed', item.error);
    }
  }
  // Track counts in memory rather than re-aggregating the table per item;
  // the drain re-syncs from the DB once per batch.
  counts.remaining = Math.max(0, counts.remaining - 1);
  if (status === 'failed') counts.failed++;
  else counts.finished++;
  if (current?.key === item.key) current = null;
  emitItem({ ...item });
  broadcastSummary();
}

// Anything left mid-flight by a previous process (or an interrupted drain)
// goes back to 'queued' so the next drain retries it — and screens hear about
// it, so no row is left showing a stale spinner.
async function resetInFlight(): Promise<void> {
  const db = await openDb();
  const rows = await db.getAllAsync(
    `SELECT * FROM uploads WHERE status IN ('checking', 'hashing', 'uploading')`
  );
  if (rows.length === 0) return;
  await db.runAsync(
    `UPDATE uploads SET status = 'queued' WHERE status IN ('checking', 'hashing', 'uploading')`
  );
  for (const row of rows) {
    emitItem({ ...rowToItem(row), status: 'queued' });
  }
}

class Paused extends Error {}

async function drain(trigger: string, sess: Session): Promise<void> {
  const db = await openDb();
  await resetInFlight();
  await db.runAsync(
    `DELETE FROM uploads WHERE status IN ('done', 'exists') AND updated_at < ?`,
    Date.now() - FINISHED_TTL_MS
  );
  await refreshAndBroadcast();
  log('queue', `drain started (${trigger}): ${counts.remaining} queued`);

  const ensureNetwork = async () => {
    const permission = await uploadAllowed();
    if (!permission.allowed) throw new Paused(permission.reason ?? 'Uploads paused');
  };

  while (!stopRequested) {
    await ensureNetwork();
    await refreshCounts();

    const rows = await db.getAllAsync(
      `SELECT * FROM uploads WHERE status = 'queued' ORDER BY rowid LIMIT ?`,
      BATCH_SIZE
    );
    if (rows.length === 0) break;
    const batch = rows.map(rowToItem);

    // One write for the whole batch; per-item events keep screens accurate.
    const placeholders = batch.map(() => '?').join(',');
    await db.runAsync(
      `UPDATE uploads SET status = 'checking' WHERE key IN (${placeholders})`,
      ...batch.map((b) => b.key)
    );
    batch.forEach((item) => {
      item.status = 'checking';
      emitItem({ ...item });
    });

    // Resolve missing sizes (backup items are cataloged without one) so the
    // batch manifest can be built. Only a per-file problem marks the item
    // failed; batch-level problems pause the whole queue.
    const candidates: QueueItem[] = [];
    for (const item of batch) {
      if (stopRequested) break;
      if (item.size == null || item.size === 0) {
        try {
          setCurrent(item, 'checking');
          const localUri = await resolveLocalUri(item);
          const stat = await LegacyFileSystem.getInfoAsync(localUri);
          if (!stat.exists || stat.size === undefined) throw new Error('Could not stat file');
          item.size = stat.size;
          item.localUri = localUri;
          await db.runAsync(
            'UPDATE uploads SET size = ?, local_uri = ? WHERE key = ?',
            stat.size,
            localUri,
            item.key
          );
          if (item.assetId) await setSize(item.assetId, stat.size);
        } catch (err) {
          logError('queue', `stat failed for ${item.filename}`, err);
          await settle(item, 'failed', String(err));
          continue;
        }
      }
      candidates.push(item);
    }
    if (stopRequested || candidates.length === 0) continue;

    // The server's manifest decides what actually needs work. A manifest
    // failure is a network/server problem: pause and leave everything queued.
    let neededPaths: Set<string>;
    try {
      neededPaths = await manifestCheck(
        sess,
        candidates.map((c) => ({ path: c.path, mtime: c.mtime, size: c.size! }))
      );
    } catch (err) {
      logError('queue', 'manifest failed, pausing queue', err);
      throw new Paused(`Could not reach the server: ${String(err)}`);
    }

    for (const item of candidates) {
      if (neededPaths.has(item.path)) continue;
      if (!(await stillWanted(item.key))) continue; // removed mid-batch
      await settle(item, 'exists');
    }

    // Hash + upload, strictly one file at a time so per-file status stays
    // accurate and one bad file can't fail the batch.
    for (const item of candidates.filter((c) => neededPaths.has(c.path))) {
      if (stopRequested) break;
      if (!(await stillWanted(item.key))) continue; // removed mid-batch
      // Connectivity can change mid-run (leave the house, Wi-Fi drops).
      await ensureNetwork();
      try {
        const localUri = await resolveLocalUri(item);
        setCurrent(item, 'hashing');
        const outcome = await hashAndUpload(
          sess,
          {
            path: item.path,
            mtime: item.mtime,
            size: item.size!,
            localUri,
            // Only cache hashes under a stable identity; picker temp files
            // without an assetId have none.
            cacheKey: item.assetId ? `${item.assetId}:${item.mtime}:${item.size}` : null,
          },
          (phase) => {
            setCurrent(item, phase);
            setItemStatus(item, phase).catch(() => {});
          },
          onUploadProgress
        );
        await settle(item, outcome === 'deduped' ? 'exists' : 'done');
      } catch (err) {
        if (err instanceof Paused) throw err;
        logError('queue', `failed ${item.filename}`, err);
        await settle(item, 'failed', String(err));
      }
    }
  }

  log('queue', stopRequested ? 'drain stopped' : 'drain complete', counts);
}

// Start the drain unless one is already going. Returns the run's promise so
// the background task can await the whole drain. A kick that lands while a
// drain is winding down (Stop pressed, or its final empty batch) isn't lost —
// it's remembered and honored as soon as the old drain exits.
export function kick(trigger: string): Promise<void> {
  if (runPromise) {
    pendingKick = true;
    return runPromise;
  }
  if (!session) return Promise.resolve();
  const sess = session;
  stopRequested = false;
  pausedReason = null;
  runPromise = drain(trigger, sess)
    .catch((err) => {
      if (err instanceof Paused) {
        pausedReason = err.message;
        log('queue', `drain paused: ${err.message}`);
        return;
      }
      pausedReason = String(err);
      logError('queue', 'drain crashed', err);
    })
    .finally(async () => {
      runPromise = null;
      current = null;
      await resetInFlight();
      await refreshAndBroadcast();
      if (pendingKick) {
        pendingKick = false;
        if (counts.remaining > 0 && session) kick(`${trigger}+pending`);
      }
    });
  broadcastSummary();
  return runPromise;
}

// Stop after the current file; everything else stays queued (auto-retry or
// the next manual kick resumes it).
export function stop(): void {
  if (!runPromise) return;
  stopRequested = true;
  pendingKick = false;
  pausedReason = 'Stopped';
  broadcastSummary();
}

// --- Auto retry ----------------------------------------------------------------

// Call once per signed-in session; returns a cleanup function. Re-queues
// anything marked for backup and kicks the drain — on a timer, when the app
// returns to the foreground, and when connectivity changes to something
// uploads are allowed on. Also resumes whatever the queue still holds from a
// previous app run.
export function startAutoRetry(s: Session): () => void {
  session = s;

  const tryKick = async (trigger: string) => {
    try {
      if (runPromise) return;
      // Cheap aggregate first; the full selected-assets fetch only runs when
      // something is actually marked for backup but not uploaded.
      const catalog = await libraryCounts();
      if (catalog.pending > 0) await enqueueBackupPending();
      await refreshCounts();
      if (counts.remaining > 0) kick(`auto:${trigger}`);
    } catch (err) {
      logError('queue', `auto retry failed (${trigger})`, err);
    }
  };

  // Resume anything persisted from a previous session right away.
  tryKick('startup');

  const interval = setInterval(() => tryKick('interval'), RETRY_INTERVAL_MS);

  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') tryKick('foreground');
  });

  // Debounce network flaps a little before retrying.
  let networkTimer: ReturnType<typeof setTimeout> | null = null;
  const unNetwork = onNetworkChange(() => {
    if (networkTimer) clearTimeout(networkTimer);
    networkTimer = setTimeout(() => tryKick('network-change'), 3000);
  });

  return () => {
    clearInterval(interval);
    appState.remove();
    if (networkTimer) clearTimeout(networkTimer);
    unNetwork();
    // Stop and drop the credentials so nothing else can kick a drain with
    // them. (A new sign-in calls startAutoRetry again; sign-out follows up
    // with clearAll().)
    stop();
    session = null;
  };
}
