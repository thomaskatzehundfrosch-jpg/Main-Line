import React, { useState, useCallback, useMemo, useEffect } from 'react';
import {
  Search, Loader, ChevronDown, ChevronRight, Check, ArrowLeft,
  BookOpen, CornerDownRight, Milestone,
} from 'lucide-react';
import { useGames } from '../../context/GameContext';
import { useRepertoire } from '../../context/RepertoireContext';
import { useAuth } from '../../context/AuthContext';
import { generateGameId } from '../../types/game';
import type { ImportedGame } from '../../types/game';
import type { TreeNode } from '../../types';
import {
  fetchGames,
  parsePgnMoves,
  parsePgnResult,
  type GameSource,
  type RawFetchedGame,
  type FetchProgress,
} from '../../utils/chessComFetcher';
import { classifyTimeControl } from '../../utils/ecoClassifier';
import { MonthYearInput } from './MonthYearInput';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Filters {
  rated: 'all' | 'rated' | 'unrated';
  tc: 'all' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'daily';
  color: 'all' | 'white' | 'black';
  result: 'all' | 'win' | 'loss' | 'draw';
}

interface ClassifiedGame {
  id: string;
  raw: RawFetchedGame;
  moves: string[];
  result: string;
  deviationIndex: number;       // index of first deviation (-1 = followed whole line)
  deviationSan: string | null;  // what they played instead
}

