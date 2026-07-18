import { Ionicons } from '@expo/vector-icons';
import { usePathname, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import { accent } from '@/lib/theme';
import * as queue from '@/lib/upload-queue';

// Persistent little upload pill in the corner of every screen while anything
// is queued, uploading, paused, or failed. Tapping it opens the full queue.

export default function UploadIndicator() {
  const { session, user } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [summary, setSummary] = useState<queue.QueueSummary>(queue.getSummary());

  useEffect(() => queue.subscribeSummary(setSummary), []);

  if (!session || !user?.can_write) return null;
  // The queue screen shows all of this itself; the login screen has no user.
  // The Backup tab has its own inline status row, and the pill would cover
  // its "Back up" button.
  if (pathname === '/queue' || pathname === '/login' || pathname === '/library') return null;

  const running = summary.state === 'running';
  const paused = summary.state === 'paused';
  if (!running && summary.remaining === 0 && summary.failed === 0) return null;

  const fraction =
    summary.current && summary.current.bytesTotal > 0
      ? Math.min(1, summary.current.bytesSent / summary.current.bytesTotal)
      : 0;

  const label = running
    ? `${summary.remaining} left`
    : paused
      ? 'Paused'
      : `${summary.failed} failed`;

  return (
    // Sits above the tab bar (when there is one); pointerEvents lets taps
    // everywhere else fall through to the screen underneath.
    <View pointerEvents="box-none" style={[styles.overlay, { bottom: insets.bottom + 64 }]}>
      <Pressable
        onPress={() => router.push('/queue')}
        style={styles.pill}
        accessibilityRole="button"
        accessibilityLabel="Show upload queue"
      >
        <View style={styles.row}>
          {running ? (
            <ActivityIndicator size="small" color="#fff" />
          ) : (
            <Ionicons
              name={paused ? 'cloud-offline-outline' : 'alert-circle'}
              size={16}
              color={paused ? '#F5C518' : '#ED4956'}
            />
          )}
          <Text style={styles.text}>{label}</Text>
          <Ionicons name="chevron-up" size={14} color="rgba(255,255,255,0.7)" />
        </View>
        {running && summary.current ? (
          <View style={styles.barTrack}>
            <View style={[styles.barFill, { width: `${Math.round(fraction * 100)}%` }]} />
          </View>
        ) : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    right: 12,
    alignItems: 'flex-end',
  },
  pill: {
    backgroundColor: 'rgba(20,20,20,0.92)',
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 6,
    shadowColor: '#000',
    shadowOpacity: 0.3,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
    elevation: 6,
    minWidth: 96,
  },
  row: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  text: { color: '#fff', fontSize: 13, fontWeight: '600' },
  barTrack: {
    height: 3,
    borderRadius: 2,
    backgroundColor: 'rgba(255,255,255,0.25)',
    overflow: 'hidden',
  },
  barFill: {
    height: 3,
    borderRadius: 2,
    backgroundColor: accent,
  },
});
