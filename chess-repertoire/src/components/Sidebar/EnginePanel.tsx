import React from 'react';
import { EngineLine } from '../../types';
import { formatPVElements } from '../../utils/figurineNotation';

interface EnginePanelProps {
  lines: EngineLine[];
  isThinking: boolean;
  enabled: boolean;
  depth: number;
  multiPV: number;
  threads: number;
  currentFen: string;
  onToggle: () => void;
  onDepthChange: (depth: number) => void;
  onMultiPVChange: (count: number) => void;
  onThreadsChange: (count: number) => void;
}

export const EnginePanel: React.FC<EnginePanelProps> = ({
  lines,
  isThinking,
  enabled,
  depth,
  multiPV,
  threads,
  currentFen,
  onToggle,
  onDepthChange,
  onMultiPVChange,
  onThreadsChange,
}) => {
  // Determine whose turn it is from the FEN
  const isWhiteToMove = currentFen ? currentFen.split(' ')[1] === 'w' : true;
  // Extract move number from FEN
  const fenParts = currentFen ? currentFen.split(' ') : [];
  const fenMoveNumber = fenParts.length >= 6 ? parseInt(fenParts[5], 10) || 1 : 1;

  const formatScore = (line: EngineLine): string => {
    if (line.mate !== null) {
      return `M${line.mate > 0 ? '' : '-'}${Math.abs(line.mate)}`;
    }
    const pawnScore = line.score / 100;
    const sign = line.score > 0 ? '+' : '';
    return `${sign}${pawnScore.toFixed(2)}`;
  };

  const getScoreBadgeClasses = (line: EngineLine): string => {
    if (line.mate !== null) {
      return line.mate > 0
        ? 'bg-accent-green/30 text-accent-green'
        : 'bg-accent-red/30 text-accent-red';
    }
    if (line.score > 30) return 'bg-accent-green/20 text-accent-green';
    if (line.score < -30) return 'bg-accent-red/20 text-accent-red';
    return 'bg-bg-hover text-text-secondary';
  };

  /**
   * Render PV moves with figurine notation and move numbers.
   */
  const renderPV = (line: EngineLine): React.ReactNode => {
    const elements = formatPVElements(line.pv, isWhiteToMove, 14);

    // Adjust move numbers to match actual position
    const adjustedElements = elements.map((el) => {
      if (el.isMoveNumber) {
        const numMatch = el.text.match(/^(\d+)/);
        if (numMatch) {
          const relativeNum = parseInt(numMatch[1], 10);
          const actualNum = fenMoveNumber + relativeNum - 1;
          return { ...el, text: el.text.replace(/^\d+/, String(actualNum)) };
        }
      }
      return el;
    });

    return (
      <span className="leading-relaxed">
        {adjustedElements.map((el, i) => (
          <span
            key={i}
            className={
              el.isMoveNumber
                ? 'text-text-muted mr-0.5'
                : el.isWhiteMove
                  ? 'text-text-primary font-medium mr-1'
                  : 'text-blue-700 mr-1'
            }
          >
            {el.text}
          </span>
        ))}
      </span>
    );
  };

  const ThinkingDots: React.FC = () => (
    <div className="flex gap-1">
      <span className="animate-pulse-subtle">●</span>
      <span className="animate-pulse-subtle" style={{ animationDelay: '0.1s' }}>
        ●
      </span>
      <span className="animate-pulse-subtle" style={{ animationDelay: '0.2s' }}>
        ●
      </span>
    </div>
  );

  return (
    <div className="panel flex flex-col">
      <div className="panel-header flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="flex min-w-0 items-center gap-2">
          <button
            onClick={onToggle}
            className={`w-4 h-4 rounded border transition-colors flex-shrink-0 ${
              enabled
                ? 'bg-accent-teal border-accent-teal'
                : 'bg-bg-hover border-border-subtle'
            }`}
            title={enabled ? 'Disable engine' : 'Enable engine'}
          />
          <span>ENGINE</span>
          {isThinking && <ThinkingDots />}
          {enabled && lines.length > 0 && (
            <span className="text-[10px] text-text-muted font-normal normal-case tracking-normal">
              d{lines[0].depth}
            </span>
          )}
        </div>
        {enabled && (
          <div className="ml-auto flex flex-wrap items-center justify-end gap-x-2 gap-y-1 text-[11px]">
            {/* Depth control */}
            <div className="flex items-center gap-1">
              <span className="text-text-muted">DEPTH</span>
              <button
                onClick={() => onDepthChange(Math.max(1, depth - 2))}
                className="w-4 h-4 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[10px]"
              >−</button>
              <span className="text-text-primary font-semibold w-5 text-center">{depth}</span>
              <button
                onClick={() => onDepthChange(Math.min(30, depth + 2))}
                className="w-4 h-4 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[10px]"
              >+</button>
            </div>
            {/* Lines (MultiPV) control */}
            <div className="flex items-center gap-1">
              <span className="text-text-muted">LINES</span>
              <button
                onClick={() => onMultiPVChange(Math.max(1, multiPV - 1))}
                className="w-4 h-4 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[10px]"
              >−</button>
              <span className="text-text-primary font-semibold w-3 text-center">{multiPV}</span>
              <button
                onClick={() => onMultiPVChange(Math.min(5, multiPV + 1))}
                className="w-4 h-4 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[10px]"
              >+</button>
            </div>
            {/* Threads control */}
            <div className="flex items-center gap-1">
              <span className="text-text-muted">THREADS</span>
              <button
                onClick={() => onThreadsChange(Math.max(1, threads - 1))}
                className="w-4 h-4 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[10px]"
              >−</button>
              <span className="text-text-primary font-semibold w-3 text-center">{threads}</span>
              <button
                onClick={() => onThreadsChange(threads + 1)}
                className="w-4 h-4 flex items-center justify-center rounded bg-bg-hover hover:bg-border-subtle text-text-secondary transition-colors text-[10px]"
              >+</button>
            </div>
          </div>
        )}
      </div>

      <div className="p-3 space-y-2 flex-1 overflow-auto">
        {!enabled ? (
          <div className="text-center text-text-muted py-4">
            Engine disabled
          </div>
        ) : lines.length === 0 && !isThinking ? (
          <div className="text-center text-text-muted py-4">
            No analysis available
          </div>
        ) : (
          lines.map((line, index) => {
            return (
              <div key={index} className="flex gap-2 items-baseline text-xs">
                <span className="text-text-muted flex-shrink-0 w-4">
                  {index + 1}.
                </span>
                <div
                  className={`px-2 py-1 rounded font-semibold flex-shrink-0 ${getScoreBadgeClasses(line)}`}
                >
                  {formatScore(line)}
                </div>
                <div className="flex-1 break-words text-[11px]">
                  {renderPV(line)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};

export default EnginePanel;
