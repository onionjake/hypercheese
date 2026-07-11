import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { ActionRow } from './action-row';
import type { Session } from '@/lib/api';
import { resizedUrl } from '@/lib/api';
import { usePalette } from '@/lib/theme';
import type { FeedItem } from '@/lib/types';

interface Props {
  item: FeedItem;
  session: Session;
  tagLine: string;
  canWrite: boolean;
  onToggleBullhorn: (item: FeedItem) => void;
  onToggleStar: (item: FeedItem) => void;
  onOpen: (item: FeedItem) => void;
}

export const FeedCard = memo(function FeedCard({
  item,
  session,
  tagLine,
  canWrite,
  onToggleBullhorn,
  onToggleStar,
  onOpen,
}: Props) {
  const palette = usePalette();
  const { width } = useWindowDimensions();
  const imageSize = Math.min(width, 600);

  return (
    <View style={[styles.card, { backgroundColor: palette.card, borderColor: palette.border }]}>
      {tagLine ? (
        <Text style={[styles.header, { color: palette.text }]} numberOfLines={1}>
          {tagLine}
        </Text>
      ) : null}
      <Pressable onPress={() => onOpen(item)}>
        <Image
          source={{ uri: resizedUrl(session, item, 'large') }}
          style={{ width: imageSize, height: imageSize, alignSelf: 'center' }}
          contentFit="cover"
          recyclingKey={String(item.id)}
          transition={150}
        />
        {item.variety === 'video' ? (
          <View style={styles.playBadge}>
            <Ionicons name="play" size={28} color="#fff" />
          </View>
        ) : null}
      </Pressable>
      <ActionRow
        item={item}
        canWrite={canWrite}
        onToggleBullhorn={() => onToggleBullhorn(item)}
        onToggleStar={() => onToggleStar(item)}
        onPressComments={() => onOpen(item)}
      />
      {item.has_comments ? (
        <Pressable onPress={() => onOpen(item)}>
          <Text style={[styles.comments, { color: palette.subtleText }]}>View comments</Text>
        </Pressable>
      ) : null}
    </View>
  );
});

const styles = StyleSheet.create({
  card: {
    marginBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  header: {
    fontWeight: '600',
    fontSize: 14,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  playBadge: {
    position: 'absolute',
    top: '50%',
    left: '50%',
    marginTop: -26,
    marginLeft: -26,
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingLeft: 3,
  },
  comments: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    fontSize: 14,
  },
});
