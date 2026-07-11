import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Stack, useLocalSearchParams } from 'expo-router';
import { useHeaderHeight } from 'expo-router/build/react-navigation/elements';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  useWindowDimensions,
} from 'react-native';

import { ActionRow } from '@/components/action-row';
import * as api from '@/lib/api';
import { useAuth } from '@/lib/auth';
import { tagLine, useTagMap } from '@/lib/tags';
import { accent, usePalette } from '@/lib/theme';
import type { Comment, FeedItem, ItemDetails, Tag } from '@/lib/types';

function formatTaken(taken: string | null): string {
  if (!taken) return '';
  const date = new Date(taken);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
}

function formatTakenFull(taken: string | null): string {
  if (!taken) return '';
  const date = new Date(taken);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatCommentTime(createdAt: string): string {
  const date = new Date(createdAt);
  if (isNaN(date.getTime())) return '';
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function exifValue(exif: Record<string, unknown> | null, key: string): string | null {
  const value = exif?.[key];
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && isFinite(value)) return String(value);
  return null;
}

// Build the info rows from whatever details the server actually has.
function buildInfoRows(details: ItemDetails, tags: Map<number, Tag> | null): [string, string][] {
  const rows: [string, string][] = [];

  const taken = formatTakenFull(details.taken);
  if (taken) rows.push(['Taken', taken]);

  if (details.width && details.height) {
    const megapixels = (details.width * details.height) / 1_000_000;
    rows.push([
      'Dimensions',
      `${details.width} × ${details.height}${megapixels >= 1 ? ` (${megapixels.toFixed(1)} MP)` : ''}`,
    ]);
  }
  if (details.pretty_size) rows.push(['File size', details.pretty_size]);

  const camera = [exifValue(details.exif, 'make'), exifValue(details.exif, 'model')]
    .filter(Boolean)
    .join(' ');
  if (camera) rows.push(['Camera', camera]);

  const exposureParts = [
    exifValue(details.exif, 'f_number') && `ƒ/${exifValue(details.exif, 'f_number')}`,
    exifValue(details.exif, 'exposure_time') && `${exifValue(details.exif, 'exposure_time')}s`,
    exifValue(details.exif, 'iso_speed_ratings') && `ISO ${exifValue(details.exif, 'iso_speed_ratings')}`,
    exifValue(details.exif, 'focal_length') && `${exifValue(details.exif, 'focal_length')}mm`,
  ].filter(Boolean) as string[];
  if (exposureParts.length) rows.push(['Exposure', exposureParts.join(' · ')]);

  const where = [...(details.places ?? []), ...(details.locations ?? [])];
  if (where.length) rows.push(['Location', where.join(', ')]);
  if (details.latitude != null && details.longitude != null) {
    rows.push(['GPS', `${details.latitude.toFixed(5)}, ${details.longitude.toFixed(5)}`]);
  }

  for (const [tagId, age] of Object.entries(details.ages ?? {})) {
    const tag = tags?.get(Number(tagId));
    rows.push(['Age', tag ? `${tag.alias || tag.label}: ${age}` : age]);
  }

  if (details.paths?.length) {
    rows.push(['File', details.paths[0].split('/').pop() ?? details.paths[0]]);
  }

  return rows;
}

function VideoPlayer({ uri, width, height }: { uri: string; width: number; height: number }) {
  const player = useVideoPlayer(uri);
  return (
    <VideoView
      player={player}
      style={{ width, height }}
      contentFit="contain"
      nativeControls
    />
  );
}

export default function ItemScreen() {
  const params = useLocalSearchParams<{ id: string; code?: string; variety?: string }>();
  const id = Number(params.id);
  const { session, user } = useAuth();
  const palette = usePalette();
  const tags = useTagMap(session);
  const { width } = useWindowDimensions();
  const headerHeight = useHeaderHeight();

  const [item, setItem] = useState<FeedItem | null>(null);
  const [details, setDetails] = useState<ItemDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [posting, setPosting] = useState(false);
  const [showInfo, setShowInfo] = useState(false);

  const canWrite = !!user?.can_write;

  const load = useCallback(async () => {
    if (!session) return;
    setError(null);
    try {
      const [freshItem, freshDetails] = await Promise.all([
        api.fetchItem(session, id),
        api.fetchItemDetails(session, id),
      ]);
      setItem(freshItem);
      setDetails(freshDetails);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load this item');
    }
  }, [session, id]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (
    field: 'bullhorned' | 'starred',
    call: (s: api.Session, id: number) => Promise<FeedItem>
  ) => {
    if (!session || !item) return;
    const previous = item;
    setItem({ ...item, [field]: !item[field] });
    try {
      setItem(await call(session, item.id));
    } catch {
      setItem(previous);
    }
  };

  const submitComment = async () => {
    const text = commentText.trim();
    if (!session || !text || posting) return;
    setPosting(true);
    try {
      const comment = await api.postComment(session, id, text);
      setCommentText('');
      setDetails((prev) =>
        prev ? { ...prev, comments: [...prev.comments, comment] } : prev
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not post comment');
    } finally {
      setPosting(false);
    }
  };

  const code = item?.code ?? (params.code as string | undefined);
  const variety = item?.variety ?? (params.variety as string | undefined);
  const aspect =
    details?.width && details?.height ? details.width / details.height : 1;
  const mediaWidth = Math.min(width, 600);
  const mediaHeight = Math.min(mediaWidth / aspect, mediaWidth * 1.6);
  const infoRows = details ? buildInfoRows(details, tags) : [];

  return (
    <>
      <Stack.Screen options={{ title: formatTaken(details?.taken ?? null) || 'Photo' }} />
      <KeyboardAvoidingView
        style={[styles.flex, { backgroundColor: palette.background }]}
        behavior="padding"
        keyboardVerticalOffset={headerHeight}
      >
        <ScrollView contentContainerStyle={styles.scroll} keyboardShouldPersistTaps="handled">
          {code && session ? (
            variety === 'video' ? (
              <VideoPlayer
                uri={api.resizedUrl(session, { id, code }, 'stream')}
                width={mediaWidth}
                height={mediaHeight}
              />
            ) : (
              <Image
                source={{ uri: api.resizedUrl(session, { id, code }, 'large') }}
                style={{ width: mediaWidth, height: mediaHeight, alignSelf: 'center' }}
                contentFit="contain"
                transition={150}
              />
            )
          ) : (
            <ActivityIndicator style={{ margin: 48 }} />
          )}

          {item ? (
            <View style={styles.actionRowWrap}>
              <View style={styles.flex}>
                <ActionRow
                  item={item}
                  canWrite={canWrite}
                  onToggleBullhorn={() => toggle('bullhorned', api.toggleBullhorn)}
                  onToggleStar={() => toggle('starred', api.toggleStar)}
                />
              </View>
              {infoRows.length ? (
                <Pressable onPress={() => setShowInfo((v) => !v)} hitSlop={8} style={styles.infoButton}>
                  <Ionicons
                    name={showInfo ? 'information-circle' : 'information-circle-outline'}
                    size={26}
                    color={showInfo ? accent : palette.text}
                  />
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {item && tags ? (
            <Text style={[styles.tags, { color: palette.text }]}>
              {tagLine(item.tag_ids, tags)}
            </Text>
          ) : null}

          {showInfo && infoRows.length ? (
            <View style={[styles.info, { backgroundColor: palette.card, borderColor: palette.border }]}>
              {infoRows.map(([label, value], index) => (
                <View key={`${label}-${index}`} style={styles.infoRow}>
                  <Text style={[styles.infoLabel, { color: palette.subtleText }]}>{label}</Text>
                  <Text style={[styles.infoValue, { color: palette.text }]}>{value}</Text>
                </View>
              ))}
            </View>
          ) : null}

          {error ? <Text style={styles.error}>{error}</Text> : null}

          <View style={styles.comments}>
            {details?.comments.map((comment: Comment) => (
              <View key={comment.id} style={styles.comment}>
                <Text style={{ color: palette.text }}>
                  <Text style={styles.commentUser}>{comment.username} </Text>
                  {comment.text}
                </Text>
                <Text style={[styles.commentTime, { color: palette.subtleText }]}>
                  {formatCommentTime(comment.created_at)}
                </Text>
              </View>
            ))}
            {details && details.comments.length === 0 ? (
              <Text style={{ color: palette.subtleText }}>No comments yet.</Text>
            ) : null}
          </View>
        </ScrollView>

        {canWrite ? (
          <View style={[styles.inputRow, { borderColor: palette.border, backgroundColor: palette.card }]}>
            <TextInput
              style={[
                styles.input,
                { backgroundColor: palette.inputBackground, color: palette.text },
              ]}
              placeholder="Add a comment…"
              placeholderTextColor={palette.subtleText}
              value={commentText}
              onChangeText={setCommentText}
              multiline
            />
            <Pressable
              onPress={submitComment}
              disabled={!commentText.trim() || posting}
              style={[styles.send, (!commentText.trim() || posting) && { opacity: 0.4 }]}
            >
              <Text style={styles.sendText}>Post</Text>
            </Pressable>
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  scroll: { paddingBottom: 24 },
  actionRowWrap: { flexDirection: 'row', alignItems: 'center' },
  infoButton: { paddingHorizontal: 12, paddingVertical: 8 },
  tags: { paddingHorizontal: 12, fontWeight: '600' },
  info: {
    marginHorizontal: 12,
    marginTop: 10,
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 10,
    padding: 12,
    gap: 6,
  },
  infoRow: { flexDirection: 'row', gap: 10 },
  infoLabel: { width: 90, fontSize: 13, fontWeight: '600' },
  infoValue: { flex: 1, fontSize: 13 },
  error: { color: '#ED4956', padding: 12 },
  comments: { padding: 12, gap: 10 },
  comment: { gap: 2 },
  commentUser: { fontWeight: '700' },
  commentTime: { fontSize: 12 },
  inputRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    padding: 10,
    gap: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  input: {
    flex: 1,
    borderRadius: 18,
    paddingHorizontal: 14,
    paddingVertical: 8,
    fontSize: 15,
    maxHeight: 120,
  },
  send: { paddingHorizontal: 6, paddingVertical: 10 },
  sendText: { color: accent, fontWeight: '700', fontSize: 15 },
});
