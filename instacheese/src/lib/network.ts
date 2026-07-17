import NetInfo from '@react-native-community/netinfo';

import { log } from './log';
import { getSettings } from './settings';

// Uploads are restricted to un-metered Wi-Fi unless the user has opted in to
// mobile data. NetInfo's isConnectionExpensive reflects Android's "metered"
// flag (and iOS's expensive/constrained paths), which covers Wi-Fi networks
// marked as metered.
//
// NetInfo.fetch() answers from NetInfo's internal cache, which goes stale on
// Android when capability changes (like the metered flag flipping) arrive
// while the app is backgrounded — the OS doesn't deliver network callbacks to
// cached apps, so the cache keeps saying "metered" until the process is
// killed. refresh() re-queries the platform every time, and this gate only
// runs at drain/batch boundaries, so the extra native round-trip is cheap.

export interface UploadPermission {
  allowed: boolean;
  reason: string | null; // human-readable, shown in the UI when not allowed
}

export async function uploadAllowed(): Promise<UploadPermission> {
  const [settings, state] = await Promise.all([getSettings(), NetInfo.refresh()]);
  const summary = `type=${state.type} expensive=${String(
    state.details && 'isConnectionExpensive' in state.details
      ? state.details.isConnectionExpensive
      : 'unknown'
  )} cellularOk=${settings.uploadOnCellular}`;

  if (!state.isConnected) {
    log('network', `uploads blocked: offline (${summary})`);
    return { allowed: false, reason: 'No network connection' };
  }
  if (settings.uploadOnCellular) {
    return { allowed: true, reason: null };
  }
  if (state.type !== 'wifi') {
    log('network', `uploads blocked: not on Wi-Fi (${summary})`);
    return { allowed: false, reason: 'Waiting for Wi-Fi (or enable mobile data uploads)' };
  }
  if (state.details?.isConnectionExpensive) {
    log('network', `uploads blocked: metered Wi-Fi (${summary})`);
    return { allowed: false, reason: 'This Wi-Fi is marked as metered' };
  }
  return { allowed: true, reason: null };
}

// Fires when connectivity changes in a way that might newly allow uploads.
export function onNetworkChange(fn: () => void): () => void {
  return NetInfo.addEventListener(() => fn());
}
