import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import { exportLogs, logError } from '@/lib/log';
import { getSettings, updateSettings } from '@/lib/settings';
import { accent, usePalette } from '@/lib/theme';

export default function ProfileScreen() {
  const { session, user, signOut } = useAuth();
  const palette = usePalette();
  const [uploadOnCellular, setUploadOnCellular] = useState(false);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    getSettings().then((s) => setUploadOnCellular(s.uploadOnCellular));
  }, []);

  const toggleCellular = async (value: boolean) => {
    setUploadOnCellular(value);
    await updateSettings({ uploadOnCellular: value });
  };

  const shareLogs = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const uri = await exportLogs();
      if (await Sharing.isAvailableAsync()) {
        await Sharing.shareAsync(uri, {
          mimeType: 'application/gzip',
          dialogTitle: 'InstaCheese debug logs',
        });
      } else {
        Alert.alert('Logs saved', uri);
      }
    } catch (err) {
      logError('logs', 'export failed', err);
      Alert.alert('Could not export logs', String(err));
    } finally {
      setExporting(false);
    }
  };

  const displayName = user?.name || user?.username || 'Family member';
  const initial = displayName.trim().charAt(0).toUpperCase() || '🧀';

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.background }]} edges={['top']}>
      <View style={styles.container}>
        <View style={[styles.avatar, { backgroundColor: accent }]}>
          <Text style={styles.avatarText}>{initial}</Text>
        </View>
        <Text style={[styles.name, { color: palette.text }]}>{displayName}</Text>
        {user?.username ? (
          <Text style={[styles.subtle, { color: palette.subtleText }]}>@{user.username}</Text>
        ) : null}
        <Text style={[styles.subtle, { color: palette.subtleText }]}>{session?.baseUrl}</Text>
        {user && !user.can_write ? (
          <Text style={[styles.subtle, { color: palette.subtleText, marginTop: 8 }]}>
            Read-only account — ask your admin for upload access.
          </Text>
        ) : null}

        <View style={[styles.settingRow, { borderColor: palette.border }]}>
          <View style={{ flex: 1 }}>
            <Text style={{ color: palette.text, fontWeight: '600' }}>
              Upload using mobile data
            </Text>
            <Text style={{ color: palette.subtleText, fontSize: 12, marginTop: 2 }}>
              Off: uploads wait for un-metered Wi-Fi.
            </Text>
          </View>
          <Switch
            value={uploadOnCellular}
            onValueChange={toggleCellular}
            trackColor={{ true: accent }}
          />
        </View>

        <Pressable
          style={[styles.button, { borderColor: palette.border }]}
          onPress={() => session && WebBrowser.openBrowserAsync(session.baseUrl)}
        >
          <Text style={{ color: palette.text, fontWeight: '600' }}>Open web gallery</Text>
        </Pressable>

        <Pressable
          style={[styles.button, { borderColor: palette.border }]}
          onPress={shareLogs}
          disabled={exporting}
        >
          {exporting ? (
            <ActivityIndicator size="small" />
          ) : (
            <Text style={{ color: palette.text, fontWeight: '600' }}>
              Download compressed debug logs
            </Text>
          )}
        </Pressable>

        <Pressable style={[styles.button, { borderColor: palette.border }]} onPress={signOut}>
          <Text style={{ color: '#ED4956', fontWeight: '600' }}>Sign out</Text>
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  container: { alignItems: 'center', padding: 24, gap: 6, marginTop: 32 },
  avatar: {
    width: 88,
    height: 88,
    borderRadius: 44,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 8,
  },
  avatarText: { fontSize: 40, fontWeight: '700', color: '#fff' },
  name: { fontSize: 22, fontWeight: '700' },
  subtle: { fontSize: 14 },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginTop: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 10,
    paddingHorizontal: 16,
    alignSelf: 'stretch',
  },
  button: {
    marginTop: 20,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    paddingVertical: 12,
    paddingHorizontal: 32,
    minWidth: 220,
    alignItems: 'center',
  },
});
