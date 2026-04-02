import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, BarChart3, ChevronRight, Loader, Search } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { useFiles } from '../context/FileContext';
import { analyzeGame, createAnalysisWorker } from '../engine/analyzer';
import { Chess } from 'chess.js';
import {
  fetchGames,
  type FetchProgress,
  type GameSource,
} from '../utils/chessComFetcher';
import {
  buildPerformanceReport,
  type GamePhase,
  type MatchedPerformanceGame,
  toPerformanceGames,
  type PerformanceReportData,
  type RepertoirePerformanceDetail,
  type RepertoirePerformanceSummary,
} from '../utils/performanceReport';
import type { ImportedGame } from '../types/game';
import { addLineToTree, cloneTree } from '../utils/treeBuilder';

interface PerformanceReportPageProps {
  onClose: () => void;
}

const SOURCE_OPTIONS: { value: GameSource; label: string }[] = [
  { value: 'chesscom', label: 'Chess.com' },
  { value: 'lichess', label: 'Lichess' },
];

const WINDOW_OPTIONS = [30, 60, 90] as const;

function sourceLabel(source: GameSource): string {
  return source === 'lichess' ? 'Lichess' : 'Chess.com';
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`;
}

function formatAverage(value: number): string {
  return value.toFixed(1);
}

function getWindowMonthRange(days: number): { from: string; to: string; cutoffSeconds: number } {
  const now = new Date();
  const cutoff = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const from = `${cutoff.getFullYear()}-${String(cutoff.getMonth() + 1).padStart(2, '0')}`;
  const to = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  return {
    from,
    to,
    cutoffSeconds: Math.floor(cutoff.getTime() / 1000),
  };
}

function stageLabel(phase: GamePhase): string {
  if (phase === 'opening') return 'Opening';
  if (phase === 'middlegame') return 'Middlegame';
  return 'Endgame';
}

function StageBar({
  wins,
  draws,
  losses,
  total,
}: {
  wins: number;
  draws: number;
  losses: number;
  total: number;
}) {
  const winPct = total > 0 ? (wins / total) * 100 : 0;
  const drawPct = total > 0 ? (draws / total) * 100 : 0;
  const lossPct = total > 0 ? (losses / total) * 100 : 0;

  return (
    <div className="h-36 rounded-md overflow-hidden border border-border-subtle bg-bg-panel flex">
      <div className="bg-accent-red/70" style={{ width: `${lossPct}%` }} />
      <div className="bg-text-muted/70" style={{ width: `${drawPct}%` }} />
      <div className="bg-accent-green/70" style={{ width: `${winPct}%` }} />
    </div>
  );
}

function ResultStrip({
  wins,
  draws,
  losses,
  total,
}: {
  wins: number;
  draws: number;
  losses: number;
  total: number;
}) {
  const winPct = total > 0 ? (wins / total) * 100 : 0;
  const drawPct = total > 0 ? (draws / total) * 100 : 0;
  const lossPct = total > 0 ? (losses / total) * 100 : 0;

  return (
    <>
      <div className="flex items-center gap-4 text-xs font-mono flex-wrap">
        <span className="text-accent-green">W {formatPercent(winPct)}</span>
        <span className="text-text-muted">D {formatPercent(drawPct)}</span>
        <span className="text-accent-red">L {formatPercent(lossPct)}</span>
      </div>
      <div className="h-3 rounded-full overflow-hidden border border-border-subtle bg-bg-panel flex mt-2">
        <div className="bg-accent-green" style={{ width: `${winPct}%` }} />
        <div className="bg-text-muted" style={{ width: `${drawPct}%` }} />
        <div className="bg-accent-red" style={{ width: `${lossPct}%` }} />
      </div>
    </>
  );
}

interface RecurringMistake {
  key: string;
  count: number;
  moveNumber: number;
  side: 'white' | 'black';
  movePlayed: string;
  bestMove: string;
  averageEvalDrop: number;
}

interface WorstLineEntry {
  key: string;
  moves: string[];
  games: number;
  wins: number;
  draws: number;
  losses: number;
  winRate: number;
  score: number;
}

function normalizeLineForTierList(entry: MatchedPerformanceGame): string[] {
  const moves = [...entry.matchedMoves];
  if (moves.length === 0) return moves;

  const shouldEndOnOpponentMove =
    entry.game.playerColor === 'white'
      ? moves.length % 2 === 0
      : moves.length % 2 === 1;

  if (shouldEndOnOpponentMove) {
    return moves.slice(0, Math.min(moves.length, 8));
  }

  return moves.slice(0, Math.min(Math.max(0, moves.length - 1), 8));
}

function buildTierListLine(
  entry: MatchedPerformanceGame,
  forcedPrefix: string[]
): string[] {
  if (forcedPrefix.length === 0) {
    return normalizeLineForTierList(entry);
  }

  const nextMove = entry.matchedMoves[forcedPrefix.length] ?? entry.deviationMove;
  if (!nextMove) {
    return forcedPrefix;
  }

  return [...forcedPrefix, nextMove];
}

export const PerformanceReportPage: React.FC<PerformanceReportPageProps> = ({ onClose }) => {
  const { files, updateFile } = useFiles();
  const { user } = useAuth();
  const [source, setSource] = useState<GameSource>('chesscom');
  const usernameStorageKey = user
    ? `gamefetcher_username_${source}_${user.id}`
    : `gamefetcher_username_${source}`;

  const [username, setUsername] = useState('');
  const [windowDays, setWindowDays] = useState<30 | 60 | 90>(30);
  const [minMatchMoves, setMinMatchMoves] = useState(3);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState<FetchProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [totalFetched, setTotalFetched] = useState(0);
  const [matchedGames, setMatchedGames] = useState(0);
  const [summaries, setSummaries] = useState<RepertoirePerformanceSummary[]>([]);
  const [reportData, setReportData] = useState<PerformanceReportData | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
  const [analyzingMistakes, setAnalyzingMistakes] = useState(false);
  const [mistakeProgress, setMistakeProgress] = useState('');
  const [mistakeError, setMistakeError] = useState<string | null>(null);
  const [recurringMistakes, setRecurringMistakes] = useState<RecurringMistake[]>([]);
  const [addedLineKeys, setAddedLineKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    const saved = localStorage.getItem(usernameStorageKey);
    setUsername(saved ?? '');
  }, [usernameStorageKey]);

  const sortedSummaries = useMemo(
    () => [...summaries].sort((a, b) => {
      if (b.matchedGames !== a.matchedGames) return b.matchedGames - a.matchedGames;
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      return a.file.name.localeCompare(b.file.name);
    }),
    [summaries]
  );

  const selectedDetail = useMemo<RepertoirePerformanceDetail | null>(() => {
    if (!selectedFileId || !reportData) return null;
    return reportData.detailsByFileId[selectedFileId] ?? null;
  }, [selectedFileId, reportData]);

  const worstLines = useMemo<WorstLineEntry[]>(() => {
    if (!selectedDetail) return [];

    const buildEntries = (grouped: Map<string, WorstLineEntry>) =>
      Array.from(grouped.values()).map((line) => {
        line.winRate = line.games > 0 ? (line.wins / line.games) * 100 : 0;
        const lossRate = line.games > 0 ? line.losses / line.games : 0;
        line.score = lossRate * 100 + line.games * 0.5 - line.winRate * 0.25;
        return line;
      })
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        if (b.games !== a.games) return b.games - a.games;
        return a.key.localeCompare(b.key);
      });

    const accumulate = (
      grouped: Map<string, WorstLineEntry>,
      moves: string[],
      result: 'win' | 'draw' | 'loss'
    ) => {
      if (moves.length === 0) return;
      const key = moves.join(' ');
      const existing = grouped.get(key);
      if (existing) {
        existing.games += 1;
        if (result === 'win') existing.wins += 1;
        else if (result === 'draw') existing.draws += 1;
        else existing.losses += 1;
        return;
      }

      grouped.set(key, {
        key,
        moves,
        games: 1,
        wins: result === 'win' ? 1 : 0,
        draws: result === 'draw' ? 1 : 0,
        losses: result === 'loss' ? 1 : 0,
        winRate: 0,
        score: 0,
      });
    };

    const forcedPrefix = selectedDetail.summary.linePreview;
    const primaryGrouped = new Map<string, WorstLineEntry>();
    for (const entry of selectedDetail.games) {
      accumulate(primaryGrouped, buildTierListLine(entry, forcedPrefix), entry.game.result);
    }

    const primary = buildEntries(primaryGrouped).slice(0, 5);
    if (primary.length >= 5) {
      return primary;
    }

    const fallbackGrouped = new Map<string, WorstLineEntry>();
    for (const entry of selectedDetail.games) {
      accumulate(fallbackGrouped, normalizeLineForTierList(entry), entry.game.result);
    }

    const seen = new Set(primary.map((line) => line.key));
    const fallback = buildEntries(fallbackGrouped)
      .filter((line) => !seen.has(line.key))
      .slice(0, 5 - primary.length);

    return [...primary, ...fallback].slice(0, 5);
  }, [selectedDetail]);

  const resetRecurringMistakes = useCallback(() => {
    setRecurringMistakes([]);
    setMistakeError(null);
    setMistakeProgress('');
    setAnalyzingMistakes(false);
  }, []);

  const handleFetch = useCallback(async () => {
    const trimmedUsername = username.trim();
    if (!trimmedUsername) {
      setError(`Enter a ${sourceLabel(source)} username.`);
      return;
    }
    if (files.length === 0) {
      setError('Save at least one repertoire before running a performance report.');
      return;
    }

    setLoading(true);
    setError(null);
    setProgress(null);
    resetRecurringMistakes();

    try {
      localStorage.setItem(usernameStorageKey, trimmedUsername);
      const range = getWindowMonthRange(windowDays);
      const rawGames = await fetchGames(source, trimmedUsername, range.from, range.to, setProgress);
      const performanceGames = toPerformanceGames(rawGames, trimmedUsername)
        .filter((game) => game.endedAt >= range.cutoffSeconds);
      const nextReportData = buildPerformanceReport(files, performanceGames, minMatchMoves * 2);
      const nextSummaries = nextReportData.summaries;
      const nextMatchedGames = nextReportData.matchedGames.length;

      setTotalFetched(performanceGames.length);
      setMatchedGames(nextMatchedGames);
      setSummaries(nextSummaries);
      setReportData(nextReportData);
      const firstNonEmpty = [...nextSummaries]
        .sort((a, b) => b.matchedGames - a.matchedGames)
        .find((summary) => summary.matchedGames > 0);
      setSelectedFileId(firstNonEmpty?.file.id ?? null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSummaries([]);
      setReportData(null);
      setTotalFetched(0);
      setMatchedGames(0);
      setSelectedFileId(null);
    } finally {
      setLoading(false);
    }
  }, [username, source, files, usernameStorageKey, windowDays, minMatchMoves, resetRecurringMistakes]);

  useEffect(() => {
    resetRecurringMistakes();
  }, [selectedFileId, resetRecurringMistakes]);

  useEffect(() => {
    setAddedLineKeys(new Set());
  }, [selectedFileId]);

  const handleAnalyzeRecurringMistakes = useCallback(async () => {
    if (!selectedDetail || selectedDetail.games.length === 0 || analyzingMistakes) return;

    setAnalyzingMistakes(true);
    setMistakeError(null);
    setRecurringMistakes([]);

    let worker: Worker | null = null;
    try {
      worker = await createAnalysisWorker();
      const gamesToAnalyze = selectedDetail.games.slice(0, 8);
      const grouped = new Map<string, {
        count: number;
        moveNumber: number;
        side: 'white' | 'black';
        movePlayed: string;
        bestMove: string;
        totalEvalDrop: number;
      }>();

      for (let gameIndex = 0; gameIndex < gamesToAnalyze.length; gameIndex++) {
        const entry = gamesToAnalyze[gameIndex];
        const importedGame: ImportedGame = {
          id: entry.game.id,
          pgn: entry.game.raw.pgn,
          white: entry.game.raw.white.username,
          black: entry.game.raw.black.username,
          date: new Date(entry.game.endedAt * 1000).toISOString().split('T')[0],
          result: entry.game.result,
          moves: entry.game.moves,
          mistakes: [],
          analyzed: false,
        };

        setMistakeProgress(`Analyzing game ${gameIndex + 1}/${gamesToAnalyze.length}`);
        const mistakes = await analyzeGame(importedGame, worker, 25, undefined, undefined, undefined, 24);

        for (const mistake of mistakes) {
          const key = `${mistake.side}|${mistake.moveNumber}|${mistake.movePlayed}|${mistake.bestMove}`;
          const existing = grouped.get(key);
          if (existing) {
            existing.count += 1;
            existing.totalEvalDrop += mistake.evalDrop;
          } else {
            grouped.set(key, {
              count: 1,
              moveNumber: mistake.moveNumber,
              side: mistake.side,
              movePlayed: mistake.movePlayed,
              bestMove: mistake.bestMove,
              totalEvalDrop: mistake.evalDrop,
            });
          }
        }
      }

      const recurring = Array.from(grouped.entries())
        .map(([key, value]) => ({
          key,
          count: value.count,
          moveNumber: value.moveNumber,
          side: value.side,
          movePlayed: value.movePlayed,
          bestMove: value.bestMove,
          averageEvalDrop: value.totalEvalDrop / value.count,
        }))
        .filter((item) => item.count >= 2)
        .sort((a, b) => {
          if (b.count !== a.count) return b.count - a.count;
          return b.averageEvalDrop - a.averageEvalDrop;
        })
        .slice(0, 8);

      setRecurringMistakes(recurring);
      setMistakeProgress('');
    } catch (err) {
      setMistakeError(err instanceof Error ? err.message : String(err));
    } finally {
      if (worker) worker.terminate();
      setAnalyzingMistakes(false);
    }
  }, [selectedDetail, analyzingMistakes]);

  const handleAddWorstLine = useCallback((line: WorstLineEntry) => {
    if (!selectedDetail) return;

    const nextTree = cloneTree(selectedDetail.summary.file.tree);
    const chess = new Chess();
    const movesToAdd: { move: string; fen: string }[] = [];

    for (const san of line.moves) {
      const moveResult = chess.move(san);
      if (!moveResult) return;
      movesToAdd.push({
        move: moveResult.san,
        fen: chess.fen(),
      });
    }

    addLineToTree(nextTree, nextTree.id, movesToAdd);
    updateFile(selectedDetail.summary.file.id, nextTree);
    setAddedLineKeys((prev) => new Set(prev).add(line.key));
  }, [selectedDetail, updateFile]);

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-bg-primary">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-bg-surface">
        <button onClick={onClose} className="btn-icon p-1.5" title="Back to repertoire">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-accent-teal" />
            <h1 className="text-sm font-semibold text-text-primary">Performance Report</h1>
          </div>
          <p className="text-xs text-text-muted mt-0.5">
            Fetch live {sourceLabel(source)} games and match them against your saved repertoires.
          </p>
        </div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="max-w-[1040px] mx-auto p-6 space-y-6">
          <div className="panel">
            <div className="p-4 space-y-4">
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div>
                  <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    Report Setup
                  </div>
                  <div className="text-sm text-text-secondary mt-1">
                    Games count for a repertoire when they match its move tree for at least the selected number of moves.
                  </div>
                </div>
                <div className="flex items-center gap-1 bg-bg-panel rounded border border-border-subtle p-0.5 h-9">
                  {SOURCE_OPTIONS.map((option) => (
                    <button
                      key={option.value}
                      onClick={() => setSource(option.value)}
                      className={`px-3 py-1 rounded text-xs font-mono transition-all ${
                        source === option.value
                          ? 'bg-bg-surface text-accent-teal border border-accent-teal/40'
                          : 'text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex gap-3 items-end flex-wrap">
                <div className="flex flex-col gap-1 min-w-[240px] flex-1">
                  <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    Username
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder={`Enter ${sourceLabel(source)} username`}
                    className="h-9 px-3 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-sm outline-none focus:border-accent-teal transition-colors"
                  />
                </div>

                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    Interval
                  </label>
                  <div className="flex items-center gap-1 bg-bg-panel rounded border border-border-subtle p-0.5 h-9">
                    {WINDOW_OPTIONS.map((days) => (
                      <button
                        key={days}
                        onClick={() => setWindowDays(days)}
                        className={`px-3 py-1 rounded text-xs font-mono transition-all ${
                          windowDays === days
                            ? 'bg-bg-surface text-accent-teal border border-accent-teal/40'
                            : 'text-text-muted hover:text-text-secondary'
                        }`}
                      >
                        {days} days
                      </button>
                    ))}
                  </div>
                </div>

                <div className="flex flex-col gap-1 min-w-[140px]">
                  <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    Min Match
                  </label>
                  <select
                    value={minMatchMoves}
                    onChange={(e) => setMinMatchMoves(Number(e.target.value))}
                    className="h-9 px-3 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-sm outline-none focus:border-accent-teal transition-colors"
                  >
                    {[2, 3, 4, 5, 6].map((moves) => (
                      <option key={moves} value={moves}>
                        {moves} moves
                      </option>
                    ))}
                  </select>
                </div>

                <button
                  onClick={() => void handleFetch()}
                  disabled={loading}
                  className="btn-primary h-9 px-4 flex items-center gap-2"
                >
                  {loading ? <Loader className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                  <span>{loading ? 'Fetching...' : 'Fetch Report'}</span>
                </button>
              </div>

              {progress && (
                <div className="text-xs text-text-muted">
                  Fetched {progress.fetchedMonths}/{progress.totalMonths} month{progress.totalMonths !== 1 ? 's' : ''} and found {progress.gamesFound} games so far.
                </div>
              )}

              {error && (
                <div className="text-sm text-accent-red bg-accent-red/10 border border-accent-red/20 rounded-md px-3 py-2">
                  {error}
                </div>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="panel p-4">
              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Saved repertoires</div>
              <div className="text-2xl font-semibold text-text-primary mt-2">{files.length}</div>
            </div>
            <div className="panel p-4">
              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Fetched games</div>
              <div className="text-2xl font-semibold text-text-primary mt-2">{totalFetched}</div>
            </div>
            <div className="panel p-4">
              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Matched games</div>
              <div className="text-2xl font-semibold text-text-primary mt-2">{matchedGames}</div>
            </div>
          </div>

          <div className="panel overflow-hidden">
            <div className="panel-header">Repertoire Overview</div>
            {sortedSummaries.length === 0 ? (
              <div className="p-6 text-sm text-text-muted">
                Run the report to see winrates and coverage across your saved repertoires.
              </div>
            ) : (
              <div className="divide-y divide-border-subtle">
                {sortedSummaries.map((summary) => {
                  const isSelected = selectedFileId === summary.file.id;
                  const detail = isSelected ? selectedDetail : null;

                  return (
                    <div key={summary.file.id}>
                      <button
                        type="button"
                        onClick={() => setSelectedFileId((current) => current === summary.file.id ? null : summary.file.id)}
                        className={`w-full text-left p-4 flex items-center justify-between gap-4 flex-wrap transition-colors ${
                          isSelected ? 'bg-accent-teal/5' : 'hover:bg-bg-hover/50'
                        }`}
                      >
                        <div className="min-w-[220px] flex-1">
                          <div className="text-sm font-medium text-text-primary flex items-center gap-2">
                            <span>{summary.file.name}</span>
                            <ChevronRight className={`w-3.5 h-3.5 text-text-muted transition-transform ${isSelected ? 'rotate-90 text-accent-teal' : ''}`} />
                          </div>
                          {summary.linePreview.length > 0 && (
                            <div className="text-xs text-text-secondary mt-1 font-mono">
                              {summary.linePreview.join(' ')}
                            </div>
                          )}
                          <div className="text-xs text-text-muted mt-1">
                            {summary.matchedGames} matched game{summary.matchedGames !== 1 ? 's' : ''} • avg {formatAverage(summary.averageMatchedMoves)} moves • deepest {summary.deepestMatchMoves} moves
                          </div>
                        </div>
                        <div className="flex items-center gap-6 flex-wrap">
                          <div className="min-w-[220px]">
                            <ResultStrip
                              wins={summary.wins}
                              draws={summary.draws}
                              losses={summary.losses}
                              total={summary.matchedGames}
                            />
                          </div>
                        </div>
                      </button>

                      {detail && (
                        <div className="border-t border-border-subtle bg-bg-primary/70">
                          <div className="p-4 space-y-5">
                            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                              <div className="bg-bg-panel rounded-md border border-border-subtle p-3">
                                <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Winrate</div>
                                <div className="text-xl font-semibold text-text-primary mt-1">
                                  {formatPercent(detail.summary.winRate)}
                                </div>
                              </div>
                              <div className="bg-bg-panel rounded-md border border-border-subtle p-3">
                                <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Matched games</div>
                                <div className="text-xl font-semibold text-text-primary mt-1">
                                  {detail.summary.matchedGames}
                                </div>
                              </div>
                              <div className="bg-bg-panel rounded-md border border-border-subtle p-3">
                                <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Avg matched</div>
                                <div className="text-xl font-semibold text-text-primary mt-1">
                                  {formatAverage(detail.summary.averageMatchedMoves)} moves
                                </div>
                              </div>
                              <div className="bg-bg-panel rounded-md border border-border-subtle p-3">
                                <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">W-D-L</div>
                                <div className="text-xl font-semibold text-text-primary mt-1">
                                  {detail.summary.wins}-{detail.summary.draws}-{detail.summary.losses}
                                </div>
                              </div>
                            </div>

                            <div>
                              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-2">
                                Matched Games By Result
                              </div>
                              <div className="rounded-md border border-border-subtle bg-bg-panel px-3 py-3">
                                <ResultStrip
                                  wins={detail.summary.wins}
                                  draws={detail.summary.draws}
                                  losses={detail.summary.losses}
                                  total={detail.summary.matchedGames}
                                />
                              </div>
                            </div>

                            <div>
                              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-3">
                                Results By Game Phase
                              </div>
                              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                                {detail.stageResults.map((stage) => (
                                  <div key={stage.phase} className="rounded-md border border-border-subtle bg-bg-panel p-3">
                                    <StageBar
                                      wins={stage.wins}
                                      draws={stage.draws}
                                      losses={stage.losses}
                                      total={stage.total}
                                    />
                                    <div className="mt-3 text-sm font-medium text-text-primary text-center">
                                      {stageLabel(stage.phase)}
                                    </div>
                                    <div className="mt-2">
                                      <ResultStrip
                                        wins={stage.wins}
                                        draws={stage.draws}
                                        losses={stage.losses}
                                        total={stage.total}
                                      />
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>

                            <div>
                              <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider mb-3">
                                Worst Performing Lines
                              </div>
                              {worstLines.length === 0 ? (
                                <div className="text-sm text-text-muted">
                                  Not enough matched lines yet to rank weak branches.
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  {worstLines.map((line, index) => (
                                    <div key={line.key} className="rounded-md border border-border-subtle bg-bg-panel px-3 py-3">
                                      <div className="flex items-center justify-between gap-3 flex-wrap">
                                        <div className="text-sm text-text-primary">
                                          #{index + 1} worst line
                                        </div>
                                        <div className="flex items-center gap-3">
                                          <div className="text-xs text-text-muted">
                                            {line.games} game{line.games !== 1 ? 's' : ''}
                                          </div>
                                          <button
                                            onClick={() => handleAddWorstLine(line)}
                                            disabled={addedLineKeys.has(line.key)}
                                            className="btn-primary text-xs py-1 px-2 disabled:opacity-50"
                                          >
                                            {addedLineKeys.has(line.key) ? 'Added' : 'Add to repertoire'}
                                          </button>
                                        </div>
                                      </div>
                                      <div className="text-sm text-text-primary font-mono mt-2 break-words">
                                        {line.moves.join(' ')}
                                      </div>
                                      <div className="mt-2">
                                        <ResultStrip
                                          wins={line.wins}
                                          draws={line.draws}
                                          losses={line.losses}
                                          total={line.games}
                                        />
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>

                            <div>
                              <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
                                <div>
                                  <div className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                                    Mistakes Made At Least Twice
                                  </div>
                                  <div className="text-sm text-text-secondary mt-1">
                                    Analyze the latest matched games for recurring inaccuracies, mistakes, and blunders.
                                  </div>
                                </div>
                                <button
                                  onClick={() => void handleAnalyzeRecurringMistakes()}
                                  disabled={analyzingMistakes || detail.games.length === 0}
                                  className="btn-primary"
                                >
                                  {analyzingMistakes ? 'Analyzing...' : 'Analyze mistakes'}
                                </button>
                              </div>

                              {mistakeProgress && (
                                <div className="text-xs text-text-muted mb-2">{mistakeProgress}</div>
                              )}
                              {mistakeError && (
                                <div className="text-sm text-accent-red bg-accent-red/10 border border-accent-red/20 rounded-md px-3 py-2 mb-3">
                                  {mistakeError}
                                </div>
                              )}

                              {recurringMistakes.length === 0 ? (
                                <div className="text-sm text-text-muted">
                                  {analyzingMistakes
                                    ? 'Looking for repeated mistakes...'
                                    : 'No recurring mistakes yet. Run the analysis to populate this section.'}
                                </div>
                              ) : (
                                <div className="space-y-2">
                                  {recurringMistakes.map((mistake) => (
                                    <div key={mistake.key} className="rounded-md border border-border-subtle bg-bg-panel px-3 py-2">
                                      <div className="flex items-center justify-between gap-3 flex-wrap">
                                        <div className="text-sm text-text-primary">
                                          Move {mistake.moveNumber} • {mistake.side} played <span className="font-mono">{mistake.movePlayed}</span> instead of <span className="font-mono text-accent-green">{mistake.bestMove}</span>
                                        </div>
                                        <div className="text-xs text-text-muted">
                                          repeated {mistake.count}x
                                        </div>
                                      </div>
                                      <div className="text-xs text-text-secondary mt-1">
                                        Average eval drop: {mistake.averageEvalDrop.toFixed(1)}
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
