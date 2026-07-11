import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { FeedCard } from '@/components/feed-card';
import * as api from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { tagLine, useTagMap } from '@/lib/tags';
import { accent, usePalette } from '@/lib/theme';
import type { FeedItem } from '@/lib/types';

const PAGE_SIZE = 24;

type FeedMode = 'bullhorns' | 'all';

export default function FeedScreen() {
  const { session, user } = useAuth();
  const palette = usePalette();
  const router = useRouter();
  const tags = useTagMap(session);

  // The bullhorned filter needs the upgraded backend; older servers would
  // silently return everything, so only offer it in token mode.
  const canFilterBullhorns = session?.mode === 'token';
  const [mode, setMode] = useState<FeedMode>(canFilterBullhorns ? 'bullhorns' : 'all');

  const [items, setItems] = useState<FeedItem[]>([]);
  const [searchKey, setSearchKey] = useState('');
  const [total, setTotal] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const modeRef = useRef(mode);

  const canWrite = !!user?.can_write;

  const loadPage = useCallback(
    async (opts: { refresh?: boolean } = {}) => {
      if (!session || loadingRef.current) return;
      loadingRef.current = true;
      setError(null);
      const requestMode = modeRef.current;
      const refresh = opts.refresh || items.length === 0;
      try {
        const page = await api.fetchFeed(session, {
          searchKey: refresh ? '' : searchKey,
          offset: refresh ? 0 : items.length,
          limit: PAGE_SIZE,
          bullhorned: requestMode === 'bullhorns',
        });
        // Ignore responses that raced with a mode switch.
        if (modeRef.current !== requestMode) return;
        setSearchKey(page.searchKey);
        setTotal(page.total);
        setItems((prev) => (refresh ? page.items : [...prev, ...page.items]));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not load the feed');
      } finally {
        loadingRef.current = false;
        setRefreshing(false);
        setLoadingMore(false);
      }
    },
    [session, searchKey, items.length]
  );

  useEffect(() => {
    if (session && items.length === 0 && total === null) {
      loadPage({ refresh: true });
    }
  }, [session, items.length, total, loadPage]);

  const switchMode = (next: FeedMode) => {
    if (next === mode) return;
    setMode(next);
    modeRef.current = next;
    setItems([]);
    setSearchKey('');
    setTotal(null);
    // The reset above retriggers the initial-load effect.
  };

  const onRefresh = () => {
    setRefreshing(true);
    loadPage({ refresh: true });
  };

  const onEndReached = () => {
    if (total !== null && items.length < total && !loadingRef.current) {
      setLoadingMore(true);
      loadPage();
    }
  };

  const replaceItem = (updated: FeedItem) => {
    setItems((prev) => prev.map((it) => (it.id === updated.id ? updated : it)));
  };

  const toggle = async (
    item: FeedItem,
    field: 'bullhorned' | 'starred',
    call: (s: api.Session, id: number) => Promise<FeedItem>
  ) => {
    if (!session) return;
    replaceItem({ ...item, [field]: !item[field] });
    try {
      replaceItem(await call(session, item.id));
    } catch {
      replaceItem(item);
    }
  };

  const openItem = (item: FeedItem) => {
    router.push({ pathname: '/item/[id]', params: { id: String(item.id), code: item.code, variety: item.variety } });
  };

  const modeButton = (value: FeedMode, icon: keyof typeof Ionicons.glyphMap, label: string) => {
    const active = mode === value;
    return (
      <Pressable
        onPress={() => switchMode(value)}
        style={[
          styles.modeButton,
          { borderColor: active ? accent : palette.border },
          active && { backgroundColor: `${accent}22` },
        ]}
      >
        <Ionicons name={icon} size={15} color={active ? accent : palette.subtleText} />
        <Text style={{ color: active ? accent : palette.subtleText, fontWeight: '600', fontSize: 13 }}>
          {label}
        </Text>
      </Pressable>
    );
  };

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.background }]} edges={['top']}>
      <View style={[styles.titleBar, { borderColor: palette.border }]}>
        <Text style={[styles.title, { color: palette.text }]}>🧀 InstaCheese</Text>
        {canFilterBullhorns ? (
          <View style={styles.modeRow}>
            {modeButton('bullhorns', 'megaphone', 'Bullhorns')}
            {modeButton('all', 'albums-outline', 'Everything')}
          </View>
        ) : null}
      </View>
      {error && items.length === 0 ? (
        <View style={styles.center}>
          <Text style={{ color: palette.subtleText, textAlign: 'center', padding: 24 }}>{error}</Text>
        </View>
      ) : session ? (
        <FlatList
          data={items}
          keyExtractor={(item) => String(item.id)}
          renderItem={({ item }) => (
            <FeedCard
              item={item}
              session={session}
              tagLine={tagLine(item.tag_ids, tags)}
              canWrite={canWrite}
              onToggleBullhorn={(it) => toggle(it, 'bullhorned', api.toggleBullhorn)}
              onToggleStar={(it) => toggle(it, 'starred', api.toggleStar)}
              onOpen={openItem}
            />
          )}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
          onEndReached={onEndReached}
          onEndReachedThreshold={2}
          ListEmptyComponent={
            total === null ? (
              <View style={styles.center}>
                <ActivityIndicator style={{ marginTop: 48 }} />
              </View>
            ) : (
              <Text style={{ color: palette.subtleText, textAlign: 'center', padding: 48 }}>
                {mode === 'bullhorns'
                  ? 'Nothing bullhorned yet — find a favorite in Everything and tell the family about it!'
                  : 'No photos yet — upload the first one!'}
              </Text>
            )
          }
          ListFooterComponent={loadingMore ? <ActivityIndicator style={{ margin: 16 }} /> : null}
        />
      ) : null}
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
  modeRow: { flexDirection: 'row', gap: 8 },
  modeButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderRadius: 16,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
