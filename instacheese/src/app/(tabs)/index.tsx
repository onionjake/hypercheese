import { useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  FlatList,
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
import { usePalette } from '@/lib/theme';
import type { FeedItem } from '@/lib/types';

const PAGE_SIZE = 24;

export default function FeedScreen() {
  const { session, user } = useAuth();
  const palette = usePalette();
  const router = useRouter();
  const tags = useTagMap(session);

  const [items, setItems] = useState<FeedItem[]>([]);
  const [searchKey, setSearchKey] = useState('');
  const [total, setTotal] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const loadingRef = useRef(false);

  const canWrite = !!user?.can_write;

  const loadPage = useCallback(
    async (opts: { refresh?: boolean } = {}) => {
      if (!session || loadingRef.current) return;
      loadingRef.current = true;
      setError(null);
      const refresh = opts.refresh || items.length === 0;
      try {
        const page = await api.fetchFeed(session, {
          searchKey: refresh ? '' : searchKey,
          offset: refresh ? 0 : items.length,
          limit: PAGE_SIZE,
        });
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

  return (
    <SafeAreaView style={[styles.safe, { backgroundColor: palette.background }]} edges={['top']}>
      <View style={[styles.titleBar, { borderColor: palette.border }]}>
        <Text style={[styles.title, { color: palette.text }]}>🧀 InstaCheese</Text>
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
                No photos yet — upload the first one!
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
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: { fontSize: 20, fontWeight: '700' },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
});
