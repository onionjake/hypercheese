import { AppState } from 'react-native';

import { type Session } from './api';
import { libraryCounts } from './library-db';
import { log } from './log';
import { onNetworkChange, uploadAllowed } from './network';
import {
  startPartialSync,
  type PartialSyncHandle,
  type PartialSyncStatus,
} from './partial-sync';

// Single owner of the partial-sync run, shared by the Backup screen and the
// automatic retry. Anything marked for upload ('pending' in the catalog)
// is retried periodically while the app is open — on a timer, when the app
// returns to the foreground, and when connectivity changes to something
// uploads are allowed on.

const RETRY_INTERVAL_MS = 15 * 60 * 1000;

type StatusListener = (status: PartialSyncStatus | null) => void;
type AssetListener = (id: string, status: 'synced' | 'failed' | 'pending', error?: string) => void;

let currentStatus: PartialSyncStatus | null = null;
let handle: PartialSyncHandle | null = null;
const statusListeners = new Set<StatusListener>();
const assetListeners = new Set<AssetListener>();

export function getStatus(): PartialSyncStatus | null {
  return currentStatus;
}

export function isRunning(): boolean {
  return currentStatus?.phase === 'running';
}

export function subscribeStatus(fn: StatusListener): () => void {
  statusListeners.add(fn);
  return () => statusListeners.delete(fn);
}

export function subscribeAssets(fn: AssetListener): () => void {
  assetListeners.add(fn);
  return () => assetListeners.delete(fn);
}

function broadcast(status: PartialSyncStatus): void {
  currentStatus = status;
  statusListeners.forEach((fn) => fn(status));
}

// Starts a run unless one is already going. When uploads aren't allowed on
// the current network, broadcasts a 'paused' status instead of starting.
export async function start(session: Session, trigger: string): Promise<void> {
  if (isRunning()) return;
  const permission = await uploadAllowed();
  if (!permission.allowed) {
    log('backup', `not starting (${trigger}): ${permission.reason}`);
    broadcast({
      phase: 'paused',
      activity: permission.reason ?? 'Uploads paused',
      counts: { selected: 0, checked: 0, upToDate: 0, uploaded: 0, deduped: 0, failed: 0 },
      lastError: null,
    });
    return;
  }
  log('backup', `starting run (${trigger})`);
  handle = startPartialSync(session, broadcast, (id, status, error) =>
    assetListeners.forEach((fn) => fn(id, status, error))
  );
}

export function cancel(): void {
  handle?.cancel();
}

async function maybeAutoStart(session: Session, trigger: string): Promise<void> {
  if (isRunning()) return;
  const counts = await libraryCounts();
  if (counts.pending === 0) return;
  await start(session, `auto:${trigger} (${counts.pending} pending)`);
}

// Call once per signed-in session; returns a cleanup function.
export function startAutoRetry(session: Session): () => void {
  const interval = setInterval(() => maybeAutoStart(session, 'interval'), RETRY_INTERVAL_MS);

  const appState = AppState.addEventListener('change', (state) => {
    if (state === 'active') maybeAutoStart(session, 'foreground');
  });

  // Debounce network flaps a little before retrying.
  let networkTimer: ReturnType<typeof setTimeout> | null = null;
  const unNetwork = onNetworkChange(() => {
    if (networkTimer) clearTimeout(networkTimer);
    networkTimer = setTimeout(() => maybeAutoStart(session, 'network-change'), 3000);
  });

  return () => {
    clearInterval(interval);
    appState.remove();
    if (networkTimer) clearTimeout(networkTimer);
    unNetwork();
  };
}
