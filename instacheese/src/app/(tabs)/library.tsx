import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import {
  excludeSelected,
  libraryCounts,
  listAssets,
  markForUpload,
  markSelectedForUpload,
  refreshFromLibrary,
  setAllSelected,
  setExcluded,
  setSelected,
  type AssetFilter,
  type LibraryAsset,
  type LibraryCounts,
} from '@/lib/library-db';
import { flushLogs, log } from '@/lib/log';
import { refreshMarkReminder } from '@/lib/mark-reminder';
import { accent, usePalette } from '@/lib/theme';
import * as queue from '@/lib/upload-queue';

// Backup: a browsable catalog of the camera roll where each photo can be
// included in or excluded from backup, with per-photo sync status. The
// checkboxes are a working set: stage a batch, then commit it with "Back up"
// or "Won't upload" — either action consumes the selection so the next batch
// can be staged. "Back up" hands the batch to the shared upload queue; keep
// selecting, switch screens, or close the app and the queue keeps draining,
// with the per-photo cloud badge tracking real upload state throughout.

const PAGE = 120;

// 'unmarked' is the default triage view: only photos with no decision yet, so
// each asset needs a look exactly once. Long-press → "Won't upload" removes a
// photo from it permanently; the "Won't upload" chip finds those again.
const FILTERS: { key: AssetFilter; label: string }[] = [
  { key: 'unmarked', label: 'Unmarked' },
  { key: 'all', label: 'All' },
  { key: 'selected', label: 'Selected' },
  { key: 'synced', label: 'Backed up' },
  { key: 'failed', label: 'Failed' },
  { key: 'excluded', label: "Won't upload" },
];

const countFor = (counts: LibraryCounts, key: AssetFilter): number =>
  key === 'all' ? counts.total : counts[key];

