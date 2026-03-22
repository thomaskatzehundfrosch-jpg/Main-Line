import React, { useState, useMemo, useCallback } from 'react';
import { ChevronDown, Filter, Download } from 'lucide-react';
import { useGames } from '../context/GameContext';
import type { MistakeTier, MistakeRecord } from '../types/game';
import { MISTAKE_COLORS } from '../types/game';
import type { TreeNode } from '../types';

interface MistakePanelProps {
  onNavigateToFen: (fen: string) => void;
}

type SortKey = 'moveNumber' | 'evalDrop' | 'reviewed';
type SortDir = 'asc' | 'desc';

const TIER_LABELS: Record<MistakeTier, string> = {
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
};

const TIER_ORDER: Record<MistakeTier, number> = {
  inaccuracy: 0,
  mistake: 1,
  blunder: 2,
};

export const MistakePanel: React.FC<MistakePanelProps> = ({ onNavigateToFen }) => {
  const {
    importedGames,
    allMistakes,
    reviewedCount,
    totalMistakes,
    toggleReviewed,
  } = useGames();

  // Filters
  const [tierFilter, setTierFilter] = useState<Set<MistakeTier>>(
    new Set(['inaccuracy', 'mistake', 'blunder'])
  );
  const [sideFilter, setSideFilter] = useState<'all' | 'white' | 'black'>('all');
  const [gameFilter, setGameFilter] = useState<string>('all');
  const [showFilters, setShowFilters] = useState(false);

  // Sorting
  const [sortKey, setSortKey] = useState<SortKey>('evalDrop');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  const toggleTierFilter = useCallback((tier: MistakeTier) => {
    setTierFilter((prev) => {
      const next = new Set(prev);
      if (next.has(tier)) {
        // Don't allow empty filter
        if (next.size > 1) next.delete(tier);
      } else {
        next.add(tier);
      }
      return next;
    });
  }, []);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir(key === 'evalDrop' ? 'desc' : 'asc');
      }
    },
    [sortKey]
  );

  // Filtered & sorted mistakes
  const filteredMistakes = useMemo(() => {
    let result = allMistakes;

    // Tier filter
    result = result.filter((m) => tierFilter.has(m.tier));

    // Side filter
    if (sideFilter !== 'all') {
      result = result.filter((m) => m.side === sideFilter);
    }

    // Game filter
    if (gameFilter !== 'all') {
      result = result.filter((m) => m.gameId === gameFilter);
    }

    // Sort
    result.sort((a, b) => {
      let cmp = 0;
      switch (sortKey) {
        case 'moveNumber':
          cmp = a.moveNumber - b.moveNumber;
          break;
        case 'evalDrop':
          cmp = a.evalDrop - b.evalDrop;
          break;
        case 'reviewed':
          cmp = (a.reviewed ? 1 : 0) - (b.reviewed ? 1 : 0);
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });

    return result;
  }, [allMistakes, tierFilter, sideFilter, gameFilter, sortKey, sortDir]);

  // Export analysis as JSON
  const handleExport = useCallback(() => {
    const data = {
      exportDate: new Date().toISOString(),
      games: importedGames.filter((g) => g.analyzed),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'game-analysis.json';
    a.click();
    URL.revokeObjectURL(url);
  }, [importedGames]);

  if (totalMistakes === 0) {
    return (
      <div className="text-center text-text-muted text-xs py-6">
        {importedGames.some((g) => g.analyzed)
          ? 'No mistakes found in analyzed games.'
          : 'Analyze some games to see mistakes here.'}
      </div>
    );
  }

  const progressPct = Math.round((reviewedCount / totalMistakes) * 100);

  return (
    <div className="flex flex-col gap-2">
      {/* Progress counter */}
      <div className="flex items-center gap-2">
        <div className="flex-1">
          <div className="flex items-center justify-between text-xs mb-1">
            <span className="text-text-secondary">
              {reviewedCount}/{totalMistakes} mistakes reviewed
            </span>
            <span className="text-text-muted">{progressPct}%</span>
          </div>
          <div className="w-full h-1.5 bg-bg-hover rounded-full overflow-hidden">
            <div
              className="h-full bg-accent-teal rounded-full transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
        <button
          onClick={handleExport}
          className="btn-icon p-1"
          title="Export analysis JSON"
        >
          <Download className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Filter toggle */}
      <button
        onClick={() => setShowFilters((f) => !f)}
        className="flex items-center gap-1 text-xs text-text-secondary hover:text-text-primary transition-colors"
      >
        <Filter className="w-3 h-3" />
        <span>Filters</span>
        <ChevronDown
          className={`w-3 h-3 transition-transform ${showFilters ? 'rotate-180' : ''}`}
        />
      </button>

      {/* Filters */}
      {showFilters && (
        <div className="flex flex-col gap-2 p-2 bg-bg-primary border border-border-subtle rounded-md">
          {/* Tier filter */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted w-10">Tier:</span>
            {(['inaccuracy', 'mistake', 'blunder'] as MistakeTier[]).map((tier) => (
              <button
                key={tier}
                onClick={() => toggleTierFilter(tier)}
                className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                  tierFilter.has(tier)
                    ? 'border-current opacity-100'
                    : 'border-border-subtle opacity-40'
                }`}
                style={{ color: MISTAKE_COLORS[tier] }}
              >
                {TIER_LABELS[tier]}
              </button>
            ))}
          </div>

          {/* Side filter */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted w-10">Side:</span>
            {(['all', 'white', 'black'] as const).map((side) => (
              <button
                key={side}
                onClick={() => setSideFilter(side)}
                className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                  sideFilter === side
                    ? 'border-accent-teal text-accent-teal'
                    : 'border-border-subtle text-text-muted'
                }`}
              >
                {side === 'all' ? 'All' : side === 'white' ? '♔ White' : '♚ Black'}
              </button>
            ))}
          </div>

          {/* Game filter */}
          {importedGames.filter((g) => g.analyzed).length > 1 && (
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] text-text-muted w-10">Game:</span>
              <select
                value={gameFilter}
                onChange={(e) => setGameFilter(e.target.value)}
                className="text-[10px] bg-bg-hover border border-border-subtle rounded px-1.5 py-0.5 text-text-primary focus:outline-none"
              >
                <option value="all">All games</option>
                {importedGames
                  .filter((g) => g.analyzed)
                  .map((g) => (
                    <option key={g.id} value={g.id}>
                      {g.white} vs {g.black}
                    </option>
                  ))}
              </select>
            </div>
          )}

          {/* Sort buttons */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-text-muted w-10">Sort:</span>
            {([
              ['moveNumber', 'Move #'],
              ['evalDrop', 'Severity'],
              ['reviewed', 'Reviewed'],
            ] as [SortKey, string][]).map(([key, label]) => (
              <button
                key={key}
                onClick={() => handleSort(key)}
                className={`text-[10px] px-1.5 py-0.5 rounded border transition-colors ${
                  sortKey === key
                    ? 'border-accent-teal text-accent-teal'
                    : 'border-border-subtle text-text-muted'
                }`}
              >
                {label} {sortKey === key && (sortDir === 'asc' ? '↑' : '↓')}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Mistake List */}
      <div className="flex flex-col gap-0.5 max-h-[350px] overflow-auto">
        {filteredMistakes.map((mistake) => (
          <button
            key={mistake.id}
            onClick={() => onNavigateToFen(mistake.fen)}
            className={`flex items-center gap-2 w-full text-left px-2 py-1.5 rounded-md hover:bg-bg-hover transition-colors group ${
              mistake.reviewed ? 'opacity-40' : ''
            }`}
          >
            {/* Checkbox */}
            <label
              className="flex-shrink-0 cursor-pointer"
              onClick={(e) => e.stopPropagation()}
            >
              <input
                type="checkbox"
                checked={mistake.reviewed}
                onChange={() => toggleReviewed(mistake.id, mistake.gameId)}
                className="w-3.5 h-3.5 rounded border-border-subtle bg-bg-primary accent-accent-teal cursor-pointer"
              />
            </label>

            {/* Move number + side */}
            <span className="text-[10px] text-text-muted flex-shrink-0 w-8">
              {mistake.moveNumber}.{mistake.side === 'black' ? '..' : ''}
            </span>

            {/* Side icon */}
            <span className="text-xs flex-shrink-0 w-4">
              {mistake.side === 'white' ? '♔' : '♚'}
            </span>

            {/* Moves: played → best */}
            <div className="flex-1 min-w-0 text-xs">
              <span className="text-accent-red font-mono">{mistake.movePlayed}</span>
              <span className="text-text-muted mx-1">→</span>
              <span className="text-accent-green font-mono">{mistake.bestMove}</span>
            </div>

            {/* Eval drop */}
            <span className="text-[10px] text-text-muted flex-shrink-0">
              -{mistake.evalDrop.toFixed(1)}
            </span>

            {/* Tier badge */}
            <span
              className="text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 font-medium"
              style={{
                color: MISTAKE_COLORS[mistake.tier],
                backgroundColor: `${MISTAKE_COLORS[mistake.tier]}20`,
              }}
            >
              {mistake.tier === 'inaccuracy'
                ? '?!'
                : mistake.tier === 'mistake'
                ? '?'
                : '??'}
            </span>
          </button>
        ))}
      </div>

      {filteredMistakes.length === 0 && (
        <div className="text-center text-text-muted text-xs py-3">
          No mistakes match the current filters.
        </div>
      )}
    </div>
  );
};
