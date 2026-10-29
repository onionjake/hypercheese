import * as SecureStore from 'expo-secure-store';
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { Platform } from 'react-native';

import * as api from './api';
import type { Session } from './api';
import { claimCatalog, releaseCatalog } from './library-db';
import { log, logError } from './log';
import { clearTagCache } from './tags';
import type { CurrentUser } from './types';
import { clearAll as clearUploadQueue } from './upload-queue';

const STORAGE_KEY = 'instacheese.session';

export interface StoredSession extends Session {
  user: CurrentUser | null;
}

interface AuthContextValue {
  status: 'loading' | 'signedOut' | 'signedIn';
  session: Session | null;
  user: CurrentUser | null;
  signIn: (serverUrl: string, username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

// Everything cached on the device for the signed-in account that must not
// carry over to whoever signs in next. The upload queue persists across
// restarts — left behind, the next account would upload these files.
async function forgetAccountState(): Promise<void> {
  clearTagCache();
  await clearUploadQueue().catch((err) => logError('auth', 'could not clear upload queue', err));
  await releaseCatalog().catch((err) => logError('auth', 'could not release catalog', err));
}

// Identifies whose backup marks the library catalog holds. Scheme and a
// leading www. are dropped so the same server typed two ways still matches.
function accountKey(baseUrl: string, username: string): string {
  const host = baseUrl.replace(/^https?:\/\//i, '').replace(/^www\./i, '').toLowerCase();
  return `${host}|${username.trim().toLowerCase()}`;
}

// The background upload task reads the session while the phone is usually
// locked (iOS runs BGProcessingTasks overnight), and the default
// whenUnlocked keychain class refuses that. An existing item keeps its old
// class on update, so delete before writing. (iOS only: Android has no
// keychain classes, and a failed write after a delete would sign the user out.)
async function writeStoredSession(value: StoredSession): Promise<void> {
  if (Platform.OS === 'ios') await SecureStore.deleteItemAsync(STORAGE_KEY).catch(() => {});
  await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(value), {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
}

// Also used outside React (the background upload task) to act on behalf of
// the signed-in user without an AuthProvider.
export async function loadStoredSession(): Promise<StoredSession | null> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredSession;
    if (!parsed.baseUrl) return null;
    // Sessions stored by older app versions predate `mode`.
    parsed.mode ??= 'token';
    if (parsed.mode === 'token' && !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [status, setStatus] = useState<AuthContextValue['status']>('loading');
  const [session, setSession] = useState<Session | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  // Bumped by every sign-in and sign-out, so the startup refresh below can't
  // write back (or delete) a session that has since been replaced.
  const authEpoch = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const epoch = authEpoch.current;
    const stale = () => cancelled || authEpoch.current !== epoch;
    (async () => {
      const stored = await loadStoredSession();
      if (cancelled) return;
      if (!stored) {
        log('auth', 'no stored session');
        setStatus('signedOut');
        return;
      }
      log('auth', `restored ${stored.mode} session for ${stored.user?.username ?? 'unknown user'}`);
      setSession({ baseUrl: stored.baseUrl, mode: stored.mode, token: stored.token });
      setUser(stored.user);
      setStatus('signedIn');
      // Refresh the user in the background; sign out if the token was revoked.
      try {
        const fresh = await api.fetchCurrentUser(stored);
        if (stale()) return;
        log('auth', `current user refreshed (can_write=${!!fresh.can_write})`);
        setUser(fresh);
        await writeStoredSession({ ...stored, user: fresh });
      } catch (err) {
        logError('auth', 'could not refresh current user', err);
        if (!stale() && err instanceof api.ApiError && err.status === 401) {
          authEpoch.current++;
          // Session first: a background wakeup that reads it after the
          // queue clear below must find nothing to re-seed the queue with.
          await SecureStore.deleteItemAsync(STORAGE_KEY);
          await forgetAccountState();
          setSession(null);
          setUser(null);
          setStatus('signedOut');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const signIn = useCallback(async (serverUrl: string, username: string, password: string) => {
    const baseUrl = api.normalizeBaseUrl(serverUrl);
    const nickname = `InstaCheese on ${Platform.OS}`;
    authEpoch.current++;

    // A browser session left in the native cookie jar (a sign-out that
    // couldn't reach the server, a half-finished sign-in) would make the
    // server treat these credentials as that earlier user: /files/auth
    // trusts current_user over the posted password. Drop it first.
    await api.sessionLogout({ baseUrl, mode: 'session', token: null });

    // Preferred path: a device JWT that the upgraded backend accepts on /api.
    let token: string | null = null;
    try {
      token = await api.tokenLogin(baseUrl, username, password, nickname, Platform.OS);
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 401) {
        throw new Error('Invalid username or password');
      }
      // Anything else (404, 500, proxy errors) just means the token endpoint
      // isn't usable — fall through to a browser-style session login.
    }

    if (token) {
      const tokenSession: Session = { baseUrl, mode: 'token', token };
      try {
        const freshUser = await api.fetchCurrentUser(tokenSession);
        await persist(tokenSession, freshUser);
        return;
      } catch (err) {
        if (!(err instanceof api.ApiError && err.status === 401)) {
          throw err instanceof Error ? err : new Error('Could not reach the server');
        }
        // 401 with a fresh token: the backend doesn't accept API tokens yet.
      }
    }

    // Fallback for servers without the API token support: Devise session.
    await api.sessionLogin(baseUrl, username, password);
    const sessionSession: Session = { baseUrl, mode: 'session', token };
    let freshUser: CurrentUser;
    try {
      freshUser = await api.fetchCurrentUser(sessionSession);
    } catch (err) {
      if (err instanceof api.ApiError && err.status === 401) {
        throw new Error('Invalid username or password');
      }
      throw err instanceof Error ? err : new Error('Could not sign in');
    }
    await persist(sessionSession, freshUser);

    async function persist(newSession: Session, newUser: CurrentUser | null) {
      // Before the session goes live (and the upload queue starts): a
      // different account must not inherit this device's backup marks.
      await claimCatalog(accountKey(baseUrl, username));
      clearTagCache();
      await writeStoredSession({ ...newSession, user: newUser });
      setSession(newSession);
      setUser(newUser);
      setStatus('signedIn');
    }
  }, []);

  const signOut = useCallback(async () => {
    authEpoch.current++;
    // In token mode too: a stray browser cookie would otherwise outlive the
    // sign-out (see signIn).
    if (session) await api.sessionLogout(session);
    // Stored session before the queue clear: a background wakeup in between
    // would otherwise read it after the clear and re-queue this account's
    // marks for whoever signs in next.
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    await forgetAccountState();
    setSession(null);
    setUser(null);
    setStatus('signedOut');
  }, [session]);

  const value = useMemo(
    () => ({ status, session, user, signIn, signOut }),
    [status, session, user, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function useSession(): Session {
  const { session } = useAuth();
  if (!session) throw new Error('No active session');
  return session;
}
