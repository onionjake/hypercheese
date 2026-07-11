import { Ionicons } from '@expo/vector-icons';
import { Pressable, StyleSheet, View } from 'react-native';

import type { FeedItem } from '@/lib/types';
import { likeColor, starColor, usePalette } from '@/lib/theme';

interface Props {
  item: FeedItem;
  canWrite: boolean;
  onToggleBullhorn: () => void;
  onToggleStar: () => void;
  onPressComments?: () => void;
}

// Bullhorn = "tell the family about this" (the social like).
// Star = private bookmark, like Instagram's save.
export function ActionRow({ item, canWrite, onToggleBullhorn, onToggleStar, onPressComments }: Props) {
  const palette = usePalette();
  return (
    <View style={styles.row}>
      <Pressable
        onPress={onToggleBullhorn}
        disabled={!canWrite}
        hitSlop={8}
        style={styles.button}
      >
        <Ionicons
          name={item.bullhorned ? 'megaphone' : 'megaphone-outline'}
          size={26}
          color={item.bullhorned ? likeColor : palette.text}
        />
      </Pressable>
      {onPressComments ? (
        <Pressable onPress={onPressComments} hitSlop={8} style={styles.button}>
          <Ionicons name="chatbubble-outline" size={25} color={palette.text} />
        </Pressable>
      ) : null}
      <View style={styles.spacer} />
      <Pressable onPress={onToggleStar} disabled={!canWrite} hitSlop={8} style={styles.button}>
        <Ionicons
          name={item.starred ? 'star' : 'star-outline'}
          size={26}
          color={item.starred ? starColor : palette.text}
        />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    gap: 16,
  },
  button: { padding: 2 },
  spacer: { flex: 1 },
});
