/**
 * Simplified move tree display for the generator.
 * Shows the generated repertoire as an indented tree with SAN moves.
 */

import React, { useCallback } from 'react';
import { Trash2 } from 'lucide-react';
import type { GeneratorNode } from '../../types/generator';

interface GeneratorMoveTreeProps {
  tree: GeneratorNode | null;
  selectedNode: GeneratorNode | null;
  onSelect: (node: GeneratorNode) => void;
  color: string;
  onClear: () => void;
}

function countNodesRecursive(node: GeneratorNode): number {
  let count = 1;
  for (const child of node.children) {
    count += countNodesRecursive(child);
  }
  return count;
}

/** Render a single tree node and its children recursively. */
const TreeNodeRow: React.FC<{
  node: GeneratorNode;
  selectedNode: GeneratorNode | null;
  onSelect: (node: GeneratorNode) => void;
  depth: number;
  color: string;
}> = ({ node, selectedNode, onSelect, depth, color }) => {
  const isSelected = selectedNode?.id === node.id;
  const isRoot = node.isRoot;

  // Eval display
  let evalStr = '';
  if (node.stockfish && node.stockfish.eval !== null) {
    const ev = node.stockfish.eval;
    evalStr = (ev >= 0 ? '+' : '') + ev.toFixed(1);
  }

  // Lichess games display
  let lichessStr = '';
  if (node.lichess && node.lichess.totalGames > 0) {
    lichessStr = `${node.lichess.totalGames}g`;
  }

  // Move number + SAN
  let moveLabel = '';
  if (isRoot) {
    moveLabel = 'Start';
  } else if (node.san) {
    const isBlackMove = !node.isOurMove
      ? (color === 'white')
      : (color === 'black');
    if (!isBlackMove) {
      moveLabel = `${node.fullMoveNumber}. ${node.san}`;
    } else {
      moveLabel = `${node.fullMoveNumber}... ${node.san}`;
    }
  }

  return (
    <>
      <div
        onClick={() => onSelect(node)}
        className={`flex items-center gap-1.5 px-2 py-0.5 cursor-pointer rounded transition-colors text-[11px] font-mono ${
          isSelected
            ? 'bg-accent-teal/15 text-accent-teal'
            : 'text-text-secondary hover:bg-bg-hover'
        }`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
      >
        {/* Main line / dangerous indicators */}
        {node.isMainLine && (
          <span className="w-1.5 h-1.5 rounded-full bg-accent-teal flex-shrink-0" />
        )}
        {node.isDangerous && (
          <span className="text-[9px] text-accent-red flex-shrink-0">!</span>
        )}
        {node.isSeed && (
          <span className="text-[9px] text-accent-amber flex-shrink-0">S</span>
        )}

        {/* Move label */}
        <span className={`${node.isMainLine ? 'font-semibold' : ''} ${node.isDangerous ? 'text-accent-red' : ''}`}>
          {moveLabel}
        </span>

        {/* Eval */}
        {evalStr && (
          <span className="text-[9px] text-text-muted ml-auto">{evalStr}</span>
        )}

        {/* Lichess games */}
        {lichessStr && (
          <span className="text-[9px] text-text-muted">{lichessStr}</span>
        )}
      </div>

      {/* Children */}
      {node.children.map((child) => (
        <TreeNodeRow
          key={child.id}
          node={child}
          selectedNode={selectedNode}
          onSelect={onSelect}
          depth={depth + 1}
          color={color}
        />
      ))}
    </>
  );
};

export const GeneratorMoveTree: React.FC<GeneratorMoveTreeProps> = ({
  tree,
  selectedNode,
  onSelect,
  color,
  onClear,
}) => {
  const nodeCount = tree ? countNodesRecursive(tree) - 1 : 0; // -1 for root

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-border-subtle">
        <div>
          <h3 className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            Move Tree
          </h3>
          {tree && (
            <span className="text-[10px] text-text-muted">{nodeCount} nodes</span>
          )}
        </div>
        {tree && (
          <button
            onClick={onClear}
            className="btn-icon p-1"
            title="Clear tree"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Tree */}
      <div className="flex-1 overflow-y-auto custom-scrollbar py-1">
        {tree ? (
          <TreeNodeRow
            node={tree}
            selectedNode={selectedNode}
            onSelect={onSelect}
            depth={0}
            color={color}
          />
        ) : (
          <div className="flex items-center justify-center h-full text-text-muted text-xs">
            Generate a repertoire to see the move tree
          </div>
        )}
      </div>
    </div>
  );
};
