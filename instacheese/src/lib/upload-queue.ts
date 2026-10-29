import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as SQLite from 'expo-sqlite';
import { AppState } from 'react-native';

import { type Session } from './api';
import {
  assetInfo,
  libraryCounts,
  markStatus,
  markedForSync,
  resetFailures,
  setSize,
  sweepPairedVideoLeftovers,
} from './library-db';
import { flushLogs, log, logError } from './log';
import { onNetworkChange, uploadAllowed, uploadAllowedRecently } from './network';
import {
  NetworkError,
  ServerError,
  StaleFileError,
  UploadInterrupted,
  flushShaCache,
  hashAndUpload,
  manifestCheck,
  stablePath,
  yieldToUI,
} from './upload-protocol';

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
// Automatic retries leave a failed backup alone this long after it failed:
// failures are now file-specific (connectivity pauses instead), and
// re-sending, say, a video the server rejects on every interval wastes data
// and holds up newer photos. "Back up" and Retry still retry right away.
export const FAILED_RETRY_MS = 6 * 60 * 60 * 1000;
// Scheduled retries for a picker/sync row before it is left to expire: a
// file the server rejects with a 5xx every time would otherwise be re-sent
// in full every FAILED_RETRY_MS forever.
const MAX_AUTO_RETRIES = 4;
// Background cut-offs a file may take, uncounted, before they count as
// ordinary interruptions.
const MAX_DEFERRALS = 3;

