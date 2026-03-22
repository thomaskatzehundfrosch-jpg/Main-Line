import React, { useState } from 'react';
import { X, Mail, Lock, LogIn, UserPlus, Chrome } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { isSupabaseConfigured } from '../../lib/supabase';

interface AuthModalProps {
  onClose: () => void;
}

type Tab = 'signin' | 'signup';

export const AuthModal: React.FC<AuthModalProps> = ({ onClose }) => {
  const { signIn, signUp, signInWithGoogle } = useAuth();
  const [tab, setTab] = useState<Tab>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  if (!isSupabaseConfigured) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
        <div className="bg-bg-primary border border-border-subtle rounded-xl p-6 w-full max-w-sm shadow-2xl">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-text-primary font-semibold text-lg">Cloud Sync</h2>
            <button onClick={onClose} className="btn-icon"><X className="w-4 h-4" /></button>
          </div>
          <p className="text-text-muted text-sm">
            Supabase is not configured yet. Add{' '}
            <code className="text-accent-teal">VITE_SUPABASE_URL</code> and{' '}
            <code className="text-accent-teal">VITE_SUPABASE_ANON_KEY</code> to your{' '}
            <code className="text-accent-teal">.env</code> file to enable login and cloud sync.
          </p>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setInfo(null);
    setLoading(true);

    if (tab === 'signin') {
      const { error } = await signIn(email, password);
      if (error) {
        setError(error.message);
      } else {
        onClose();
      }
    } else {
      const { error } = await signUp(email, password);
      if (error) {
        setError(error.message);
      } else {
        onClose();
      }
    }
    setLoading(false);
  };

  const handleGoogle = async () => {
    setError(null);
    const { error } = await signInWithGoogle();
    if (error) setError(error.message);
    // OAuth redirect will close the modal automatically
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onClose}>
      <div
        className="bg-bg-primary border border-border-subtle rounded-xl p-6 w-full max-w-sm shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-text-primary font-semibold text-lg">
            {tab === 'signin' ? 'Sign In' : 'Create Account'}
          </h2>
          <button onClick={onClose} className="btn-icon">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="flex bg-bg-secondary rounded-lg p-1 mb-5">
          <button
            className={`flex-1 text-sm py-1.5 rounded-md font-medium transition-colors ${
              tab === 'signin'
                ? 'bg-bg-primary text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-primary'
            }`}
            onClick={() => { setTab('signin'); setError(null); setInfo(null); }}
          >
            Sign In
          </button>
          <button
            className={`flex-1 text-sm py-1.5 rounded-md font-medium transition-colors ${
              tab === 'signup'
                ? 'bg-bg-primary text-text-primary shadow-sm'
                : 'text-text-muted hover:text-text-primary'
            }`}
            onClick={() => { setTab('signup'); setError(null); setInfo(null); }}
          >
            Sign Up
          </button>
        </div>

        {/* Google OAuth */}
        <button
          onClick={handleGoogle}
          className="w-full flex items-center justify-center gap-2 btn-secondary mb-4 py-2"
        >
          <Chrome className="w-4 h-4" />
          <span>Continue with Google</span>
        </button>

        <div className="flex items-center gap-3 mb-4">
          <div className="flex-1 h-px bg-border-subtle" />
          <span className="text-text-muted text-xs">or</span>
          <div className="flex-1 h-px bg-border-subtle" />
        </div>

        {/* Email/Password Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <div className="relative">
            <Mail className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full bg-bg-secondary border border-border-subtle rounded-lg pl-9 pr-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-teal"
            />
          </div>
          <div className="relative">
            <Lock className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-text-muted pointer-events-none" />
            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
              className="w-full bg-bg-secondary border border-border-subtle rounded-lg pl-9 pr-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:border-accent-teal"
            />
          </div>

          {error && (
            <p className="text-red-400 text-xs bg-red-900/20 border border-red-800/40 rounded-lg px-3 py-2">
              {error}
            </p>
          )}
          {info && (
            <p className="text-green-400 text-xs bg-green-900/20 border border-green-800/40 rounded-lg px-3 py-2">
              {info}
            </p>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn-primary flex items-center justify-center gap-2 py-2 disabled:opacity-50"
          >
            {tab === 'signin'
              ? <><LogIn className="w-4 h-4" />{loading ? 'Signing in…' : 'Sign In'}</>
              : <><UserPlus className="w-4 h-4" />{loading ? 'Creating account…' : 'Create Account'}</>
            }
          </button>
        </form>

        <p className="text-text-muted text-xs text-center mt-4">
          Your repertoires sync automatically when signed in.
        </p>
      </div>
    </div>
  );
};
