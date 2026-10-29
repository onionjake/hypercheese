import type { Comment, CurrentUser, FeedItem, FeedPage, ItemDetails, Tag } from './types';

// 'token' — the upgraded backend accepts the device JWT on /api endpoints.
// 'session' — older backend: Devise session cookie + CSRF token, like the web app.
export type AuthMode = 'token' | 'session';

export interface Session {
  baseUrl: string;
  mode: AuthMode;
  token: string | null;
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

// React Native's Android client has no default timeout; without one a
// stalled connection leaves sign-in or the feed spinning forever.
const REQUEST_TIMEOUT_MS = 60_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: abort.signal });
  } catch (err) {
    if (abort.signal.aborted) throw new Error('The server took too long to respond');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// --- CSRF support for session mode -----------------------------------------
// Older backends protect /api writes with Rails CSRF. We do what the web app
// does: read <meta name="csrf-token"> from an HTML page and send it as
// X-CSRF-Token. The token is cached per server and refreshed on failure.

const csrfTokens = new Map<string, string>();

function extractCsrfToken(html: string): string | null {
  const meta = html.match(/<meta[^>]+name="csrf-token"[^>]+content="([^"]+)"/);
  if (meta) return meta[1];
  const metaReversed = html.match(/<meta[^>]+content="([^"]+)"[^>]+name="csrf-token"/);
  if (metaReversed) return metaReversed[1];
  const input = html.match(/name="authenticity_token"[^>]+value="([^"]+)"/);
  return input ? input[1] : null;
}

async function fetchCsrfToken(
  baseUrl: string,
  path = '/',
  signal?: AbortSignal
): Promise<string> {
  const res = signal
    ? await fetch(baseUrl + path, { credentials: 'include', signal })
    : await fetchWithTimeout(baseUrl + path, { credentials: 'include' });
  const html = await res.text();
  const token = extractCsrfToken(html);
  if (!token) throw new ApiError(res.status, 'Could not find CSRF token');
  csrfTokens.set(baseUrl, token);
  return token;
}

async function request<T>(session: Session, path: string, init: RequestInit = {}): Promise<T> {
  const method = (init.method || 'GET').toUpperCase();

  const doFetch = async (csrfToken: string | null) => {
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...((init.headers as Record<string, string>) || {}),
    };
    if (session.mode === 'token' && session.token) {
      headers.Authorization = `Bearer ${session.token}`;
    }
    if (csrfToken) {
      headers['X-CSRF-Token'] = csrfToken;
    }
    if (typeof init.body === 'string' && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }
    return fetchWithTimeout(session.baseUrl + path, { ...init, credentials: 'include', headers });
  };

  const needsCsrf = session.mode === 'session' && method !== 'GET';
  let csrfToken: string | null = null;
  if (needsCsrf) {
    csrfToken = csrfTokens.get(session.baseUrl) ?? (await fetchCsrfToken(session.baseUrl));
  }

  let res = await doFetch(csrfToken);

  // A failed write in session mode is usually a stale CSRF token — refresh
  // it once and retry. Rails rejects a bad token before the action runs
  // (this server raises, so it's a 500; stock Rails says 422), so those are
  // safe to replay. A gateway error may have reached a committed write, and
  // replaying a toggle or comment would undo or duplicate it.
  if (needsCsrf && (res.status === 422 || res.status === 500)) {
    csrfToken = await fetchCsrfToken(session.baseUrl);
    res = await doFetch(csrfToken);
  }

  // Unapproved accounts are redirected to an HTML page (a 200, or an error
  // status for a JSON Accept); say so rather than surfacing its body.
  if (res.url.includes('/users/pending')) {
    throw new ApiError(403, 'Your account is waiting for approval by a family admin');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || `Request failed (${res.status})`);
  }
  try {
    return (await res.json()) as T;
  } catch {
    throw new ApiError(res.status, 'Unexpected response from the server');
  }
}

export async function tokenLogin(
  baseUrl: string,
  username: string,
  password: string,
  nickname: string,
  os: string
): Promise<string> {
  const res = await fetchWithTimeout(`${baseUrl}/files/auth`, {
    method: 'POST',
    // The server prefers a cookie session's user over these credentials.
    credentials: 'omit',
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

// A device token for the user the browser session (cookie) belongs to —
// /files/auth trusts current_user, so no password is needed. Used to recover
// upload credentials when the password-based tokenLogin failed transiently.
// Only call while the cookie jar is known to hold THIS user's session.
export async function tokenFromSession(
  baseUrl: string,
  nickname: string,
  os: string
): Promise<string> {
  const res = await fetchWithTimeout(`${baseUrl}/files/auth`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', 'X-API-Version': '1.0' },
    body: JSON.stringify({
      nickname,
      os,
      client_software: CLIENT_SOFTWARE,
      client_version: CLIENT_VERSION,
    }),
  });
  if (!res.ok) {
    throw new ApiError(res.status, (await res.text().catch(() => '')) || 'Could not get upload token');
  }
  const json = (await res.json()) as { token?: string };
  if (!json.token) throw new ApiError(res.status, 'Could not get upload token');
  return json.token;
}

// Sign in the way a browser does: fetch the Devise form for a CSRF token,
// then POST the credentials. React Native's networking stack stores the
// session cookie automatically, so later /api requests are authenticated.
export async function sessionLogin(
  baseUrl: string,
  username: string,
  password: string
): Promise<void> {
  const csrfToken = await fetchCsrfToken(baseUrl, '/users/sign_in');
  const form = new URLSearchParams({
    authenticity_token: csrfToken,
    'user[login]': username,
    'user[password]': password,
    'user[remember_me]': '1',
  });
  const res = await fetchWithTimeout(`${baseUrl}/users/sign_in`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (!res.ok && res.status !== 302) {
    throw new ApiError(res.status, 'Could not sign in');
  }
  // Signing in rotates the Rails session, so any cached CSRF token is stale.
  csrfTokens.delete(baseUrl);
  // Success and failure both end as a 200 HTML page after redirects, so the
  // caller confirms the session by fetching the current user.
}

// Ends any browser session (and remember-me cookie) for this server. Best
// effort and bounded: sign-in and sign-out both wait on it, and a dead
// network must not hang either.
// Resolves true when the server answered the sign-out, i.e. the cookie jar
// is known to hold no earlier user's session afterwards.
export async function sessionLogout(session: Session): Promise<boolean> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10_000);
  try {
    const csrfToken = await fetchCsrfToken(session.baseUrl, '/', abort.signal);
    const res = await fetch(`${session.baseUrl}/users/sign_out`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrfToken },
      signal: abort.signal,
    });
    return res.status < 500;
  } catch {
    // Best effort — local state is cleared regardless.
    return false;
  } finally {
    clearTimeout(timer);
    csrfTokens.delete(session.baseUrl);
  }
}

export async function fetchCurrentUser(session: Session): Promise<CurrentUser> {
  return request<CurrentUser>(session, '/api/users/current');
}

export async function fetchFeed(
  session: Session,
  opts: {
    searchKey?: string;
    offset?: number;
    limit?: number;
    query?: string;
    bullhorned?: boolean;
  } = {}
): Promise<FeedPage> {
  const params = new URLSearchParams();
  params.set('search_key', opts.searchKey ?? '');
  params.set('offset', String(opts.offset ?? 0));
  params.set('limit', String(opts.limit ?? 24));
  if (opts.query) {
    // Free-form text becomes a CLIP similarity search on the server.
    params.set('query[clip]', opts.query);
  }
  if (opts.bullhorned) {
    // Only items someone bullhorned.
    params.set('query[bullhorned]', '1');
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
