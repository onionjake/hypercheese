import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/lib/auth';
import * as backup from '@/lib/backup-manager';
import {
  libraryCounts,
  listAssets,
  refreshFromLibrary,
  setAllSelected,
  setSelected,
  type AssetFilter,
  type LibraryAsset,
  type LibraryCounts,
} from '@/lib/library-db';
import { type PartialSyncStatus } from '@/lib/partial-sync';
import { accent, usePalette } from '@/lib/theme';

// Partial sync: a browsable catalog of the camera roll where each photo can
// be included in or excluded from backup, with per-photo sync status.

const PAGE = 120;

const FILTERS: { key: AssetFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'selected', label: 'Selected' },
  { key: 'synced', label: 'Backed up' },
  { key: 'failed', label: 'Failed' },
];

export default function LibraryScreen() {
  const { session, user } = useAuth();
  const palette = usePalette();

  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [filter, setFilter] = useState<AssetFilter>('all');
  const [counts, setCounts] = useState<LibraryCounts | null>(null);
  const [scanning, setScanning] = useState(false);
  const [scanCount, setScanCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [syncStatus, setSyncStatus] = useState<PartialSyncStatus | null>(backup.getStatus());
  const endReached = useRef(false);

  const canWrite = !!user?.can_write;
  const running = syncStatus?.phase === 'running';

  const refreshCounts = useCallback(async () => {
    setCounts(await libraryCounts());
  }, []);

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

  // The backup run is owned by backup-manager (it can also start
  // automatically), so this screen just observes it.
  useEffect(() => {
    const unStatus = backup.subscribeStatus(setSyncStatus);
    const unAssets = backup.subscribeAssets((id, result, error) => {
      setAssets((prev) =>
        prev.map((a) => (a.id === id ? { ...a, status: result, error: error ?? null } : a))
      );
    });
    return () => {
      unStatus();
      unAssets();
    };
  }, []);

  const changeFilter = (next: AssetFilter) => {
    setFilter(next);
    setAssets([]);
    endReached.current = false;
    loadPage(true, next);
  };

  const toggle = async (asset: LibraryAsset) => {
    if (!asset.supported) return;
    const selected = !asset.selected;
    await setSelected([asset.id], selected);
    setAssets((prev) =>
      prev.map((a) =>
        a.id === asset.id
          ? {
              ...a,
              selected,
              error: selected ? a.error : null,
              status:
                a.status === 'synced' ? 'synced' : selected ? 'pending' : 'none',
            }
          : a
      )
    );
    refreshCounts();
  };

  const selectAll = async (selected: boolean) => {
    await setAllSelected(selected);
    await loadPage(true, filter);
    await refreshCounts();
  };

  const begin = () => {
    if (!session || running) return;
    backup.start(session, 'manual');
  };

  useEffect(() => {
    if (syncStatus && syncStatus.phase !== 'running') refreshCounts();
  }, [syncStatus, refreshCounts]);

  const showDetails = (item: LibraryAsset) => {
    const lines = [
      item.status === 'synced'
        ? 'Backed up'
        : item.status === 'failed'
          ? 'Last attempt failed'
          : item.selected
            ? 'Marked for backup — not uploaded yet'
            : 'Not marked for backup',
    ];
    if (item.error) lines.push(`\n${item.error}`);
    Alert.alert(item.filename, lines.join('\n'));
  };

  const cell = ({ item }: { item: LibraryAsset }) => (
    <Pressable
      style={styles.cell}
      onPress={() => toggle(item)}
      onLongPress={() => showDetails(item)}
      disabled={running}
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
              name={item.selected ? 'checkmark-circle' : 'ellipse-outline'}
              size={22}
              color={item.selected ? accent : 'rgba(255,255,255,0.9)'}
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

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.background }]} edges={['top']}>
      <View style={[styles.titleBar, { borderColor: palette.border }]}>
        <Text style={[styles.title, { color: palette.text }]}>Back up library</Text>
        <Pressable onPress={rescan} disabled={scanning || running} hitSlop={8}>
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
          <View style={[styles.chips, { borderColor: palette.border }]}>
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
                  {counts
                    ? ` ${
                        key === 'all'
                          ? counts.total
                          : key === 'selected'
                            ? counts.selected
                            : key === 'synced'
                              ? counts.synced
                              : counts.failed
                      }`
                    : ''}
                </Text>
              </Pressable>
            ))}
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
                    {loadError ?? 'No photos here yet.'}
                  </Text>
                )}
              </View>
            }
          />

          {syncStatus ? (
            <View style={[styles.statusRow, { borderColor: palette.border }]}>
              {running ? (
                <ActivityIndicator size="small" />
              ) : (
                <Ionicons
                  name={
                    syncStatus.phase === 'done'
                      ? 'checkmark-circle'
                      : syncStatus.phase === 'paused'
                        ? 'cloud-offline-outline'
                        : 'alert-circle'
                  }
                  size={18}
                  color={
                    syncStatus.phase === 'done'
                      ? '#2E7D32'
                      : syncStatus.phase === 'paused'
                        ? '#E8A33D'
                        : '#ED4956'
                  }
                />
              )}
              <View style={{ flex: 1 }}>
                <Text style={{ color: palette.text, fontSize: 13 }} numberOfLines={2}>
                  {syncStatus.activity}
                </Text>
                <Text style={{ color: palette.subtleText, fontSize: 12 }} numberOfLines={1}>
                  {syncStatus.counts.uploaded + syncStatus.counts.deduped} uploaded ·{' '}
                  {syncStatus.counts.upToDate} already there · {syncStatus.counts.failed} failed
                </Text>
                {syncStatus.lastError ? (
                  <Text style={{ color: '#ED4956', fontSize: 12 }} numberOfLines={2}>
                    {syncStatus.lastError}
                  </Text>
                ) : null}
              </View>
            </View>
          ) : null}

          <View style={styles.buttons}>
            <Pressable
              style={[styles.button, styles.secondaryButton, { borderColor: accent }]}
              onPress={() => selectAll((counts?.selected ?? 0) === 0)}
              disabled={running || scanning}
            >
              <Text style={[styles.buttonText, { color: accent }]}>
                {(counts?.selected ?? 0) === 0 ? 'Select all' : 'Clear selection'}
              </Text>
            </Pressable>
            <Pressable
              style={[
                styles.button,
                running ? styles.cancelButton : { backgroundColor: accent },
                !running && (counts?.pending ?? 0) === 0 && { opacity: 0.5 },
              ]}
              onPress={running ? backup.cancel : begin}
              disabled={!running && (counts?.pending ?? 0) === 0}
            >
              <Text style={[styles.buttonText, { color: running ? '#ED4956' : '#fff' }]}>
                {running ? 'Stop' : `Back up ${counts?.pending || ''}`}
              </Text>
            </Pressable>
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
    borderBottomWidth: StyleSheet.hairlineWidth,
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
