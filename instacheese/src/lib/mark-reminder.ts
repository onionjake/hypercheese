import * as MediaLibrary from 'expo-media-library/legacy';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { libraryCounts, refreshFromLibrary } from './library-db';
import { log, logError } from './log';
import { getSettings, updateSettings } from './settings';

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

async function ensureChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync(CHANNEL_ID, {
    name: 'Nightly mark reminder',
    importance: Notifications.AndroidImportance.DEFAULT,
  });
}

export async function cancelMarkReminder(): Promise<void> {
  try {
    await Notifications.cancelScheduledNotificationAsync(REMINDER_ID);
  } catch (err) {
    logError('reminder', 'could not cancel reminder', err);
  }
}

// Re-derive the schedule from current state: a daily 9pm notification with
// the current unmarked count, or nothing when the pool is empty. Pass the
// count if the caller just computed it; otherwise it's read from the catalog.
export async function refreshMarkReminder(unmarked?: number): Promise<void> {
  try {
    if (!(await getSettings()).nightlyMarkReminder) return;
    const permission = await Notifications.getPermissionsAsync();
    if (!permission.granted) return;

    const count = unmarked ?? (await libraryCounts()).unmarked;
    // Cancel-then-schedule (rather than relying on identifier replacement)
    // so a count that dropped to zero removes the pending notification.
    await Notifications.cancelScheduledNotificationAsync(REMINDER_ID);
    if (count <= 0) return;

    await ensureChannel();
    await Notifications.scheduleNotificationAsync({
      identifier: REMINDER_ID,
      content: {
        title: 'Photos waiting to be marked',
        body:
          count === 1
            ? '1 photo in your library still needs a Back up or Won’t upload decision.'
            : `${count} photos in your library still need a Back up or Won’t upload decision.`,
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DAILY,
        hour: REMINDER_HOUR,
        minute: 0,
        channelId: CHANNEL_ID,
      },
    });
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
      const media = await MediaLibrary.getPermissionsAsync();
      if (media.granted) {
        try {
          await refreshFromLibrary();
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
