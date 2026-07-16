import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import { accent, usePalette } from '@/lib/theme';
import { prepareFiles, uploadFiles, type UploadFile, type UploadStatus } from '@/lib/uploader';

const STATUS_LABELS: Record<UploadStatus, string> = {
  pending: 'Ready',
  checking: 'Checking…',
  hashing: 'Preparing…',
  uploading: 'Uploading…',
  done: 'Uploaded',
  'already-uploaded': 'Already uploaded',
  unsupported: 'Not supported',
  error: 'Failed',
};

export default function UploadScreen() {
  const { session, user } = useAuth();
  const palette = usePalette();
  const [files, setFiles] = useState<UploadFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [doneMessage, setDoneMessage] = useState<string | null>(null);

  const canWrite = !!user?.can_write;

  const pick = async () => {
    setDoneMessage(null);
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images', 'videos'],
      allowsMultipleSelection: true,
      selectionLimit: 50,
      quality: 1,
      // Hand over the ORIGINAL bytes — no on-device transcoding. The server
      // transcodes video itself (ffmpeg), and stable original bytes keep the
      // sha256 dedup working across picks. HEIC photos will show as
      // unsupported until the server importer accepts them.
      preferredAssetRepresentationMode:
        ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Current,
    });
    if (result.canceled) return;
    setFiles(await prepareFiles(result.assets));
  };

  const upload = async () => {
    if (!session || busy) return;
    setBusy(true);
    setDoneMessage(null);
    try {
      await uploadFiles(session, files, (updated) => {
        setFiles((prev) => prev.map((f) => (f.key === updated.key ? { ...updated } : f)));
      });
      setFiles((current) => {
        const uploaded = current.filter(
          (f) => f.status === 'done' || f.status === 'already-uploaded'
        ).length;
        const failed = current.filter((f) => f.status === 'error').length;
        setDoneMessage(
          failed === 0
            ? `Shared ${uploaded} ${uploaded === 1 ? 'item' : 'items'} with the family 🧀`
            : `${uploaded} uploaded, ${failed} failed — try again for the failed ones`
        );
        return current;
      });
    } finally {
      setBusy(false);
    }
  };

  const pendingCount = files.filter((f) => f.status === 'pending').length;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.background }]} edges={['top']}>
      <View style={[styles.titleBar, { borderColor: palette.border }]}>
        <Text style={[styles.title, { color: palette.text }]}>Share photos</Text>
      </View>

      {!canWrite ? (
        <View style={styles.center}>
          <Text style={{ color: palette.subtleText, textAlign: 'center', padding: 24 }}>
            Your account doesn&apos;t have upload permission yet.
          </Text>
        </View>
      ) : (
        <>
          <FlatList
            data={files}
            keyExtractor={(f) => f.key}
            contentContainerStyle={styles.list}
            ListEmptyComponent={
              <View style={styles.center}>
                <Ionicons name="images-outline" size={64} color={palette.subtleText} />
                <Text style={{ color: palette.subtleText, marginTop: 12, textAlign: 'center' }}>
                  Pick photos or videos from your library{'\n'}to share with the family.
                </Text>
              </View>
            }
            renderItem={({ item: file }) => (
              <View style={[styles.row, { borderColor: palette.border }]}>
                <Image source={{ uri: file.asset.uri }} style={styles.thumb} contentFit="cover" />
                <View style={styles.rowText}>
                  <Text style={{ color: palette.text }} numberOfLines={1}>
                    {file.path}
                  </Text>
                  <Text
                    style={{
                      color:
                        file.status === 'error' || file.status === 'unsupported'
                          ? '#ED4956'
                          : file.status === 'done'
                            ? '#2E7D32'
                            : palette.subtleText,
                      fontSize: 13,
                    }}
                    numberOfLines={2}
                  >
                    {STATUS_LABELS[file.status]}
                    {file.error && file.status === 'error' ? ` — ${file.error}` : ''}
                  </Text>
                </View>
                {['checking', 'hashing', 'uploading'].includes(file.status) ? (
                  <ActivityIndicator size="small" />
                ) : file.status === 'done' || file.status === 'already-uploaded' ? (
                  <Ionicons name="checkmark-circle" size={22} color="#2E7D32" />
                ) : null}
              </View>
            )}
          />

          {doneMessage ? (
            <Text style={[styles.done, { color: palette.text }]}>{doneMessage}</Text>
          ) : null}

          <View style={styles.buttons}>
            <Pressable
              style={[styles.button, styles.secondaryButton, { borderColor: accent }]}
              onPress={pick}
              disabled={busy}
            >
              <Text style={[styles.buttonText, { color: accent }]}>
                {files.length ? 'Pick different' : 'Pick photos'}
              </Text>
            </Pressable>
            {files.length > 0 ? (
              <Pressable
                style={[styles.button, { backgroundColor: accent }, (busy || pendingCount === 0) && { opacity: 0.5 }]}
                onPress={upload}
                disabled={busy || pendingCount === 0}
              >
                {busy ? (
                  <ActivityIndicator color="#fff" />
                ) : (
                  <Text style={[styles.buttonText, { color: '#fff' }]}>
                    Upload {pendingCount || ''}
                  </Text>
                )}
              </Pressable>
            ) : null}
          </View>
        </>
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
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  list: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thumb: { width: 52, height: 52, borderRadius: 6 },
  rowText: { flex: 1, gap: 2 },
  done: { textAlign: 'center', padding: 8, fontWeight: '600' },
  buttons: { flexDirection: 'row', gap: 12, padding: 16 },
  button: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 14,
    alignItems: 'center',
  },
  secondaryButton: { borderWidth: 1.5 },
  buttonText: { fontSize: 16, fontWeight: '600' },
});
