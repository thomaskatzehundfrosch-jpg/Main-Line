import React, { useState, useRef, useEffect } from 'react';
import { LogOut, User, Cloud } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';

export const UserMenu: React.FC = () => {
  const { user, signOut } = useAuth();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  if (!user) return null;

  const initials = user.email
    ? user.email.slice(0, 2).toUpperCase()
    : '?';

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 btn-secondary py-1.5 px-3"
        title={user.email ?? 'Signed in'}
      >
        <div className="w-5 h-5 rounded-full bg-accent-teal/20 text-accent-teal flex items-center justify-center text-xs font-bold">
          {initials}
        </div>
        <span className="text-xs text-text-muted max-w-[120px] truncate hidden sm:block">
          {user.email}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 bg-bg-primary border border-border-subtle rounded-lg shadow-xl py-1 w-52 z-50">
          {/* User info */}
          <div className="px-3 py-2 border-b border-border-subtle">
            <div className="flex items-center gap-2">
              <User className="w-3 h-3 text-text-muted" />
              <span className="text-xs text-text-muted truncate">{user.email}</span>
            </div>
            <div className="flex items-center gap-2 mt-1">
              <Cloud className="w-3 h-3 text-accent-teal" />
              <span className="text-xs text-accent-teal">Cloud sync active</span>
            </div>
          </div>

          {/* Sign out */}
          <button
            onClick={() => { signOut(); setOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-text-muted hover:text-red-400 hover:bg-red-900/10 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            Sign Out
          </button>
        </div>
      )}
    </div>
  );
};
