import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import type { LibraryAsset } from '@/lib/library-db';
import { accent } from '@/lib/theme';

// One square of the Backup grid. Memoized: the grid re-renders whenever any
// asset changes (taps, upload-queue badge updates), and only the cells whose
// asset object actually changed should do any work. That relies on the
// parent passing stable `onToggle` / `onDetails` callbacks and replacing an
// asset object only when that asset changed.
export const LibraryCell = memo(function LibraryCell({
  item,
  onToggle,
  onDetails,
}: {
  item: LibraryAsset;
  onToggle: (item: LibraryAsset) => void;
  onDetails: (item: LibraryAsset) => void;
}) {
  return (
    <Pressable
      style={styles.cell}
      onPress={() => onToggle(item)}
      onLongPress={() => onDetails(item)}
      accessibilityRole="checkbox"
      accessibilityLabel={item.filename}
      accessibilityState={{ checked: item.selected }}
      accessibilityHint="Long press for details"
    >
      {/* expo-image downsamples the original to the cell size when it
          decodes (allowDownscaling defaults to on), so the bitmap is
          thumbnail-sized. Its default 'disk' policy skips the memory cache,
          though, so every remount (scrolling back, a window shift) decoded
          again; keep decoded thumbnails in the bounded memory cache too. */}
      <Image
        source={{ uri: item.uri }}
        style={styles.thumb}
        contentFit="cover"
        recyclingKey={item.id}
        cachePolicy="memory-disk"
      />
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
});

// Margin of each cell on every side. A full grid row is therefore exactly
// one third of the list width tall (cell side = width / 3 - 2 * margin).
export const LIBRARY_CELL_MARGIN = 1;

const styles = StyleSheet.create({
  cell: { flex: 1, maxWidth: '33.333%', aspectRatio: 1, margin: LIBRARY_CELL_MARGIN },
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
});