export default function LibraryScreen() {
  const { session, user } = useAuth();
  const palette = usePalette();

  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [filter, setFilter] = useState<AssetFilter>('unmarked');
  const [counts, setCounts] = useState<LibraryCounts | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [summary, setSummary] = useState<queue.QueueSummary>(queue.getSummary());
  const endReached = useRef(false);
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const canWrite = !!user?.can_write;
  const running = summary.state === 'running';

  // Every path that can change the unmarked pool (scans, batch actions,
  // queue settles) funnels through here, so this is also where the nightly
  // mark reminder gets re-scheduled with the fresh count.
  const refreshCounts = useCallback(async () => {
    const next = await libraryCounts();
    setCounts(next);
    refreshMarkReminder(next.unmarked);
  }, []);

  // Queue settles arrive per file; refresh the chip counts on a small
  // debounce instead of once per event.
  const refreshCountsSoon = useCallback(() => {
    if (countsTimer.current) clearTimeout(countsTimer.current);
    countsTimer.current = setTimeout(() => {
      countsTimer.current = null;
      refreshCounts();
    }, 500);
  }, [refreshCounts]);

  const loadPage = useCallback(
    async (reset: boolean, activeFilter: AssetFilter) => {
      const offset = reset ? 0 : assets.length;
      const page = await listAssets(activeFilter, PAGE, offset);
      endReached.current = page.length < PAGE;
      setAssets((prev) => (reset ? page : [...prev, ...page]));
    },
    [assets.length]
  );

  const rescan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setLoadError(null);
    try {
      await refreshFromLibrary(setScanCount);
      await loadPage(true, filter);
      await refreshCounts();
    } catch (err) {
      setLoadError(String(err instanceof Error ? err.message : err));
    } finally {
      setScanning(false);
    }
  }, [scanning, filter, loadPage, refreshCounts]);

  // First open: scan the library into the catalog.
  useEffect(() => {
    if (canWrite) rescan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canWrite]);

  // The upload queue owns the run (it can also start automatically or in the
  // background), so this screen just observes it. Byte-progress broadcasts
  // arrive every ~300ms during uploads; skip re-rendering the whole thumbnail
  // grid for changes this screen doesn't display.
  useEffect(() => {
    const unSummary = queue.subscribeSummary((next) => {
      setSummary((prev) =>
        prev.state === next.state &&
        prev.reason === next.reason &&
        prev.remaining === next.remaining &&
        prev.failed === next.failed &&
        prev.finished === next.finished &&
        prev.current?.key === next.current?.key &&
        prev.current?.phase === next.current?.phase
          ? prev
          : next
      );
    });
    const unItems = queue.subscribeItems((item) => {
      if (!item.assetId) return;
      const status =
        item.status === 'done' || item.status === 'exists'
          ? 'synced'
          : item.status === 'failed'
            ? 'failed'
            : 'pending';
      setAssets((prev) =>
        prev.map((a) => (a.id === item.assetId ? { ...a, status, error: item.error } : a))
      );
      if (status !== 'pending') refreshCountsSoon();
    });
    return () => {
      unSummary();
      unItems();
      if (countsTimer.current) clearTimeout(countsTimer.current);
    };
  }, [refreshCountsSoon]);

  const changeFilter = (next: AssetFilter) => {
    setFilter(next);
    setAssets([]);
    endReached.current = false;
    loadPage(true, next);
  };

  // Tapping only toggles working-set membership — the decision happens when a
  // batch action (Back up / Won't upload) commits the selection.
  const toggle = async (asset: LibraryAsset) => {
    if (!asset.supported) return;
    const selected = !asset.selected;
    await setSelected([asset.id], selected);
    setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...a, selected } : a)));
    refreshCounts();
  };

  // Clearing the checkboxes is just a selection reset for staging the next
  // batch — it never touches sync state, so anything already marked for
  // upload keeps its cloud badge and keeps uploading. Mark a photo "won't
  // upload" (or use the queue screen) to cancel a queued upload.
  const selectAll = async (selected: boolean) => {
    await setAllSelected(selected);
    await loadPage(true, filter);
    await refreshCounts();
  };

  // Commit the selection as marked-for-upload, hand everything awaiting
  // upload to the shared queue, and clear the checkboxes so the next batch
  // can be staged. Works mid-run too. Deliberately NOT includeSynced: that
  // re-queues the entire ever-growing synced history for manifest
  // re-verification on every press, which is a full sync's job (the Sync
  // screen re-checks the whole library against the server) — a routine
  // batch commit must stay proportional to what's awaiting upload.
  const begin = async () => {
    if (!session) return;
    log('backup', `Back up pressed (${counts?.backupReady ?? '?'} ready)`);
    await flushLogs().catch(() => {});
    await markSelectedForUpload();
    await queue.enqueueBackupPending();
    queue.kick('backup');
    await loadPage(true, filter);
    await refreshCounts();
  };

  // Marking "won't upload" also pulls the photo out of the upload queue, same
  // as un-checking it would.
  const markWontUpload = async (asset: LibraryAsset) => {
    await setExcluded([asset.id], true);
    await queue.removeQueued([queue.assetKey(asset.id)], 'backup');
    setAssets((prev) =>
      prev.map((a) =>
        a.id === asset.id
          ? {
              ...a,
              excluded: true,
              selected: false,
              error: null,
              status: a.status === 'synced' ? 'synced' : 'none',
            }
          : a
      )
    );
    refreshCounts();
  };

  // Bulk "won't upload" for the whole current selection — select a batch by
  // tapping (or Select all), then write them all off in one go. Confirmed
  // first because it consumes the selection; the Won't upload filter is the
  // undo path.
  const wontUploadSelected = () => {
    const n = counts?.selected ?? 0;
    if (n === 0) return;
    Alert.alert(
      "Won't upload",
      `Mark ${n} selected photo${n === 1 ? '' : 's'} as won't upload? They won't be backed up and will disappear from Unmarked.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: "Won't upload",
          style: 'destructive',
          onPress: async () => {
            const ids = await excludeSelected();
            await queue.removeQueued(ids.map(queue.assetKey), 'backup');
            await loadPage(true, filter);
            await refreshCounts();
          },
        },
      ]
    );
  };

  // Direct change of mind from the detail dialog: mark for upload and start
  // uploading right away, without a trip through the selection.
  const markForUploadNow = async (asset: LibraryAsset) => {
    await markForUpload([asset.id]);
    await queue.enqueueBackupPending();
    queue.kick('backup');
    setAssets((prev) =>
      prev.map((a) =>
        a.id === asset.id
          ? {
              ...a,
              excluded: false,
              selected: false,
              error: null,
              status: a.status === 'synced' ? 'synced' : 'pending',
            }
          : a
      )
    );
    refreshCounts();
  };

  const showDetails = (item: LibraryAsset) => {
    const lines = [
      item.excluded
        ? "Marked won't upload"
        : item.status === 'synced'
          ? 'Backed up'
          : item.status === 'failed'
            ? 'Last attempt failed'
            : item.status === 'pending'
              ? 'Marked for backup — not uploaded yet'
              : item.selected
                ? 'Selected — Back up or Won’t upload will decide'
                : 'Not marked for backup',
    ];
    if (item.error) lines.push(`\n${item.error}`);
    const buttons: Parameters<typeof Alert.alert>[2] = [];
    if (item.supported) {
      if (item.excluded) {
        buttons.push({ text: 'Mark for upload', onPress: () => markForUploadNow(item) });
      } else if (item.status !== 'synced') {
        buttons.push({
          text: "Won't upload",
          style: 'destructive',
          onPress: () => markWontUpload(item),
        });
      }
    }
    buttons.push({ text: 'Close', style: 'cancel' });
    Alert.alert(item.filename, lines.join('\n'), buttons);
  };

  const cell = ({ item }: { item: LibraryAsset }) => (
    <Pressable
      style={styles.cell}
      onPress={() => toggle(item)}
      onLongPress={() => showDetails(item)}
    >
      <Image source={{ uri: item.uri }} style={styles.thumb} contentFit="cover" recyclingKey={item.id} />
      {!item.supported ? (
        <View style={styles.dim}>
          <Ionicons name="ban" size={18} color="#fff" />
        </View>
      ) : (
        <>
          <View style={styles.selectBadge}>
            <Ionicons
              name={
                item.selected
                  ? 'checkmark-circle'
                  : item.excluded
                    ? 'close-circle'
                    : 'ellipse-outline'
              }
              size={22}
              color={
                item.selected ? accent : item.excluded ? 'rgba(255,255,255,0.65)' : 'rgba(255,255,255,0.9)'
              }
            />
          </View>
          {item.status !== 'none' ? (
            <View style={styles.statusBadge}>
              {item.status === 'synced' ? (
                <Ionicons name="cloud-done" size={16} color="#7BE38B" />
              ) : item.status === 'failed' ? (
                <Ionicons name="alert-circle" size={16} color="#ED4956" />
              ) : (
                <Ionicons name="cloud-upload-outline" size={16} color="#fff" />
              )}
            </View>
          ) : null}
          {item.mediaType === 'video' ? (
            <View style={styles.videoBadge}>
              <Ionicons name="videocam" size={14} color="#fff" />
            </View>
          ) : null}
        </>
      )}
    </Pressable>
  );

  const showStatusRow = running || summary.state === 'paused' || summary.remaining > 0 || summary.failed > 0;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.background }]} edges={['top']}>
      <View style={[styles.titleBar, { borderColor: palette.border }]}>
        <Text style={[styles.title, { color: palette.text }]}>Back up library</Text>
        <Pressable onPress={rescan} disabled={scanning} hitSlop={8}>
          {scanning ? (
            <ActivityIndicator size="small" />
          ) : (
            <Ionicons name="refresh" size={22} color={accent} />
          )}
        </Pressable>
      </View>

      {!canWrite ? (
        <View style={styles.center}>
          <Text style={{ color: palette.subtleText, textAlign: 'center', padding: 24 }}>
            Your account doesn&apos;t have upload permission yet.
          </Text>
        </View>
      ) : (
        <>
          <View style={{ borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border }}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
              {FILTERS.map(({ key, label }) => (
                <Pressable
                  key={key}
                  onPress={() => changeFilter(key)}
                  style={[
                    styles.chip,
                    { borderColor: filter === key ? accent : palette.border },
                    filter === key && { backgroundColor: `${accent}22` },
                  ]}
                >
                  <Text style={{ color: filter === key ? accent : palette.subtleText, fontSize: 13 }}>
                    {label}
                    {counts ? ` ${countFor(counts, key)}` : ''}
                  </Text>
                </Pressable>
              ))}
            </ScrollView>
          </View>

          <FlatList
            data={assets}
            numColumns={3}
            keyExtractor={(a) => a.id}
            renderItem={cell}
            onEndReachedThreshold={2}
            onEndReached={() => {
              if (!endReached.current && !scanning) loadPage(false, filter);
            }}
            ListEmptyComponent={
              <View style={styles.center}>
                {scanning ? (
                  <Text style={{ color: palette.subtleText }}>
                    Scanning library… ({scanCount})
                  </Text>
                ) : (
                  <Text style={{ color: palette.subtleText, textAlign: 'center', padding: 24 }}>
                    {loadError ??
                      (filter === 'unmarked'
                        ? 'All caught up — every photo has been marked, backed up, or skipped.'
                        : 'No photos here yet.')}
                  </Text>
                )}
              </View>
            }
          />

          {showStatusRow ? (
            <View style={[styles.statusRow, { borderColor: palette.border }]}>
              {running ? (
                <ActivityIndicator size="small" />
              ) : (
                <Ionicons
                  name={
                    summary.state === 'paused'
                      ? 'cloud-offline-outline'
                      : summary.failed > 0
                        ? 'alert-circle'
                        : 'checkmark-circle'
                  }
                  size={18}
                  color={
                    summary.state === 'paused'
                      ? '#E8A33D'
                      : summary.failed > 0
                        ? '#ED4956'
                        : '#2E7D32'
                  }
                />
              )}
              <View style={{ flex: 1 }}>
                <Text style={{ color: palette.text, fontSize: 13 }} numberOfLines={2}>
                  {running
                    ? summary.current
                      ? `${summary.current.phase === 'uploading' ? 'Uploading' : summary.current.phase === 'hashing' ? 'Preparing' : 'Checking'} ${summary.current.filename}…`
                      : 'Uploading…'
                    : summary.state === 'paused'
                      ? summary.reason ?? 'Uploads paused'
                      : 'Uploads idle'}
                </Text>
                <Text style={{ color: palette.subtleText, fontSize: 12 }} numberOfLines={1}>
                  {summary.remaining} in queue · {summary.finished} uploaded · {summary.failed}{' '}
                  failed
                </Text>
              </View>
            </View>
          ) : null}

          <View style={styles.buttons}>
            <Pressable
              style={[styles.button, styles.secondaryButton, { borderColor: accent }]}
              onPress={() => selectAll((counts?.selected ?? 0) === 0)}
              disabled={scanning}
            >
              <Text style={[styles.buttonText, { color: accent }]}>
                {(counts?.selected ?? 0) === 0 ? 'Select all' : 'Clear selection'}
              </Text>
            </Pressable>
            {(counts?.selected ?? 0) > 0 ? (
              <Pressable
                style={[styles.button, styles.secondaryButton, { borderColor: '#ED4956' }]}
                onPress={wontUploadSelected}
                disabled={scanning}
              >
                <Text style={[styles.buttonText, { color: '#ED4956' }]}>Won&apos;t upload</Text>
              </Pressable>
            ) : null}
            {(counts?.backupReady ?? 0) > 0 || !running ? (
              <Pressable
                style={[
                  styles.button,
                  { backgroundColor: accent },
                  (counts?.backupReady ?? 0) === 0 && { opacity: 0.5 },
                ]}
                onPress={begin}
                disabled={(counts?.backupReady ?? 0) === 0}
              >
                <Text style={[styles.buttonText, { color: '#fff' }]}>
                  {`Back up ${counts?.backupReady || ''}`}
                </Text>
              </Pressable>
            ) : (
              <Pressable
                style={[styles.button, styles.cancelButton]}
                onPress={() => queue.stop()}
              >
                <Text style={[styles.buttonText, { color: '#ED4956' }]}>Stop</Text>
              </Pressable>
            )}
          </View>
        </>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1 },
  titleBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 20, fontWeight: '700' },
  center: { alignItems: 'center', justifyContent: 'center', paddingTop: 80 },
  chips: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  chip: {
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  cell: { flex: 1, maxWidth: '33.333%', aspectRatio: 1, margin: 1 },
  thumb: { flex: 1, backgroundColor: '#8883' },
  dim: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectBadge: { position: 'absolute', top: 4, left: 4 },
  statusBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    backgroundColor: 'rgba(0,0,0,0.45)',
    borderRadius: 9,
    padding: 1,
  },
  videoBadge: { position: 'absolute', bottom: 4, left: 4 },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  buttons: { flexDirection: 'row', gap: 12, padding: 12 },
  button: {
    flex: 1,
    borderRadius: 10,
    paddingVertical: 12,
    alignItems: 'center',
  },
  secondaryButton: { borderWidth: 1.5 },
  cancelButton: { borderWidth: 1.5, borderColor: '#ED4956' },
  buttonText: { fontSize: 15, fontWeight: '600' },
});
