export interface FeedComment {
  text: string;
  username: string | null;
  created_at: string;
}

export interface FeedSource {
  label: string | null;
  user_name: string | null;
}

export interface FeedItem {
  id: number;
  code: string;
  variety: 'photo' | 'video';
  has_comments: boolean;
  starred: boolean;
  bullhorned: boolean;
  rating: number | null;
  tag_ids: number[];
  // Optional: servers older than the feed-metadata upgrade omit these.
  taken?: string | null;
  comment_count?: number;
  first_comment?: FeedComment | null;
  source?: FeedSource | null;
}

export interface Comment {
  id: number;
  text: string;
  created_at: string;
  item_id: number;
  username: string;
}

export interface ItemDetails {
  id: number;
  taken: string | null;
  width: number | null;
  height: number | null;
  latitude: number | null;
  longitude: number | null;
  ages: Record<string, string>;
  locations: string[];
  places: string[];
  paths: string[];
  pretty_size: string | null;
  exif: Record<string, unknown> | null;
  comments: Comment[];
}

export interface Tag {
  id: number;
  label: string;
  icon_id: number | null;
  icon_code: string | null;
  item_count: number;
  parent_id: number | null;
  alias: string | null;
}

export interface CurrentUser {
  id: number | null;
  username: string | null;
  name: string | null;
  can_write: boolean;
  is_admin: boolean;
}

export interface FeedPage {
  items: FeedItem[];
  searchKey: string;
  total: number;
}