// When the app last left the foreground. A transfer that dies while the app
// is (or was) in the background was most likely cut off by iOS suspending
// it, which says nothing about the file — so it isn't counted as a failure.
let lastLeftForeground = 0;
try {
  // 'background' only: 'inactive' (Control Center, a system alert) doesn't
  // suspend anything.
  AppState.addEventListener('change', (state) => {
    if (state === 'background') lastLeftForeground = Date.now();
  });
} catch {
  // unavailable in some headless contexts; AppState.currentState still works
}
// Both platforms: iOS suspends a backgrounded app, and Android's cached-app
// freezer (Android 14+, many 12/13 devices) and Doze freeze it, killing the
// in-flight transfer either way. A file that fails on its own in the
// background can't loop unstruck: attempts are counted up front and capped
// by MAX_DEFERRALS.
function wasBackgroundedSince(since: number, startedInBackground: boolean): boolean {
  // startedInBackground: a wakeup's attempt never sees a 'background' event,
  // and its error may only surface after the app is opened again.
  return (
    startedInBackground || AppState.currentState === 'background' || lastLeftForeground >= since
  );
}
// Finished rows stick around so the queue screen can show what happened, but
// not forever.
const FINISHED_TTL_MS = 24 * 60 * 60 * 1000;
// Failed rows nobody retried or cleared: a deleted photo would otherwise keep
// the "failed" pill up forever. (Still-marked backups get re-queued.)
const FAILED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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
      // Automatic retry of cut-off picker/sync transfers (see settle()).
      const cols = await db.getAllAsync<{ name: string }>('PRAGMA table_info(uploads)');
      if (!cols.some((c) => c.name === 'retry_at')) {
        await db.execAsync('ALTER TABLE uploads ADD COLUMN retry_at INTEGER');
      }
      if (!cols.some((c) => c.name === 'strikes')) {
        await db.execAsync('ALTER TABLE uploads ADD COLUMN strikes INTEGER NOT NULL DEFAULT 0');
      }
      // Times a transfer was cut off by iOS backgrounding (see drain()).
      if (!cols.some((c) => c.name === 'deferrals')) {
        await db.execAsync('ALTER TABLE uploads ADD COLUMN deferrals INTEGER NOT NULL DEFAULT 0');
      }
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
// Bumped by clearAll (sign-out). Work that started under an earlier epoch —
// a sync scan's manifest, a slow backup enqueue — must not insert rows after
// the clear, or the next account to sign in would upload them.
let epoch = 0;
export function currentEpoch(): number {
  return epoch;
}
let runPromise: Promise<void> | null = null;
let stopRequested = false;
let stoppedByUser = false; // a Stop press, as opposed to the OS ending a run
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
export function enqueue(
  items: NewQueueItem[],
  opts: { epoch?: number } = {}
): Promise<number> {
  if (items.length === 0) return Promise.resolve(0);
  const startedIn = opts.epoch ?? epoch;
  return serialized(async () => {
    if (startedIn !== epoch) {
      log('queue', `dropped ${items.length} items enqueued before a sign-out`);
      return 0;
    }
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

    // One multi-row upsert per chunk instead of one statement per item — a
    // large batch (a big backup commit or first sync) is thousands of rows,
    // and per-row round trips through the async bridge starve the event loop
    // for the whole transaction.
    await db.withTransactionAsync(async () => {
      for (const rows of chunk(toQueue, 200)) {
        const values = rows.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', NULL, ?, ?)").join(', ');
        await db.runAsync(
          `INSERT INTO uploads (key, source, asset_id, local_uri, thumb_uri, filename, path, mtime, size, status, error, created_at, updated_at)
           VALUES ${values}
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
             retry_at = NULL,
             strikes = 0,
             -- A row still waiting for the same version keeps its deferral
             -- count: backup items are re-upserted on every auto-retry, and
             -- resetting it would put a file that keeps getting cut off back
             -- at the front.
             deferrals = CASE WHEN uploads.status IN ('queued', 'checking', 'hashing', 'uploading')
               AND uploads.mtime = excluded.mtime THEN uploads.deferrals ELSE 0 END,
             updated_at = excluded.updated_at`,
          ...rows.flatMap((item) => [
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
            now,
          ])
        );
      }
    });

    // Fanning an event out to every screen per item is the other per-item
    // cost; yield to the event loop periodically so a big batch can't jam JS
    // (frozen UI, stalled upload callbacks) for the whole loop.
    let emitted = 0;
    const emitYielding = async (item: QueueItem) => {
      emitItem(item);
      if (++emitted % 200 === 0) await yieldToUI();
    };
    for (const item of toQueue) {
      await emitYielding({
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
      await emitYielding(rowToItem(existing.get(item.key)));
    }
    await refreshAndBroadcast();
    return toQueue.filter((i) => !wasActive(i.key)).length;
  });
}

// Everything marked for backup in the library catalog that isn't known to be
// on the server yet. With includeSynced, locally-'synced' assets are queued
// too — the server manifest re-verifies them for free, which notices
// server-side data loss or a device re-registration (the local 'synced'
// status is only a display cache). That set grows with the whole backed-up
// history, so only deliberate re-verification flows should pass it — routine
// "Back up" presses and auto-retries must stay O(pending).
export async function enqueueBackupPending(
  opts: { includeSynced?: boolean; failedRetryAfterMs?: number; epoch?: number } = {}
): Promise<number> {
  const started = Date.now();
  const startedIn = opts.epoch ?? epoch;
  const assets = await markedForSync(opts);
  if (assets.length === 0) return 0;
  // Persist this line before the enqueue: if the process dies in there, the
  // debounced flush never runs and the log would go silent with no trace.
  log('queue', `enqueueing ${assets.length} backup candidates`);
  await flushLogs().catch(() => {});
  const queued = await enqueue(
    assets.map((a) => ({
      key: assetKey(a.id),
      source: 'backup' as const,
      assetId: a.id,
      thumbUri: a.uri,
      filename: a.filename,
      path: stablePath(a.id, a.filename),
      mtime: a.mtime,
      size: a.size,
    })),
    { epoch: startedIn }
  );
  log('queue', `backup enqueue done: ${queued} newly queued (${Date.now() - started}ms)`);
  return queued;
}

// Drop items that haven't finished (or started uploading bytes) — used when a
// photo is marked "won't upload". Scoped to the given source(s), so that
// can't cancel an upload another flow (a picker share) queued for the same
// asset. The item currently uploading is never removed;
// the drain also re-checks row existence before each file, so removal takes
// effect even for items already read into the active batch.
export async function removeQueued(
  keys: string[],
  source?: QueueSource | QueueSource[]
): Promise<void> {
  const sources = source === undefined ? [] : Array.isArray(source) ? source : [source];
  if (keys.length === 0) return;
  const db = await openDb();
  const remove = keys.filter((k) => k !== current?.key);
  if (remove.length === 0) return;
  for (const batch of chunk(remove, 400)) {
    const placeholders = batch.map(() => '?').join(',');
    await db.runAsync(
      `DELETE FROM uploads
       WHERE status IN ('queued', 'checking', 'failed') AND key IN (${placeholders})
       ${sources.length ? `AND source IN (${sources.map(() => '?').join(',')})` : ''}`,
      ...batch,
      ...sources
    );
  }
  await refreshAndBroadcast();
}

// Forget the queue entirely. Called on sign-out so the next account on this
// device can never drain (upload) the previous account's photos.
export async function clearAll(): Promise<void> {
  epoch++;
  resolvedThisRun.clear();
  stopRequested = true;
  pendingKick = false;
  session = null;
  const db = await openDb();
  // Behind any enqueue already holding the write chain, so its rows are
  // deleted rather than landing after the DELETE.
  await serialized(() => db.runAsync('DELETE FROM uploads'));
  pausedReason = null;
  await refreshAndBroadcast();
}

export async function retryFailed(): Promise<void> {
  const db = await openDb();
  const failed = await db.getAllAsync('SELECT * FROM uploads WHERE status = ?', 'failed');
  await db.runAsync(
    `UPDATE uploads SET status = 'queued', error = NULL, retry_at = NULL, strikes = 0, updated_at = ?
     WHERE status = 'failed'`,
    Date.now()
  );
  for (const row of failed) {
    emitItem({ ...rowToItem(row), status: 'queued', error: null });
  }
  await resetFailures(
    failed
      .map(rowToItem)
      .filter((i) => i.source === 'backup' && i.assetId)
      .map((i) => i.assetId!)
  );
  await refreshAndBroadcast();
  kick('retry-failed');
}

// Failures can be permanent (the photo was deleted, a picker copy purged),
// and retrying those only fails again — let the user dismiss them. Backup
// items whose photo still exists are re-queued by auto-retry once their
// backoff (FAILED_RETRY_MS) passes.
export async function clearFailed(): Promise<void> {
  const db = await openDb();
  await db.runAsync(`DELETE FROM uploads WHERE status = 'failed'`);
  await refreshAndBroadcast();
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
       deferrals,
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
  let info: Awaited<ReturnType<typeof assetInfo>>;
  try {
    info = await assetInfo(assetId);
    if (info.localUri) return info.localUri;
  } catch (err) {
    if (fallbackUri?.startsWith('file://')) return fallbackUri;
    throw err;
  }
  if (info.slowMotion) throw new Error("Slow-motion videos can't be backed up from the app yet");
  if (fallbackUri?.startsWith('file://')) return fallbackUri;
  throw new Error('Original not available on this device');
}

// A persisted localUri can go stale — picker items keep an ImagePicker
// temp-cache path the OS may purge — so verify it still exists before use
// and otherwise re-resolve from the media library via the assetId.
// Library paths resolved in this process, by queue key: lets the upload step
// reuse the stat step's lookup (each one has side effects on iOS) without
// persisting a path a later launch may not be allowed to read.
const resolvedThisRun = new Map<string, string>();

async function resolveLocalUri(item: QueueItem): Promise<string> {
  // A path outside the app's own folders (a Photos-library original that an
  // earlier build persisted) is only trusted when there's no asset to
  // re-resolve it from.
  const ownFile = [LegacyFileSystem.cacheDirectory, LegacyFileSystem.documentDirectory].some(
    (dir) => !!dir && !!item.localUri?.startsWith(dir)
  );
  if (item.localUri && (ownFile || !item.assetId || item.localUri === resolvedThisRun.get(item.key))) {
    try {
      const info = await LegacyFileSystem.getInfoAsync(item.localUri);
      if (info.exists) return item.localUri;
    } catch {
      // fall through to the media library
    }
  }
  if (!item.assetId) throw new Error('File is no longer available');
  const uri = await libraryLocalUri(item.assetId, item.thumbUri);
  resolvedThisRun.set(item.key, uri);
  return uri;
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
  lastProgressLog = Date.now();
  broadcastSummary();
}

let lastProgressBroadcast = 0;
// Heartbeat for transfers longer than ~10s: a process death mid-upload is
// otherwise a silent gap in the log as long as the whole transfer.
let lastProgressLog = 0;
function onUploadProgress(bytesSent: number, bytesTotal: number): void {
  if (!current) return;
  current.bytesSent = bytesSent;
  current.bytesTotal = bytesTotal;
  const now = Date.now();
  if (now - lastProgressBroadcast >= 300) {
    lastProgressBroadcast = now;
    broadcastSummary();
  }
  if (now - lastProgressLog >= 10_000) {
    lastProgressLog = now;
    log('upload', `progress ${current.filename}: ${bytesSent}/${bytesTotal} bytes`);
  }
}

// Terminal state for one item; mirrors the outcome into the library catalog
// so backup badges stay truthful. Failures are only mirrored for
// backup-selected items — a failed picker share or sync upload of a photo the
// user never selected shouldn't show up in the Backup screen's Failed count
// (which it couldn't retry anyway).
// The epoch the running drain started in. Its in-flight file can finish
// after a sign-out; that outcome belongs to the previous account and must not
// land in the catalog the next account has claimed.
let drainEpoch = 0;

// `retrySoon`: a failure that may not be the file's fault (the transfer was
// cut off), so automatic retries back off only if it happens again.
async function settle(
  item: QueueItem,
  status: 'done' | 'exists' | 'failed',
  error?: string,
  opts: { retrySoon?: boolean } = {}
) {
  item.error = error ?? null;
  const db = await openDb();
  const now = Date.now();
  // Backup items are retried through their catalog marks. Picker and sync
  // rows have nothing else to bring them back, so a cut-off transfer gets
  // its own schedule here: once right away, then after the usual backoff.
  const scheduleRetry = status === 'failed' && !!opts.retrySoon && item.source !== 'backup';
  await db.runAsync(
    `UPDATE uploads SET status = ?, error = ?, updated_at = ?,
       retry_at = ${
         scheduleRetry
           ? `CASE WHEN strikes = 0 THEN ? WHEN strikes < ${MAX_AUTO_RETRIES} THEN ? ELSE NULL END`
           : 'NULL'
       },
       strikes = ${status === 'failed' ? 'strikes + 1' : '0'},
       deferrals = 0
     WHERE key = ?`,
    status,
    item.error,
    now,
    ...(scheduleRetry ? [now, now + FAILED_RETRY_MS] : []),
    item.key
  );
  item.status = status;
  if (item.assetId && drainEpoch === epoch) {
    // Guarded by mtime so an upload of a photo's old version (edited
    // mid-upload) can't mark the new one backed up. Picker items skip the
    // guard: their mtime falls back to the temp copy's when the original's
    // can't be read, and would never match.
    const version = item.source === 'picker' ? undefined : item.mtime;
    if (status !== 'failed') {
      await markStatus(item.assetId, 'synced', null, version);
    } else if (item.source === 'backup') {
      await markStatus(item.assetId, 'failed', item.error, version, {
        backoff: opts.retrySoon ? 'repeat' : 'always',
      });
    }
  }
  // Track counts in memory rather than re-aggregating the table per item;
  // the drain re-syncs from the DB once per batch.
  counts.remaining = Math.max(0, counts.remaining - 1);
  if (status === 'failed') counts.failed++;
  else counts.finished++;
  if (current?.key === item.key) current = null;
  resolvedThisRun.delete(item.key);
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

// Finished and long-failed rows age out. Run by every drain and auto-retry
// — a queue with only failed rows never starts a drain.
async function pruneExpired(): Promise<void> {
  const db = await openDb();
  const now = Date.now();
  const finished = `status IN ('done', 'exists') AND updated_at < ?`;
  const failed = `status = 'failed' AND retry_at IS NULL AND updated_at < ?`;
  const expired = await db.getAllAsync<{ local_uri: string | null }>(
    `SELECT local_uri FROM uploads WHERE source = 'picker' AND ((${finished}) OR (${failed}))`,
    now - FINISHED_TTL_MS,
    now - FAILED_TTL_MS
  );
  await db.runAsync(`DELETE FROM uploads WHERE ${finished}`, now - FINISHED_TTL_MS);
  await db.runAsync(`DELETE FROM uploads WHERE ${failed}`, now - FAILED_TTL_MS);
  // The picker hands over a full copy of every pick (Caches/ImagePicker)
  // and nothing else ever deletes it; drop it with its row. Kept until then
  // so the share screen's thumbnails don't vanish the moment a file is done.
  for (const row of expired) await deletePickerCopy(row.local_uri);
  await sweepPickerCopies();
}

function isPickerCopy(uri: string | null): uri is string {
  const cache = LegacyFileSystem.cacheDirectory;
  return !!uri && !!cache && uri.startsWith(`${cache}ImagePicker/`);
}

async function deletePickerCopy(uri: string | null): Promise<void> {
  if (!isPickerCopy(uri)) return;
  await LegacyFileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
}

// Once per run: picks that never reached the queue (picked, not shared) or
// whose rows went away some other way (Clear done/failed, sign-out). Spares
// anything a row still references and anything from the last day, which
// the share screen may still be showing.
let pickerSweepDone = false;
async function sweepPickerCopies(): Promise<void> {
  if (pickerSweepDone || !LegacyFileSystem.cacheDirectory) return;
  pickerSweepDone = true;
  const dir = `${LegacyFileSystem.cacheDirectory}ImagePicker/`;
  try {
    const names = await LegacyFileSystem.readDirectoryAsync(dir);
    const db = await openDb();
    const referenced = new Set(
      (await db.getAllAsync<{ local_uri: string }>(
        `SELECT local_uri FROM uploads WHERE local_uri IS NOT NULL`
      )).map((r) => r.local_uri)
    );
    let removed = 0;
    for (const name of names) {
      const uri = dir + name;
      if (referenced.has(uri)) continue;
      const info = await LegacyFileSystem.getInfoAsync(uri);
      // modificationTime is in seconds.
      if (!info.exists || info.isDirectory || Date.now() - info.modificationTime * 1000 < FINISHED_TTL_MS) {
        continue;
      }
      await LegacyFileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
      removed++;
    }
    if (removed) log('queue', `removed ${removed} old picker copies`);
  } catch {
    // no picker directory yet
  }
}

// Put failed picker/sync rows whose scheduled retry is due back in the queue.
export async function requeueDueRetries(): Promise<void> {
  const db = await openDb();
  const now = Date.now();
  const rows = await db.getAllAsync(
    `SELECT * FROM uploads WHERE status = 'failed' AND retry_at IS NOT NULL AND retry_at <= ?`,
    now
  );
  if (rows.length === 0) return;
  await db.runAsync(
    `UPDATE uploads SET status = 'queued', error = NULL, retry_at = NULL, updated_at = ?
     WHERE status = 'failed' AND retry_at IS NOT NULL AND retry_at <= ?`,
    now,
    now
  );
  for (const row of rows) emitItem({ ...rowToItem(row), status: 'queued', error: null });
  log('queue', `re-queued ${rows.length} interrupted uploads`);
}

// A pause for connectivity says nothing about the file: give back the
// attempt counted up front, so network flaps don't use up its deferrals or
// push it behind the rest of the queue.
async function uncountAttempt(key: string): Promise<void> {
  const db = await openDb();
  await db
    .runAsync('UPDATE uploads SET deferrals = MAX(0, deferrals - 1) WHERE key = ?', key)
    .catch(() => {});
}

class Paused extends Error {}

async function drain(trigger: string, sess: Session): Promise<void> {
  const db = await openDb();
  await resetInFlight();
  await pruneExpired();
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
      // Files deferred by a background cut-off go behind everything else.
      `SELECT * FROM uploads WHERE status = 'queued' ORDER BY deferrals, rowid LIMIT ?`,
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
        // Resolving the file can download the original from iCloud, so the
        // network rule applies per item, not just once per batch.
        const permission = await uploadAllowedRecently();
        if (!permission.allowed) throw new Paused(permission.reason ?? 'Uploads paused');
        try {
          setCurrent(item, 'checking');
          const localUri = await resolveLocalUri(item);
          const stat = await LegacyFileSystem.getInfoAsync(localUri);
          if (!stat.exists || stat.size === undefined) throw new Error('Could not stat file');
          item.size = stat.size;
          // In memory only (resolvedThisRun): a Photos-library path is
          // resolved per run (iOS grants read access to it through PhotoKit
          // for this process), so persisting it could hand a later launch a
          // path it can't read.
          item.localUri = localUri;
          await db.runAsync('UPDATE uploads SET size = ? WHERE key = ?', stat.size, item.key);
          if (item.assetId) await setSize(item.assetId, stat.size);
        } catch (err) {
          logError('queue', `stat failed for ${item.filename}`, err);
          await settle(item, 'failed', String(err));
          continue;
        }
      }
      candidates.push(item);
    }
    // Nothing is in flight during the manifest; a lingering `current` would
    // make removeQueued() skip that item.
    current = null;
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
      const attemptStarted = Date.now();
      const startedInBackground = AppState.currentState === 'background';
      // Counted up front, not when the transfer dies: if iOS kills the
      // suspended process there is no rejection to count it in, and the file
      // would be first in line again on relaunch. settle() clears it.
      await db.runAsync('UPDATE uploads SET deferrals = deferrals + 1 WHERE key = ?', item.key);
      try {
        // Claim the item before resolving its file: that can take seconds
        // (iCloud download), and removeQueued() must not delete a row the
        // drain is about to upload anyway.
        setCurrent(item, 'hashing');
        const localUri = await resolveLocalUri(item);
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
          onUploadProgress,
          // Wi-Fi may have gone while a big file was hashing: don't start
          // a multi-GB transfer over mobile data.
          async () => {
            // A failing check (settings/NetInfo) says nothing about the file.
            const permission = await uploadAllowed().catch(() => ({
              allowed: false,
              reason: 'Could not check the network',
            }));
            if (!permission.allowed) {
              await uncountAttempt(item.key);
              throw new Paused(permission.reason ?? 'Uploads paused');
            }
          }
        );
        await settle(item, outcome === 'deduped' ? 'exists' : 'done');
      } catch (err) {
        if (err instanceof Paused) throw err;
        // Connectivity, not this file: leave it queued and pause. The JSON
        // steps carry nothing file-specific, so their transport failures
        // always count; a dead byte transfer only does when the device is
        // actually offline now — otherwise it may fail the same way every
        // time, and pausing on it would starve the rest of the queue.
        if (err instanceof NetworkError) {
          logError('queue', `network error on ${item.filename}, pausing queue`, err);
          await uncountAttempt(item.key);
          throw new Paused(`Connection problem: ${err.message}`);
        }
        const interrupted = err instanceof UploadInterrupted;
        if (interrupted) {
          const permission = await uploadAllowed().catch(() => null);
          if (permission && !permission.allowed) {
            logError('queue', `upload of ${item.filename} interrupted, pausing queue`, err);
            await uncountAttempt(item.key);
            throw new Paused(permission.reason ?? 'Uploads paused');
          }
          // Cut off while the app was in the background (iOS suspends it, or
          // a background-task window ended): not the file's fault, so leave it
          // queued with no strike — but behind the rest of the queue, so one
          // big video can't hold up everything after it. A file that keeps
          // getting cut off (too big to finish in any window, or failing on
          // its own) is treated as a normal interruption after a few tries.
          if (wasBackgroundedSince(attemptStarted, startedInBackground)) {
            const row = await db.getFirstAsync<{ deferrals: number }>(
              'SELECT deferrals FROM uploads WHERE key = ?',
              item.key
            );
            if ((row?.deferrals ?? 0) <= MAX_DEFERRALS) {
              logError('queue', `upload of ${item.filename} cut off in the background, pausing`, err);
              throw new Paused('Paused while the app was in the background');
            }
          }
        }
        if (err instanceof StaleFileError) {
          // Forget the recorded size so the retry re-reads the file as it is
          // now (the cached hash was already dropped).
          await db.runAsync('UPDATE uploads SET size = NULL WHERE key = ?', item.key);
          if (item.assetId) await setSize(item.assetId, null);
          resolvedThisRun.delete(item.key);
        }
        logError('queue', `failed ${item.filename}`, err);
        // A cut-off transfer while still online, or a server 5xx, may be a
        // blip (or a restart) as easily as this file: fail it so the queue
        // moves on, and let the next auto-retry try it once more before
        // backing off.
        await settle(item, 'failed', String(err), {
          retrySoon: interrupted || err instanceof ServerError || err instanceof StaleFileError,
        });
      }
    }
  }

  log('queue', stopRequested ? 'drain stopped' : 'drain complete', counts);
}

