import * as SecureStore from 'expo-secure-store';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import * as api from './api';
import type { Session } from './api';
import type { CurrentUser } from './types';

const STORAGE_KEY = 'instacheese.session';

interface StoredSession extends Session {
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

async function loadStored(): Promise<StoredSession | null> {
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const stored = await loadStored();
      if (cancelled) return;
      if (!stored) {
        setStatus('signedOut');
        return;
      }
      setSession({ baseUrl: stored.baseUrl, mode: stored.mode, token: stored.token });
      setUser(stored.user);
      setStatus('signedIn');
      // Refresh the user in the background; sign out if the token was revoked.
      try {
        const fresh = await api.fetchCurrentUser(stored);
        if (cancelled) return;
        setUser(fresh);
        await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify({ ...stored, user: fresh }));
      } catch (err) {
        if (!cancelled && err instanceof api.ApiError && err.status === 401) {
          await SecureStore.deleteItemAsync(STORAGE_KEY);
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
      await SecureStore.setItemAsync(
        STORAGE_KEY,
        JSON.stringify({ ...newSession, user: newUser })
      );
      setSession(newSession);
      setUser(newUser);
      setStatus('signedIn');
    }
  }, []);

  const signOut = useCallback(async () => {
    if (session?.mode === 'session') {
      await api.sessionLogout(session);
    }
    await SecureStore.deleteItemAsync(STORAGE_KEY);
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
