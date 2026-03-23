import React, { useState } from 'react';
import { Crown, Upload, Download, Settings, Globe, Cpu, Brain, LogIn, Menu, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { AuthModal } from './Auth/AuthModal';
import { UserMenu } from './Auth/UserMenu';
import { useIsMobile } from '../hooks/useIsMobile';

interface TopBarProps {
  onImport: () => void;
  onExport: () => void;
  onGameFetcher?: () => void;
  onGenerator?: () => void;
  onTrainer?: () => void;
  onSettings?: () => void;
  activeFileName?: string | null;
}

export const TopBar: React.FC<TopBarProps> = ({ onImport, onExport, onGameFetcher, onGenerator, onTrainer, onSettings, activeFileName }) => {
  const { user, loading } = useAuth();
  const [showAuthModal, setShowAuthModal] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const isMobile = useIsMobile();

  if (isMobile) {
    return (
      <>
        <div className="bg-bg-primary border-b border-border-subtle px-3 py-2 flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <Crown className="w-4 h-4 text-accent-teal" />
            <span className="font-mono text-accent-teal text-base font-semibold">Main Line</span>
            {activeFileName && (
              <span className="text-[11px] text-text-muted font-normal ml-1 truncate max-w-[100px]">
                — {activeFileName}
              </span>
            )}
          </div>

          {/* Right: import + settings + menu */}
          <div className="flex items-center gap-1">
            <button onClick={onImport} className="btn-icon" title="Import PGN">
              <Upload className="w-4 h-4" />
            </button>
            <button onClick={onSettings} className="btn-icon" title="Settings">
              <Settings className="w-4 h-4" />
            </button>
            {!loading && (
              user
                ? <UserMenu />
                : (
                  <button
                    onClick={() => setShowAuthModal(true)}
                    className="btn-icon"
                    title="Sign in"
                  >
                    <LogIn className="w-4 h-4" />
                  </button>
                )
            )}
            <button
              onClick={() => setMenuOpen((o) => !o)}
              className="btn-icon"
              title="More actions"
            >
              {menuOpen ? <X className="w-4 h-4" /> : <Menu className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Mobile dropdown menu */}
        {menuOpen && (
          <div className="bg-bg-surface border-b border-border-subtle px-3 py-2 flex flex-wrap gap-2">
            <button
              onClick={() => { onExport(); setMenuOpen(false); }}
              className="btn-secondary flex items-center gap-1.5 text-sm py-1.5 px-3"
            >
              <Download className="w-3.5 h-3.5" />
              Export PGN
            </button>
            {onGameFetcher && (
              <button
                onClick={() => { onGameFetcher(); setMenuOpen(false); }}
                className="btn-primary flex items-center gap-1.5 text-sm py-1.5 px-3"
              >
                <Globe className="w-3.5 h-3.5" />
                Game Fetcher
              </button>
            )}
            {onGenerator && (
              <button
                onClick={() => { onGenerator(); setMenuOpen(false); }}
                className="btn-primary flex items-center gap-1.5 text-sm py-1.5 px-3"
              >
                <Cpu className="w-3.5 h-3.5" />
                Generate
              </button>
            )}
            {onTrainer && (
              <button
                onClick={() => { onTrainer(); setMenuOpen(false); }}
                className="btn-primary flex items-center gap-1.5 text-sm py-1.5 px-3"
              >
                <Brain className="w-3.5 h-3.5" />
                Train
              </button>
            )}
          </div>
        )}

        {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
      </>
    );
  }

  return (
    <div className="bg-bg-primary border-b border-border-subtle px-4 py-3 flex items-center justify-between">
      {/* Left side: Logo and App name */}
      <div className="flex items-center gap-2">
        <Crown className="w-5 h-5 text-accent-teal" />
        <span className="font-mono text-accent-teal text-lg font-semibold">
          Main Line
        </span>
        {activeFileName && (
          <span className="text-xs text-text-muted font-normal ml-2">
            — {activeFileName}
          </span>
        )}
      </div>

      {/* Right side: Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={onImport}
          className="btn-primary flex items-center gap-2"
          title="Import PGN file"
        >
          <Upload className="w-4 h-4" />
          <span>Import PGN</span>
        </button>

        <button
          onClick={onExport}
          className="btn-secondary flex items-center gap-2"
          title="Export to PGN"
        >
          <Download className="w-4 h-4" />
          <span>Export PGN</span>
        </button>

        {onGameFetcher && (
          <button
            onClick={onGameFetcher}
            className="btn-primary flex items-center gap-2"
            title="Fetch games from chess.com"
          >
            <Globe className="w-4 h-4" />
            <span>Game Fetcher</span>
          </button>
        )}

        {onGenerator && (
          <button
            onClick={onGenerator}
            className="btn-primary flex items-center gap-2"
            title="Generate repertoire with engine and Lichess data"
          >
            <Cpu className="w-4 h-4" />
            <span>Generate</span>
          </button>
        )}

        {onTrainer && (
          <button
            onClick={onTrainer}
            className="btn-primary flex items-center gap-2"
            title="Spaced repetition opening trainer"
          >
            <Brain className="w-4 h-4" />
            <span>Train</span>
          </button>
        )}

        <button
          className="btn-icon"
          title="Settings"
          onClick={onSettings}
        >
          <Settings className="w-4 h-4" />
        </button>

        {/* Auth */}
        {!loading && (
          user
            ? <UserMenu />
            : (
              <button
                onClick={() => setShowAuthModal(true)}
                className="btn-secondary flex items-center gap-2 py-1.5 px-3"
                title="Sign in to sync your repertoires"
              >
                <LogIn className="w-4 h-4" />
                <span className="text-sm">Sign In</span>
              </button>
            )
        )}
      </div>

      {showAuthModal && <AuthModal onClose={() => setShowAuthModal(false)} />}
    </div>
  );
};
