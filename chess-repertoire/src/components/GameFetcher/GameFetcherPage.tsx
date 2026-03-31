import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { ArrowLeft, Search, Loader, ChevronDown, ChevronRight, Check, Globe, BookOpen } from 'lucide-react';
import { useGames } from '../../context/GameContext';
import { useAuth } from '../../context/AuthContext';
import { generateGameId } from '../../types/game';
import type { ImportedGame } from '../../types/game';
import {
  fetchGames,
  parsePgnMoves,
  parsePgnResult,
  type GameSource,
  type RawFetchedGame,
  type FetchProgress,
} from '../../utils/chessComFetcher';
import { classifyOpening, classifyTimeControl } from '../../utils/ecoClassifier';
import { RepertoireGameFetcherTab } from './RepertoireGameFetcherTab';
import { MonthYearInput } from './MonthYearInput';

type FetcherMode = 'standard' | 'repertoire';

// ─── Types ───────────────────────────────────────────────────────────────────

interface GameFetcherPageProps {
  onClose: () => void;
}

interface Filters {
  rated: 'all' | 'rated' | 'unrated';
  tc: 'all' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'daily';
  color: 'all' | 'white' | 'black';
  result: 'all' | 'win' | 'loss' | 'draw';
}

interface ClassifiedGame {
  id: string;
  raw: RawFetchedGame;
  eco: string;
  opening: string;
  moves: string[];
  result: string;
}

interface OpeningGroup {
  eco: string;
  name: string;
  games: ClassifiedGame[];
  wins: number;
  draws: number;
  losses: number;
}

const SOURCE_OPTIONS: { value: GameSource; label: string }[] = [
  { value: 'chesscom', label: 'Chess.com' },
  { value: 'lichess', label: 'Lichess' },
];

function sourceLabel(source: GameSource): string {
  return source === 'lichess' ? 'Lichess' : 'Chess.com';
}

// ─── Filter Chip Component ───────────────────────────────────────────────────

