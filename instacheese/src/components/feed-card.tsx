import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';

import { ActionRow } from './action-row';
import type { Session } from '@/lib/api';
import { resizedUrl } from '@/lib/api';
import { usePalette } from '@/lib/theme';
import { timeAgo } from '@/lib/time';
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

  const author = item.source?.user_name || item.source?.label || null;
  const when = timeAgo(item.taken);
  const commentCount = item.comment_count ?? (item.has_comments ? 1 : 0);
  const firstComment = item.first_comment;

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
      {firstComment ? (
        <Pressable onPress={() => onOpen(item)}>
          <Text style={[styles.comment, { color: palette.text }]} numberOfLines={2}>
            {firstComment.username ? (
              <Text style={styles.commentUser}>{firstComment.username} </Text>
            ) : null}
            {firstComment.text}
          </Text>
        </Pressable>
      ) : null}
      {commentCount > 1 ? (
        <Pressable onPress={() => onOpen(item)}>
          <Text style={[styles.moreComments, { color: palette.subtleText }]}>
            View all {commentCount} comments
          </Text>
        </Pressable>
      ) : !firstComment && commentCount > 0 ? (
        // Older servers only say whether comments exist, not what they are.
        <Pressable onPress={() => onOpen(item)}>
          <Text style={[styles.moreComments, { color: palette.subtleText }]}>View comments</Text>
        </Pressable>
      ) : null}
      {author || when ? (
        <Text style={[styles.meta, { color: palette.subtleText }]} numberOfLines={1}>
          {[author, when].filter(Boolean).join(' · ')}
        </Text>
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
  comment: {
    paddingHorizontal: 12,
    paddingBottom: 4,
    fontSize: 14,
  },
  commentUser: {
    fontWeight: '600',
  },
  moreComments: {
    paddingHorizontal: 12,
    paddingBottom: 4,
    fontSize: 14,
  },
  meta: {
    paddingHorizontal: 12,
    paddingBottom: 12,
    fontSize: 12,
  },
});
