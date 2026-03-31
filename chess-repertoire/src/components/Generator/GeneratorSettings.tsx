/**
 * Settings panel for the auto-repertoire generator.
 */

import React, { useCallback, useRef, useState, useEffect } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { GeneratorSettings, AnalysisMode } from '../../types/generator';
import { getStyleEvalThreshold } from '../../engine/analyzer';
import { parsePGN } from '../../utils/generatorPgn';
import { getStoredToken, getStoredUsername, clearStoredToken, startOAuthFlow } from '../../utils/lichessAuth';
import { useIsMobile } from '../../hooks/useIsMobile';

interface GeneratorSettingsProps {
  settings: GeneratorSettings;
  setSettings: React.Dispatch<React.SetStateAction<GeneratorSettings>>;
  onGenerate: () => void;
  onStop: () => void;
  isGenerating: boolean;
  sfReady: boolean;
  canGenerate: boolean;
  pgnSeeds: string[][];
  setPgnSeeds: React.Dispatch<React.SetStateAction<string[][]>>;
}

export const GeneratorSettingsPanel: React.FC<GeneratorSettingsProps> = ({
  settings,
  setSettings,
  onGenerate,
  onStop,
  isGenerating,
  sfReady,
  canGenerate,
  pgnSeeds,
  setPgnSeeds,
}) => {
  const isMobile = useIsMobile();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [lichessUsername, setLichessUsername] = useState<string | null>(getStoredUsername);
  const [lichessConnected, setLichessConnected] = useState<boolean>(() => !!getStoredToken());
  const [collapsed, setCollapsed] = useState(() => isMobile);

  useEffect(() => {
    setCollapsed(isMobile);
  }, [isMobile]);

  // Sync auth state when the component re-mounts after OAuth redirect
  useEffect(() => {
    setLichessConnected(!!getStoredToken());
    setLichessUsername(getStoredUsername());

    const onAuthUpdated = () => {
      setLichessConnected(!!getStoredToken());
      setLichessUsername(getStoredUsername());
    };
    window.addEventListener('lichess-auth-updated', onAuthUpdated);
    return () => window.removeEventListener('lichess-auth-updated', onAuthUpdated);
  }, []);

  const handleLichessConnect = useCallback(() => {
    startOAuthFlow();
  }, []);

  const handleLichessDisconnect = useCallback(() => {
    clearStoredToken();
    setLichessConnected(false);
    setLichessUsername(null);
  }, []);

  const update = useCallback(
    <K extends keyof GeneratorSettings>(key: K, value: GeneratorSettings[K]) => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    [setSettings]
  );

  const showSf = settings.analysisMode === 'stockfish' || settings.analysisMode === 'lichess+stockfish';
  const showLichess = settings.analysisMode === 'lichess+stockfish';

  const handlePgnUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        const text = ev.target?.result as string;
        if (text) {
          const sequences = parsePGN(text);
          if (sequences.length > 0) {
            setPgnSeeds(sequences);
          }
        }
      };
      reader.readAsText(file);
    },
    [setPgnSeeds]
  );

  const handlePgnTextParse = useCallback(
    (text: string) => {
      try {
        const sequences = parsePGN(text);
        setPgnSeeds(sequences);
      } catch {
        // ignore parse errors during typing
      }
    },
    [setPgnSeeds]
  );

  const toggleSpeed = useCallback(
    (speed: string) => {
      setSettings((prev) => {
        const speeds = [...prev.speeds];
        const idx = speeds.indexOf(speed);
        if (idx >= 0) {
          speeds.splice(idx, 1);
        } else {
          speeds.push(speed);
        }
        return { ...prev, speeds };
      });
    },
    [setSettings]
  );

  return (
    <div className="flex flex-col h-full overflow-y-auto custom-scrollbar">
      {/* Header */}
      <div
        className="px-4 py-3 border-b border-border-subtle flex items-center justify-between cursor-pointer select-none"
        onClick={() => isMobile && setCollapsed((prev) => !prev)}
      >
        <h3 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Generator Settings
        </h3>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setCollapsed((prev) => !prev);
          }}
          className="btn-icon p-1 md:hidden"
          title={collapsed ? 'Expand settings' : 'Collapse settings'}
        >
          {collapsed ? <ChevronRight className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
        </button>
      </div>

      {!collapsed && (
      <div className="flex-1 overflow-y-auto custom-scrollbar p-4 space-y-5">
        {/* Color */}
        <div>
          <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-2">
            Color
          </label>
          <div className="flex gap-2">
            {(['white', 'black'] as const).map((c) => (
              <button
                key={c}
                onClick={() => update('color', c)}
                disabled={isGenerating}
                className={`flex-1 px-3 py-1.5 rounded text-xs font-mono border transition-all ${
                  settings.color === c
                    ? 'border-accent-teal text-accent-teal bg-accent-teal/10'
                    : 'border-border-subtle text-text-muted hover:border-border-active'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
        </div>

        {/* Repertoire Style */}
        {(() => {
          const sv = settings.styleValue ?? 0;
          const styleLabels: Record<number, string> = {
            '-2': 'Very Aggressive',
            '-1': 'Aggressive',
            '0': 'Balanced',
            '1': 'Solid',
            '2': 'Very Solid',
          };
          const styleDescriptions: Record<number, string> = {
            '-2': 'Sharp, high-risk lines — maximises win rate, ignores safety',
            '-1': 'Favors decisive, tactical lines with high win rates',
            '0': 'Engine-first selection, no style bias',
            '1': 'Favors safe, positionally sound lines',
            '2': 'Strictly avoids risky moves — minimises losing chances',
          };
          const trackColor =
            sv <= -1 ? '#ef4444'  // red for aggressive
            : sv >= 1 ? '#3b82f6' // blue for solid
            : '#14b8a6';          // teal for balanced
          return (
            <div>
              <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-2">
                Style
              </label>
              <div className="flex justify-between text-[10px] font-mono text-text-muted mb-1 px-0.5">
                <span style={{ color: sv === -2 ? '#ef4444' : undefined }}>Very Agg</span>
                <span style={{ color: sv === -1 ? '#ef4444' : undefined }}>Agg</span>
                <span style={{ color: sv === 0 ? '#14b8a6' : undefined }}>Balanced</span>
                <span style={{ color: sv === 1 ? '#3b82f6' : undefined }}>Solid</span>
                <span style={{ color: sv === 2 ? '#3b82f6' : undefined }}>V.Solid</span>
              </div>
              <input
                type="range"
                min={-2}
                max={2}
                step={1}
                value={sv}
                onChange={(e) => update('styleValue', parseInt(e.target.value))}
                disabled={isGenerating}
                style={{ accentColor: trackColor }}
                className="w-full cursor-pointer"
              />
              <p className="text-[10px] mt-1" style={{ color: trackColor }}>
                <span className="font-semibold">{styleLabels[sv]}</span>
                {' — '}
                <span className="opacity-80">{styleDescriptions[sv]}</span>
              </p>
            </div>
          );
        })()}

        {/* Trickyness */}
        {(() => {
          const on = (settings.trickynessWeight ?? 0) > 0;
          return (
            <div>
              <div className="flex items-center justify-between">
                <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                  Trickyness
                </label>
                <button
                  role="switch"
                  aria-checked={on}
                  disabled={isGenerating}
                  onClick={() => update('trickynessWeight', on ? 0 : 5)}
                  className={`relative inline-flex h-5 w-9 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ${
                    isGenerating ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'
                  } ${on ? 'bg-amber-400' : 'bg-bg-hover border border-border-active'}`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow-md transition duration-200 ease-in-out ${
                      on ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
              <p className="text-[10px] mt-1" style={{ color: on ? '#f59e0b' : '#6b7280' }}>
                {on
                  ? 'Maximum — seeks moves that maximise opponent difficulty'
                  : 'Off — no trickyness preference'}
              </p>
            </div>
          );
        })()}

        {/* Analysis Mode */}
        <div>
          <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-2">
            Analysis Mode
          </label>
          <div className="grid grid-cols-2 gap-1">
            {(['stockfish', 'lichess+stockfish'] as AnalysisMode[]).map((mode) => (
              <button
                key={mode}
                onClick={() => update('analysisMode', mode)}
                disabled={isGenerating}
                className={`px-2 py-1.5 rounded text-[11px] font-mono border transition-all ${
                  settings.analysisMode === mode
                    ? mode === 'stockfish'
                      ? 'border-accent-teal text-accent-teal bg-accent-teal/10'
                      : 'border-accent-blue text-accent-blue bg-accent-blue/10'
                    : 'border-border-subtle text-text-muted hover:border-border-active'
                }`}
              >
                {mode === 'stockfish' ? 'Stockfish' : 'Lichess + SF'}
              </button>
            ))}
          </div>
          {!sfReady && showSf && (
            <p className="text-[10px] text-accent-amber mt-1">Stockfish not ready yet...</p>
          )}
          {showLichess && (
            <p className="text-[10px] text-text-muted mt-1">
              Lichess Explorer data (~1 req/sec). Moves ranked by popularity + win rate.
            </p>
          )}
        </div>

        {/* Depth Settings */}
        <div>
          <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-2">
            Depth
          </label>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-secondary">Max move number</span>
              <input
                type="number"
                min={5}
                max={40}
                value={settings.maxMoveNumber}
                onChange={(e) => update('maxMoveNumber', parseInt(e.target.value) || 15)}
                disabled={isGenerating}
                className="w-16 h-7 text-center rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-xs outline-none focus:border-accent-teal"
              />
            </div>
          </div>
        </div>

        {/* Branching */}
        <div>
          <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-2">
            Branching
          </label>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-secondary">Our moves (top N)</span>
              <select
                value={settings.maxBranchesOur}
                onChange={(e) => update('maxBranchesOur', parseInt(e.target.value))}
                disabled={isGenerating}
                className="h-7 px-2 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-xs outline-none focus:border-accent-teal"
              >
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-secondary">Opponent responses</span>
              <select
                value={settings.maxOpponentResponses}
                onChange={(e) => update('maxOpponentResponses', parseInt(e.target.value))}
                disabled={isGenerating}
                className="h-7 px-2 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-xs outline-none focus:border-accent-teal"
              >
                {[1, 2, 3].map((n) => (
                  <option key={n} value={n}>{n}</option>
                ))}
              </select>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-text-secondary">Max nodes</span>
              <input
                type="number"
                min={10}
                max={2000}
                step={10}
                value={settings.maxNodes}
                onChange={(e) => update('maxNodes', parseInt(e.target.value) || 300)}
                disabled={isGenerating}
                className="w-20 h-7 text-center rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-xs outline-none focus:border-accent-teal"
              />
            </div>
          </div>
        </div>

        {/* Stockfish Settings */}
        {showSf && (
          <div>
            <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-2">
              Stockfish
            </label>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-secondary">Engine depth</span>
                <select
                  value={settings.sfDepth}
                  onChange={(e) => update('sfDepth', parseInt(e.target.value))}
                  disabled={isGenerating}
                  className="h-7 px-2 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-xs outline-none focus:border-accent-teal"
                >
                  {[8, 12, 16, 20, 25].map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-secondary">Eval threshold</span>
                <input
                  type="number"
                  step={0.1}
                  min={-10}
                  max={10}
                  value={settings.evalThreshold}
                  onChange={(e) => update('evalThreshold', parseFloat(e.target.value) || -0.3)}
                  disabled={isGenerating}
                  className="w-20 h-7 text-center rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-xs outline-none focus:border-accent-teal"
                />
              </div>
              {(() => {
                const effective = getStyleEvalThreshold(settings.evalThreshold ?? -0.3, settings.styleValue ?? 0);
                const adjusted = Math.abs(effective - (settings.evalThreshold ?? -0.3)) > 0.001;
                return adjusted ? (
                  <p className="text-[10px] text-accent-amber leading-tight">
                    Effective: <span className="font-mono">{effective.toFixed(2)}</span> (style {settings.styleValue > 0 ? '+' : ''}{settings.styleValue} adjusts by {(effective - (settings.evalThreshold ?? -0.3)).toFixed(2)})
                  </p>
                ) : null;
              })()}
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={settings.flagDangerousResponses}
                  onChange={(e) => update('flagDangerousResponses', e.target.checked)}
                  disabled={isGenerating}
                  className="accent-accent-teal"
                />
                <span className="text-[11px] text-text-secondary">Flag dangerous responses</span>
              </label>
            </div>
          </div>
        )}

        {/* Lichess Settings */}
        {showLichess && (
          <div>
            <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-2">
              Lichess Explorer
            </label>
            <div className="space-y-2">
              {/* Database source */}
              <div>
                <span className="text-[11px] text-text-secondary block mb-1">Database</span>
                <div className="flex gap-1">
                  {([false, true] as const).map((masters) => (
                    <button
                      key={String(masters)}
                      onClick={() => update('useMasters', masters)}
                      disabled={isGenerating}
                      className={`flex-1 px-2 py-1.5 rounded text-[11px] font-mono border transition-all ${
                        settings.useMasters === masters
                          ? 'border-accent-blue text-accent-blue bg-accent-blue/10'
                          : 'border-border-subtle text-text-muted hover:border-border-active'
                      }`}
                    >
                      {masters ? 'Masters' : 'Lichess DB'}
                    </button>
                  ))}
                </div>
              </div>

              {/* Rating range — hidden for masters */}
              {!settings.useMasters && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-text-secondary">Rating range</span>
                  <div className="flex items-center gap-1">
                    <select
                      value={settings.ratingMin}
                      onChange={(e) => update('ratingMin', parseInt(e.target.value))}
                      disabled={isGenerating}
                      className="h-7 px-1 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-xs outline-none focus:border-accent-blue"
                    >
                      {[1000, 1200, 1400, 1600, 1800, 2000, 2200].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                    <span className="text-[10px] text-text-muted">–</span>
                    <select
                      value={settings.ratingMax}
                      onChange={(e) => update('ratingMax', parseInt(e.target.value))}
                      disabled={isGenerating}
                      className="h-7 px-1 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-xs outline-none focus:border-accent-blue"
                    >
                      {[1200, 1400, 1600, 1800, 2000, 2200, 2500].map((r) => (
                        <option key={r} value={r}>{r}</option>
                      ))}
                    </select>
                  </div>
                </div>
              )}

              {/* Time controls — hidden for masters */}
              {!settings.useMasters && (
                <div>
                  <span className="text-[11px] text-text-secondary block mb-1">Time controls</span>
                  <div className="flex gap-1 flex-wrap">
                    {(['bullet', 'blitz', 'rapid', 'classical'] as const).map((speed) => (
                      <button
                        key={speed}
                        onClick={() => toggleSpeed(speed)}
                        disabled={isGenerating}
                        className={`px-2 py-1 rounded text-[10px] font-mono border transition-all ${
                          settings.speeds.includes(speed)
                            ? 'border-accent-blue text-accent-blue bg-accent-blue/10'
                            : 'border-border-subtle text-text-muted hover:border-border-active'
                        }`}
                      >
                        {speed}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* Min games */}
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-text-secondary">Min games per move</span>
                <input
                  type="number"
                  min={1}
                  max={10000}
                  step={5}
                  value={settings.minGames}
                  onChange={(e) => update('minGames', parseInt(e.target.value) || 10)}
                  disabled={isGenerating}
                  className="w-20 h-7 text-center rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-xs outline-none focus:border-accent-blue"
                />
              </div>
              {/* Lichess account */}
              <div>
                <span className="text-[11px] text-text-secondary block mb-1">Account</span>
                {lichessConnected ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-mono text-accent-blue truncate">
                      ✓ {lichessUsername ?? 'connected'}
                    </span>
                    <button
                      onClick={handleLichessDisconnect}
                      disabled={isGenerating}
                      className="text-[10px] font-mono text-text-muted hover:text-accent-red transition-colors shrink-0"
                    >
                      Disconnect
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={handleLichessConnect}
                    disabled={isGenerating}
                    className="w-full py-3 rounded border border-accent-blue text-accent-blue font-mono text-sm hover:bg-accent-blue/10 transition-colors flex flex-col items-center gap-1"
                  >
                    <span className="font-semibold">Connect Lichess</span>
                    <span className="text-[10px] text-text-secondary leading-tight">for generation lichess connect is necessary</span>
                  </button>
                )}
              </div>

            </div>
          </div>
        )}

        {/* PGN Seeds */}
        <div>
          <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider block mb-2">
            PGN Seeds (optional)
          </label>
          <textarea
            placeholder="Paste PGN to set starting positions..."
            rows={3}
            disabled={isGenerating}
            onChange={(e) => handlePgnTextParse(e.target.value)}
            className="w-full px-3 py-2 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-xs outline-none focus:border-accent-teal resize-none"
          />
          <div className="flex items-center gap-2 mt-1">
            <button
              onClick={() => fileInputRef.current?.click()}
              disabled={isGenerating}
              className="text-[10px] font-mono text-text-muted hover:text-accent-teal transition-colors"
            >
              Upload PGN file
            </button>
            {pgnSeeds.length > 0 && (
              <span className="text-[10px] font-mono text-accent-teal">
                {pgnSeeds.length} seed line{pgnSeeds.length !== 1 ? 's' : ''} loaded
              </span>
            )}
            <input
              ref={fileInputRef}
              type="file"
              accept=".pgn"
              onChange={handlePgnUpload}
              className="hidden"
            />
          </div>
        </div>
      </div>
      )}

      {/* Action Buttons */}
      <div className="sticky bottom-0 p-4 border-t border-border-subtle space-y-2 bg-bg-surface/95 backdrop-blur">
        {isGenerating ? (
          <button
            onClick={onStop}
            className="w-full py-2 rounded bg-accent-red text-white font-mono text-xs uppercase tracking-wider hover:bg-accent-red/90 transition-colors flex items-center justify-center gap-2"
          >
            Stop Generation
          </button>
        ) : (
          <button
            onClick={onGenerate}
            disabled={!canGenerate}
            className={`w-full py-2 rounded font-mono text-xs uppercase tracking-wider transition-colors flex items-center justify-center gap-2 ${
              canGenerate
                ? 'bg-accent-teal text-white hover:bg-accent-teal/90'
                : 'bg-bg-hover text-text-muted cursor-not-allowed'
            }`}
          >
            Generate Repertoire
          </button>
        )}
      </div>
    </div>
  );
};
