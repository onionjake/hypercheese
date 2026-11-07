import { Ionicons } from '@expo/vector-icons';
import { Tabs } from 'expo-router';
import { useEffect } from 'react';

import { useAuth } from '@/lib/auth';
import { accent } from '@/lib/theme';
import { startAutoRetry } from '@/lib/upload-queue';

export default function TabsLayout() {
  const { session, user } = useAuth();

  // Anything queued (or marked for backup) retries periodically while the
  // app is open — on a timer, on foreground, and when the network becomes
  // usable — and resumes whatever a previous app run left in the queue.
  useEffect(() => {
    if (!session || !user?.can_write) return;
    return startAutoRetry(session);
  }, [session, user?.can_write]);

  // RN 0.88's strict types widen the tab bar's icon `color` to ColorValue
  // (null | number | ...); it is always the tint string set here, and
  // @expo/vector-icons still types `color` as a string.
  return (
    <Tabs
      screenOptions={{
        tabBarActiveTintColor: accent,
        tabBarShowLabel: false,
        headerShown: false,
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Feed',
          tabBarIcon: ({ color, focused, size }) => (
            <Ionicons name={focused ? 'home' : 'home-outline'} size={size} color={color as string} />
          ),
        }}
      />
      <Tabs.Screen
        name="upload"
        options={{
          title: 'Upload',
          tabBarIcon: ({ color, focused, size }) => (
            <Ionicons
              name={focused ? 'add-circle' : 'add-circle-outline'}
              size={size + 6}
              color={color as string}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="library"
        options={{
          title: 'Backup',
          tabBarIcon: ({ color, focused, size }) => (
            <Ionicons name={focused ? 'images' : 'images-outline'} size={size} color={color as string} />
          ),
        }}
      />
      <Tabs.Screen
        name="sync"
        options={{
          title: 'Sync',
          tabBarIcon: ({ color, focused, size }) => (
            <Ionicons
              name={focused ? 'cloud-upload' : 'cloud-upload-outline'}
              size={size}
              color={color as string}
            />
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, focused, size }) => (
            <Ionicons name={focused ? 'person' : 'person-outline'} size={size} color={color as string} />
          ),
        }}
      />
    </Tabs>
  );
}
