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

SplashScreen.preventAutoHideAsync();

function RootNavigator() {
  const { status } = useAuth();
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
  // worth scheduling (and keeping scheduled) for a signed-in user.
  useEffect(() => {
    if (status === 'signedIn') registerBackgroundUploads();
    else if (status === 'signedOut') unregisterBackgroundUploads();
  }, [status]);

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