// Start the drain unless one is already going. Returns the run's promise so
// the background task can await the whole drain. A kick that lands while a
// drain is winding down (Stop pressed, or its final empty batch) isn't lost —
// it's remembered and honored as soon as the old drain exits.
// `auto`: an automatic trigger (background wakeup), which — unlike a tap —
// mustn't undo a Stop the user pressed while that drain winds down.
export function kick(trigger: string, opts: { auto?: boolean } = {}): Promise<void> {
  if (runPromise) {
    if (!(opts.auto && stoppedByUser)) pendingKick = true;
    return runPromise;
  }
  if (!session) return Promise.resolve();
  const sess = session;
  stopRequested = false;
  stoppedByUser = false;
  pausedReason = null;
  drainEpoch = epoch;
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
      current = null;
      try {
        await flushShaCache();
        sweepPairedVideoLeftovers({ force: true });
        await resetInFlight();
      } catch (err) {
        // Must not skip clearing runPromise below, or the queue would read
        // as running forever; the next drain resets in-flight rows anyway.
        logError('queue', 'drain cleanup failed', err);
      }
      // Only now: a kick during the cleanup above becomes a pending kick
      // instead of a new drain whose in-flight rows resetInFlight would
      // flip back to 'queued'.
      runPromise = null;
      await refreshAndBroadcast();
      if (pendingKick) {
        pendingKick = false;
        // The retry that set pendingKick skipped this step while the drain
        // ran; a transfer cut off at the end of it is due right away.
        await requeueDueRetries().catch(() => {});
        await refreshCounts().catch(() => {});
        // Skipped if a drain started during the awaits above (and may since
        // have been Stopped by the user — don't override that).
        if (counts.remaining > 0 && session && !runPromise) kick(`${trigger}+pending`);
      }
    });
  broadcastSummary();
  return runPromise;
}

