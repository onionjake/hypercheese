import { Ionicons } from '@expo/vector-icons';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
  type ListRenderItemInfo,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { CompatNotice } from '@/components/compat-notice';
import { LibraryCell } from '@/components/library-cell';
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

// "Won't upload" cancels a waiting upload queued by Back up or a full Sync
// (the sync re-enqueue takes over a backup row's source). A picker share is a
// separate, explicit request for that one photo, so it is left alone.
const WONT_UPLOAD_CANCELS: queue.QueueSource[] = ['backup', 'sync'];

const countFor = (counts: LibraryCounts, key: AssetFilter): number =>
  key === 'all' ? counts.total : counts[key];

const COLUMNS = 3;

// Grid performance notes (see bench/grid/RESULTS.md for the measurements):
// - Rows are keyed by position, not by asset id. With numColumns, FlatList
//   keys a row by its items' keys joined together, so id keys meant that
//   removing one photo near the top (Back up / Won't upload consuming the
//   selection, a rescan) re-keyed — unmounted and remounted — every later
//   row: hundreds of native views and image requests in one go. Position
//   keys keep the rows; cells just get their new asset (recyclingKey on the
//   image clears the old picture first). Cells are stateless, so nothing
//   can stick to the wrong photo.
// - The window is bounded (WINDOW_SIZE screens of rows instead of the default
//   21) and rows have a fixed height (getItemLayout), so far fewer cells
//   and thumbnail bitmaps stay alive, and nothing waits on per-cell layout.
const positionKey = (_item: LibraryAsset, index: number) => String(index);
const WINDOW_SIZE = 7;

type ItemEvent = Pick<queue.QueueItem, 'mtime' | 'source' | 'error'> & {
  status: LibraryAsset['status'];
};

