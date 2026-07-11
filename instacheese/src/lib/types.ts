export interface FeedItem {
  id: number;
  code: string;
  variety: 'photo' | 'video';
  has_comments: boolean;
  starred: boolean;
  bullhorned: boolean;
  rating: number | null;
  tag_ids: number[];
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
