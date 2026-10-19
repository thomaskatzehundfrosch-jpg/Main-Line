import React, { createContext, useContext, useEffect, useState, ReactNode } from 'react';
import { createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithPopup,
  GoogleAuthProvider, onAuthStateChanged, signOut as firebaseSignOut } from 'firebase/auth';
import { auth } from '../lib/firebase';

type AuthActionError = { message: string };
export interface AuthState {
  user: { id: string; email: string | null } | null;
  loading: boolean;
}
export interface AuthActions {
  signUp: (email: string, password: string) => Promise<{ error: AuthActionError | null }>;
  signIn: (email: string, password: string) => Promise<{ error: AuthActionError | null }>;
  signInWithGoogle: () => Promise<{ error: AuthActionError | null }>;
  signOut: () => Promise<void>;
}
const AuthContext = createContext<(AuthState & AuthActions) | null>(null);
async function authenticate(operation: () => Promise<unknown>) {
  if (!auth) return { error: { message: 'Cloud sync is not configured for this app build yet.' } };
  try {
    await operation();
    return { error: null };
  } catch (error) {
    return { error: { message: error instanceof Error ? error.message : 'Authentication failed.' } };
  }
}
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthState['user']>(null);
  const [loading, setLoading] = useState(Boolean(auth));
  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, (current) => {
      setUser(current ? { id: current.uid, email: current.email } : null);
      setLoading(false);
    }, () => { setUser(null); setLoading(false); });
  }, []);
  return <AuthContext.Provider value={{ user, loading,
    signUp: (email, password) => authenticate(() => createUserWithEmailAndPassword(auth!, email, password)),
    signIn: (email, password) => authenticate(() => signInWithEmailAndPassword(auth!, email, password)),
    signInWithGoogle: () => authenticate(() => signInWithPopup(auth!, new GoogleAuthProvider())),
    signOut: async () => { if (auth) await firebaseSignOut(auth); },
  }}>{children}</AuthContext.Provider>;
}
export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
