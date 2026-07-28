import React, { useCallback, useEffect, useState } from 'react';
import {
  X,
  Monitor,
  Cpu,
  BookOpen,
  Sliders,
  RotateCcw,
  Link2,
} from 'lucide-react';
import {
  useSettings,
  type BoardTheme,
  type PracticalMoveRating,
} from '../../context/SettingsContext';
import {
  clearStoredToken,
  getStoredToken,
  getStoredUsername,
  startOAuthFlow,
} from '../../utils/lichessAuth';

interface SettingsModalProps {
  onClose: () => void;
  initialTab?: Tab;
}

export type SettingsTab = 'board' | 'engine' | 'repertoire' | 'display' | 'lichess';
type Tab = SettingsTab;

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: 'board', label: 'Board', icon: <Monitor className="w-4 h-4" /> },
  { id: 'engine', label: 'Engine', icon: <Cpu className="w-4 h-4" /> },
  { id: 'repertoire', label: 'Repertoire', icon: <BookOpen className="w-4 h-4" /> },
  { id: 'display', label: 'Display', icon: <Sliders className="w-4 h-4" /> },
  { id: 'lichess', label: 'Lichess', icon: <Link2 className="w-4 h-4" /> },
];

const BOARD_THEMES: { id: BoardTheme; label: string; light: string; dark: string }[] = [
  { id: 'classic', label: 'Classic', light: '#e8dcc0', dark: '#4b6fa0' },
  { id: 'ocean',   label: 'Ocean',   light: '#d4e8e8', dark: '#2d7d7d' },
  { id: 'forest',  label: 'Forest',  light: '#d9e8c0', dark: '#3d6b3d' },
  { id: 'midnight',label: 'Midnight',light: '#cdd5e0', dark: '#3a4466' },
  { id: 'coral',   label: 'Coral',   light: '#f0d9d0', dark: '#b05050' },
];

const PRACTICAL_MOVE_RATINGS: PracticalMoveRating[] = [1600, 1800, 2000, 2200, 2500];

function Toggle({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus:outline-none ${
        checked ? 'bg-accent-teal' : 'bg-bg-hover border border-border-active'
      }`}
    >
      <span
        className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md ring-0 transition duration-200 ease-in-out ${
          checked ? 'translate-x-4' : 'translate-x-0'
        }`}
      />
    </button>
  );
}

function SettingRow({
  label,
  description,
  children,
}: {
  label: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between py-3 border-b border-border-subtle last:border-0">
      <div className="flex-1 mr-4">
        <div className="text-sm text-text-primary font-medium">{label}</div>
        {description && (
          <div className="text-xs text-text-muted mt-0.5">{description}</div>
        )}
      </div>
      <div className="flex-shrink-0">{children}</div>
    </div>
  );
}

