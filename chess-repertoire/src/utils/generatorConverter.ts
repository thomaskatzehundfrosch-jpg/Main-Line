/**
 * Convert GeneratorNode tree to the app's TreeNode format for import.
 */

import type { TreeNode } from '../types';
import type { GeneratorNode } from '../types/generator';
import { generateNodeId, resetNodeIdCounter } from './treeBuilder';

/**
 * Convert a GeneratorNode tree to a TreeNode tree for import into the main repertoire.
 * Recursively maps all nodes, reassigning IDs using the app's ID generator.
 */
export function convertToTreeNode(
  genNode: GeneratorNode,
  parentId: string | null = null,
  resetIds: boolean = true
): TreeNode {
  if (resetIds) {
    resetNodeIdCounter();
  }

  return convertNodeRecursive(genNode, parentId);
}

function convertNodeRecursive(
  genNode: GeneratorNode,
  parentId: string | null
): TreeNode {
  const id = genNode.isRoot ? generateNodeId() : generateNodeId();

  // Estimate game counts from Lichess data
  let gameCount = 0;
  let whiteWins = 0;
  let blackWins = 0;
  let draws = 0;

  if (genNode.lichess) {
    gameCount = genNode.lichess.totalGames;
    whiteWins = Math.round(gameCount * (genNode.lichess.winRate / 100));
    draws = Math.round(gameCount * (genNode.lichess.drawRate / 100));
    blackWins = gameCount - whiteWins - draws;
  }

  // Build comment from analysis data
  const comment = buildComment(genNode);

  const treeNode: TreeNode = {
    id,
    move: genNode.san || '',
    fen: genNode.fen,
    children: [],
    parentId,
    gameCount,
    whiteWins,
    blackWins,
    draws,
    comment,
    nags: [],
    depth: genNode.depth,
  };

  // Recursively convert children
  treeNode.children = genNode.children.map((child) =>
    convertNodeRecursive(child, id)
  );

  return treeNode;
}

/**
 * Build a comment string from generator analysis data.
 */
function buildComment(node: GeneratorNode): string {
  const parts: string[] = [];

  if (node.stockfish && node.stockfish.eval !== null) {
    const ev = node.stockfish.eval;
    const sign = ev >= 0 ? '+' : '';
    parts.push(`eval: ${sign}${ev.toFixed(2)}`);
  }

  if (node.lichess && node.lichess.totalGames > 0) {
    parts.push(
      `${node.lichess.totalGames} games (W${Math.round(node.lichess.winRate)}% D${Math.round(node.lichess.drawRate)}% L${Math.round(node.lichess.lossRate)}%)`
    );
  }

  if (node.isDangerous) {
    parts.push('⚠ dangerous line');
  }

  return parts.join(' | ');
}