interface DeviationGroup {
  key: string;
  deviationIndex: number;  // -1 = followed all
  deviationMoveLabel: string;   // e.g. "Deviated: 5...d6" or "Followed all 8 moves"
  deviationSan: string | null;
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

// ─── Helpers ─────────────────────────────────────────────────────────────────

function FilterChip<T extends string>({
  label, value, active, onClick,
}: { label: string; value: T; active: boolean; onClick: (v: T) => void }) {
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

/** Format a move index as a move label, e.g. index 4 → "3.Nf6" style prefix */
function formatMoveLabel(index: number, san: string | null): string {
  const moveNum = Math.floor(index / 2) + 1;
  const isWhite = index % 2 === 0;
  const dots = isWhite ? '.' : '...';
  return `${moveNum}${dots}${san ?? '?'}`;
}

/** Returns the move sequence (SAN) from a path of TreeNodes (excluding root). */
function pathToMoves(path: TreeNode[]): string[] {
  return path.filter((n) => n.move !== '').map((n) => n.move);
}

/** Collect all unique children moves at a node */
function getChildMoves(node: TreeNode): string[] {
  return node.children
    .filter((c) => !(c as any)._isOverlay)
    .map((c) => c.move);
}

// ─── Repertoire Path Picker ───────────────────────────────────────────────────

interface PathPickerProps {
  tree: TreeNode;
  selectedPath: TreeNode[];   // path from root (inclusive) to selected node
  onSelectPath: (path: TreeNode[]) => void;
  onUseCurrentPosition: () => void;
}

const RepertoirePathPicker: React.FC<PathPickerProps> = ({
  tree, selectedPath, onSelectPath, onUseCurrentPosition,
}) => {
  const currentNode = selectedPath[selectedPath.length - 1] ?? tree;
  const moves = pathToMoves(selectedPath);
  const childMoves = getChildMoves(currentNode);

  const goBack = () => {
    if (selectedPath.length <= 1) return;
    onSelectPath(selectedPath.slice(0, -1));
  };

  const goToRoot = () => onSelectPath([tree]);

  const selectChild = (childMove: string) => {
    const child = currentNode.children.find(
      (c) => c.move === childMove && !(c as any)._isOverlay
    );
    if (child) onSelectPath([...selectedPath, child]);
  };

  return (
    <div className="space-y-3">
      {/* Move breadcrumb */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
            Selected line
          </span>
          <button
            onClick={onUseCurrentPosition}
            className="text-[10px] font-mono px-2 py-0.5 rounded border border-accent-teal/40 text-accent-teal hover:bg-accent-teal/10 transition-colors"
            title="Jump to whatever position the main board is currently at"
          >
            Use current board position
          </button>
          {moves.length > 0 && (
            <button
              onClick={goToRoot}
              className="text-[10px] font-mono px-2 py-0.5 rounded border border-border-subtle text-text-muted hover:text-text-secondary transition-colors"
            >
              Reset to start
            </button>
          )}
        </div>

        {/* Move sequence display */}
        <div className="flex items-start gap-1 flex-wrap min-h-[32px] p-2 bg-bg-panel rounded border border-border-subtle">
          {moves.length === 0 ? (
            <span className="text-xs text-text-muted font-mono italic">
              Starting position — pick moves below to navigate your repertoire
            </span>
          ) : (
            <>
              {moves.map((m, i) => {
                const isWhiteMove = i % 2 === 0;
                const moveNum = Math.floor(i / 2) + 1;
                return (
                  <React.Fragment key={i}>
                    {isWhiteMove && (
                      <span className="text-[11px] font-mono text-text-muted">{moveNum}.</span>
                    )}
                    {/* Clickable: navigate back to this depth */}
                    <button
                      onClick={() => onSelectPath(selectedPath.slice(0, i + 2))}
                      className="text-[11px] font-mono text-text-primary hover:text-accent-teal transition-colors px-0.5"
                    >
                      {m}
                    </button>
                  </React.Fragment>
                );
              })}
            </>
          )}
        </div>
      </div>

      {/* Navigation: back + child moves */}
      <div className="flex items-center gap-2 flex-wrap">
        {selectedPath.length > 1 && (
          <button
            onClick={goBack}
            className="flex items-center gap-1 px-2 py-1 rounded border border-border-subtle text-xs font-mono text-text-muted hover:text-text-secondary hover:border-border-active transition-colors"
          >
            <ArrowLeft className="w-3 h-3" />
            Back
          </button>
        )}

        {childMoves.length === 0 ? (
          <span className="text-xs text-text-muted font-mono italic">
            {moves.length === 0 ? 'No moves in repertoire yet' : 'End of repertoire line'}
          </span>
        ) : (
          <>
            <span className="text-[10px] font-mono text-text-muted">next moves:</span>
            {childMoves.map((m) => (
              <button
                key={m}
                onClick={() => selectChild(m)}
                className="px-2.5 py-1 rounded border border-border-subtle text-xs font-mono text-text-secondary hover:border-accent-teal hover:text-accent-teal bg-bg-surface hover:bg-accent-teal/5 transition-all"
              >
                {m}
              </button>
            ))}
          </>
        )}
      </div>

      {moves.length > 0 && (
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-1.5 text-xs text-accent-teal/80 font-mono">
            <Milestone className="w-3 h-3" />
            <span>
              Will fetch games that play your first {moves.length} move{moves.length !== 1 ? 's' : ''} — grouped by where the opponent deviates
            </span>
          </div>
        </div>
      )}
    </div>
  );
};

// ─── Main Component ───────────────────────────────────────────────────────────

interface RepertoireGameFetcherTabProps {
  onClose: () => void;
}

export const RepertoireGameFetcherTab: React.FC<RepertoireGameFetcherTabProps> = ({ onClose }) => {
  const games = useGames();
  const { user } = useAuth();
  const { state: repertoire } = useRepertoire();
  const [source, setSource] = useState<GameSource>('chesscom');

  const usernameStorageKey = user
    ? `gamefetcher_username_${source}_${user.id}`
    : `gamefetcher_username_${source}`;

  // ─── Form state ───────────────────────────────────────────────────────────
  const [username, setUsername] = useState('');

  useEffect(() => {
    const saved = localStorage.getItem(usernameStorageKey);
    setUsername(saved ?? '');
  }, [usernameStorageKey]);

  const [dateFrom, setDateFrom] = useState(() => {
    const now = new Date();
    // Default to a wider range (6 months back) since rare openings need more games
    const from = new Date(now.getFullYear(), now.getMonth() - 5, 1);
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

  // ─── Repertoire path state ────────────────────────────────────────────────
  // selectedPath is root → … → selected node (root always included)
  const [selectedPath, setSelectedPath] = useState<TreeNode[]>([repertoire.tree]);

  // Keep root in sync if tree changes (e.g. file switch)
  useEffect(() => {
    setSelectedPath([repertoire.tree]);
  }, [repertoire.tree]);

  const handleUseCurrentPosition = useCallback(() => {
    setSelectedPath([...repertoire.currentPath]);
  }, [repertoire.currentPath]);

  const selectedMoves = useMemo(() => pathToMoves(selectedPath), [selectedPath]);

  // ─── Min-depth filter ─────────────────────────────────────────────────────
  // Only include games that followed at least this many moves of the selected line.
  // Default to the full line length so results are focused on the chosen opening.
  const [minDepth, setMinDepth] = useState(0);

  // When the selected line changes, default minDepth to the full line length
  useEffect(() => {
    setMinDepth(selectedMoves.length > 0 ? selectedMoves.length : 0);
  }, [selectedMoves.length]);

  // ─── Fetch state ──────────────────────────────────────────────────────────
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<FetchProgress | null>(null);

  // ─── Results state ────────────────────────────────────────────────────────
  const [groups, setGroups] = useState<DeviationGroup[]>([]);
  const [totalFetched, setTotalFetched] = useState(0);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set());
  const [sortBy, setSortBy] = useState<'count' | 'depth'>('depth');
  const [searchFilter, setSearchFilter] = useState('');

  // ─── Classify & group by deviation ───────────────────────────────────────

  const applyFiltersAndClassify = useCallback(
    (rawGames: RawFetchedGame[], uname: string): DeviationGroup[] => {
      if (selectedMoves.length === 0) return [];

      const filtered = rawGames.filter((g) => {
        if (filters.rated === 'rated' && !g.rated) return false;
        if (filters.rated === 'unrated' && g.rated) return false;
        if (filters.tc !== 'all') {
          const tc = classifyTimeControl(g.time_control);
          if (tc !== filters.tc) return false;
        }
        if (filters.color !== 'all') {
          const playerIsWhite = g.white?.username?.toLowerCase() === uname.toLowerCase();
          if (filters.color === 'white' && !playerIsWhite) return false;
          if (filters.color === 'black' && playerIsWhite) return false;
        }
        if (filters.result !== 'all') {
          const playerIsWhite = g.white?.username?.toLowerCase() === uname.toLowerCase();
          const playerResult = playerIsWhite ? g.white?.result : g.black?.result;
          const isWin = playerResult === 'win';
          const isDraw = ['agreed', 'stalemate', 'repetition', 'insufficient', 'timevsinsufficient', '50move'].includes(playerResult ?? '');
          if (filters.result === 'win' && !isWin) return false;
          if (filters.result === 'loss' && (isWin || isDraw)) return false;
          if (filters.result === 'draw' && !isDraw) return false;
        }
        return true;
      });

      // Find deviation point for each game
      const classified: ClassifiedGame[] = [];
      let gameIndex = 0;

      for (const g of filtered) {
        if (!g.pgn) continue;
        const gameMoves = parsePgnMoves(g.pgn);
        const result = parsePgnResult(g.pgn);

        // Check how far this game follows the selected repertoire line
        let deviationIndex = -1; // -1 = followed all
        for (let i = 0; i < selectedMoves.length; i++) {
          if (gameMoves[i] !== selectedMoves[i]) {
            deviationIndex = i;
            break;
          }
        }

        // Only include games that followed at least `minDepth` moves of the line.
        // deviationIndex === -1 means the full line was followed (always include).
        const followedMoves = deviationIndex === -1 ? selectedMoves.length : deviationIndex;
        if (followedMoves < minDepth) continue;

        classified.push({
          id: `rep_${gameIndex++}_${g.end_time}`,
          raw: g,
          moves: gameMoves,
          result,
          deviationIndex,
          deviationSan: deviationIndex === -1 ? null : (gameMoves[deviationIndex] ?? null),
        });
      }

      // Group by deviation
      const map = new Map<string, DeviationGroup>();

      for (const game of classified) {
        const key =
          game.deviationIndex === -1
            ? '__followed_all__'
            : `dev_${game.deviationIndex}_${game.deviationSan ?? 'unknown'}`;

        if (!map.has(key)) {
          let label: string;
          if (game.deviationIndex === -1) {
            label = `Followed all ${selectedMoves.length} move${selectedMoves.length !== 1 ? 's' : ''}`;
          } else {
            const expected = selectedMoves[game.deviationIndex];
            const played = game.deviationSan ?? '?';
            label = `${formatMoveLabel(game.deviationIndex, played)} (expected ${expected})`;
          }

          map.set(key, {
            key,
            deviationIndex: game.deviationIndex,
            deviationMoveLabel: label,
            deviationSan: game.deviationSan,
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
    [filters, selectedMoves, minDepth]
  );

  // ─── Fetch ────────────────────────────────────────────────────────────────

  const handleFetch = useCallback(async () => {
    const uname = username.trim();
    if (!uname) { setError(`Enter a ${sourceLabel(source)} username.`); return; }
    if (!dateFrom || !dateTo) { setError('Select a date range.'); return; }
    if (dateFrom > dateTo) { setError('From date must be before To date.'); return; }
    if (selectedMoves.length === 0) {
      setError('Select at least one move from your repertoire first.');
      return;
    }

    localStorage.setItem(usernameStorageKey, uname);
    setLoading(true);
    setError(null);
    setProgress(null);
    setGroups([]);
    setSelectedIds(new Set());

    try {
      const rawGames = await fetchGames(source, uname, dateFrom, dateTo, (p) => setProgress(p));

      if (rawGames.length === 0) {
        setError('No games found for this user in the selected period.');
        setLoading(false);
        return;
      }

      const grouped = applyFiltersAndClassify(rawGames, uname);
      setGroups(grouped);
      setTotalFetched(rawGames.length);

      if (grouped.length === 0) {
        setError(
          `Fetched ${rawGames.length} games but none matched your selected line. Try a wider date range or a shorter line.`
        );
      }

      // Start deselected so larger imports stay intentional.
      setSelectedIds(new Set());
    } catch (err: any) {
      setError(err.message || 'Failed to fetch games.');
    } finally {
      setLoading(false);
    }
  }, [username, dateFrom, dateTo, applyFiltersAndClassify, selectedMoves, usernameStorageKey, source]);

  // ─── Selection helpers ────────────────────────────────────────────────────

  const toggleGame = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback(
    (group: DeviationGroup) => {
      const ids = group.games.map((g) => g.id);
      const allSelected = ids.every((id) => selectedIds.has(id));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const id of ids) allSelected ? next.delete(id) : next.add(id);
        return next;
      });
    },
    [selectedIds]
  );

  const toggleExpand = useCallback((key: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }, []);

  // ─── Sorted & filtered groups ─────────────────────────────────────────────

  const sortedGroups = useMemo(() => {
    let list = groups;
    if (searchFilter) {
      const q = searchFilter.toLowerCase();
      list = groups.filter((g) => g.deviationMoveLabel.toLowerCase().includes(q));
    }
    return [...list].sort((a, b) => {
      if (sortBy === 'count') return b.games.length - a.games.length;
      // Sort by deviation depth ascending (-1 = deepest, put last)
      const aD = a.deviationIndex === -1 ? Infinity : a.deviationIndex;
      const bD = b.deviationIndex === -1 ? Infinity : b.deviationIndex;
      return aD - bD;
    });
  }, [groups, sortBy, searchFilter]);

  const totalGamesInResults = useMemo(
    () => sortedGroups.reduce((sum, g) => sum + g.games.length, 0),
    [sortedGroups]
  );

  const visibleGamesByNewest = useMemo(
    () =>
      sortedGroups
        .flatMap((group) => group.games)
        .sort((a, b) => (b.raw.end_time ?? 0) - (a.raw.end_time ?? 0)),
    [sortedGroups]
  );

  const allVisibleIds = useMemo(() => {
    const ids = new Set<string>();
    for (const group of sortedGroups) for (const game of group.games) ids.add(game.id);
    return ids;
  }, [sortedGroups]);

  const allSelected = useMemo(
    () => allVisibleIds.size > 0 && [...allVisibleIds].every((id) => selectedIds.has(id)),
    [allVisibleIds, selectedIds]
  );

  const toggleSelectAll = useCallback(() => {
    setSelectedIds(allSelected ? new Set() : new Set(allVisibleIds));
  }, [allSelected, allVisibleIds]);

  const selectNewest = useCallback(
    (count: number) => {
      setSelectedIds(
        new Set(visibleGamesByNewest.slice(0, count).map((game) => game.id))
      );
    },
    [visibleGamesByNewest]
  );

  // ─── Import ───────────────────────────────────────────────────────────────

  const handleImport = useCallback(() => {
    const toImport: ClassifiedGame[] = [];
    for (const group of groups) {
      for (const game of group.games) {
        if (selectedIds.has(game.id)) toImport.push(game);
      }
    }
    if (toImport.length === 0) return;

    const imported: ImportedGame[] = toImport.map((g) => ({
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
    if (!games.showGameOverlay) games.toggleGameOverlay();
    onClose();
  }, [groups, selectedIds, games, onClose]);

  // ─── Render ───────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 flex flex-col min-h-0 overflow-auto">
      <div className="max-w-[900px] mx-auto p-6 w-full space-y-6">

        {/* ─── Repertoire Path Picker ──────────────────────────────────── */}
        <div className="panel">
          <div className="p-4 space-y-3">
            <div className="flex items-center gap-2 mb-1">
              <BookOpen className="w-3.5 h-3.5 text-accent-teal" />
              <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
                Opening Line
              </span>
            </div>
            <RepertoirePathPicker
              tree={repertoire.tree}
              selectedPath={selectedPath}
              onSelectPath={setSelectedPath}
              onUseCurrentPosition={handleUseCurrentPosition}
            />
          </div>
        </div>

        {/* ─── Fetch Form ──────────────────────────────────────────────── */}
        <div className="panel">
          <div className="p-4 space-y-4">
            {/* Username + date range */}
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
                disabled={loading || selectedMoves.length === 0}
                className={`btn-primary h-9 px-5 flex items-center gap-2 ${
                  selectedMoves.length === 0 ? 'opacity-40 cursor-not-allowed' : ''
                }`}
              >
                {loading ? (
                  <Loader className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Search className="w-3.5 h-3.5" />
                )}
                <span>{loading ? 'FETCHING...' : 'FETCH GAMES'}</span>
              </button>
            </div>

            {/* Min depth filter */}
            {selectedMoves.length > 1 && (
              <div className="flex items-center gap-3 py-2 border-t border-border-subtle">
                <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider whitespace-nowrap">
                  Min. moves matched
                </span>
                <input
                  type="range"
                  min={1}
                  max={selectedMoves.length}
                  value={minDepth}
                  onChange={(e) => setMinDepth(Number(e.target.value))}
                  className="w-32 accent-teal-400"
                />
                <span className="font-mono text-sm text-accent-teal min-w-[20px]">{minDepth}</span>
                <span className="text-[11px] font-mono text-text-muted">
                  {minDepth === selectedMoves.length
                    ? '— only games that played your full line'
                    : minDepth === 1
                    ? '— all games (even 1-move deviations)'
                    : `— games that followed ≥ ${minDepth} of your ${selectedMoves.length} moves`}
                </span>
              </div>
            )}

            {/* Filters */}
            <div className="flex gap-6 flex-wrap">
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Rated</span>
                <div className="flex gap-1.5">
                  {(['all', 'rated', 'unrated'] as const).map((v) => (
                    <FilterChip key={v} label={v} value={v} active={filters.rated === v}
                      onClick={(val) => setFilters((f) => ({ ...f, rated: val }))} />
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Time Control</span>
                <div className="flex gap-1.5 flex-wrap">
                  {(['all', 'bullet', 'blitz', 'rapid', 'classical', 'daily'] as const).map((v) => (
                    <FilterChip key={v} label={v} value={v} active={filters.tc === v}
                      onClick={(val) => setFilters((f) => ({ ...f, tc: val }))} />
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Color</span>
                <div className="flex gap-1.5">
                  {(['all', 'white', 'black'] as const).map((v) => (
                    <FilterChip key={v} label={v} value={v} active={filters.color === v}
                      onClick={(val) => setFilters((f) => ({ ...f, color: val }))} />
                  ))}
                </div>
              </div>
              <div className="flex flex-col gap-1.5">
                <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">Result</span>
                <div className="flex gap-1.5">
                  {(['all', 'win', 'loss', 'draw'] as const).map((v) => (
                    <FilterChip key={v} label={v} value={v} active={filters.result === v}
                      onClick={(val) => setFilters((f) => ({ ...f, result: val }))} />
                  ))}
                </div>
              </div>
            </div>

            {/* Progress / Error */}
            {loading && progress && (
              <div className="text-xs font-mono text-text-muted">
                Fetched {progress.fetchedMonths}/{progress.totalMonths} months... ({progress.gamesFound} games so far)
              </div>
            )}
            {error && (
              <div className="text-xs font-mono text-accent-red">{error}</div>
            )}
          </div>
        </div>

        {/* ─── Results ──────────────────────────────────────────────────── */}
        {groups.length > 0 && (
          <>
            {/* Stats bar */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <input
                  type="text"
                  value={searchFilter}
                  onChange={(e) => setSearchFilter(e.target.value)}
                  placeholder="filter deviations..."
                  className="h-8 px-3 rounded border border-border-subtle bg-bg-surface text-text-primary font-mono text-xs outline-none focus:border-accent-teal transition-colors w-[200px]"
                />
                <span className="text-xs text-text-muted font-mono">
                  {totalGamesInResults} matching · {sortedGroups.length} deviation{sortedGroups.length !== 1 ? 's' : ''} · {selectedIds.size} selected
                </span>
                {selectedIds.size > 30 && (
                  <span className="text-xs font-mono text-amber-400">
                    Warning: more than 30 selected may get slow
                  </span>
                )}
                {totalFetched > 0 && (
                  <span className="text-xs text-text-muted font-mono opacity-60">
                    ({totalFetched} total fetched)
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => selectNewest(10)}
                  disabled={visibleGamesByNewest.length === 0}
                  className="text-xs font-mono px-3 py-1 rounded border border-border-subtle text-text-secondary hover:border-accent-teal hover:text-accent-teal disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  Newest 10
                </button>
                <button
                  onClick={() => selectNewest(20)}
                  disabled={visibleGamesByNewest.length === 0}
                  className="text-xs font-mono px-3 py-1 rounded border border-border-subtle text-text-secondary hover:border-accent-teal hover:text-accent-teal disabled:opacity-40 disabled:cursor-not-allowed transition-all"
                >
                  Newest 20
                </button>
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
                <span className="text-[10px] font-mono text-text-muted ml-1">sort:</span>
                {(['depth', 'count'] as const).map((s) => (
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

            {/* Deviation Groups */}
            <div className="space-y-2">
              {sortedGroups.map((group) => {
                const isExpanded = expandedGroups.has(group.key);
                const groupIds = group.games.map((g) => g.id);
                const allGroupSelected = groupIds.every((id) => selectedIds.has(id));
                const someGroupSelected = !allGroupSelected && groupIds.some((id) => selectedIds.has(id));
                const total = group.games.length;
                const wPct = total ? ((group.wins / total) * 100).toFixed(0) : '0';
                const dPct = total ? ((group.draws / total) * 100).toFixed(0) : '0';
                const lPct = total ? ((group.losses / total) * 100).toFixed(0) : '0';
                const isFollowed = group.deviationIndex === -1;

                return (
                  <div
                    key={group.key}
                    className={`border rounded-lg overflow-hidden transition-colors ${
                      isExpanded ? 'border-accent-teal/30' : 'border-border-subtle hover:border-border-active'
                    }`}
                  >
                    {/* Group header */}
                    <div
                      className="flex items-center gap-3 px-4 py-2.5 bg-bg-surface cursor-pointer select-none hover:bg-bg-hover transition-colors"
                      onClick={() => toggleExpand(group.key)}
                    >
                      {/* Checkbox */}
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleGroup(group); }}
                        className={`w-4 h-4 rounded border flex items-center justify-center flex-shrink-0 transition-colors ${
                          allGroupSelected
                            ? 'bg-accent-teal border-accent-teal text-white'
                            : someGroupSelected
                            ? 'border-accent-teal bg-accent-teal/20'
                            : 'border-border-active bg-bg-primary'
                        }`}
                      >
                        {allGroupSelected && <Check className="w-3 h-3" />}
                        {someGroupSelected && !allGroupSelected && (
                          <div className="w-2 h-0.5 bg-accent-teal rounded" />
                        )}
                      </button>

                      {/* Deviation icon */}
                      <span
                        className={`flex-shrink-0 ${isFollowed ? 'text-accent-teal' : 'text-text-muted'}`}
                        title={isFollowed ? 'Followed your whole line' : 'Deviated from your line'}
                      >
                        {isFollowed
                          ? <Check className="w-3.5 h-3.5" />
                          : <CornerDownRight className="w-3.5 h-3.5" />
                        }
                      </span>

                      {/* Label */}
                      <span className={`text-sm flex-1 truncate ${
                        isFollowed ? 'text-accent-teal font-medium' : 'text-text-primary'
                      }`}>
                        {group.deviationMoveLabel}
                      </span>

                      {/* Win bar */}
                      <div className="flex h-1 w-16 rounded overflow-hidden flex-shrink-0">
                        <div className="bg-text-primary" style={{ width: `${wPct}%` }} />
                        <div className="bg-border-subtle" style={{ width: `${dPct}%` }} />
                        <div className="bg-bg-hover" style={{ width: `${lPct}%` }} />
                      </div>

                      {/* Count */}
                      <span className="font-mono text-xs text-text-secondary min-w-[24px] text-right">
                        {total}
                      </span>

                      {isExpanded
                        ? <ChevronDown className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                        : <ChevronRight className="w-3.5 h-3.5 text-text-muted flex-shrink-0" />
                      }
                    </div>

                    {/* Expanded game list */}
                    {isExpanded && (
                      <div className="border-t border-border-subtle">
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
                            ? new Date(game.raw.end_time * 1000).toISOString().slice(0, 10)
                            : '';
                          let resultClass = 'text-text-muted';
                          let resultText = '½-½';
                          if (game.result === '1-0') { resultClass = 'text-text-primary'; resultText = '1-0'; }
                          else if (game.result === '0-1') { resultClass = 'text-text-secondary'; resultText = '0-1'; }

                          return (
                            <div
                              key={game.id}
                              className={`grid grid-cols-[24px_1fr_1fr_72px_80px_80px] gap-2 px-4 py-1.5 items-center text-sm cursor-pointer transition-colors ${
                                isSelected ? 'bg-accent-teal/5' : 'hover:bg-bg-hover'
                              }`}
                              onClick={() => toggleGame(game.id)}
                            >
                              <div className={`w-3.5 h-3.5 rounded border flex items-center justify-center transition-colors ${
                                isSelected ? 'bg-accent-teal border-accent-teal text-white' : 'border-border-active bg-bg-primary'
                              }`}>
                                {isSelected && <Check className="w-2.5 h-2.5" />}
                              </div>
                              <span className="text-text-primary truncate">{game.raw.white?.username ?? '?'}</span>
                              <span className="text-text-secondary truncate">{game.raw.black?.username ?? '?'}</span>
                              <span className={`font-mono text-xs ${resultClass}`}>{resultText}</span>
                              <span className="font-mono text-[11px] text-text-muted">
                                {game.raw.white?.rating ?? ''}/{game.raw.black?.rating ?? ''}
                              </span>
                              <span className="font-mono text-[10px] text-text-muted">{date}</span>
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
                  No deviations match your search.
                </div>
              )}
            </div>

            {/* Import bar */}
            <div className="sticky bottom-0 bg-bg-primary border-t border-border-subtle py-3 flex items-center justify-between">
              <div className="flex flex-col gap-1">
                <span className="text-xs font-mono text-text-muted">
                  {selectedIds.size} of {totalGamesInResults} games selected
                </span>
                {selectedIds.size > 30 && (
                  <span className="text-[10px] font-mono text-amber-400">
                    Large imports above 30 games can become heavy.
                  </span>
                )}
              </div>
              <div className="flex gap-2">
                <button onClick={onClose} className="btn-secondary">Cancel</button>
                <button
                  onClick={handleImport}
                  disabled={selectedIds.size === 0}
                  className={`btn-primary px-5 flex items-center gap-2 ${selectedIds.size === 0 ? 'opacity-40 cursor-not-allowed' : ''}`}
                >
                  <Check className="w-3.5 h-3.5" />
                  Import Selected ({selectedIds.size})
                </button>
              </div>
            </div>
          </>
        )}

        {/* Empty state */}
        {!loading && groups.length === 0 && !error && (
          <div className="text-center py-16 text-text-muted text-sm">
            {selectedMoves.length === 0
              ? 'Navigate your repertoire above to select an opening line, then fetch games.'
              : `Line set to ${selectedMoves.join(' ')} — enter a ${sourceLabel(source)} username and fetch.`
            }
          </div>
        )}
      </div>
    </div>
  );
};
