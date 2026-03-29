import React, { useState, useCallback, useRef } from 'react';
import { parse } from '@mliebelt/pgn-parser';
import { Chess } from 'chess.js';
import { Upload, Trash2, Play, Loader, X, StopCircle, Settings, Eye } from 'lucide-react';
import { useGames } from '../context/GameContext';
import { analyzeGame, createAnalysisWorker } from '../engine/analyzer';
import type { ImportedGame } from '../types/game';
import { generateGameId } from '../types/game';

interface AnalysisSettings {
  depth: number;
  inaccuracyThreshold: number;
  mistakeThreshold: number;
  blunderThreshold: number;
  /** Max half-moves (plies) to analyse per game. 0 = no limit. */
  maxMoves: number;
}

const DEFAULT_SETTINGS: AnalysisSettings = {
  depth: 22,
  inaccuracyThreshold: 0.5,
  mistakeThreshold: 1.0,
  blunderThreshold: 2.0,
  maxMoves: 20,
};

interface GameImportPanelProps {
  onViewGame?: (game: ImportedGame) => void;
  viewingGameId?: string | null;
}

export const GameImportPanel: React.FC<GameImportPanelProps> = ({ onViewGame, viewingGameId }) => {
  const {
    importedGames,
    analyzingGameId,
    analysisProgress,
    analysisCancelled,
    addGames,
    removeGame,
    setGameAnalyzed,
    setAnalyzing,
    setAnalysisProgress,
    cancelAnalysis,
    resetCancellation,
    clearAllGames,
  } = useGames();

  const [pgnText, setPgnText] = useState('');
  const [importError, setImportError] = useState<string | null>(null);
  const [isImporting, setIsImporting] = useState(false);
  const workerRef = useRef<Worker | null>(null);
  const [showClearConfirm, setShowClearConfirm] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settings, setSettings] = useState<AnalysisSettings>(DEFAULT_SETTINGS);

  /**
   * Parse PGN text and extract games.
   */
  const handleImport = useCallback(() => {
    if (!pgnText.trim()) return;

    setIsImporting(true);
    setImportError(null);

    try {
      // Try parsing as multiple games first, fall back to single game
      let gamesArray: any[];
      try {
        const parsedGames = parse(pgnText, { startRule: 'games' });
        gamesArray = Array.isArray(parsedGames) ? parsedGames : [parsedGames];
      } catch {
        // Fallback: try parsing as a single game
        try {
          const singleGame = parse(pgnText, { startRule: 'game' });
          gamesArray = [singleGame];
        } catch (innerErr) {
          throw new Error(
            innerErr instanceof Error ? innerErr.message : 'Failed to parse PGN'
          );
        }
      }

      const importedBatch: ImportedGame[] = [];

      for (const game of gamesArray) {
        try {
          const tags = game?.tags || {};
          const moves: string[] = [];

          // Extract moves as SAN strings
          if (Array.isArray(game?.moves)) {
            for (const moveObj of game.moves) {
              const san = moveObj?.notation?.notation;
              if (san && typeof san === 'string') moves.push(san);
            }
          }

          // Skip games with no moves
          if (moves.length === 0) continue;

          // PGN parser may return Date as an object {value, year, month, day}
          let dateStr: string | undefined;
          if (tags.Date) {
            if (typeof tags.Date === 'string') {
              dateStr = tags.Date;
            } else if (typeof tags.Date === 'object' && tags.Date.value) {
              dateStr = String(tags.Date.value);
            } else {
              dateStr = String(tags.Date);
            }
          }

          // Result can also be an object in some parser versions
          let resultStr: string | undefined;
          if (tags.Result) {
            resultStr = typeof tags.Result === 'string' ? tags.Result : String(tags.Result);
          }

          importedBatch.push({
            id: generateGameId(),
            pgn: pgnText,
            white: typeof tags.White === 'string' ? tags.White : (tags.White ? String(tags.White) : 'Unknown'),
            black: typeof tags.Black === 'string' ? tags.Black : (tags.Black ? String(tags.Black) : 'Unknown'),
            date: dateStr,
            result: resultStr,
            moves,
            mistakes: [],
            analyzed: false,
          });
        } catch {
          // Skip malformed games in the batch
          continue;
        }
      }

      if (importedBatch.length === 0) {
        setImportError('No valid games found in PGN text.');
      } else {
        addGames(importedBatch);
        setPgnText('');
      }
    } catch (err) {
      setImportError(
        err instanceof Error ? err.message : 'Failed to parse PGN. Check formatting.'
      );
    } finally {
      setIsImporting(false);
    }
  }, [pgnText, addGames]);

  /**
   * Analyze a single game with Stockfish.
   */
  const handleAnalyze = useCallback(
    async (game: ImportedGame) => {
      if (analyzingGameId) return; // already analyzing

      resetCancellation();
      setAnalyzing(game.id);
      setAnalysisProgress([0, game.moves.length + 1]);

      try {
        // Create a dedicated worker for batch analysis
        const worker = await createAnalysisWorker();
        workerRef.current = worker;

        const mistakes = await analyzeGame(
          game,
          worker,
          settings.depth,
          (current, total) => {
            setAnalysisProgress([current, total]);
          },
          () => analysisCancelled,
          {
            inaccuracy: settings.inaccuracyThreshold,
            mistake: settings.mistakeThreshold,
            blunder: settings.blunderThreshold,
          },
          settings.maxMoves > 0 ? settings.maxMoves : undefined
        );

        setGameAnalyzed(game.id, mistakes);

        // Clean up worker
        worker.terminate();
        workerRef.current = null;
      } catch (err) {
        console.error('Analysis failed:', err);
      } finally {
        setAnalyzing(null);
        setAnalysisProgress(null);
      }
    },
    [
      analyzingGameId,
      analysisCancelled,
      resetCancellation,
      setAnalyzing,
      setAnalysisProgress,
      setGameAnalyzed,
      settings,
    ]
  );

  /**
   * Analyze all unanalyzed games sequentially.
   */
  const handleAnalyzeAll = useCallback(async () => {
    const unanalyzed = importedGames.filter((g) => !g.analyzed);
    if (unanalyzed.length === 0 || analyzingGameId) return;

    for (const game of unanalyzed) {
      if (analysisCancelled) break;
      await handleAnalyze(game);
    }
  }, [importedGames, analyzingGameId, analysisCancelled, handleAnalyze]);

  /**
   * Cancel ongoing analysis.
   */
  const handleCancel = useCallback(() => {
    cancelAnalysis();
    if (workerRef.current) {
      workerRef.current.postMessage('stop');
      workerRef.current.terminate();
      workerRef.current = null;
    }
    setAnalyzing(null);
    setAnalysisProgress(null);
  }, [cancelAnalysis, setAnalyzing, setAnalysisProgress]);

  const unanalyzedCount = importedGames.filter((g) => !g.analyzed).length;
  const progressPct =
    analysisProgress
      ? Math.round((analysisProgress[0] / Math.max(1, analysisProgress[1])) * 100)
      : 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Import Section */}
      <div className="flex flex-col gap-2">
        <textarea
          value={pgnText}
          onChange={(e) => setPgnText(e.target.value)}
          placeholder="Paste PGN here (one or multiple games)..."
          className="w-full h-28 bg-bg-primary border border-border-subtle rounded-md p-2 text-xs font-mono text-text-primary placeholder:text-text-muted resize-none focus:outline-none focus:border-accent-teal/50"
        />
        <div className="flex gap-2 items-center">
          <button
            onClick={handleImport}
            disabled={!pgnText.trim() || isImporting}
            className="btn-primary flex items-center gap-1.5 text-xs disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Upload className="w-3.5 h-3.5" />
            Import
          </button>
          {unanalyzedCount > 0 && !analyzingGameId && (
            <button
              onClick={handleAnalyzeAll}
              className="btn-secondary flex items-center gap-1.5 text-xs"
            >
              <Play className="w-3.5 h-3.5" />
              Analyze All ({unanalyzedCount})
            </button>
          )}
          {analyzingGameId && (
            <button
              onClick={handleCancel}
              className="btn-secondary flex items-center gap-1.5 text-xs text-accent-red border-accent-red/30"
            >
              <StopCircle className="w-3.5 h-3.5" />
              Cancel
            </button>
          )}
          {/* Settings toggle */}
          <button
            onClick={() => setShowSettings((s) => !s)}
            className={`btn-icon p-1 ml-auto ${showSettings ? 'text-accent-teal' : ''}`}
            title="Analysis settings"
          >
            <Settings className="w-3.5 h-3.5" />
          </button>
        </div>
        {importError && (
          <div className="text-xs text-accent-red bg-accent-red/10 border border-accent-red/20 rounded-md px-2 py-1.5">
            {importError}
          </div>
        )}
      </div>

      {/* Analysis Settings Panel */}
      {showSettings && (
        <div className="bg-bg-primary border border-border-subtle rounded-md p-3 space-y-3">
          <div className="text-[10px] text-text-muted uppercase tracking-wider font-mono mb-1">
            Analysis Settings
          </div>

          {/* Depth */}
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">Engine Depth</span>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() =>
                  setSettings((s) => ({ ...s, depth: Math.max(6, s.depth - 2) }))
                }
                className="w-5 h-5 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[11px]"
              >
                −
              </button>
              <span className="text-xs text-text-primary font-semibold w-6 text-center">
                {settings.depth}
              </span>
              <button
                onClick={() =>
                  setSettings((s) => ({ ...s, depth: Math.min(30, s.depth + 2) }))
                }
                className="w-5 h-5 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[11px]"
              >
                +
              </button>
            </div>
          </div>

          {/* Max Moves */}
          <div className="flex items-center justify-between">
            <div>
              <span className="text-xs text-text-secondary">Max Moves</span>
              <div className="text-[10px] text-text-muted">
                {settings.maxMoves === 0 ? 'Analyse full game' : `Stop after move ${settings.maxMoves}`}
              </div>
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() =>
                  setSettings((s) => ({ ...s, maxMoves: Math.max(0, s.maxMoves - 10) }))
                }
                className="w-5 h-5 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[11px]"
              >
                −
              </button>
              <span className="text-xs text-text-primary font-semibold w-8 text-center">
                {settings.maxMoves === 0 ? '∞' : settings.maxMoves}
              </span>
              <button
                onClick={() =>
                  setSettings((s) => ({ ...s, maxMoves: s.maxMoves === 0 ? 10 : s.maxMoves + 10 }))
                }
                className="w-5 h-5 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[11px]"
              >
                +
              </button>
            </div>
          </div>

          {/* Thresholds */}
          <div className="space-y-2">
            <div className="text-[10px] text-text-muted">
              Mistake Thresholds (eval drop in pawns)
            </div>

            {/* Inaccuracy */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-accent-amber flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-accent-amber inline-block" />
                Inaccuracy
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      inaccuracyThreshold: Math.max(0.1, +(s.inaccuracyThreshold - 0.1).toFixed(1)),
                    }))
                  }
                  className="w-5 h-5 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[11px]"
                >
                  −
                </button>
                <span className="text-xs text-text-primary font-semibold w-8 text-center">
                  {settings.inaccuracyThreshold.toFixed(1)}
                </span>
                <button
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      inaccuracyThreshold: Math.min(
                        s.mistakeThreshold - 0.1,
                        +(s.inaccuracyThreshold + 0.1).toFixed(1)
                      ),
                    }))
                  }
                  className="w-5 h-5 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[11px]"
                >
                  +
                </button>
              </div>
            </div>

            {/* Mistake */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-orange-400 flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-orange-400 inline-block" />
                Mistake
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      mistakeThreshold: Math.max(
                        s.inaccuracyThreshold + 0.1,
                        +(s.mistakeThreshold - 0.1).toFixed(1)
                      ),
                    }))
                  }
                  className="w-5 h-5 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[11px]"
                >
                  −
                </button>
                <span className="text-xs text-text-primary font-semibold w-8 text-center">
                  {settings.mistakeThreshold.toFixed(1)}
                </span>
                <button
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      mistakeThreshold: Math.min(
                        s.blunderThreshold - 0.1,
                        +(s.mistakeThreshold + 0.1).toFixed(1)
                      ),
                    }))
                  }
                  className="w-5 h-5 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[11px]"
                >
                  +
                </button>
              </div>
            </div>

            {/* Blunder */}
            <div className="flex items-center justify-between">
              <span className="text-xs text-accent-red flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-accent-red inline-block" />
                Blunder
              </span>
              <div className="flex items-center gap-1.5">
                <button
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      blunderThreshold: Math.max(
                        s.mistakeThreshold + 0.1,
                        +(s.blunderThreshold - 0.1).toFixed(1)
                      ),
                    }))
                  }
                  className="w-5 h-5 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[11px]"
                >
                  −
                </button>
                <span className="text-xs text-text-primary font-semibold w-8 text-center">
                  {settings.blunderThreshold.toFixed(1)}
                </span>
                <button
                  onClick={() =>
                    setSettings((s) => ({
                      ...s,
                      blunderThreshold: Math.min(10, +(s.blunderThreshold + 0.1).toFixed(1)),
                    }))
                  }
                  className="w-5 h-5 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[11px]"
                >
                  +
                </button>
              </div>
            </div>
          </div>

          {/* Reset defaults */}
          <button
            onClick={() => setSettings(DEFAULT_SETTINGS)}
            className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
          >
            Reset to defaults
          </button>
        </div>
      )}

      {/* Analysis Progress */}
      {analyzingGameId && analysisProgress && (
        <div className="bg-bg-primary border border-border-subtle rounded-md p-2">
          <div className="flex items-center justify-between text-xs text-text-secondary mb-1.5">
            <span className="flex items-center gap-1.5">
              <Loader className="w-3 h-3 animate-spin" />
              Analyzing position {analysisProgress[0]}/{analysisProgress[1]} (depth {settings.depth})
            </span>
            <span>{progressPct}%</span>
          </div>
          <div className="w-full h-1.5 bg-bg-hover rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-teal rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {/* Game List */}
      {importedGames.length > 0 && (
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-muted uppercase tracking-wide">
              Imported Games ({importedGames.length})
            </span>
            {!showClearConfirm ? (
              <button
                onClick={() => setShowClearConfirm(true)}
                className="text-[10px] text-text-muted hover:text-accent-red transition-colors"
              >
                Clear All
              </button>
            ) : (
              <div className="flex items-center gap-1">
                <button
                  onClick={() => {
                    clearAllGames();
                    setShowClearConfirm(false);
                  }}
                  className="text-[10px] text-accent-red hover:text-accent-red/80 transition-colors"
                >
                  Confirm
                </button>
                <button
                  onClick={() => setShowClearConfirm(false)}
                  className="text-[10px] text-text-muted hover:text-text-secondary transition-colors"
                >
                  Cancel
                </button>
              </div>
            )}
          </div>

          <div className="flex flex-col gap-1 max-h-[250px] overflow-auto">
            {importedGames.map((game) => {
              const isCurrentlyAnalyzing = analyzingGameId === game.id;
              const mistakeCount = game.mistakes.length;

              return (
                <div
                  key={game.id}
                  className="flex items-center gap-2 bg-bg-primary border border-border-subtle rounded-md px-2 py-1.5 group"
                >
                  {/* Game info */}
                  <div className="flex-1 min-w-0">
                    <div className="text-xs text-text-primary truncate">
                      {typeof game.white === 'string' ? game.white : String(game.white)} vs{' '}
                      {typeof game.black === 'string' ? game.black : String(game.black)}
                    </div>
                    <div className="flex items-center gap-2 text-[10px] text-text-muted">
                      {game.date && (
                        <span>
                          {typeof game.date === 'string'
                            ? game.date
                            : typeof game.date === 'object' && (game.date as any)?.value
                              ? String((game.date as any).value)
                              : String(game.date)}
                        </span>
                      )}
                      {game.result && (
                        <span>
                          {typeof game.result === 'string' ? game.result : String(game.result)}
                        </span>
                      )}
                      <span>{game.moves.length} moves</span>
                    </div>
                  </div>

                  {/* Status / Actions */}
                  <div className="flex items-center gap-1 flex-shrink-0">
                    {game.analyzed ? (
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded ${
                          mistakeCount > 0
                            ? 'bg-accent-amber/20 text-accent-amber'
                            : 'bg-accent-green/20 text-accent-green'
                        }`}
                      >
                        {mistakeCount > 0
                          ? `${mistakeCount} mistake${mistakeCount !== 1 ? 's' : ''}`
                          : 'Clean'}
                      </span>
                    ) : isCurrentlyAnalyzing ? (
                      <Loader className="w-3.5 h-3.5 text-accent-teal animate-spin" />
                    ) : (
                      <button
                        onClick={() => handleAnalyze(game)}
                        disabled={!!analyzingGameId}
                        className="btn-icon p-1 disabled:opacity-40"
                        title="Analyze game"
                      >
                        <Play className="w-3.5 h-3.5 text-accent-teal" />
                      </button>
                    )}
                    {/* View game on board */}
                    {onViewGame && (
                      <button
                        onClick={() => onViewGame(game)}
                        className={`btn-icon p-1 ${
                          viewingGameId === game.id ? 'text-accent-teal bg-accent-teal/10' : ''
                        }`}
                        title="View game on board"
                      >
                        <Eye className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      onClick={() => removeGame(game.id)}
                      disabled={isCurrentlyAnalyzing}
                      className="btn-icon p-1 opacity-0 group-hover:opacity-100 disabled:opacity-0"
                      title="Remove game"
                    >
                      <Trash2 className="w-3.5 h-3.5 text-accent-red" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {importedGames.length === 0 && (
        <div className="text-center text-text-muted text-xs py-6">
          No games imported yet. Paste PGN above to get started.
        </div>
      )}
    </div>
  );
};
