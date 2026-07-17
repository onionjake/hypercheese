import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useState } from 'react';
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
import { enqueuePicked, prepareFiles, type UploadFile, type UploadStatus } from '@/lib/uploader';
import * as queue from '@/lib/upload-queue';

const STATUS_LABELS: Record<UploadStatus, string> = {
  ready: 'Ready',
  queued: 'Queued',
  checking: 'Checking…',
  hashing: 'Preparing…',
  uploading: 'Uploading…',
  done: 'Uploaded',
  exists: 'Already uploaded',
  unsupported: 'Not supported',
  failed: 'Failed',
};

const IN_FLIGHT: UploadStatus[] = ['queued', 'checking', 'hashing', 'uploading'];

export default function UploadScreen() {
  const { user } = useAuth();
  const palette = usePalette();
  const [files, setFiles] = useState<UploadFile[]>([]);

  const canWrite = !!user?.can_write;

  // The queue owns the uploads; this screen just mirrors status back onto the
  // picked rows (keys match queue keys).
  useEffect(
    () =>
      queue.subscribeItems((item) => {
        setFiles((prev) =>
          prev.map((f) =>
            f.key === item.key ? { ...f, status: item.status, error: item.error ?? undefined } : f
          )
        );
      }),
    []
  );

  const pick = async () => {
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
    // Append to what's already listed (anything mid-upload keeps going), so
    // the user can pick more while earlier picks are still in the queue.
    const picked = await prepareFiles(result.assets);
    setFiles((prev) => {
      const pickedKeys = new Set(picked.map((f) => f.key));
      return [...prev.filter((f) => !pickedKeys.has(f.key)), ...picked];
    });
  };

  // Hands files to the shared upload queue and returns immediately — watch
  // progress here, from the uploads pill, or leave the screen entirely.
  const share = async (targets: UploadFile[]) => {
    if (targets.length === 0) return;
    await enqueuePicked(targets);
  };

  const readyFiles = files.filter((f) => f.status === 'ready');
  const failedFiles = files.filter((f) => f.status === 'failed');
  const inFlightCount = files.filter((f) => IN_FLIGHT.includes(f.status)).length;
  const uploadedCount = files.filter((f) => f.status === 'done' || f.status === 'exists').length;

  const summaryLine =
    files.length > 0 && inFlightCount === 0 && readyFiles.length === 0 && uploadedCount > 0
      ? failedFiles.length === 0
        ? `Shared ${uploadedCount} ${uploadedCount === 1 ? 'item' : 'items'} with the family 🧀`
        : `${uploadedCount} uploaded, ${failedFiles.length} failed`
      : null;

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
                    {file.name}
                  </Text>
                  <Text
                    style={{
                      color:
                        file.status === 'failed' || file.status === 'unsupported'
                          ? '#ED4956'
                          : file.status === 'done'
                            ? '#2E7D32'
                            : palette.subtleText,
                      fontSize: 13,
                    }}
                    numberOfLines={2}
                  >
                    {STATUS_LABELS[file.status]}
                    {file.error && file.status === 'failed' ? ` — ${file.error}` : ''}
                  </Text>
                </View>
                {['checking', 'hashing', 'uploading'].includes(file.status) ? (
                  <ActivityIndicator size="small" />
                ) : file.status === 'done' || file.status === 'exists' ? (
                  <Ionicons name="checkmark-circle" size={22} color="#2E7D32" />
                ) : null}
              </View>
            )}
          />

          {summaryLine ? (
            <Text style={[styles.done, { color: palette.text }]}>{summaryLine}</Text>
          ) : null}

          <View style={styles.buttons}>
            <Pressable
              style={[styles.button, styles.secondaryButton, { borderColor: accent }]}
              onPress={pick}
            >
              <Text style={[styles.buttonText, { color: accent }]}>
                {files.length ? 'Pick more' : 'Pick photos'}
              </Text>
            </Pressable>
            {failedFiles.length > 0 ? (
              <Pressable
                style={[styles.button, styles.secondaryButton, { borderColor: '#ED4956' }]}
                onPress={() => share(failedFiles)}
              >
                <Text style={[styles.buttonText, { color: '#ED4956' }]}>
                  Retry {failedFiles.length} failed
                </Text>
              </Pressable>
            ) : null}
            {files.length > 0 ? (
              <Pressable
                style={[
                  styles.button,
                  { backgroundColor: accent },
                  readyFiles.length === 0 && { opacity: 0.5 },
                ]}
                onPress={() => share(readyFiles)}
                disabled={readyFiles.length === 0}
              >
                <Text style={[styles.buttonText, { color: '#fff' }]}>
                  Upload {readyFiles.length || ''}
                </Text>
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
