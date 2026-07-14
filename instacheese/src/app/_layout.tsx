import { DarkTheme, DefaultTheme, Stack, ThemeProvider, useRouter, useSegments } from 'expo-router';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { AuthProvider, useAuth } from '@/lib/auth';
import { itemIdFromResponse, registerForPushNotifications } from '@/lib/notifications';

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { status, session } = useAuth();
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

  useEffect(() => {
    if (status === 'signedIn' && session) {
      registerForPushNotifications(session);
    }
  }, [status, session]);

  // Tapping a bullhorn notification opens the item it's about.
  const notificationResponse = Notifications.useLastNotificationResponse();
  useEffect(() => {
    if (status !== 'signedIn') return;
    const itemId = itemIdFromResponse(notificationResponse);
    if (itemId) {
      router.push({ pathname: '/item/[id]', params: { id: String(itemId) } });
    }
  }, [notificationResponse, status, router]);

  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="login" />
      <Stack.Screen name="item/[id]" options={{ headerShown: true, title: '' }} />
    </Stack>
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
