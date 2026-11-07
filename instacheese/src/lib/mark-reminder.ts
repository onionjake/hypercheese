import * as MediaLibrary from 'expo-media-library/legacy';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { loadStoredSession } from './auth';
import { libraryCounts, refreshFromLibrary } from './library-db';
import { log, logError } from './log';
import { getSettings, updateSettings } from './settings';
import { MEDIA_PERMISSIONS } from './upload-protocol';

// Nightly nudge to triage the camera roll: a local notification around 9pm
// saying how many photos still need a Back up / Won't upload decision. The
// count is baked into the notification at schedule time, so every place the
// unmarked pool can change re-schedules (or cancels) the reminder: the
// library screen after scans and batch actions, sign-in, and the periodic
// background task. When nothing needs marking there is no notification at
// all — the reminder is cancelled, not shown with a zero.

export const REMINDER_ID = 'nightly-mark-reminder';
const CHANNEL_ID = 'mark-reminder';
const REMINDER_HOUR = 21; // "around 9pm is fine" — the OS may drift a little

// Photos taken during the day only enter the catalog via a library scan,
// which normally happens when the library screen opens. So the background
// task rescans before the evening reminder fires — throttled, because a full
// catalog pass is more work than the OS background window owes us.
const BACKGROUND_RESCAN_INTERVAL = 4 * 60 * 60 * 1000;

// The reminder targets someone away from the app; while they're actively in
// it there's nothing to interrupt with (the library tab shows live counts).
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: false,
    shouldShowList: false,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Once per process: re-creating an existing channel changes nothing (Android
// ignores an app's later importance changes) but still costs an IPC to the
// notification service on every schedule. Nothing in the app deletes it, and
// users can only disable a channel, not remove it.
let channelReady = false;
async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android' || channelReady) return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Nightly mark reminder',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
  channelReady = true;
}

// Schedule changes run one at a time, in call order. Each refresh is a
// cancel-then-schedule over several native awaits; overlapping, a refresh
// that read the setting (or a non-zero count) before a sign-out, a toggle-off
// or the last photo being marked could schedule AFTER the cancel that
// followed it — a reminder left firing nightly after sign-out, with the
// setting off, or with a count when nothing needs marking.
let scheduleChain: Promise<void> = Promise.resolve();
function serialized(fn: () => Promise<void>): Promise<void> {
  const run = scheduleChain.then(fn, fn);
  scheduleChain = run.catch(() => {});
  return run;
}

// The library screen refreshes on every tap and queue settle. Each refresh
// is a handful of native round trips (Keystore read, permission check,
// cancel and schedule broadcasts), so a burst of taps used to queue dozens of
// them, all re-deriving the same reminder. Refreshes still waiting their turn
// are therefore merged: a new one joins the queued one (latest count wins),
// so at most one runs and one waits. Only the last refresh's result ever
// mattered — each one replaces the schedule wholesale.
let queuedRefresh: { unmarked: number | undefined; dropped: boolean; run: Promise<void> } | null =
  null;

// What this process last left scheduled: the reminder's body, null for
// nothing, undefined when unknown (process start, or a change that failed
// partway). Only touched inside the chain. A refresh that would leave
// exactly this in place skips its native calls — re-running it could only
// cancel and re-schedule the same content, or (signed out, setting off, no
// permission) leave it alone, which is what skipping does. Sign-out and
// toggle-off still always cancel. Nothing else in the app cancels or
// schedules this reminder, so the record can't go stale while the process
// lives; a new process starts from unknown and does the full refresh.
let scheduledBody: string | null | undefined;

function reminderBody(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 photo in your library still needs a Back up or Won’t upload decision.'
    : `${count} photos in your library still need a Back up or Won’t upload decision.`;
}

export function cancelMarkReminder(): Promise<void> {
  // A refresh still waiting ahead of this cancel can be dropped: whatever it
  // would schedule, this cancel removes right after.
  if (queuedRefresh) queuedRefresh.dropped = true;
  queuedRefresh = null;
  return serialized(async () => {
    try {
      scheduledBody = undefined;
      await Notifications.cancelScheduledNotificationAsync(REMINDER_ID);
      scheduledBody = null;
    } catch (err) {
      logError('reminder', 'could not cancel reminder', err);
    }
  });
}

