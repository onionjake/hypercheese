import * as LegacyFileSystem from 'expo-file-system/legacy';
import { AppState } from 'react-native';

// Persistent debug log for the upload/sync flows. Lines accumulate in memory
// and are flushed (whole current chunk) to disk on a short debounce; chunks
// rotate so the log is bounded. exportLogs() gzips everything for sharing
// from the profile screen.

const LOG_DIR = `${LegacyFileSystem.documentDirectory}logs/`;
const CHUNK_BYTES = 256 * 1024;
const MAX_CHUNKS = 6; // ~1.5 MB of history
const FLUSH_MS = 1500;

let chunkIndex: number | null = null; // highest existing chunk number
let current = ''; // contents of the newest chunk
let dirty = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let initPromise: Promise<void> | null = null;
let generation = 0; // bumped by clearLogs so an in-flight flush discards itself

function chunkUri(index: number): string {
  return `${LOG_DIR}log.${index}.txt`;
}

async function init(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      // log() runs before this first disk read finishes (the "started" line
      // at bundle load always does), buffering lines into `current` — append
      // them after the disk contents rather than replacing (losing) them.
      try {
        await LegacyFileSystem.makeDirectoryAsync(LOG_DIR, { intermediates: true });
        const names = await LegacyFileSystem.readDirectoryAsync(LOG_DIR);
        const indexes = names
          .map((n) => n.match(/^log\.(\d+)\.txt$/))
          .filter(Boolean)
          .map((m) => Number(m![1]))
          .sort((a, b) => a - b);
        chunkIndex = indexes.length ? indexes[indexes.length - 1] : 0;
        const disk = indexes.length
          ? await LegacyFileSystem.readAsStringAsync(chunkUri(chunkIndex)).catch(() => '')
          : '';
        current = disk + current;
      } catch {
        chunkIndex = 0;
      }
    })();
  }
  return initPromise;
}

async function flush(): Promise<void> {
  const gen = generation;
  await init();
  if (gen !== generation || !dirty || chunkIndex === null) return;
  dirty = false;
  try {
    await LegacyFileSystem.writeAsStringAsync(chunkUri(chunkIndex), current);
    if (current.length >= CHUNK_BYTES) {
      chunkIndex++;
      current = '';
      const stale = chunkIndex - MAX_CHUNKS;
      if (stale >= 0) {
        await LegacyFileSystem.deleteAsync(chunkUri(stale), { idempotent: true }).catch(() => {});
      }
    }
  } catch {
    // Logging must never break the app.
  }
}

export function log(tag: string, message: string, extra?: unknown): void {
  let line = `${new Date().toISOString()} [${tag}] ${message}`;
  if (extra !== undefined) {
    try {
      line += ` ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`;
    } catch {
      line += ` ${String(extra)}`;
    }
  }
  if (__DEV__) console.log(line);
  current += line + '\n';
  dirty = true;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flush();
    }, FLUSH_MS);
  }
}

export function logError(tag: string, message: string, err: unknown): void {
  const detail =
    err instanceof Error ? `${err.message}${err.stack ? `\n${err.stack}` : ''}` : String(err);
  log(tag, `${message}: ${detail}`);
}

// Write pending lines to disk immediately, skipping the debounce. Used when
// the process may be about to die.
export function flushLogs(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  return flush();
}

// Delete all history so the next export contains only what happens after
// this point (clear → reproduce the issue → export).
export async function clearLogs(): Promise<void> {
  await init();
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  dirty = false;
  generation++;
  const last = chunkIndex ?? 0;
  for (let i = Math.max(0, last - MAX_CHUNKS + 1); i <= last; i++) {
    await LegacyFileSystem.deleteAsync(chunkUri(i), { idempotent: true }).catch(() => {});
  }
  chunkIndex = 0;
  current = '';
  log('log', 'logs cleared');
}

// Record bundle startup and hook fatal errors / unhandled rejections into the
// debug log. A crash previously left no trace — the log just went silent —
// so flush before handing off to the default handler (which kills the app in
// production). The startup line also makes restarts-after-crash visible:
// silence followed by "started" reads as a process death.
let crashLoggingInstalled = false;

export function installCrashLogging(): void {
  if (crashLoggingInstalled) return;
  crashLoggingInstalled = true;
  log('app', 'started (bundle loaded)');
  // An ANR or OOM kill never reaches the JS handlers below — the only
  // evidence is what made it to disk beforehand. Persist the start marker
  // immediately instead of waiting out the flush debounce.
  flushLogs().catch(() => {});
  // Record foreground/background moves so a silent gap in the log can be
  // told apart from the user simply leaving the app.
  try {
    AppState.addEventListener('change', (state) => log('app', `app state: ${state}`));
  } catch {
    // unavailable in some headless contexts
  }
  // A frozen JS thread (big synchronous read, GC storm) shows up as missed
  // timer ticks. OS-suspended timers land here too — read these lines
  // alongside the app-state ones.
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const stall = now - lastTick - 1000;
    if (stall > 2000) log('app', `js thread stalled ~${(stall / 1000).toFixed(1)}s`);
    lastTick = now;
  }, 1000);
  const errorUtils = (globalThis as { ErrorUtils?: any }).ErrorUtils;
  if (errorUtils?.setGlobalHandler) {
    const prev = errorUtils.getGlobalHandler?.();
    errorUtils.setGlobalHandler((err: unknown, isFatal?: boolean) => {
      logError('crash', isFatal ? 'FATAL uncaught error' : 'uncaught error', err);
      flushLogs().finally(() => prev?.(err, isFatal));
    });
  }
  // In dev, LogBox already owns rejection tracking; don't fight it.
  if (!__DEV__) {
    const hermes = (globalThis as { HermesInternal?: any }).HermesInternal;
    hermes?.enablePromiseRejectionTracker?.({
      allRejections: true,
      onUnhandled: (_id: number, err: unknown) => {
        logError('crash', 'unhandled promise rejection', err);
      },
    });
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return globalThis.btoa(bin);
}

// Concatenate all chunks (oldest first), gzip, and write the archive to the
// cache directory. Returns the file uri to hand to the share sheet.
export async function exportLogs(): Promise<string> {
  await init();
  await flush();
  const pako = await import('pako');

  let text = '';
  if (chunkIndex !== null) {
    for (let i = Math.max(0, chunkIndex - MAX_CHUNKS + 1); i < chunkIndex; i++) {
      text += await LegacyFileSystem.readAsStringAsync(chunkUri(i)).catch(() => '');
    }
  }
  text += current;
  if (!text) text = '(log is empty)\n';

  const gz = pako.gzip(text);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const uri = `${LegacyFileSystem.cacheDirectory}instacheese-debug-${stamp}.log.gz`;
  await LegacyFileSystem.writeAsStringAsync(uri, bytesToBase64(gz), {
    encoding: LegacyFileSystem.EncodingType.Base64,
  });
  return uri;
}