function FilterChip<T extends string>({
  label,
  value,
  active,
  onClick,
}: {
  label: string;
  value: T;
  active: boolean;
  onClick: (v: T) => void;
}) {
  return (
    <button
      onClick={() => onClick(value)}
      className={`px-3 py-1 rounded text-xs font-mono transition-all border ${
        active
          ? 'border-accent-teal text-accent-teal bg-accent-teal/10'
          : 'border-border-subtle text-text-muted hover:border-border-active hover:text-text-secondary'
      }`}
    >
      {label}
    </button>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export const GameFetcherPage: React.FC<GameFetcherPageProps> = ({ onClose }) => {
  const games = useGames();
  const { user } = useAuth();
  const [mode, setMode] = useState<FetcherMode>('standard');
  const [source, setSource] = useState<GameSource>('chesscom');

  const usernameStorageKey = user
    ? `gamefetcher_username_${source}_${user.id}`
    : `gamefetcher_username_${source}`;

  // Form state
  const [username, setUsername] = useState('');

  // Load saved username on mount / when the signed-in user changes
  useEffect(() => {
    const saved = localStorage.getItem(usernameStorageKey);
    setUsername(saved ?? '');
  }, [usernameStorageKey]);
  const [dateFrom, setDateFrom] = useState(() => {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth() - 2, 1);
    return `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, '0')}`;
  });
  const [dateTo, setDateTo] = useState(() => {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  });
  const [filters, setFilters] = useState<Filters>({
    rated: 'all',
    tc: 'all',
    color: 'all',
    result: 'all',
  });

  // Fetch state
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<FetchProgress | null>(null);

  // Results state
  const [groups, setGroups] = useState<OpeningGroup[]>([]);
  const [totalFetched, setTotalFetched] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<'count' | 'name' | 'eco'>('count');
  const [searchFilter, setSearchFilter] = useState('');

  // ─── Filter & classify fetched games ─────────────────────────────────────

  const applyFiltersAndClassify = useCallback(
    (rawGames: RawFetchedGame[], user: string): OpeningGroup[] => {
      const filtered = rawGames.filter((g) => {
        // Rated filter
        if (filters.rated === 'rated' && !g.rated) return false;
        if (filters.rated === 'unrated' && g.rated) return false;

        // Time control filter
        if (filters.tc !== 'all') {
          const tc = classifyTimeControl(g.time_control);
          if (tc !== filters.tc) return false;
        }

        // Color filter
        if (filters.color !== 'all') {
          const playerIsWhite =
            g.white?.username?.toLowerCase() === user.toLowerCase();
          if (filters.color === 'white' && !playerIsWhite) return false;
          if (filters.color === 'black' && playerIsWhite) return false;
        }

        // Result filter (win/loss/draw from the fetched player's perspective)
        if (filters.result !== 'all') {
          const playerIsWhite =
            g.white?.username?.toLowerCase() === user.toLowerCase();
          const playerResult = playerIsWhite
            ? g.white?.result
            : g.black?.result;
          // chess.com API: 'win' means the player won; other values
          // like 'checkmated', 'timeout', 'resigned', 'abandoned' are losses;
          // draw values include 'agreed', 'stalemate', 'repetition', etc.
          const isWin = playerResult === 'win';
          const isDraw = [
            'agreed',
            'stalemate',
            'repetition',
            'insufficient',
            'timevsinsufficient',
            '50move',
          ].includes(playerResult ?? '');

          if (filters.result === 'win' && !isWin) return false;
          if (filters.result === 'loss' && (isWin || isDraw)) return false;
          if (filters.result === 'draw' && !isDraw) return false;
        }

        return true;
      });

      // Classify each game
      const classified: ClassifiedGame[] = filtered
        .filter((g) => g.pgn)
        .map((g, i) => {
          const moves = parsePgnMoves(g.pgn);
          const opening = classifyOpening(moves);
          const result = parsePgnResult(g.pgn);
          return {
            id: `fetch_${i}_${g.end_time}`,
            raw: g,
            eco: opening?.eco ?? '?',
            opening: opening?.name ?? 'Unknown / Unclassified',
            moves,
            result,
          };
        });

      // Group by opening
      const map = new Map<string, OpeningGroup>();
      for (const game of classified) {
        const key = `${game.eco}|${game.opening}`;
        if (!map.has(key)) {
          map.set(key, {
            eco: game.eco,
            name: game.opening,
            games: [],
            wins: 0,
            draws: 0,
            losses: 0,
          });
        }
        const group = map.get(key)!;
        group.games.push(game);
        if (game.result === '1-0') group.wins++;
        else if (game.result === '0-1') group.losses++;
        else if (game.result === '1/2-1/2') group.draws++;
      }

      return [...map.values()];
    },
    [filters]
  );

  // ─── Fetch games ─────────────────────────────────────────────────────────

  const handleFetch = useCallback(async () => {
    const user = username.trim();
    if (!user) {
      setError(`Enter a ${sourceLabel(source)} username.`);
      return;
    }
    if (!dateFrom || !dateTo) {
      setError('Select a date range.');
      return;
    }
    if (dateFrom > dateTo) {
      setError('From date must be before To date.');
      return;
    }

    // Persist the username so it's pre-filled next time
    localStorage.setItem(usernameStorageKey, user);

    setLoading(true);
    setError(null);
    setProgress(null);
    setGroups([]);
    setSelectedIds(new Set());

    try {
      const rawGames = await fetchGames(source, user, dateFrom, dateTo, (p) =>
        setProgress(p)
      );

      if (rawGames.length === 0) {
        setError('No games found for this user in the selected period.');
        setLoading(false);
        return;
      }

      const grouped = applyFiltersAndClassify(rawGames, user);
      setGroups(grouped);
      setTotalFetched(rawGames.length);

      // Select all games by default
      const allIds = new Set<string>();
      for (const group of grouped) {
        for (const game of group.games) {
          allIds.add(game.id);
        }
      }
      setSelectedIds(allIds);
    } catch (err: any) {
      setError(err.message || 'Failed to fetch games.');
    } finally {
      setLoading(false);
    }
  }, [username, dateFrom, dateTo, applyFiltersAndClassify, usernameStorageKey, source]);

  // ─── Selection helpers ───────────────────────────────────────────────────

  const toggleGame = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback(
    (group: OpeningGroup) => {
      const groupIds = group.games.map((g) => g.id);
      const allSelected = groupIds.every((id) => selectedIds.has(id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of groupIds) {
          if (allSelected) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    },
    [selectedIds]
  );

  const toggleExpand = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  // ─── Sorted & filtered groups ────────────────────────────────────────────

  const sortedGroups = useMemo(() => {
    let filtered = groups;
    if (searchFilter) {
      const q = searchFilter.toLowerCase();
      filtered = groups.filter(
        (g) =>
          g.name.toLowerCase().includes(q) || g.eco.toLowerCase().includes(q)
      );
    }

    return [...filtered].sort((a, b) => {
      if (sortBy === 'count') return b.games.length - a.games.length;
      if (sortBy === 'name') return a.name.localeCompare(b.name);
      if (sortBy === 'eco') return a.eco.localeCompare(b.eco);
      return 0;
    });
  }, [groups, sortBy, searchFilter]);

  const totalGamesInResults = useMemo(
    () => sortedGroups.reduce((sum, g) => sum + g.games.length, 0),
    [sortedGroups]
  );

  // ─── Select / Deselect All ────────────────────────────────────────────

  const allVisibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of sortedGroups) {
      for (const game of group.games) {
        ids.add(game.id);
      }
    }
    return ids;
  }, [sortedGroups]);

  const allSelected = useMemo(
    () => allVisibleIds.size > 0 && [...allVisibleIds].every((id) => selectedIds.has(id)),
    [allVisibleIds, selectedIds]
  );

  const toggleSelectAll = useCallback(() => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allVisibleIds));
    }
  }, [allSelected, allVisibleIds]);

  // ─── Import selected games ──────────────────────────────────────────────

  const handleImport = useCallback(() => {
    const selectedGames: ClassifiedGame[] = [];
    for (const group of groups) {
      for (const game of group.games) {
        if (selectedIds.has(game.id)) {
          selectedGames.push(game);
        }
      }
    }

    if (selectedGames.length === 0) return;

    const imported: ImportedGame[] = selectedGames.map((g) => ({
      id: generateGameId(),
      pgn: g.raw.pgn,
      white: g.raw.white?.username ?? '?',
      black: g.raw.black?.username ?? '?',
      date: g.raw.end_time
        ? new Date(g.raw.end_time * 1000).toISOString().split('T')[0]
        : undefined,
      result: g.result,
      moves: g.moves,
      mistakes: [],
      analyzed: false,
    }));

    games.addGames(imported);

    // Enable overlay if not already on
    if (!games.showGameOverlay) {
      games.toggleGameOverlay();
    }

    onClose();
  }, [groups, selectedIds, games, onClose]);

  // ─── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-bg-primary">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-bg-surface">
        <button
          onClick={onClose}
          className="btn-icon p-1.5"
          title="Back to repertoire"
        >
          <ArrowLeft className="w-4 h-4" />
        </button>
        <h2 className="font-mono text-sm uppercase tracking-wider text-text-secondary">
          Game Fetcher
        </h2>

        {/* Mode tabs */}
        <div className="flex items-center gap-1 ml-4 bg-bg-panel rounded border border-border-subtle p-0.5">
          <button
            onClick={() => setMode('standard')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-mono transition-all ${
              mode === 'standard'
                ? 'bg-bg-surface text-text-primary border border-border-active'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            <Globe className="w-3 h-3" />
            Standard
          </button>
          <button
            onClick={() => setMode('repertoire')}
            className={`flex items-center gap-1.5 px-3 py-1 rounded text-xs font-mono transition-all ${
              mode === 'repertoire'
                ? 'bg-bg-surface text-accent-teal border border-accent-teal/40'
                : 'text-text-muted hover:text-text-secondary'
            }`}
          >
            <BookOpen className="w-3 h-3" />
            From Repertoire
          </button>
        </div>

        <span className="text-xs text-text-muted ml-1">
          {mode === 'standard'
            ? `Fetch games from ${sourceLabel(source)} and import as overlay`
            : 'Find games that reached a specific line in your repertoire'}
        </span>
      </div>

      {/* Repertoire mode — delegate entirely to dedicated component */}
      {mode === 'repertoire' && (
        <RepertoireGameFetcherTab onClose={onClose} />
      )}

      {/* Content (standard mode only) */}
      {mode === 'standard' && <div className="flex-1 overflow-auto">
        <div className="max-w-[900px] mx-auto p-6">
          {/* ─── Fetch Form ─────────────────────────────────────────── */}
          <div className="panel mb-6">
            <div className="p-4 space-y-4">
              {/* Username + Date + Fetch */}
              <div className="flex gap-3 items-end flex-wrap">
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    Source
                  </label>
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
                <div className="flex flex-col gap-1">
                  <label className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    Username ({sourceLabel(source)})
                  </label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && handleFetch()}
                    placeholder={source === 'lichess' ? 'e.g. DrNykterstein' : 'e.g. hikaru'}
                    className="h-9 px-3 rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-sm outline-none focus:border-accent-teal transition-colors w-[180px]"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <MonthYearInput label="From" value={dateFrom} onChange={setDateFrom} />
                <MonthYearInput label="To" value={dateTo} onChange={setDateTo} />
                <button
                  onClick={handleFetch}
                  disabled={loading}
                  className="btn-primary h-9 px-5 flex items-center gap-2"
                >
                  {loading ? (
                    <Loader className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Search className="w-3.5 h-3.5" />
                  )}
                  <span>{loading ? 'FETCHING...' : 'FETCH GAMES'}</span>
                </button>
              </div>

              {/* Filters */}
              <div className="flex gap-6 flex-wrap">
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    Rated
                  </span>
                  <div className="flex gap-1.5">
                    {(['all', 'rated', 'unrated'] as const).map((v) => (
                      <FilterChip
                        key={v}
                        label={v}
                        value={v}
                        active={filters.rated === v}
                        onClick={(val) =>
                          setFilters((f) => ({ ...f, rated: val }))
                        }
                      />
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    Time Control
                  </span>
                  <div className="flex gap-1.5 flex-wrap">
                    {(
                      [
                        'all',
                        'bullet',
                        'blitz',
                        'rapid',
                        'classical',
                        'daily',
                      ] as const
                    ).map((v) => (
                      <FilterChip
                        key={v}
                        label={v}
                        value={v}
                        active={filters.tc === v}
                        onClick={(val) =>
                          setFilters((f) => ({ ...f, tc: val }))
                        }
                      />
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    Color
                  </span>
                  <div className="flex gap-1.5">
                    {(['all', 'white', 'black'] as const).map((v) => (
                      <FilterChip
                        key={v}
                        label={v}
                        value={v}
                        active={filters.color === v}
                        onClick={(val) =>
                          setFilters((f) => ({ ...f, color: val }))
                        }
                      />
                    ))}
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                    Result
                  </span>
                  <div className="flex gap-1.5">
                    {(['all', 'win', 'loss', 'draw'] as const).map((v) => (
                      <FilterChip
                        key={v}
                        label={v}
                        value={v}
                        active={filters.result === v}
                        onClick={(val) =>
                          setFilters((f) => ({ ...f, result: val }))
                        }
                      />
                    ))}
                  </div>
                </div>
              </div>

              {/* Progress / Error */}
              {loading && progress && (
                <div className="text-xs font-mono text-text-muted">
                  Fetched {progress.fetchedMonths}/{progress.totalMonths}{' '}
                  months... ({progress.gamesFound} games so far)
                </div>
              )}
              {error && (
                <div className="text-xs font-mono text-accent-red">{error}</div>
              )}
            </div>
          </div>

          {/* ─── Results ────────────────────────────────────────────── */}
          {groups.length > 0 && (
            <>
              {/* Toolbar */}
              <div className="flex items-center justify-between mb-3 gap-3">
                <div className="flex items-center gap-3">
                  <input
                    type="text"
                    value={searchFilter}
                    onChange={(e) => setSearchFilter(e.target.value)}
                    placeholder="filter openings..."
                    className="h-8 px-3 rounded border border-border-subtle bg-bg-surface text-text-primary font-mono text-xs outline-none focus:border-accent-teal transition-colors w-[200px]"
                  />
                  <span className="text-xs text-text-muted font-mono">
                    {totalGamesInResults} games · {sortedGroups.length} openings
                    · {selectedIds.size} selected
                  </span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={toggleSelectAll}
                    className={`text-xs font-mono px-3 py-1 rounded border transition-all ${
                      allSelected
                        ? 'border-accent-red/50 text-accent-red hover:bg-accent-red/10'
                        : 'border-accent-teal/50 text-accent-teal hover:bg-accent-teal/10'
                    }`}
                  >
                    {allSelected ? 'Deselect All' : 'Select All'}
                  </button>
                  <span className="text-text-muted">·</span>
                  <span className="text-[10px] font-mono text-text-muted ml-1">
                    sort:
                  </span>
                  {(['count', 'name', 'eco'] as const).map((s) => (
                    <button
                      key={s}
                      onClick={() => setSortBy(s)}
                      className={`text-xs font-mono px-2 py-0.5 rounded border transition-all ${
                        sortBy === s
                          ? 'border-accent-teal text-accent-teal'
                          : 'border-border-subtle text-text-muted hover:text-text-secondary'
                      }`}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>

              {/* Opening Groups */}
              <div className="space-y-2 mb-6">
                {sortedGroups.map((group) => {
                  const key = `${group.eco}|${group.name}`;
                  const isExpanded = expandedGroups.has(key);
                  const groupIds = group.games.map((g) => g.id);
                  const allSelected = groupIds.every((id) =>
                    selectedIds.has(id)
                  );
                  const someSelected =
                    !allSelected &&
                    groupIds.some((id) => selectedIds.has(id));
                  const total = group.games.length;
                  const wPct = total
                    ? ((group.wins / total) * 100).toFixed(0)
                    : '0';
                  const dPct = total
                    ? ((group.draws / total) * 100).toFixed(0)
                    : '0';
                  const lPct = total
                    ? ((group.losses / total) * 100).toFixed(0)
                    : '0';

                  return (
                    <div
                      key={key}
                      className={`border rounded-lg overflow-hidden transition-colors ${
                        isExpanded
                          ? 'border-accent-teal/30'
                          : 'border-border-subtle hover:border-border-active'
                      }`}
                    >
                      {/* Group Header */}
                      <div
                        className="flex items-center gap-3 px-4 py-2.5 bg-bg-surface cursor-pointer select-none hover:bg-bg-hover transition-colors"
                        onClick={() => toggleExpand(key)}
                      >
                        {/* Group checkbox */}
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleGroup(group);
                          }}
                          className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                            allSelected
                              ? 'bg-accent-teal border-accent-teal text-white'
                              : someSelected
                              ? 'border-accent-teal bg-accent-teal/20'
                              : 'border-border-active bg-bg-primary'
                          }`}
                        >
                          {allSelected && <Check className="w-3 h-3" />}
                          {someSelected && !allSelected && (
                            <div className="w-2 h-0.5 bg-accent-teal rounded" />
                          )}
                        </button>

                        {/* ECO badge */}
                        <span
                          className={`font-mono text-[10px] font-medium px-2 py-0.5 rounded tracking-wider min-w-[36px] text-center flex-shrink-0 ${
                            group.eco === '?'
                              ? 'text-text-muted bg-bg-hover'
                              : 'text-accent-teal bg-accent-teal/10'
                          }`}
                        >
                          {group.eco}
                        </span>

                        {/* Name */}
                        <span className="text-sm text-text-primary flex-1 truncate">
                          {group.name}
                        </span>

                        {/* Win bar (mini) */}
                        <div className="flex h-1 w-16 rounded overflow-hidden flex-shrink-0">
                          <div
                            className="bg-text-primary"
                            style={{ width: `${wPct}%` }}
                          />
                          <div
                            className="bg-border-subtle"
                            style={{ width: `${dPct}%` }}
                          />
                          <div
                            className="bg-bg-hover"
                            style={{ width: `${lPct}%` }}
                          />
                        </div>

                        {/* Count */}
                        <span className="font-mono text-xs text-text-secondary min-w-[24px] text-right">
                          {total}
                        </span>

                        {/* Chevron */}
                        {isExpanded ? (
                          <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                        ) : (
                          <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                        )}
                      </div>

                      {/* Expanded game list */}
                      {isExpanded && (
                        <div className="border-t border-border-subtle">
                          {/* Column headers */}
                          <div className="grid grid-cols-[24px_1fr_1fr_72px_80px_80px] gap-2 px-4 py-1.5 bg-bg-panel text-[10px] font-mono text-text-muted uppercase tracking-wider">
                            <span />
                            <span>White</span>
                            <span>Black</span>
                            <span>Result</span>
                            <span>Rating</span>
                            <span>Date</span>
                          </div>

                          {group.games.map((game) => {
                            const isSelected = selectedIds.has(game.id);
                            const date = game.raw.end_time
                              ? new Date(game.raw.end_time * 1000)
                                  .toISOString()
                                  .slice(0, 10)
                              : '';

                            let resultClass = 'text-text-muted';
                            let resultText = '½-½';
                            if (game.result === '1-0') {
                              resultClass = 'text-text-primary';
                              resultText = '1-0';
                            } else if (game.result === '0-1') {
                              resultClass = 'text-text-secondary';
                              resultText = '0-1';
                            }

                            const whiteRating = game.raw.white?.rating ?? '';
                            const blackRating = game.raw.black?.rating ?? '';

                            return (
                              <div
                                key={game.id}
                                className={`grid grid-cols-[24px_1fr_1fr_72px_80px_80px] gap-2 px-4 py-1.5 items-center text-sm cursor-pointer transition-colors ${
                                  isSelected
                                    ? 'bg-accent-teal/5'
                                    : 'hover:bg-bg-hover'
                                }`}
                                onClick={() => toggleGame(game.id)}
                              >
                                {/* Checkbox */}
                                <div
                                  className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
                                    isSelected
                                      ? 'bg-accent-teal border-accent-teal text-white'
                                      : 'border-border-active bg-bg-primary'
                                  }`}
                                >
                                  {isSelected && (
                                    <Check className="w-2.5 h-2.5" />
                                  )}
                                </div>

                                {/* White */}
                                <span className="text-text-primary truncate">
                                  {game.raw.white?.username ?? '?'}
                                </span>

                                {/* Black */}
                                <span className="text-text-secondary truncate">
                                  {game.raw.black?.username ?? '?'}
                                </span>

                                {/* Result */}
                                <span
                                  className={`font-mono text-xs ${resultClass}`}
                                >
                                  {resultText}
                                </span>

                                {/* Ratings */}
                                <span className="font-mono text-[11px] text-text-muted">
                                  {whiteRating}/{blackRating}
                                </span>

                                {/* Date */}
                                <span className="font-mono text-[10px] text-text-muted">
                                  {date}
                                </span>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}

                {sortedGroups.length === 0 && searchFilter && (
                  <div className="text-center py-8 text-text-muted text-sm">
                    No openings match your search.
                  </div>
                )}
              </div>

              {/* Import bar */}
              <div className="sticky bottom-0 bg-bg-primary border-t border-border-subtle py-3 flex items-center justify-between">
                <span className="text-xs font-mono text-text-muted">
                  {selectedIds.size} of {totalGamesInResults} games selected
                </span>
                <div className="flex gap-2">
                  <button onClick={onClose} className="btn-secondary">
                    Cancel
                  </button>
                  <button
                    onClick={handleImport}
                    disabled={selectedIds.size === 0}
                    className={`btn-primary px-5 flex items-center gap-2 ${
                      selectedIds.size === 0 ? 'opacity-40 cursor-not-allowed' : ''
                    }`}
                  >
                    <Check className="w-3.5 h-3.5" />
                    Import Selected ({selectedIds.size})
                  </button>
                </div>
              </div>
            </>
          )}

          {/* Empty state when no results yet */}
          {!loading && groups.length === 0 && !error && (
            <div className="text-center py-16 text-text-muted text-sm">
              Enter a {sourceLabel(source)} username and fetch games to get started.
            </div>
          )}
        </div>
      </div>}
    </div>
  );
};
