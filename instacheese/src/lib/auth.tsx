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
    if (!parsed.baseUrl || !parsed.token) return null;
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
      setSession({ baseUrl: stored.baseUrl, token: stored.token });
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
    const token = await api.login(baseUrl, username, password, nickname, Platform.OS);
    const newSession: Session = { baseUrl, token };
    let freshUser: CurrentUser | null = null;
    try {
      freshUser = await api.fetchCurrentUser(newSession);
    } catch {
      // The server may not have API token auth deployed yet; the token is
      // still valid for uploads, so continue signed in.
    }
    await SecureStore.setItemAsync(
      STORAGE_KEY,
      JSON.stringify({ ...newSession, user: freshUser })
    );
    setSession(newSession);
    setUser(freshUser);
    setStatus('signedIn');
  }, []);

  const signOut = useCallback(async () => {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    setSession(null);
    setUser(null);
    setStatus('signedOut');
  }, []);

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