// Re-derive the schedule from current state: a daily 9pm notification with
// the current unmarked count, or nothing when the pool is empty. Pass the
// count if the caller just computed it; otherwise it's read from the catalog.
export function refreshMarkReminder(unmarked?: number): Promise<void> {
  if (queuedRefresh) {
    queuedRefresh.unmarked = unmarked;
    return queuedRefresh.run;
  }
  const entry = { unmarked, dropped: false, run: Promise.resolve() };
  queuedRefresh = entry;
  entry.run = serialized(async () => {
    // Started: later calls queue a new refresh behind this one.
    if (queuedRefresh === entry) queuedRefresh = null;
    if (entry.dropped) return;
    await scheduleMarkReminder(entry.unmarked);
  });
  return entry.run;
}

async function scheduleMarkReminder(unmarked?: number): Promise<void> {
  try {
    // Already scheduled exactly so (see scheduledBody): nothing to do.
    if (
      unmarked !== undefined &&
      scheduledBody !== undefined &&
      reminderBody(unmarked) === scheduledBody
    ) {
      return;
    }
    if (!(await getSettings()).nightlyMarkReminder) return;
    // Signed out: a refresh still in flight from before the sign-out (the
    // background task finishing its drain, a Back up press still awaiting
    // its enqueue) runs after sign-out's cancel, and the catalog it would
    // count survives sign-out — it would re-arm a nightly reminder nobody
    // can act on. Sign-out deletes the stored session before it cancels.
    if (!(await loadStoredSession())) return;
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return;

    const count = unmarked ?? (await libraryCounts()).unmarked;
    const body = reminderBody(count);
    if (scheduledBody !== undefined && body === scheduledBody) return;
    // Cancel-then-schedule (rather than relying on identifier replacement)
    // so a count that dropped to zero removes the pending notification.
    scheduledBody = undefined;
    await Notifications.cancelScheduledNotificationAsync(REMINDER_ID);
    scheduledBody = null;
    if (body === null) return;

    scheduledBody = undefined;
    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      identifier: REMINDER_ID,
      content: {
        title: 'Photos waiting to be marked',
        body,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: REMINDER_HOUR,
        minute: 0,
        channelId: CHANNEL_ID,
      },
    });
    scheduledBody = body;
  } catch (err) {
    // An app build predating the notifications native module lands here; the
    // rest of the app must keep working without the reminder.
    logError('reminder', 'could not schedule reminder', err);
  }
}

// Foreground entry point (sign-in, or turning the setting on): this is the
// only place allowed to show the OS permission prompt.
export async function registerMarkReminder(): Promise<void> {
  try {
    if (!(await getSettings()).nightlyMarkReminder) return;
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) {
      await Notifications.requestPermissionsAsync();
    }
    await refreshMarkReminder();
  } catch (err) {
    logError('reminder', 'could not register reminder', err);
  }
}

// Background entry point: freshen the catalog first (permission-gated and
// throttled — never prompts) so the evening count includes photos taken since
// the app was last opened, then re-schedule.
export async function refreshMarkReminderInBackground(): Promise<void> {
  try {
    const settings = await getSettings();
    if (!settings.nightlyMarkReminder) return;
    if (!(await Notifications.getPermissionsAsync()).granted) return;

    const now = Date.now();
    if (now - settings.reminderLastScan > BACKGROUND_RESCAN_INTERVAL) {
      const media = await MediaLibrary.getPermissionsAsync(false, MEDIA_PERMISSIONS);
      if (media.granted) {
        try {
          await refreshFromLibrary({ requestPermission: false });
          await updateSettings({ reminderLastScan: now });
          log('reminder', 'background library rescan complete');
        } catch (err) {
          // A cut-short scan leaves the catalog usable (upserts per page);
          // schedule from whatever we have.
          logError('reminder', 'background library rescan failed', err);
        }
      }
    }
    await refreshMarkReminder();
  } catch (err) {
    logError('reminder', 'background reminder refresh failed', err);
  }
}
