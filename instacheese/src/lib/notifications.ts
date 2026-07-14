import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import * as api from './api';
import type { Session } from './api';

const TOKEN_STORAGE_KEY = 'instacheese.pushToken';

// Show bullhorn notifications even while the app is in the foreground.
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: false,
    shouldSetBadge: false,
  }),
});

// Registers this device with the server so it receives a push notification
// when someone bullhorns a photo. Safe to call on every app start — the
// server upserts by token. No-ops (quietly) on iOS, emulators without
// Google services, builds without google-services.json, or if the user
// declines the notification permission.
export async function registerForPushNotifications(session: Session): Promise<void> {
  if (Platform.OS !== 'android' || !Device.isDevice) return;

  try {
    // The server targets this channel in its FCM messages.
    await Notifications.setNotificationChannelAsync('default', {
      name: 'Bullhorns',
      importance: Notifications.AndroidImportance.DEFAULT,
    });

    let { status } = await Notifications.getPermissionsAsync();
    if (status !== 'granted') {
      ({ status } = await Notifications.requestPermissionsAsync());
    }
    if (status !== 'granted') return;

    const token = (await Notifications.getDevicePushTokenAsync()).data as string;
    await api.registerPushToken(session, token, Platform.OS);
    await SecureStore.setItemAsync(TOKEN_STORAGE_KEY, token);
  } catch (err) {
    // Push is a nice-to-have; never let it break sign-in or startup.
    console.warn('Push notification registration failed:', err);
  }
}

// Tells the server to forget this device. Called on sign-out, before the
// session is discarded.
export async function unregisterForPushNotifications(session: Session): Promise<void> {
  try {
    const token = await SecureStore.getItemAsync(TOKEN_STORAGE_KEY);
    if (!token) return;
    await api.unregisterPushToken(session, token);
    await SecureStore.deleteItemAsync(TOKEN_STORAGE_KEY);
  } catch (err) {
    console.warn('Push notification unregistration failed:', err);
  }
}

// The item to open when the user taps a notification, if any.
export function itemIdFromResponse(
  response: Notifications.NotificationResponse | null | undefined
): number | null {
  const raw = response?.notification.request.content.data?.item_id;
  const id = typeof raw === 'string' ? parseInt(raw, 10) : NaN;
  return Number.isFinite(id) ? id : null;
}
