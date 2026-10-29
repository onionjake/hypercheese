import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';

import { useAuth } from '@/lib/auth';

// Shown wherever uploads start or are reported, while signed in through the
// compatibility (session) fallback. Uploads still go through /files there,
// but a server without the InstaCheese API support only imports them into
// the gallery when an admin has linked a Source to this device — otherwise
// the bytes are stored and never shown, while the app reports them done.
// Nobody should delete originals from their phone believing otherwise.
export function CompatNotice() {
  const { session } = useAuth();
  if (session?.mode !== 'session') return null;
  return (
    <View style={styles.box}>
      <Ionicons name="warning-outline" size={18} color="#8A5A00" />
      <Text style={styles.text}>
        Compatibility mode: this server stores app uploads, but may not show them in the
        gallery until it&apos;s upgraded. Keep the originals on your phone for now — sign out
        and back in after the upgrade.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    flexDirection: 'row',
    gap: 8,
    alignItems: 'flex-start',
    backgroundColor: '#FFF4D6',
    borderColor: '#F5A623',
    borderWidth: 1,
    borderRadius: 8,
    marginHorizontal: 12,
    marginVertical: 8,
    padding: 10,
  },
  text: { flex: 1, color: '#5C3D00', fontSize: 13 },
});