function NumberStepper({
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <button
        onClick={() => onChange(Math.max(min, value - step))}
        disabled={value <= min}
        className="w-6 h-6 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold"
      >
        −
      </button>
      <span className="w-8 text-center text-sm font-mono text-text-primary">{value}</span>
      <button
        onClick={() => onChange(Math.min(max, value + step))}
        disabled={value >= max}
        className="w-6 h-6 rounded flex items-center justify-center text-text-secondary hover:text-text-primary hover:bg-bg-hover disabled:opacity-30 disabled:cursor-not-allowed transition-colors text-sm font-bold"
      >
        +
      </button>
    </div>
  );
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ onClose, initialTab = 'board' }) => {
  const { settings, updateSetting, resetSettings } = useSettings();
  const [activeTab, setActiveTab] = useState<Tab>(initialTab);
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [lichessUsername, setLichessUsername] = useState<string | null>(getStoredUsername);
  const [lichessConnected, setLichessConnected] = useState<boolean>(() => !!getStoredToken());

  const maxThreads = Math.max(1, navigator?.hardwareConcurrency ?? 4);

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    const syncAuthState = () => {
      setLichessConnected(!!getStoredToken());
      setLichessUsername(getStoredUsername());
    };

    syncAuthState();
    window.addEventListener('lichess-auth-updated', syncAuthState);
    return () => window.removeEventListener('lichess-auth-updated', syncAuthState);
  }, []);

  const handleLichessConnect = useCallback(() => {
    startOAuthFlow();
  }, []);

  const handleLichessDisconnect = useCallback(() => {
    clearStoredToken();
    setLichessConnected(false);
    setLichessUsername(null);
  }, []);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-bg-surface border border-border-subtle rounded-xl shadow-2xl w-[560px] max-h-[80vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border-subtle flex-shrink-0">
          <h2 className="font-mono text-base text-text-primary font-semibold">Settings</h2>
          <button onClick={onClose} className="btn-icon">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex flex-1 min-h-0">
          {/* Sidebar tabs */}
          <div className="w-36 flex-shrink-0 border-r border-border-subtle bg-bg-panel py-2">
            {TABS.map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 text-sm transition-colors text-left ${
                  activeTab === tab.id
                    ? 'text-accent-teal bg-accent-teal/10 border-r-2 border-accent-teal'
                    : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                }`}
              >
                {tab.icon}
                {tab.label}
              </button>
            ))}
          </div>

          {/* Content */}
          <div className="flex-1 overflow-y-auto px-5 py-2">

            {/* ── BOARD ── */}
            {activeTab === 'board' && (
              <div>
                <p className="text-xs text-text-muted font-mono uppercase tracking-wider py-2 mb-1">Board Appearance</p>

                {/* Theme picker */}
                <SettingRow label="Board Theme" description="Choose a colour scheme for the board squares">
                  <div className="flex gap-1.5">
                    {BOARD_THEMES.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => updateSetting('boardTheme', t.id)}
                        title={t.label}
                        className={`relative w-7 h-7 rounded overflow-hidden border-2 transition-all ${
                          settings.boardTheme === t.id
                            ? 'border-accent-teal scale-110 shadow-glow-sm'
                            : 'border-transparent hover:border-border-active'
                        }`}
                      >
                        <div className="absolute inset-0 grid grid-cols-2 grid-rows-2">
                          <div style={{ background: t.light }} />
                          <div style={{ background: t.dark }} />
                          <div style={{ background: t.dark }} />
                          <div style={{ background: t.light }} />
                        </div>
                      </button>
                    ))}
                  </div>
                </SettingRow>

                <SettingRow
                  label="Show Coordinates"
                  description="Display rank and file labels around the board"
                >
                  <Toggle
                    checked={settings.showCoordinates}
                    onChange={(v) => updateSetting('showCoordinates', v)}
                  />
                </SettingRow>

                <SettingRow
                  label="Legal Move Hints"
                  description="Highlight squares you can move to when a piece is selected"
                >
                  <Toggle
                    checked={settings.showLegalMoveHints}
                    onChange={(v) => updateSetting('showLegalMoveHints', v)}
                  />
                </SettingRow>

                <SettingRow
                  label="Last Move Highlight"
                  description="Highlight the from/to squares of the most recent move"
                >
                  <Toggle
                    checked={settings.showLastMoveHighlight}
                    onChange={(v) => updateSetting('showLastMoveHighlight', v)}
                  />
                </SettingRow>

                <SettingRow
                  label="Animate Moves"
                  description="Smooth piece animations when navigating moves"
                >
                  <Toggle
                    checked={settings.animateMoves}
                    onChange={(v) => updateSetting('animateMoves', v)}
                  />
                </SettingRow>
              </div>
            )}

            {/* ── ENGINE ── */}
            {activeTab === 'engine' && (
              <div>
                <p className="text-xs text-text-muted font-mono uppercase tracking-wider py-2 mb-1">Stockfish Engine</p>

                <SettingRow
                  label="Auto-start Engine"
                  description="Automatically begin analysis when you navigate to a position"
                >
                  <Toggle
                    checked={settings.autoStartEngine}
                    onChange={(v) => updateSetting('autoStartEngine', v)}
                  />
                </SettingRow>

                <SettingRow
                  label="Analysis Depth"
                  description="Maximum search depth (higher = stronger but slower)"
                >
                  <NumberStepper
                    value={settings.engineDepth}
                    min={10}
                    max={40}
                    step={5}
                    onChange={(v) => updateSetting('engineDepth', v)}
                  />
                </SettingRow>

                <SettingRow
                  label="Lines Shown (MultiPV)"
                  description="Number of top moves analysed simultaneously"
                >
                  <NumberStepper
                    value={settings.engineMultiPV}
                    min={1}
                    max={5}
                    onChange={(v) => updateSetting('engineMultiPV', v)}
                  />
                </SettingRow>

                <SettingRow
                  label="CPU Threads"
                  description={`Threads used by the engine (your CPU has ${maxThreads} logical cores)`}
                >
                  <NumberStepper
                    value={settings.engineThreads}
                    min={1}
                    max={maxThreads}
                    onChange={(v) => updateSetting('engineThreads', v)}
                  />
                </SettingRow>
              </div>
            )}

            {/* ── REPERTOIRE ── */}
            {activeTab === 'repertoire' && (
              <div>
                <p className="text-xs text-text-muted font-mono uppercase tracking-wider py-2 mb-1">Repertoire Behaviour</p>

                <SettingRow
                  label="Default Colour"
                  description="Which side you are building lines for by default"
                >
                  <div className="flex rounded-md overflow-hidden border border-border-subtle">
                    {(['white', 'black'] as const).map((c) => (
                      <button
                        key={c}
                        onClick={() => updateSetting('defaultColor', c)}
                        className={`px-3 py-1.5 text-sm capitalize transition-colors ${
                          settings.defaultColor === c
                            ? 'bg-accent-teal/15 text-accent-teal font-medium'
                            : 'text-text-secondary hover:text-text-primary hover:bg-bg-hover'
                        }`}
                      >
                        {c === 'white' ? '♔' : '♚'} {c}
                      </button>
                    ))}
                  </div>
                </SettingRow>

                <SettingRow
                  label="Auto-save"
                  description="Automatically save changes to your repertoire file"
                >
                  <Toggle
                    checked={settings.autoSave}
                    onChange={(v) => updateSetting('autoSave', v)}
                  />
                </SettingRow>

                <SettingRow
                  label="Confirm Node Deletion"
                  description="Ask for confirmation before removing a move from the tree"
                >
                  <Toggle
                    checked={settings.confirmDeleteNode}
                    onChange={(v) => updateSetting('confirmDeleteNode', v)}
                  />
                </SettingRow>

              </div>
            )}

            {/* ── DISPLAY ── */}
            {activeTab === 'display' && (
              <div>
                <p className="text-xs text-text-muted font-mono uppercase tracking-wider py-2 mb-1">Notation & UI</p>

                <SettingRow
                  label="Figurine Notation"
                  description="Show ♙♘♗♖♕♔ symbols instead of letters like N, B, Q"
                >
                  <Toggle
                    checked={settings.useFigurineNotation}
                    onChange={(v) => updateSetting('useFigurineNotation', v)}
                  />
                </SettingRow>

                <SettingRow
                  label="Evaluation Bar"
                  description="Show the vertical eval bar alongside the board"
                >
                  <Toggle
                    checked={settings.showEvalBar}
                    onChange={(v) => updateSetting('showEvalBar', v)}
                  />
                </SettingRow>

                <SettingRow
                  label="Compact Move List"
                  description="Reduce spacing in the move list sidebar to fit more moves"
                >
                  <Toggle
                    checked={settings.compactMoveList}
                    onChange={(v) => updateSetting('compactMoveList', v)}
                  />
                </SettingRow>
              </div>
            )}

            {activeTab === 'lichess' && (
              <div>
                <p className="text-xs text-text-muted font-mono uppercase tracking-wider py-2 mb-1">Lichess Connection</p>

                <div className="rounded-lg border border-border-subtle bg-bg-panel px-4 py-4 mb-4">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <div className="text-sm font-semibold text-text-primary">Account Access</div>
                      <div className="mt-1 text-xs text-text-muted">
                        Connect your Lichess account to enable the Most Likely Move feature and Lichess-powered repertoire generation.
                      </div>
                    </div>
                    <div className={`rounded-full px-2 py-1 text-[10px] font-mono uppercase tracking-wide ${
                      lichessConnected
                        ? 'bg-accent-green/15 text-accent-green'
                        : 'bg-bg-hover text-text-muted'
                    }`}>
                      {lichessConnected ? 'Connected' : 'Not connected'}
                    </div>
                  </div>

                  <div className="mt-4 flex flex-wrap items-center gap-3">
                    {lichessConnected ? (
                      <>
                        <div className="text-sm text-text-primary">
                          Signed in as <span className="font-semibold">{lichessUsername ?? 'Lichess user'}</span>
                        </div>
                        <button
                          onClick={handleLichessDisconnect}
                          className="btn-secondary text-sm px-3 py-1.5"
                        >
                          Disconnect
                        </button>
                      </>
                    ) : (
                      <button
                        onClick={handleLichessConnect}
                        className="btn-primary text-sm px-3 py-1.5"
                      >
                        Connect Lichess
                      </button>
                    )}
                  </div>
                </div>

                <SettingRow
                  label="Most Likely Move Rating"
                  description='Used for the "Most Likely Move?" button when querying Lichess player data.'
                >
                  <select
                    value={settings.mostLikelyMoveRating}
                    onChange={(e) => updateSetting('mostLikelyMoveRating', Number(e.target.value) as PracticalMoveRating)}
                    className="bg-bg-primary border border-border-subtle rounded-md px-2 py-1 text-sm text-text-primary focus:outline-none focus:border-accent-teal/50"
                  >
                    {PRACTICAL_MOVE_RATINGS.map((rating) => (
                      <option key={rating} value={rating}>
                        {rating}+
                      </option>
                    ))}
                  </select>
                </SettingRow>
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-border-subtle flex-shrink-0 bg-bg-panel">
          {showResetConfirm ? (
            <div className="flex items-center gap-2 text-sm">
              <span className="text-text-secondary">Reset all settings to defaults?</span>
              <button
                onClick={() => { resetSettings(); setShowResetConfirm(false); }}
                className="text-accent-red hover:text-accent-red/80 font-medium transition-colors"
              >
                Yes, reset
              </button>
              <button
                onClick={() => setShowResetConfirm(false)}
                className="text-text-muted hover:text-text-primary transition-colors"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              onClick={() => setShowResetConfirm(true)}
              className="flex items-center gap-1.5 text-xs text-text-muted hover:text-text-secondary transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset to defaults
            </button>
          )}
          <button onClick={onClose} className="btn-primary text-sm px-4 py-1.5">
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
