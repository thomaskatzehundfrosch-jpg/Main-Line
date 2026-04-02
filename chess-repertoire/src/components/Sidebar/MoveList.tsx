import React, { useMemo } from 'react';
import { Chess } from 'chess.js';
import { TreeNode } from '../../types';
import { NAG_SYMBOLS } from '../../types';
import type { ImportedGame } from '../../types/game';
import { toFigurine } from '../../utils/figurineNotation';
import { useRepertoireEval } from '../../context/RepertoireEvalContext';
import { formatEval } from '../../engine/repertoireAnalyzer';
import type { RepertoireEval } from '../../types';
import { MISTAKE_COLORS } from '../../types/game';

interface MoveListProps {
  currentPath: TreeNode[];
  currentNode: TreeNode;
  onNavigateToNode: (node: TreeNode) => void;
  /** Imported games for showing divergence moves */
  importedGames?: ImportedGame[];
  /** Whether the game overlay is active */
  showGameOverlay?: boolean;
  /** Add a game move to the repertoire tree */
  onAddMove?: (parentId: string, move: string, fen: string) => void;
  hideHeader?: boolean;
}

/** Return a Tailwind text-color class based on centipawn score (White's perspective). */
function evalColorClass(evalResult: RepertoireEval): string {
  if (evalResult.isMate) {
    return evalResult.mateIn !== null && evalResult.mateIn > 0
      ? 'text-accent-green'
      : 'text-accent-red';
  }
  const pawns = evalResult.score / 100;
  if (pawns >= 1.5) return 'text-accent-green';
  if (pawns >= 0.3) return 'text-blue-400';
  if (pawns > -0.3) return 'text-text-muted';
  if (pawns > -1.5) return 'text-accent-amber';
  return 'text-accent-red';
}

