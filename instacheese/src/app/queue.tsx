import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';

import { accent, usePalette } from '@/lib/theme';
import * as queue from '@/lib/upload-queue';

// The consolidated upload queue: everything the picker, backup, and sync
// flows have queued, with live per-file progress. Reachable from the floating
// upload pill on any screen.

const STATUS_LABELS: Record<queue.QueueItemStatus, string> = {
  queued: 'Waiting…',
  checking: 'Checking…',
  hashing: 'Preparing…',
  uploading: 'Uploading…',
  done: 'Uploaded',
  exists: 'Already uploaded',
  failed: 'Failed',
};

const SOURCE_LABELS: Record<queue.QueueSource, string> = {
  picker: 'Shared',
  backup: 'Backup',
  sync: 'Full sync',
};

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export default function QueueScreen() {
  const palette = usePalette();
  const [summary, setSummary] = useState<queue.QueueSummary>(queue.getSummary());
  const [items, setItems] = useState<queue.QueueItem[]>([]);

  useEffect(() => queue.subscribeSummary(setSummary), []);

  // Item events update rows in place; structural changes (new enqueues,
  // clears) change the totals and trigger a reload below.
  useEffect(
    () =>
      queue.subscribeItems((item) => {
        setItems((prev) => {
          const index = prev.findIndex((p) => p.key === item.key);
          if (index === -1) return prev;
          const next = [...prev];
          next[index] = item;
          return next;
        });
      }),
    []
  );

  // Reload when the queue's composition changes (enqueues, removals, clears)
  // — settles and retries update loaded rows through the item events above,
  // so keying on `total` alone avoids re-querying the whole list once per
  // uploaded file.
  const { total } = summary;
  useEffect(() => {
    queue.listItems().then(setItems);
  }, [total]);

  const running = summary.state === 'running';

  const headline = running
    ? summary.current
      ? `${STATUS_LABELS[summary.current.phase].replace('…', '')} ${summary.current.filename}…`
      : 'Uploading…'
    : summary.state === 'paused'
      ? summary.reason ?? 'Uploads paused'
      : summary.remaining > 0
        ? 'Waiting to upload'
        : summary.failed > 0
          ? 'Some uploads failed'
          : 'All caught up 🧀';

  const renderItem = ({ item }: { item: queue.QueueItem }) => {
    const isCurrent = summary.current?.key === item.key;
    const fraction =
      isCurrent && summary.current!.bytesTotal > 0
        ? Math.min(1, summary.current!.bytesSent / summary.current!.bytesTotal)
        : 0;
    return (
      <View style={[styles.row, { borderColor: palette.border }]}>
        {item.thumbUri ? (
          <Image source={{ uri: item.thumbUri }} style={styles.thumb} contentFit="cover" />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]}>
            <Ionicons name="image-outline" size={20} color={palette.subtleText} />
          </View>
        )}
        <View style={styles.rowText}>
          <Text style={{ color: palette.text }} numberOfLines={1}>
            {item.filename}
          </Text>
          <Text
            style={{
              color:
                item.status === 'failed'
                  ? '#ED4956'
                  : item.status === 'done'
                    ? '#2E7D32'
                    : palette.subtleText,
              fontSize: 13,
            }}
            numberOfLines={2}
          >
            {SOURCE_LABELS[item.source]} · {STATUS_LABELS[item.status]}
            {item.status === 'uploading' && isCurrent && summary.current!.bytesTotal > 0
              ? ` ${formatBytes(summary.current!.bytesSent)} / ${formatBytes(summary.current!.bytesTotal)}`
              : ''}
            {item.error && item.status === 'failed' ? ` — ${item.error}` : ''}
          </Text>
          {isCurrent && item.status === 'uploading' ? (
            <View style={[styles.barTrack, { backgroundColor: palette.border }]}>
              <View style={[styles.barFill, { width: `${Math.round(fraction * 100)}%` }]} />
            </View>
          ) : null}
        </View>
        {['checking', 'hashing', 'uploading'].includes(item.status) ? (
          <ActivityIndicator size="small" />
        ) : item.status === 'done' || item.status === 'exists' ? (
          <Ionicons name="checkmark-circle" size={22} color="#2E7D32" />
        ) : item.status === 'failed' ? (
          <Ionicons name="alert-circle" size={22} color="#ED4956" />
        ) : (
          <Ionicons name="time-outline" size={20} color={palette.subtleText} />
        )}
      </View>
    );
  };

  return (
    <View style={[styles.container, { backgroundColor: palette.background }]}>
      <View style={[styles.header, { borderColor: palette.border }]}>
        <View style={styles.headlineRow}>
          {running ? <ActivityIndicator size="small" /> : (
            <Ionicons
              name={
                summary.state === 'paused'
                  ? 'cloud-offline-outline'
                  : summary.failed > 0
                    ? 'alert-circle'
                    : summary.remaining > 0
                      ? 'time-outline'
                      : 'checkmark-circle'
              }
              size={20}
              color={
                summary.state === 'paused'
                  ? '#E8A33D'
                  : summary.failed > 0
                    ? '#ED4956'
                    : summary.remaining > 0
                      ? palette.subtleText
                      : '#2E7D32'
              }
            />
          )}
          <Text style={{ color: palette.text, flex: 1, fontSize: 15 }} numberOfLines={2}>
            {headline}
          </Text>
        </View>
        <Text style={{ color: palette.subtleText, fontSize: 13 }}>
          {summary.remaining} in queue · {summary.finished} uploaded · {summary.failed} failed
        </Text>

        <View style={styles.controls}>
          {running ? (
            <Pressable
              style={[styles.controlButton, { borderColor: '#ED4956' }]}
              onPress={() => queue.stop()}
            >
              <Text style={[styles.controlText, { color: '#ED4956' }]}>Stop</Text>
            </Pressable>
          ) : summary.remaining > 0 ? (
            <Pressable
              style={[styles.controlButton, { borderColor: accent }]}
              onPress={() => queue.kick('manual')}
            >
              <Text style={[styles.controlText, { color: accent }]}>Start uploading</Text>
            </Pressable>
          ) : null}
          {summary.failed > 0 ? (
            <Pressable
              style={[styles.controlButton, { borderColor: accent }]}
              onPress={() => queue.retryFailed()}
            >
              <Text style={[styles.controlText, { color: accent }]}>
                Retry {summary.failed} failed
              </Text>
            </Pressable>
          ) : null}
          {summary.finished > 0 ? (
            <Pressable
              style={[styles.controlButton, { borderColor: palette.border }]}
              onPress={() => queue.clearFinished()}
            >
              <Text style={[styles.controlText, { color: palette.subtleText }]}>Clear done</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      <FlatList
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Ionicons name="cloud-done-outline" size={56} color={palette.subtleText} />
            <Text style={{ color: palette.subtleText, marginTop: 12, textAlign: 'center' }}>
              Nothing queued right now.{'\n'}Share, back up, or sync to add uploads.
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  header: {
    padding: 16,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headlineRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  controls: { flexDirection: 'row', gap: 10, marginTop: 4, flexWrap: 'wrap' },
  controlButton: {
    borderWidth: 1.5,
    borderRadius: 10,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  controlText: { fontSize: 14, fontWeight: '600' },
  list: { flexGrow: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  thumb: { width: 48, height: 48, borderRadius: 6 },
  thumbFallback: { alignItems: 'center', justifyContent: 'center', backgroundColor: '#8883' },
  rowText: { flex: 1, gap: 3 },
  barTrack: { height: 3, borderRadius: 2, overflow: 'hidden' },
  barFill: { height: 3, borderRadius: 2, backgroundColor: accent },
  empty: { alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
});
