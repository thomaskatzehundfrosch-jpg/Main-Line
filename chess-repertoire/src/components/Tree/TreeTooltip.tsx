import React from 'react';
import type { TreeNode } from '../../types';
import type { FenMistakeInfo, OverlayMoveInfo } from './OpeningTree';
import { MISTAKE_COLORS } from '../../types/game';
import { useRepertoireEval } from '../../context/RepertoireEvalContext';
import { formatEval } from '../../engine/repertoireAnalyzer';

interface TreeTooltipProps {
  node: TreeNode | null;
  overlayMove?: OverlayMoveInfo;
  x: number;
  y: number;
  visible: boolean;
  mistakeInfo?: FenMistakeInfo;
}

const TIER_LABELS: Record<string, string> = {
  inaccuracy: 'Inaccuracy',
  mistake: 'Mistake',
  blunder: 'Blunder',
};

const TIER_SYMBOLS: Record<string, string> = {
  inaccuracy: '?!',
  mistake: '?',
  blunder: '??',
};

export const TreeTooltip: React.FC<TreeTooltipProps> = ({ node, overlayMove, x, y, visible, mistakeInfo }) => {
  const { getEval, getNodeAnnotation, isAnalyzing } = useRepertoireEval();

  if (!visible || (!node && !overlayMove)) return null;

  // Overlay move tooltip (for imported game divergence nodes)
  if (overlayMove && !node) {
    return (
      <div
        className="fixed z-[100] pointer-events-none animate-fade-in"
        style={{ left: x + 12, top: y - 10 }}
      >
        <div className="bg-bg-surface border border-border-subtle rounded-lg shadow-xl p-3 min-w-[160px] max-w-[220px]">
          <div className="font-mono text-sm font-semibold text-purple-400 mb-1.5">
            ◇ {overlayMove.move}
          </div>
          <div className="text-[10px] text-text-muted mb-1">
            From {overlayMove.gameNames.length} imported game{overlayMove.gameNames.length !== 1 ? 's' : ''}
          </div>
          {overlayMove.gameNames.slice(0, 3).map((name, i) => (
            <div key={i} className="text-[10px] text-text-secondary truncate">{name}</div>
          ))}
          {overlayMove.gameNames.length > 3 && (
            <div className="text-[10px] text-text-muted">
              +{overlayMove.gameNames.length - 3} more...
            </div>
          )}
          <div className="text-[10px] text-accent-teal mt-1.5 font-medium">
            Click to add to repertoire
          </div>
        </div>
      </div>
    );
  }

  if (!node) return null;

  const total = node.gameCount;
  const whiteWinPct = total > 0 ? ((node.whiteWins / total) * 100).toFixed(1) : '0';
  const drawPct = total > 0 ? ((node.draws / total) * 100).toFixed(1) : '0';
  const blackWinPct = total > 0 ? ((node.blackWins / total) * 100).toFixed(1) : '0';

  const barWidth = 120;
  const whitePx = total > 0 ? (node.whiteWins / total) * barWidth : 0;
  const drawPx = total > 0 ? (node.draws / total) * barWidth : 0;

  return (
    <div
      className="fixed z-[100] pointer-events-none animate-fade-in"
      style={{ left: x + 12, top: y - 10 }}
    >
      <div className="bg-bg-surface border border-border-subtle rounded-lg shadow-xl p-3 min-w-[160px] max-w-[260px]">
        {node.move && (
          <div className="font-mono text-sm font-semibold text-accent-teal mb-1.5">
            {node.depth % 2 === 1
              ? `${Math.ceil(node.depth / 2)}. ${node.move}`
              : `${Math.ceil(node.depth / 2)}... ${node.move}`}
          </div>
        )}

        {total > 0 && (
          <>
            <div className="text-xs text-text-muted mb-1">
              {total} game{total !== 1 ? 's' : ''}
            </div>

            {/* Win/Draw/Loss bar */}
            <div
              className="flex rounded-sm overflow-hidden mb-1.5"
              style={{ width: barWidth, height: 6 }}
            >
              <div
                className="bg-white"
                style={{ width: whitePx }}
                title={`White: ${whiteWinPct}%`}
              />
              <div
                className="bg-gray-500"
                style={{ width: drawPx }}
                title={`Draw: ${drawPct}%`}
              />
              <div
                className="bg-gray-900 flex-1"
                title={`Black: ${blackWinPct}%`}
              />
            </div>

            <div className="flex justify-between text-[10px] font-mono text-text-muted">
              <span>{whiteWinPct}%</span>
              <span>{drawPct}%</span>
              <span>{blackWinPct}%</span>
            </div>
          </>
        )}

        {node.children.length > 0 && (
          <div className="text-[10px] text-text-muted mt-1">
            {node.children.length} continuation{node.children.length !== 1 ? 's' : ''}
          </div>
        )}

        {/* Engine evaluation */}
        {(() => {
          const evalResult = getEval(node.fen);
          if (evalResult) {
            // after node.move, who is to move next?
            const whiteToMove = node.depth % 2 === 0; // even depth = white to move
            const label = formatEval(evalResult, whiteToMove);
            const isPositive = !evalResult.isMate
              ? evalResult.score > 30
              : (evalResult.mateIn ?? 0) > 0;
            const isNegative = !evalResult.isMate
              ? evalResult.score < -30
              : (evalResult.mateIn ?? 0) < 0;
            const colorClass = isPositive
              ? 'text-accent-green'
              : isNegative
              ? 'text-accent-red'
              : 'text-text-secondary';
            return (
              <div className={`text-[10px] font-mono font-semibold mt-1 ${colorClass}`}>
                Engine: {label}
                <span className="text-text-muted font-normal ml-1">
                  d{evalResult.depth} · {evalResult.bestMove}
                </span>
              </div>
            );
          }
          if (isAnalyzing) {
            return (
              <div className="text-[10px] text-text-muted mt-1 italic">
                Analysing…
              </div>
            );
          }
          return null;
        })()}

        {/* Repertoire eval-drop annotation */}
        {node.move && (() => {
          const ann = getNodeAnnotation(node.id);
          if (!ann) return null;
          const color = MISTAKE_COLORS[ann.tier];
          const symbol = TIER_SYMBOLS[ann.tier];
          const drop = Math.min(ann.evalDrop, 10).toFixed(2);
          return (
            <div
              className="text-[10px] font-mono font-semibold mt-1 flex items-center gap-1"
              style={{ color }}
            >
              <span>{symbol}</span>
              <span>{TIER_LABELS[ann.tier]}</span>
              <span className="font-normal opacity-75">−{drop} pawns</span>
            </div>
          );
        })()}

        {/* Mistake info section */}
        {mistakeInfo && (
          <div className="mt-2 pt-2 border-t border-border-subtle">
            <div
              className="text-[10px] font-semibold mb-1"
              style={{ color: MISTAKE_COLORS[mistakeInfo.tier] }}
            >
              {mistakeInfo.count} {TIER_LABELS[mistakeInfo.tier]}
              {mistakeInfo.count !== 1 ? 's' : ''} at this position
            </div>
            {mistakeInfo.mistakes.slice(0, 3).map((m, i) => (
              <div key={i} className="text-[10px] mb-0.5">
                <span className="text-text-muted">{m.gameName}:</span>{' '}
                <span style={{ color: MISTAKE_COLORS[m.tier] }}>{m.movePlayed}</span>
                <span className="text-text-muted"> → </span>
                <span className="text-accent-green">{m.bestMove}</span>
                <span className="text-text-muted"> ({m.evalDrop.toFixed(1)})</span>
                {m.reviewed && (
                  <span className="text-text-muted ml-1" title="Reviewed">
                    ✓
                  </span>
                )}
              </div>
            ))}
            {mistakeInfo.mistakes.length > 3 && (
              <div className="text-[10px] text-text-muted">
                +{mistakeInfo.mistakes.length - 3} more...
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
