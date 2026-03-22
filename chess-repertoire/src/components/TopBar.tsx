import React, { useState } from 'react';
import { Crown, Upload, Download, Settings, Globe, Cpu, Brain, LogIn } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { AuthModal } from './Auth/AuthModal';
import { UserMenu } from './Auth/UserMenu';

interface TopBarProps {
  onImport: () => void;
  onExport: () => void;
  onGameFetcher?: () => void;
  onGenerator?: () => void;
  onTrainer?: () => void;
  activeFileName?: string | null;
}

export const TopBar: React.FC<TopBarProps> = ({ onImport, onExport, onGameFetcher, onGenerator, onTrainer, activeFileName }) => {
  const { user, loading } = useAuth();
  const [showAuthModal, setShowAuthModal] = useState(false);

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
          onClick={() => {
            // TODO: Open settings
          }}
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