// Resolves once no drain is running. A kick that lands while one runs
// returns THAT drain's promise, and the drain it queues up (pendingKick)
// starts only as the old one ends — so awaiting kick() alone can return
// while the real work has just begun. The background task must outlast it:
// the OS freezes the process as soon as the task resolves.
export async function waitForIdle(): Promise<void> {
  while (runPromise) await runPromise;
}

// Stop after the current file; everything else stays queued (auto-retry or
// the next manual kick resumes it). `byUser: false` is for the OS ending a
// background window — an auto-retry arriving meanwhile resumes right after.
export function stop(opts: { byUser?: boolean } = {}): void {
  if (!runPromise) return;
  stopRequested = true;
  stoppedByUser = opts.byUser ?? true;
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
    // Pinned at entry: a sign-out during the awaits below must make the
    // enqueue a no-op rather than re-insert the old account's marks.
    const startedIn = epoch;
    try {
      if (!session) return;
      // A drain winding down (e.g. stopped when the background window
      // expired) would otherwise swallow this retry until the next interval.
      if (runPromise) {
        // ...but a Stop press gets to finish winding down first.
        if (!stoppedByUser) pendingKick = true;
        return;
      }
      // Cheap aggregate first; the full selected-assets fetch only runs when
      // something is actually marked for backup but not uploaded.
      const catalog = await libraryCounts();
      if (catalog.pending > 0) {
        await enqueueBackupPending({ failedRetryAfterMs: FAILED_RETRY_MS, epoch: startedIn });
      }
      if (startedIn !== epoch) return;
      await requeueDueRetries();
      await pruneExpired();
      await refreshAndBroadcast();
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
    // with clearAll().) Not a user Stop: a quick re-sign-in's startup
    // retry should still resume once this drain winds down.
    stop({ byUser: false });
    session = null;
  };
}
