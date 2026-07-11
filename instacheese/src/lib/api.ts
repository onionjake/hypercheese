import type { Comment, CurrentUser, FeedItem, FeedPage, ItemDetails, Tag } from './types';

export interface Session {
  baseUrl: string;
  token: string;
}

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const CLIENT_SOFTWARE = 'instacheese';
export const CLIENT_VERSION = '1.0.0';

export function normalizeBaseUrl(input: string): string {
  let url = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  return url;
}

async function request<T>(session: Session, path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${session.token}`,
    ...((init.headers as Record<string, string>) || {}),
  };
  if (typeof init.body === 'string' && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(session.baseUrl + path, { ...init, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || `Request failed (${res.status})`);
  }
  return (await res.json()) as T;
}

export async function login(
  baseUrl: string,
  username: string,
  password: string,
  nickname: string,
  os: string
): Promise<string> {
  const res = await fetch(`${baseUrl}/files/auth`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-API-Version': '1.0',
    },
    body: JSON.stringify({
      username,
      password,
      nickname,
      os,
      client_software: CLIENT_SOFTWARE,
      client_version: CLIENT_VERSION,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, res.status === 401 ? 'Invalid username or password' : text);
  }
  const json = (await res.json()) as { token: string };
  return json.token;
}

export async function fetchCurrentUser(session: Session): Promise<CurrentUser> {
  return request<CurrentUser>(session, '/api/users/current');
}

export async function fetchFeed(
  session: Session,
  opts: { searchKey?: string; offset?: number; limit?: number; query?: string } = {}
): Promise<FeedPage> {
  const params = new URLSearchParams();
  params.set('search_key', opts.searchKey ?? '');
  params.set('offset', String(opts.offset ?? 0));
  params.set('limit', String(opts.limit ?? 24));
  if (opts.query) {
    // Free-form text becomes a CLIP similarity search on the server.
    params.set('query[clip]', opts.query);
  }
  const json = await request<{
    items: FeedItem[];
    meta: { search_key: string; total: number };
  }>(session, `/api/items?${params.toString()}`);
  return { items: json.items, searchKey: json.meta.search_key, total: json.meta.total };
}

export async function fetchItem(session: Session, id: number): Promise<FeedItem> {
  const json = await request<{ item: FeedItem }>(session, `/api/items/${id}`);
  return json.item;
}

export async function fetchItemDetails(session: Session, id: number): Promise<ItemDetails> {
  const json = await request<{ item: ItemDetails }>(session, `/api/items/${id}/details`);
  return json.item;
}

export async function toggleStar(session: Session, id: number): Promise<FeedItem> {
  const json = await request<{ item: FeedItem }>(session, `/api/items/${id}/toggle_star`, {
    method: 'POST',
  });
  return json.item;
}

export async function toggleBullhorn(session: Session, id: number): Promise<FeedItem> {
  const json = await request<{ item: FeedItem }>(session, `/api/items/${id}/toggle_bullhorn`, {
    method: 'POST',
  });
  return json.item;
}

export async function postComment(session: Session, itemId: number, text: string): Promise<Comment> {
  const json = await request<{ comment: Comment }>(session, '/api/comments', {
    method: 'POST',
    body: JSON.stringify({ comment: { item_id: itemId, text } }),
  });
  return json.comment;
}

export async function fetchTags(session: Session): Promise<Tag[]> {
  const json = await request<{ tags: Tag[] }>(session, '/api/tags');
  return json.tags;
}

export type ImageSize = 'square' | 'large' | 'stream' | 'exploded';

export function resizedUrl(
  session: Session,
  item: { id: number; code: string },
  size: ImageSize
): string {
  const ext = size === 'stream' ? 'mp4' : 'jpg';
  return `${session.baseUrl}/data/resized/${size}/${item.id}-${item.code}.${ext}`;
}
