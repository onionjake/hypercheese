import * as LegacyFileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as WebBrowser from 'expo-web-browser';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import { clearLogs, exportLogs, logError } from '@/lib/log';
import { cancelMarkReminder, registerMarkReminder } from '@/lib/mark-reminder';
import { getSettings, updateSettings } from '@/lib/settings';
import { accent, usePalette } from '@/lib/theme';

export default function ProfileScreen() {
  const { session, user, signOut } = useAuth();
  const palette = usePalette();
  const [uploadOnCellular, setUploadOnCellular] = useState(false);
  const [nightlyReminder, setNightlyReminder] = useState(true);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    getSettings().then((s) => {
      setUploadOnCellular(s.uploadOnCellular);
      setNightlyReminder(s.nightlyMarkReminder);
    });
  }, []);

  const toggleCellular = async (value: boolean) => {
    setUploadOnCellular(value);
    await updateSettings({ uploadOnCellular: value });
  };

  const toggleNightlyReminder = async (value: boolean) => {
    setNightlyReminder(value);
    await updateSettings({ nightlyMarkReminder: value });
    // Turning it on may prompt for notification permission; turning it off
    // removes any already-scheduled reminder.
    if (value) await registerMarkReminder();
    else await cancelMarkReminder();
  };

  // Android: copy the archive into a folder the user picked once (Downloads,
  // typically) via the Storage Access Framework. Returns null if the user
  // cancelled the folder picker.
  const saveToFolder = async (fileUri: string): Promise<string | null> => {
    const { StorageAccessFramework } = LegacyFileSystem;
    const filename = fileUri.split('/').pop()!;
    const write = async (dirUri: string) => {
      const dest = await StorageAccessFramework.createFileAsync(
        dirUri,
        filename,
        'application/gzip'
      );
      const data = await LegacyFileSystem.readAsStringAsync(fileUri, {
        encoding: LegacyFileSystem.EncodingType.Base64,
      });
      await LegacyFileSystem.writeAsStringAsync(dest, data, {
        encoding: LegacyFileSystem.EncodingType.Base64,
      });
      return dest;
    };

    const remembered = (await getSettings()).logDownloadDirUri;
    if (remembered) {
      try {
        return await write(remembered);
      } catch {
        // Grant was revoked or the folder is gone — ask again below.
      }
    }
    const perm = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!perm.granted) return null;
    await updateSettings({ logDownloadDirUri: perm.directoryUri });
    return write(perm.directoryUri);
  };

  const downloadLogs = async () => {
    if (exporting) return;
    setExporting(true);
    try {
      const uri = await exportLogs();
      const filename = uri.split('/').pop()!;
      if (Platform.OS === 'android') {
        if (await saveToFolder(uri)) {
          Alert.alert('Logs downloaded', `Saved ${filename} to your chosen folder.`);
        }
      } else if (await Sharing.isAvailableAsync()) {
        // No general downloads folder on iOS — the share sheet's "Save to
        // Files" is the download path there.
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

  // Clear → reproduce the issue → export gives a log containing only the
  // incident, without days of unrelated history.
  const confirmClearLogs = () => {
    Alert.alert('Clear debug logs?', 'The next export will only contain activity from now on.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Clear',
        style: 'destructive',
        onPress: async () => {
          try {
            await clearLogs();
          } catch (err) {
            logError('logs', 'clear failed', err);
            Alert.alert('Could not clear logs', String(err));
          }
        },
      },
    ]);
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

        {user?.can_write ? (
          <View style={[styles.settingRow, { borderColor: palette.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={{ color: palette.text, fontWeight: '600' }}>
                Nightly reminder to mark photos
              </Text>
              <Text style={{ color: palette.subtleText, fontSize: 12, marginTop: 2 }}>
                Around 9 PM, only when photos still need a back up decision.
              </Text>
            </View>
            <Switch
              value={nightlyReminder}
              onValueChange={toggleNightlyReminder}
              trackColor={{ true: accent }}
            />
          </View>
        ) : null}

        <Pressable
          style={[styles.button, { borderColor: palette.border }]}
          onPress={() => session && WebBrowser.openBrowserAsync(session.baseUrl)}
        >
          <Text style={{ color: palette.text, fontWeight: '600' }}>Open web gallery</Text>
        </Pressable>

        <Pressable
          style={[styles.button, { borderColor: palette.border }]}
          onPress={downloadLogs}
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

        <Pressable
          style={[styles.button, { borderColor: palette.border }]}
          onPress={confirmClearLogs}
        >
          <Text style={{ color: palette.text, fontWeight: '600' }}>Clear debug logs</Text>
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
