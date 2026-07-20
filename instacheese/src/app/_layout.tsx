import * as Notifications from 'expo-notifications';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme, View } from 'react-native';

import UploadIndicator from '@/components/upload-indicator';
import { AuthProvider, useAuth } from '@/lib/auth';
import {
  registerBackgroundUploads,
  unregisterBackgroundUploads,
} from '@/lib/background-upload';
import { cancelMarkReminder, registerMarkReminder, REMINDER_ID } from '@/lib/mark-reminder';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { status, user } = useAuth();
  const segments = useSegments();
  const router = useRouter();

  useEffect(() => {
    if (status === 'loading') return;
    SplashScreen.hideAsync();
    const onLogin = segments[0] === 'login';
    if (status === 'signedOut' && !onLogin) {
      router.replace('/login');
    } else if (status === 'signedIn' && onLogin) {
      router.replace('/');
    }
  }, [status, segments, router]);

  // The OS periodically wakes the upload queue while the app is closed; only
  // worth scheduling (and keeping scheduled) for a signed-in user. Same for
  // the nightly mark reminder (which also owns the permission prompt).
  useEffect(() => {
    if (status === 'signedIn') {
      registerBackgroundUploads();
      // Only writers can mark photos, so read-only accounts get neither the
      // reminder nor its notification-permission prompt.
      if (user?.can_write) registerMarkReminder();
    } else if (status === 'signedOut') {
      unregisterBackgroundUploads();
      cancelMarkReminder();
    }
  }, [status, user?.can_write]);

  // Tapping the nightly reminder lands on the library screen it's nagging
  // about. useLastNotificationResponse covers both warm taps and cold starts;
  // wait for signedIn so the auth redirect doesn't immediately bounce us.
  const notificationResponse = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (status !== 'signedIn') return;
    if (notificationResponse?.notification.request.identifier === REMINDER_ID) {
      router.push('/library');
    }
  }, [notificationResponse, status, router]);

  return (
    <View style={{ flex: 1 }}>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="login" />
        <Stack.Screen name="item/[id]" options={{ headerShown: true, title: '' }} />
        <Stack.Screen
          name="queue"
          options={{ headerShown: true, title: 'Uploads', presentation: 'modal' }}
        />
      </Stack>
      {/* Floating upload progress pill, on every screen. */}
      <UploadIndicator />
    </View>
  );
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <AuthProvider>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <RootNavigator />
      </ThemeProvider>
    </AuthProvider>
  );
}
