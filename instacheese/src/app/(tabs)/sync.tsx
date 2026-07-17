import { Ionicons } from '@expo/vector-icons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import { startSync, type SyncHandle, type SyncStatus } from '@/lib/sync';
import { accent, usePalette } from '@/lib/theme';

export default function SyncScreen() {
  const { session, user } = useAuth();
  const palette = usePalette();
  const [status, setStatus] = useState<SyncStatus | null>(null);
  const handleRef = useRef<SyncHandle | null>(null);

  // Stop the sync if the user logs out or the screen unmounts for good.
  useEffect(() => () => handleRef.current?.cancel(), []);

  const canWrite = !!user?.can_write;
  const running = status?.phase === 'running';

  const begin = () => {
    if (!session || running) return;
    handleRef.current = startSync(session, setStatus);
  };

  const cancel = () => handleRef.current?.cancel();

  const counts = status?.counts;
  const stats: [string, number | undefined][] = [
    ['Scanned', counts?.scanned],
    ['Already on server', counts?.upToDate],
    ['Queued for upload', counts?.queued],
    ['Not supported yet', counts?.unsupported],
    ['Failed', counts?.failed],
  ];

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.background }]} edges={['top']}>
      <View style={[styles.titleBar, { borderColor: palette.border }]}>
        <Text style={[styles.title, { color: palette.text }]}>Sync library</Text>
      </View>

      {!canWrite ? (
        <View style={styles.center}>
          <Text style={{ color: palette.subtleText, textAlign: 'center', padding: 24 }}>
            Your account doesn&apos;t have upload permission yet.
          </Text>
        </View>
      ) : (
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={{ color: palette.subtleText, textAlign: 'center' }}>
            Uploads your whole camera roll in original quality. Files the server already has are
            skipped; everything else is queued for upload, so it&apos;s safe to run again anytime —
            it just picks up where it left off.
          </Text>

          {status ? (
            <View style={[styles.card, { borderColor: palette.border }]}>
              <View style={styles.activityRow}>
                {running ? <ActivityIndicator size="small" /> : (
                  <Ionicons
                    name={status.phase === 'done' ? 'checkmark-circle' : 'alert-circle'}
                    size={20}
                    color={status.phase === 'done' ? '#2E7D32' : '#ED4956'}
                  />
                )}
                <Text style={{ color: palette.text, flex: 1 }} numberOfLines={2}>
                  {status.activity}
                </Text>
              </View>
              {stats.map(([label, value]) => (
                <View key={label} style={styles.statRow}>
                  <Text style={{ color: palette.subtleText }}>{label}</Text>
                  <Text style={{ color: palette.text, fontVariant: ['tabular-nums'] }}>
                    {value ?? 0}
                  </Text>
                </View>
              ))}
              {status.lastError ? (
                <Text style={styles.error} numberOfLines={3}>
                  {status.lastError}
                </Text>
              ) : null}
            </View>
          ) : (
            <View style={styles.center}>
              <Ionicons name="cloud-upload-outline" size={64} color={palette.subtleText} />
            </View>
          )}

          <Pressable
            style={[styles.button, running ? styles.cancelButton : { backgroundColor: accent }]}
            onPress={running ? cancel : begin}
          >
            <Text style={[styles.buttonText, { color: running ? '#ED4956' : '#fff' }]}>
              {running ? 'Stop scanning' : status ? 'Scan again' : 'Start sync'}
            </Text>
          </Pressable>

          <Text style={{ color: palette.subtleText, fontSize: 12, textAlign: 'center' }}>
            Scanning queues anything missing into the upload queue — you can leave this screen and
            watch progress from the uploads pill in the corner.
          </Text>
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  titleBar: {
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 20, fontWeight: '700' },
  center: { alignItems: 'center', justifyContent: 'center', paddingVertical: 40 },
  body: { padding: 16, gap: 16 },
  card: {
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 12,
    padding: 16,
    gap: 8,
  },
  activityRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 4 },
  statRow: { flexDirection: 'row', justifyContent: 'space-between' },
  error: { color: '#ED4956', fontSize: 13, marginTop: 4 },
  button: {
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  cancelButton: { borderWidth: 1.5, borderColor: '#ED4956' },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