// Applies one queue item event to its catalog row, or returns it unchanged.
// An upload of an older version (edited mid-upload) doesn't change the
// catalog row, so don't badge it either.
function applyItemEvent(a: LibraryAsset, ev: ItemEvent): LibraryAsset {
  if (!(ev.status === 'pending' || ev.source === 'picker' || a.mtime === ev.mtime)) return a;
  if (a.status === ev.status && a.error === ev.error) return a;
  return { ...a, status: ev.status, error: ev.error };
}

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
  // The latest filter and the latest load request, so a slow load (or the
  // scan that preceded it) can't land on top of a newer filter's list.
  const filterRef = useRef(filter);
  const loadGeneration = useRef(0);
  const pageLoading = useRef(false);
  const countsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapCountsTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Queue item events waiting for the next frame, per asset, in order.
  const pendingItemEvents = useRef(new Map<string, ItemEvent[]>());
  const itemFrame = useRef<number | null>(null);
  const { width: windowWidth } = useWindowDimensions();
  const [listWidth, setListWidth] = useState<number | null>(null);

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

  // Same for single-photo taps (the cell itself updates right away): a run
  // of quick taps costs one count query instead of one per tap. Shorter, so
  // the chips and the Back up button keep up with the taps.
  const refreshCountsAfterTap = useCallback(() => {
    if (tapCountsTimer.current) clearTimeout(tapCountsTimer.current);
    tapCountsTimer.current = setTimeout(() => {
      tapCountsTimer.current = null;
      refreshCounts();
    }, 200);
  }, [refreshCounts]);

  // Always loads for the current filter. A reset supersedes any load in
  // flight; an append is skipped while another load is running (the end of
  // the list fires repeatedly) and dropped if a reset overtook it.
  const loadPage = useCallback(
    async (reset: boolean) => {
      if (!reset && pageLoading.current) return;
      const generation = ++loadGeneration.current;
      pageLoading.current = true;
      try {
        const last = reset ? undefined : assets[assets.length - 1];
        const page = await listAssets(filterRef.current, PAGE, last);
        if (generation !== loadGeneration.current) return;
        endReached.current = page.length < PAGE;
        setAssets((prev) => {
          if (reset) return page;
          // A row can reappear below the cursor after an edit moved it; never
          // render the same asset twice.
          const seen = new Set(prev.map((a) => a.id));
          return [...prev, ...page.filter((a) => !seen.has(a.id))];
        });
      } finally {
        if (generation === loadGeneration.current) pageLoading.current = false;
      }
    },
    [assets]
  );

  const rescan = useCallback(async () => {
    if (scanning) return;
    setScanning(true);
    setLoadError(null);
    try {
      await refreshFromLibrary({ onProgress: setScanCount });
      await loadPage(true);
      await refreshCounts();
    } catch (err) {
      setLoadError(String(err instanceof Error ? err.message : err));
    } finally {
      setScanning(false);
    }
  }, [scanning, loadPage, refreshCounts]);

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
    // Item events come per file per phase, a drain batch marks up to 200
    // 'checking' back to back, and every re-enqueue re-announces each pending
    // row. Re-rendering the grid for each one starved the JS thread, so they
    // are queued and applied together once per frame, in arrival order.
    const flushItemEvents = () => {
      itemFrame.current = null;
      const pending = pendingItemEvents.current;
      if (pending.size === 0) return;
      pendingItemEvents.current = new Map();
      // Returning the same array when no loaded row changed lets React skip
      // the render entirely (most events are for photos not in this list).
      setAssets((prev) => {
        let changed = false;
        const next = prev.map((a) => {
          const events = pending.get(a.id);
          if (!events) return a;
          const updated = events.reduce(applyItemEvent, a);
          if (updated !== a) changed = true;
          return updated;
        });
        return changed ? next : prev;
      });
    };
    const unItems = queue.subscribeItems((item) => {
      if (!item.assetId) return;
      const status =
        item.status === 'done' || item.status === 'exists'
          ? 'synced'
          : item.status === 'failed'
            ? 'failed'
            : 'pending';
      const ev: ItemEvent = { status, source: item.source, mtime: item.mtime, error: item.error };
      // An event that applies regardless of mtime overwrites whatever came
      // before it, so only it and later ones need keeping.
      const unconditional = status === 'pending' || item.source === 'picker';
      const events = pendingItemEvents.current.get(item.assetId);
      if (events && !unconditional) events.push(ev);
      else pendingItemEvents.current.set(item.assetId, [ev]);
      if (itemFrame.current == null) itemFrame.current = requestAnimationFrame(flushItemEvents);
      if (status !== 'pending') refreshCountsSoon();
    });
    return () => {
      unSummary();
      unItems();
      if (countsTimer.current) clearTimeout(countsTimer.current);
      if (tapCountsTimer.current) clearTimeout(tapCountsTimer.current);
      if (itemFrame.current != null) cancelAnimationFrame(itemFrame.current);
      itemFrame.current = null;
      pendingItemEvents.current = new Map();
    };
  }, [refreshCountsSoon]);

  const changeFilter = (next: AssetFilter) => {
    setFilter(next);
    filterRef.current = next;
    setAssets([]);
    endReached.current = false;
    loadPage(true);
  };

  // Tapping only toggles working-set membership — the decision happens when a
  // batch action (Back up / Won't upload) commits the selection.
  // Stable (as are the other per-cell handlers below) so memoized grid
  // cells only re-render when their own asset changes.
  const toggle = useCallback(
    async (asset: LibraryAsset) => {
      if (!asset.supported) return;
      const selected = !asset.selected;
      await setSelected([asset.id], selected);
      setAssets((prev) => prev.map((a) => (a.id === asset.id ? { ...a, selected } : a)));
      refreshCountsAfterTap();
    },
    [refreshCountsAfterTap]
  );

  // Clearing the checkboxes is just a selection reset for staging the next
  // batch — it never touches sync state, so anything already marked for
  // upload keeps its cloud badge and keeps uploading. Mark a photo "won't
  // upload" (or use the queue screen) to cancel a queued upload.
  const selectAll = async (selected: boolean) => {
    await setAllSelected(selected);
    await loadPage(true);
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
    await loadPage(true);
    await refreshCounts();
  };

  // Marking "won't upload" also pulls the photo out of the upload queue, same
  // as un-checking it would.
  const markWontUpload = useCallback(
    async (asset: LibraryAsset) => {
      await setExcluded([asset.id], true);
      await queue.removeQueued([queue.assetKey(asset.id)], WONT_UPLOAD_CANCELS);
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
      refreshCountsAfterTap();
    },
    [refreshCountsAfterTap]
  );

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
            await queue.removeQueued(ids.map(queue.assetKey), WONT_UPLOAD_CANCELS);
            await loadPage(true);
            await refreshCounts();
          },
        },
      ]
    );
  };

  // Direct change of mind from the detail dialog: mark for upload and start
  // uploading right away, without a trip through the selection.
  const markForUploadNow = useCallback(
    async (asset: LibraryAsset) => {
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
      refreshCountsAfterTap();
    },
    [refreshCountsAfterTap]
  );

  const showDetails = useCallback((item: LibraryAsset) => {
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
  }, [markForUploadNow, markWontUpload]);

  const renderCell = useCallback(
    ({ item }: ListRenderItemInfo<LibraryAsset>) => (
      <LibraryCell item={item} onToggle={toggle} onDetails={showDetails} />
    ),
    [toggle, showDetails]
  );

  // Every FlatList prop below is stable unless what it shows changed, so
  // screen-only updates (queue summary, chip counts) skip the grid entirely.
  const rowLength = (listWidth ?? windowWidth) / COLUMNS;
  const getItemLayout = useCallback(
    (_data: ArrayLike<LibraryAsset> | null | undefined, index: number) => ({
      length: rowLength,
      offset: rowLength * index,
      index,
    }),
    [rowLength]
  );
  const onListLayout = useCallback((e: LayoutChangeEvent) => {
    setListWidth(e.nativeEvent.layout.width);
  }, []);

  // onEndReached reads the latest loadPage/scanning without changing identity.
  const latest = useRef({ loadPage, scanning });
  useLayoutEffect(() => {
    latest.current = { loadPage, scanning };
  });
  const onEndReached = useCallback(() => {
    if (!endReached.current && !latest.current.scanning) latest.current.loadPage(false);
  }, []);

  const listEmpty = useMemo(
    () => (
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
    ),
    [scanning, scanCount, loadError, filter, palette.subtleText]
  );

  const showStatusRow = running || summary.state === 'paused' || summary.remaining > 0 || summary.failed > 0;

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.background }]} edges={['top']}>
      <View style={[styles.titleBar, { borderColor: palette.border }]}>
        <Text style={[styles.title, { color: palette.text }]}>Back up library</Text>
        <Pressable
          onPress={rescan}
          disabled={scanning}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Rescan library"
        >
          {scanning ? (
            <ActivityIndicator size="small" />
          ) : (
            <Ionicons name="refresh" size={22} color={accent} />
          )}
        </Pressable>
      </View>
      {canWrite ? <CompatNotice /> : null}

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
            numColumns={COLUMNS}
            keyExtractor={positionKey}
            renderItem={renderCell}
            getItemLayout={getItemLayout}
            windowSize={WINDOW_SIZE}
            onLayout={onListLayout}
            onEndReachedThreshold={2}
            onEndReached={onEndReached}
            ListEmptyComponent={listEmpty}
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