export const MoveList: React.FC<MoveListProps> = ({
  currentPath,
  currentNode,
  onNavigateToNode,
  importedGames = [],
  showGameOverlay = false,
  onAddMove,
  hideHeader = false,
}) => {
  const { getEval, getNodeAnnotation, isAnalyzing } = useRepertoireEval();

  const ANNOTATION_SYMBOL: Record<string, string> = {
    inaccuracy: '?!',
    mistake: '?',
    blunder: '??',
  };

  const renderMoveNumber = (depth: number): string => {
    // depth 1 is white's first move (move 1), depth 2 is black's first move (still move 1), etc.
    const moveNumber = Math.floor(depth / 2) + 1;
    return `${moveNumber}. `;
  };

  const hasVariations = (node: TreeNode): boolean => {
    if (currentPath.length === 0) return false;
    const nodeIndex = currentPath.indexOf(node);
    if (nodeIndex === -1 || nodeIndex === currentPath.length - 1) return false;

    const nextNodeInPath = currentPath[nodeIndex + 1];
    return node.children.length > 1 ||
           (node.children.length > 0 && node.children[0].id !== nextNodeInPath.id);
  };

  const getVariations = (node: TreeNode): TreeNode[] => {
    if (currentPath.length === 0) return [];
    const nodeIndex = currentPath.indexOf(node);
    if (nodeIndex === -1 || nodeIndex === currentPath.length - 1) return [];

    const nextNodeInPath = currentPath[nodeIndex + 1];
    return node.children.filter(child => child.id !== nextNodeInPath.id);
  };

  // Compute game moves at each FEN position for showing divergences
  const gameMovesByFen = useMemo(() => {
    if (!showGameOverlay || importedGames.length === 0) {
      return new Map<string, { move: string; fen: string; count: number; continuation: string[] }[]>();
    }
    const result = new Map<string, { move: string; fen: string; count: number; continuation: string[] }[]>();
    for (const game of importedGames) {
      const chess = new Chess();
      for (let mi = 0; mi < game.moves.length; mi++) {
        const san = game.moves[mi];
        const fenBefore = chess.fen();
        try {
          chess.move(san);
        } catch {
          break;
        }
        const fenAfter = chess.fen();
        if (!result.has(fenBefore)) result.set(fenBefore, []);
        const entries = result.get(fenBefore)!;
        const existing = entries.find((e) => e.move === san);
        if (existing) {
          existing.count += 1;
          // Keep the longer continuation
          const cont = game.moves.slice(mi + 1);
          if (cont.length > existing.continuation.length) {
            existing.continuation = cont;
          }
        } else {
          entries.push({ move: san, fen: fenAfter, count: 1, continuation: game.moves.slice(mi + 1) });
        }
      }
    }
    return result;
  }, [importedGames, showGameOverlay]);

  /** Determine if a move at a given depth is a white move (odd depth = white) */
  const isWhiteMove = (depth: number): boolean => depth % 2 === 1;

  const renderMoves = (): React.ReactNode[] => {
    const elements: React.ReactNode[] = [];
    let moveNumberShown = false;

    // Skip root node (index 0)
    for (let i = 1; i < currentPath.length; i++) {
      const node = currentPath[i];
      const isCurrentMove = node.id === currentNode.id;
      const depth = node.depth;
      const isWhite = isWhiteMove(depth);
      const figurineMove = toFigurine(node.move, isWhite);

      // Show move number for white moves (odd depth)
      if (isWhite) {
        if (moveNumberShown) {
          elements.push(' ');
        }
        elements.push(
          <span key={`movenum-${i}`} className="text-text-secondary">
            {renderMoveNumber(depth)}
          </span>
        );
        moveNumberShown = true;
      }

      // Render the move with figurine notation + white/black color styling
      elements.push(
        <span
          key={`move-${i}`}
          onClick={() => onNavigateToNode(node)}
          className={`cursor-pointer rounded px-1 transition-colors ${
            isCurrentMove
              ? 'bg-accent-teal/20 text-accent-teal font-semibold'
              : isWhite
                ? 'text-text-primary font-medium hover:bg-bg-hover'
                : 'text-blue-700 hover:bg-bg-hover'
          }`}
        >
          {figurineMove}
        </span>
      );

      // Show engine eval for this position (the FEN after the move)
      const evalResult = getEval(node.fen);
      if (evalResult) {
        const label = formatEval(evalResult, !isWhite); // after White's move, Black to move next
        elements.push(
          <span
            key={`eval-${i}`}
            className={`text-[9px] font-mono ml-0.5 ${evalColorClass(evalResult)}`}
            title={`Depth ${evalResult.depth} • best: ${evalResult.bestMove}`}
          >
            {label}
          </span>
        );
      } else if (isAnalyzing) {
        elements.push(
          <span key={`eval-pending-${i}`} className="text-[9px] text-text-muted/40 ml-0.5">
            …
          </span>
        );
      }

      // Eval-drop annotation symbol (?! / ? / ??)
      const ann = getNodeAnnotation(node.id);
      if (ann) {
        const symbol = ANNOTATION_SYMBOL[ann.tier];
        const drop   = Math.min(ann.evalDrop, 10).toFixed(2);
        elements.push(
          <span
            key={`ann-${i}`}
            className="text-[10px] font-bold ml-0.5 align-baseline"
            style={{ color: MISTAKE_COLORS[ann.tier] }}
            title={`${ann.tier.charAt(0).toUpperCase() + ann.tier.slice(1)}: −${drop} pawns`}
          >
            {symbol}
          </span>
        );
      }

      // Show NAG symbols
      if (node.nags && node.nags.length > 0) {
        node.nags.forEach((nag) => {
          const nagData = NAG_SYMBOLS[nag];
          if (nagData) {
            elements.push(
              <span
                key={`nag-${i}-${nag}`}
                className={`text-xs font-semibold ${nagData.className}`}
                title={nagData.meaning}
              >
                {nagData.symbol}
              </span>
            );
          }
        });
      }

      // Show comment if present
      if (node.comment) {
        elements.push(
          <div
            key={`comment-${i}`}
            className="text-text-muted text-xs italic block mt-1 mb-1"
          >
            {node.comment}
          </div>
        );
      }

      // Show variations if this node has multiple children
      if (hasVariations(node)) {
        const variations = getVariations(node);
        variations.forEach((variation, varIndex) => {
          // Determine if the variation move is white or black
          const varIsWhite = isWhiteMove(variation.depth);
          const varFigurine = toFigurine(variation.move, varIsWhite);

          elements.push(
            <div
              key={`var-${i}-${varIndex}`}
              className="border-l-2 border-border-subtle pl-3 block mt-1 mb-1 text-sm"
            >
              <span className="text-text-muted text-xs">
                (
              </span>
              <span
                onClick={() => onNavigateToNode(variation)}
                className={`cursor-pointer hover:text-accent-teal hover:bg-bg-hover rounded px-1 ${
                  varIsWhite ? 'text-text-primary/70' : 'text-blue-700/70'
                }`}
              >
                {varFigurine}
                {variation.comment && (
                  <div className="text-text-muted text-xs italic">
                    {variation.comment}
                  </div>
                )}
              </span>
              <span className="text-text-muted text-xs">
                )
              </span>
            </div>
          );
        });
      }

      // Show imported game divergence moves (not in repertoire)
      if (showGameOverlay && gameMovesByFen.size > 0) {
        const gameMoves = gameMovesByFen.get(node.fen) || [];
        const divergenceMoves = gameMoves.filter(
          (gm) => !node.children.some((c) => c.move === gm.move)
        );
        if (divergenceMoves.length > 0) {
          divergenceMoves.forEach((dm, dmIdx) => {
            const dmIsWhite = isWhiteMove(node.depth + 1);
            const dmFigurine = toFigurine(dm.move, dmIsWhite);

            // Build the full continuation line with move numbers
            const contElements: React.ReactNode[] = [];
            if (dm.continuation.length > 0) {
              let contIsWhite = !dmIsWhite;
              // Move number for the divergence move
              const dmMoveNum = Math.floor((node.depth + 1) / 2) + 1;
              let moveNum = dmIsWhite ? dmMoveNum : dmMoveNum + 1;
              const maxCont = Math.min(dm.continuation.length, 12);

              for (let ci = 0; ci < maxCont; ci++) {
                const fig = toFigurine(dm.continuation[ci], contIsWhite);
                if (contIsWhite) {
                  contElements.push(
                    <span key={`cont-num-${ci}`} className="text-purple-400/50 mr-0.5">
                      {moveNum}.
                    </span>
                  );
                } else if (ci === 0 && dmIsWhite) {
                  // First continuation after white's divergence move — no extra move number needed
                }
                contElements.push(
                  <span key={`cont-move-${ci}`} className="text-purple-300/50 mr-1">
                    {fig}
                  </span>
                );
                if (!contIsWhite) moveNum++;
                contIsWhite = !contIsWhite;
              }
              if (dm.continuation.length > maxCont) {
                contElements.push(
                  <span key="cont-ellipsis" className="text-purple-300/30">…</span>
                );
              }
            }

            elements.push(
              <div
                key={`game-div-${i}-${dmIdx}`}
                className="border-l-2 border-dashed border-purple-500/40 pl-3 block mt-1 mb-1 text-sm"
              >
                <span className="text-[10px] text-purple-400/80 mr-0.5">◇</span>
                <span
                  onClick={() => onAddMove?.(node.id, dm.move, dm.fen)}
                  className="cursor-pointer hover:text-accent-teal hover:bg-bg-hover rounded px-1 text-purple-300/70"
                  title={`From imported games (${dm.count}×) — click to add to repertoire`}
                >
                  {dmFigurine}
                </span>
                <span className="text-[10px] text-text-muted ml-1 mr-1">
                  {dm.count}×
                </span>
                {contElements}
              </div>
            );
          });
        }
      }

      elements.push(' ');
    }

    return elements;
  };

  return (
    <div className="panel flex flex-col">
      {!hideHeader && <div className="panel-header">MOVES</div>}
      <div className="p-3 overflow-auto flex-1">
        <div className="text-sm leading-relaxed">
          {currentPath.length > 1 ? renderMoves() : (
            <span className="text-text-muted">No moves in this line</span>
          )}
        </div>
      </div>
    </div>
  );
};

export default MoveList;
