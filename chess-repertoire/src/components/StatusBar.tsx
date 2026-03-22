import React from 'react';

interface StatusBarProps {
  openingName: string | null;
  eco: string | null;
  moveNumber: number;
  isWhiteToMove: boolean;
  nodeCount: number;
  gameCount: number;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  openingName,
  eco,
  moveNumber,
  isWhiteToMove,
  nodeCount,
  gameCount,
}) => {
  return (
    <div className="bg-bg-primary border-t border-border-subtle px-4 py-1.5 flex items-center justify-between">
      {/* Left: Opening name + ECO code */}
      <div className="flex items-center gap-2 min-w-0">
        {eco && (
          <span className="font-mono text-xs text-accent-teal font-semibold flex-shrink-0">
            {eco}
          </span>
        )}
        {openingName && (
          <span className="font-mono text-xs text-text-secondary truncate">
            {openingName}
          </span>
        )}
        {!openingName && !eco && (
          <span className="font-mono text-xs text-text-secondary">
            Starting position
          </span>
        )}
      </div>

      {/* Center: Current move info */}
      <div className="font-mono text-xs text-text-secondary flex-shrink-0">
        Move {moveNumber} · {isWhiteToMove ? 'White' : 'Black'} to move
      </div>

      {/* Right: Tree stats */}
      <div className="font-mono text-xs text-text-secondary text-right flex-shrink-0">
        {nodeCount} position{nodeCount !== 1 ? 's' : ''} ·{' '}
        {gameCount} game{gameCount !== 1 ? 's' : ''}
      </div>
    </div>
  );
};
