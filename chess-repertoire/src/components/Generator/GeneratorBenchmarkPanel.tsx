import React, { useMemo, useState } from 'react';
import { AlertTriangle, BarChart3, CheckCircle2, GitCompareArrows } from 'lucide-react';
import type { GeneratorNode } from '../../types/generator';
import evansGambitPgn from '../../benchmarks/evans-gambit.pgn?raw';
import {
  buildBenchmarkMapFromGeneratorTree,
  buildBenchmarkMapFromPgn,
  compareBenchmarkMaps,
  percent,
  type BenchmarkMoveIssue,
} from '../../utils/repertoireBenchmark';

interface GeneratorBenchmarkPanelProps {
  tree: GeneratorNode | null;
}

const humanEvansMap = buildBenchmarkMapFromPgn(evansGambitPgn);

function formatPct(value: number): string {
  return `${value.toFixed(1)}%`;
}

const StatTile: React.FC<{
  label: string;
  value: string;
  tone?: 'good' | 'warn' | 'bad';
}> = ({ label, value, tone = 'good' }) => {
  const toneClass =
    tone === 'good'
      ? 'text-accent-teal'
      : tone === 'warn'
        ? 'text-accent-amber'
        : 'text-accent-red';

  return (
    <div className="rounded-md border border-border-subtle bg-bg-panel px-3 py-2">
      <div className={`font-mono text-base font-semibold ${toneClass}`}>{value}</div>
      <div className="mt-0.5 text-[10px] uppercase tracking-wider text-text-muted">{label}</div>
    </div>
  );
};

const ProgressRow: React.FC<{
  label: string;
  current: number;
  total: number;
}> = ({ label, current, total }) => {
  const pct = percent(current, total);
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-text-secondary">{label}</span>
        <span className="font-mono text-text-muted">
          {current}/{total} · {formatPct(pct)}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full border border-border-subtle bg-bg-primary">
        <div
          className="h-full rounded-full bg-accent-teal transition-all"
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
    </div>
  );
};

