import * as WebBrowser from 'expo-web-browser';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import { accent, usePalette } from '@/lib/theme';

export default function ProfileScreen() {
  const { session, user, signOut } = useAuth();
  const palette = usePalette();

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
        {session?.mode === 'session' ? (
          <Text style={[styles.subtle, { color: palette.subtleText, marginTop: 8, textAlign: 'center' }]}>
            Compatibility mode — this server doesn&apos;t support app uploads
            yet. Sign out and back in after it&apos;s upgraded.
          </Text>
        ) : null}

        <Pressable
          style={[styles.button, { borderColor: palette.border }]}
          onPress={() => session && WebBrowser.openBrowserAsync(session.baseUrl)}
        >
          <Text style={{ color: palette.text, fontWeight: '600' }}>Open web gallery</Text>
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
