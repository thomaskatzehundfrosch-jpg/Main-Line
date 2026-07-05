import React, { useState } from 'react';
import { Upload, Download, Settings, Globe, Cpu, Brain, LogIn, Menu, X, Heart, Mail, Youtube, BarChart3, RefreshCw } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { AuthModal } from './Auth/AuthModal';
import { UserMenu } from './Auth/UserMenu';
import { useIsMobile } from '../hooks/useIsMobile';
import type { GeneratorProgress } from '../types/generator';

interface TopBarProps {
  onImport: () => void;
  onExport: () => void;
  onGameFetcher?: () => void;
  onPerformanceReport?: () => void;
  onGenerator?: () => void;
  onTrainer?: () => void;
  onSettings?: () => void;
  onSync?: () => void;
  activeFileName?: string | null;
  generatorProgress?: GeneratorProgress;
  isGenerating?: boolean;
  isSyncing?: boolean;
}

function GeneratorStatus({ progress, isGenerating }: { progress?: GeneratorProgress; isGenerating?: boolean }) {
  if (!progress) return null;
  if (!isGenerating && progress.nodes <= 0) return null;

  const pct = progress.maxNodes > 0
    ? Math.min(100, Math.round((progress.nodes / progress.maxNodes) * 100))
    : 0;
  const label = isGenerating ? (progress.status || 'Generating') : 'Ready';

  return (
    <div className="flex items-center gap-2 min-w-0">
      <span className={`text-[10px] font-mono uppercase tracking-wider ${isGenerating ? 'text-accent-teal' : 'text-text-muted'}`}>
        {label}
      </span>
      <div className="w-20 sm:w-24 h-1 rounded-full bg-bg-hover overflow-hidden">
        <div
          className={`h-full rounded-full transition-all duration-200 ${isGenerating ? 'bg-accent-teal' : 'bg-text-muted/60'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="text-[10px] text-text-muted font-mono whitespace-nowrap">
        {pct}%
      </span>
    </div>
  );
}

export const TopBar: React.FC<TopBarProps> = ({
  onImport,
  onExport,
  onGameFetcher,
  onPerformanceReport,
  onGenerator,
  onTrainer,
  onSettings,
  onSync,
  activeFileName,
  generatorProgress,
  isGenerating,
  isSyncing,
}) => {
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
            <img
              src="/logo-source-tight.png"
              alt="Main Line logo"
              className="w-10 h-10 object-contain shrink-0"
            />
            <span className="font-mono text-accent-teal text-base font-semibold">Main Line</span>
            <GeneratorStatus progress={generatorProgress} isGenerating={isGenerating} />
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
            <a
              href="mailto:mainlinecheese@gmail.com"
              className="btn-icon !text-text-muted hover:!text-accent-teal"
              title="Contact: mainlinecheese@gmail.com"
            >
              <Mail className="w-4 h-4" />
            </a>
            <a
              href="https://paypal.me/minecraftweber"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-icon !text-pink-400 hover:!text-pink-300"
              title="Support this project ♥"
            >
              <Heart className="w-4 h-4" />
            </a>
            <a
              href="https://www.youtube.com/watch?v=GVZkeb9-uaM&t=101s"
              target="_blank"
              rel="noopener noreferrer"
              className="btn-icon !text-red-500 hover:!text-red-400"
              title="Watch tutorial on YouTube"
            >
              <Youtube className="w-4 h-4" />
            </a>
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
              className="btn-ghost flex items-center gap-1.5 text-sm py-1.5 px-3"
            >
              <Download className="w-3.5 h-3.5" />
              Export
            </button>
            <button
              onClick={() => { onImport(); setMenuOpen(false); }}
              className="btn-ghost flex items-center gap-1.5 text-sm py-1.5 px-3"
            >
              <Upload className="w-3.5 h-3.5" />
              Import
            </button>
            {onGameFetcher && (
              <button
                onClick={() => { onGameFetcher(); setMenuOpen(false); }}
                className="btn-secondary flex items-center gap-1.5 text-sm py-1.5 px-3"
              >
                <Globe className="w-3.5 h-3.5" />
                Game Fetcher
              </button>
            )}
            {onPerformanceReport && (
              <button
                onClick={() => { onPerformanceReport(); setMenuOpen(false); }}
                className="btn-secondary flex items-center gap-1.5 text-sm py-1.5 px-3"
              >
                <BarChart3 className="w-3.5 h-3.5" />
                Performance
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
            {onSync && (
              <button
                onClick={() => {
                  if (user) {
                    onSync();
                  } else {
                    setShowAuthModal(true);
                  }
                  setMenuOpen(false);
                }}
                disabled={!!user && isSyncing}
                className="btn-ghost flex items-center gap-1.5 text-sm py-1.5 px-3 disabled:opacity-60"
              >
                <RefreshCw className={`w-3.5 h-3.5 ${user && isSyncing ? 'animate-spin' : ''}`} />
                {user ? (isSyncing ? 'Syncing' : 'Sync') : 'Sign in to sync'}
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
      <div className="flex items-center gap-2 min-w-0">
        <img
          src="/logo-source-tight.png"
          alt="Main Line logo"
          className="w-12 h-12 object-contain shrink-0"
        />
        <span className="font-mono text-accent-teal text-lg font-semibold">Main Line</span>
        <GeneratorStatus progress={generatorProgress} isGenerating={isGenerating} />
        {activeFileName && (
          <span className="text-xs text-text-muted font-normal ml-1 truncate max-w-[220px]">
            — {activeFileName}
          </span>
        )}
      </div>

      {/* Right side: Action buttons */}
      <div className="flex items-center gap-2">
        <button
          onClick={onImport}
          className="btn-ghost flex items-center gap-2"
          title="Import PGN file"
        >
          <Upload className="w-4 h-4" />
          <span>Import</span>
        </button>

        <button
          onClick={onExport}
          className="btn-ghost flex items-center gap-2"
          title="Export to PGN"
        >
          <Download className="w-4 h-4" />
          <span>Export</span>
        </button>

        {onSync && (
          <button
            onClick={() => {
              if (user) {
                onSync();
              } else {
                setShowAuthModal(true);
              }
            }}
            disabled={!!user && isSyncing}
            className="btn-ghost flex items-center gap-2 disabled:opacity-60"
            title={user ? 'Refresh cloud repertoires' : 'Sign in to sync repertoires'}
          >
            <RefreshCw className={`w-4 h-4 ${user && isSyncing ? 'animate-spin' : ''}`} />
            <span>{user ? (isSyncing ? 'Syncing...' : 'Sync') : 'Sign in to Sync'}</span>
          </button>
        )}

        <div className="h-7 w-px bg-border-subtle" aria-hidden="true" />

        {onGameFetcher && (
          <button
            onClick={onGameFetcher}
            className="btn-secondary flex items-center gap-2"
            title="Fetch games from Chess.com or Lichess"
          >
            <Globe className="w-4 h-4" />
            <span>Game Fetcher</span>
          </button>
        )}

        {onPerformanceReport && (
          <button
            onClick={onPerformanceReport}
            className="btn-secondary flex items-center gap-2"
            title="See live platform performance by repertoire"
          >
            <BarChart3 className="w-4 h-4" />
            <span>Performance</span>
          </button>
        )}

        <div className="h-7 w-px bg-border-subtle" aria-hidden="true" />

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

        <a
          href="mailto:mainlinecheese@gmail.com"
          className="btn-icon !text-text-muted hover:!text-accent-teal"
          title="Contact: mainlinecheese@gmail.com"
        >
          <Mail className="w-4 h-4" />
        </a>

        <a
          href="https://paypal.me/minecraftweber"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-icon !text-pink-400 hover:!text-pink-300"
          title="Support this project ♥"
        >
          <Heart className="w-4 h-4" />
        </a>

        <a
          href="https://www.youtube.com/watch?v=GVZkeb9-uaM&t=101s"
          target="_blank"
          rel="noopener noreferrer"
          className="btn-icon !text-red-500 hover:!text-red-400"
          title="Watch tutorial on YouTube"
        >
          <Youtube className="w-4 h-4" />
        </a>

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