const IssueList: React.FC<{
  title: string;
  issues: BenchmarkMoveIssue[];
  type: 'missing' | 'extra' | 'position';
}> = ({ title, issues, type }) => {
  const shown = issues.slice(0, 8);
  const emptyIcon = type === 'extra' ? GitCompareArrows : CheckCircle2;

  return (
    <div className="min-h-0">
      <div className="mb-2 flex items-center justify-between">
        <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-text-muted">
          {issues.length > 0 ? (
            <AlertTriangle className="h-3.5 w-3.5 text-accent-amber" />
          ) : (
            React.createElement(emptyIcon, { className: 'h-3.5 w-3.5 text-accent-teal' })
          )}
          {title}
        </div>
        <span className="font-mono text-[10px] text-text-muted">{issues.length}</span>
      </div>

      {shown.length === 0 ? (
        <div className="rounded-md border border-border-subtle bg-bg-panel px-3 py-2 text-xs text-text-muted">
          No issues in this category.
        </div>
      ) : (
        <div className="max-h-64 space-y-2 overflow-y-auto pr-1 custom-scrollbar">
          {shown.map((issue, index) => (
            <div
              key={`${issue.fen}_${index}_${type}`}
              className="rounded-md border border-border-subtle bg-bg-panel px-3 py-2"
            >
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] text-text-muted">
                  ply {issue.ply} · {issue.sideToMove}
                </span>
                {type === 'missing' && issue.missing && (
                  <span className="font-mono text-[11px] font-semibold text-accent-red">
                    {issue.missing.join(', ')}
                  </span>
                )}
                {type === 'extra' && issue.extra && (
                  <span className="font-mono text-[11px] font-semibold text-accent-amber">
                    {issue.extra.join(', ')}
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-[10px] text-text-muted" title={issue.fen}>
                {issue.fen}
              </div>
              <div className="mt-1 grid grid-cols-2 gap-2 text-[10px]">
                <div>
                  <span className="text-text-muted">Human </span>
                  <span className="font-mono text-text-secondary">{issue.expected.join(', ') || '-'}</span>
                </div>
                <div>
                  <span className="text-text-muted">Generated </span>
                  <span className="font-mono text-text-secondary">{issue.generated.join(', ') || '-'}</span>
                </div>
              </div>
            </div>
          ))}
          {issues.length > shown.length && (
            <div className="text-center text-[10px] text-text-muted">
              {issues.length - shown.length} more
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export const GeneratorBenchmarkPanel: React.FC<GeneratorBenchmarkPanelProps> = ({ tree }) => {
  const [maxPly, setMaxPly] = useState(30);

  const result = useMemo(() => {
    const generatedMap = buildBenchmarkMapFromGeneratorTree(tree);
    return compareBenchmarkMaps(humanEvansMap, generatedMap, maxPly);
  }, [tree, maxPly]);

  const moveCoverage = percent(result.moveMatches, result.expectedMoves);
  const positionCoverage = percent(
    result.human.positions - result.missingPositions.length,
    result.human.positions
  );
  const whiteCoverage = percent(result.whiteMoveMatches, result.whiteExpectedMoves);
  const opponentCoverage = percent(result.blackMoveMatches, result.blackExpectedMoves);
  const scoreTone = moveCoverage >= 80 ? 'good' : moveCoverage >= 50 ? 'warn' : 'bad';

  return (
    <div className="panel overflow-hidden">
      <div className="panel-header flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-3.5 w-3.5 text-accent-teal" />
          <span>Evans Benchmark</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-text-muted">Max ply</span>
          <input
            type="number"
            min={4}
            max={30}
            value={maxPly}
            onChange={(e) => setMaxPly(Math.max(4, Math.min(30, parseInt(e.target.value, 10) || 30)))}
            className="h-7 w-14 rounded border border-border-subtle bg-bg-primary text-center font-mono text-xs text-text-primary outline-none focus:border-accent-teal"
          />
        </div>
      </div>

      <div className="space-y-4 p-3">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <StatTile label="Move Coverage" value={formatPct(moveCoverage)} tone={scoreTone} />
          <StatTile label="Positions Seen" value={formatPct(positionCoverage)} tone={positionCoverage >= 80 ? 'good' : 'warn'} />
          <StatTile label="Our Moves" value={formatPct(whiteCoverage)} tone={whiteCoverage >= 80 ? 'good' : 'warn'} />
          <StatTile label="Replies" value={formatPct(opponentCoverage)} tone={opponentCoverage >= 80 ? 'good' : 'warn'} />
        </div>

        <div className="space-y-2">
          <ProgressRow label="Human move coverage" current={result.moveMatches} total={result.expectedMoves} />
          <ProgressRow label="White repertoire moves" current={result.whiteMoveMatches} total={result.whiteExpectedMoves} />
          <ProgressRow label="Opponent reply coverage" current={result.blackMoveMatches} total={result.blackExpectedMoves} />
        </div>

        <div className="grid gap-3 xl:grid-cols-3">
          <IssueList title="Missing Human Moves" issues={result.missingHumanMoves} type="missing" />
          <IssueList title="Missing Positions" issues={result.missingPositions} type="position" />
          <IssueList title="Extra Generated Moves" issues={result.extraGeneratedMoves} type="extra" />
        </div>
      </div>
    </div>
  );
};

export const GeneratorBenchmarkStrip: React.FC<GeneratorBenchmarkPanelProps> = ({ tree }) => {
  const result = useMemo(() => {
    const generatedMap = buildBenchmarkMapFromGeneratorTree(tree);
    return compareBenchmarkMaps(humanEvansMap, generatedMap, 30);
  }, [tree]);

  const moveCoverage = percent(result.moveMatches, result.expectedMoves);
  const positionCoverage = percent(
    result.human.positions - result.missingPositions.length,
    result.human.positions
  );

  return (
    <div className="border-b border-border-subtle bg-bg-panel px-4 py-2">
      <div className="flex flex-col gap-2 md:flex-row md:items-center md:gap-4">
        <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-text-muted">
          <BarChart3 className="h-3.5 w-3.5 text-accent-teal" />
          Evans
        </div>
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <div className="h-2 min-w-28 flex-1 overflow-hidden rounded-full border border-border-subtle bg-bg-primary">
            <div
              className="h-full rounded-full bg-accent-teal transition-all"
              style={{ width: `${Math.min(100, moveCoverage)}%` }}
            />
          </div>
          <span className="w-20 text-right font-mono text-xs font-semibold text-accent-teal">
            {formatPct(moveCoverage)}
          </span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-[10px] md:w-[360px]">
          <div className="rounded border border-border-subtle bg-bg-surface px-2 py-1">
            <span className="text-text-muted">positions </span>
            <span className="font-mono text-text-secondary">{formatPct(positionCoverage)}</span>
          </div>
          <div className="rounded border border-border-subtle bg-bg-surface px-2 py-1">
            <span className="text-text-muted">missing </span>
            <span className="font-mono text-accent-red">{result.missingHumanMoves.length}</span>
          </div>
          <div className="rounded border border-border-subtle bg-bg-surface px-2 py-1">
            <span className="text-text-muted">extra </span>
            <span className="font-mono text-accent-amber">{result.extraGeneratedMoves.length}</span>
          </div>
        </div>
      </div>
    </div>
  );
};
