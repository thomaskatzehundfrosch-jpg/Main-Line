import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  ReactNode,
} from 'react';
import type { User, Session, AuthError } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabase';

// ─── Types ────────────────────────────────────────────────────────────────────

type AuthActionError = Pick<AuthError, 'message'>;

export interface AuthState {
  user: User | null;
  session: Session | null;
  loading: boolean;
}

export interface AuthActions {
  signUp: (email: string, password: string) => Promise<{ error: AuthActionError | null }>;
  signIn: (email: string, password: string) => Promise<{ error: AuthActionError | null }>;
  signInWithGoogle: () => Promise<{ error: AuthActionError | null }>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<(AuthState & AuthActions) | null>(null);
const AUTH_TIMEOUT_MS = 10000;
const AUTH_TIMEOUT_MESSAGE =
  'Authentication is taking too long. The auth service may be unavailable right now. Please try again in a moment.';

function timeoutAuthError(): AuthActionError {
  return { message: AUTH_TIMEOUT_MESSAGE };
}

function normalizeAuthError(error: unknown): AuthActionError {
  const message = error instanceof Error ? error.message : 'Authentication failed.';

  if (message === 'Failed to fetch' || message.toLowerCase().includes('networkerror')) {
    return {
      message:
        'Could not reach the cloud sync service. Check your connection and verify the deployed app has valid Supabase environment variables.',
    };
  }

  return { message };
}

async function withAuthTimeout<T>(
  operation: Promise<T>
): Promise<{ data: T | null; error: AuthActionError | null }> {
  try {
    const data = await Promise.race<T>([
      operation,
      new Promise<T>((_, reject) => {
        window.setTimeout(() => reject(new Error(AUTH_TIMEOUT_MESSAGE)), AUTH_TIMEOUT_MS);
      }),
    ]);
    return { data, error: null };
  } catch (error) {
    if (error instanceof Error && error.message === AUTH_TIMEOUT_MESSAGE) {
      return { data: null, error: timeoutAuthError() };
    }

    return {
      data: null,
      error: normalizeAuthError(error),
    };
  }
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!isSupabaseConfigured) {
      setLoading(false);
      return;
    }

    // Get initial session
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setUser(session?.user ?? null);
      setLoading(false);
    });

    // Listen for auth changes
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
        setUser(session?.user ?? null);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    if (!isSupabaseConfigured) {
      return { error: { message: 'Cloud sync is not configured for this app build yet.' } };
    }
    const { data, error } = await withAuthTimeout(
      supabase.auth.signUp({ email, password })
    );
    return { error: error ?? data?.error ?? null };
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    if (!isSupabaseConfigured) {
      return { error: { message: 'Cloud sync is not configured for this app build yet.' } };
    }
    const { data, error } = await withAuthTimeout(
      supabase.auth.signInWithPassword({ email, password })
    );
    return { error: error ?? data?.error ?? null };
  }, []);

  const signInWithGoogle = useCallback(async () => {
    if (!isSupabaseConfigured) {
      return { error: { message: 'Cloud sync is not configured for this app build yet.' } };
    }
    const { data, error } = await withAuthTimeout(
      supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin },
      })
    );
    return { error: error ?? data?.error ?? null };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
  }, []);

  return (
    <AuthContext.Provider
      value={{ user, session, loading, signUp, signIn, signInWithGoogle, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used within AuthProvider');
  return ctx;
}
