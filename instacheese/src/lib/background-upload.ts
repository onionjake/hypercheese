import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { Platform } from 'react-native';

import { loadStoredSession } from './auth';
import { flushLogs, log, logError } from './log';
import { refreshMarkReminderInBackground } from './mark-reminder';
import * as queue from './upload-queue';

// Periodic background drain of the upload queue, so photos queued for upload
// keep going after the user leaves the app. Android schedules this through
// WorkManager, iOS through BGTaskScheduler — in both cases the OS decides the
// actual timing, treating minimumInterval as a floor. Combined with the
// persistent queue and the manifest protocol, an interrupted run just resumes
// on the next wakeup (or the next foreground).

export const UPLOAD_TASK = 'instacheese-upload-queue';

// Tasks must be defined in module scope so headless background launches (no
// React tree) still find them — this module is imported from the app entry.
TaskManager.defineTask(UPLOAD_TASK, async () => {
  try {
    // A sign-out while the keychain read is in flight must not hand the
    // queue the signed-out account's credentials.
    const startedIn = queue.currentEpoch();
    const stored = await loadStoredSession();
    // Same gate as the foreground flows: only drain for a user known to have
    // write permission (a null cached user means we couldn't verify — skip).
    if (!stored?.user?.can_write) {
      log('bg', 'background wakeup skipped: no signed-in writer');
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    if (queue.currentEpoch() !== startedIn) {
      log('bg', 'background wakeup skipped: signed out meanwhile');
      return BackgroundTask.BackgroundTaskResult.Success;
    }
    log('bg', 'background drain woke up');
    queue.setSession({ baseUrl: stored.baseUrl, mode: stored.mode, token: stored.token });
    // Same work an in-app auto-retry does: re-queue anything marked for
    // backup, then drain until done, paused (network), or the OS calls time.
    await queue.enqueueBackupPending({
      failedRetryAfterMs: queue.FAILED_RETRY_MS,
      epoch: startedIn,
    });
    await queue.requeueDueRetries();
    await queue.kick('background');
    // Piggyback on the wakeup: freshen the catalog and keep the nightly
    // mark reminder's count/schedule current while the app stays closed.
    await refreshMarkReminderInBackground();
    log('bg', 'background wakeup done');
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch (err) {
    logError('bg', 'background drain failed', err);
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    // A headless launch is torn down as soon as this resolves — well inside
    // the flush debounce — so everything logged above would be dropped and
    // the run would show up in the export as a bare "started" line with
    // nothing after it. Force it to disk before handing back to the OS.
    await flushLogs().catch(() => {});
  }
});

// iOS can end the background window at any point; ask the engine to stop
// after the current file so state lands cleanly in the queue DB.
if (Platform.OS === 'ios') {
  try {
    BackgroundTask.addExpirationListener(() => queue.stop({ byUser: false }));
  } catch {
    // Older native builds without the listener just get interrupted; the
    // queue's stale-state reset handles that on the next drain.
  }
}

export async function registerBackgroundUploads(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) {
      log('bg', `background tasks unavailable (status ${String(status)})`);
      return;
    }
    await BackgroundTask.registerTaskAsync(UPLOAD_TASK, { minimumInterval: 15 });
    log('bg', 'background upload task registered');
  } catch (err) {
    // Likely an app build that predates the background-task native module.
    logError('bg', 'could not register background task', err);
  }
}

export async function unregisterBackgroundUploads(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(UPLOAD_TASK)) {
      await BackgroundTask.unregisterTaskAsync(UPLOAD_TASK);
      log('bg', 'background upload task unregistered');
    }
  } catch (err) {
    logError('bg', 'could not unregister background task', err);
  }
}
