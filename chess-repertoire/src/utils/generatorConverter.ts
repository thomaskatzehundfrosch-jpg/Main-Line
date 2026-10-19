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
  resetIds: boolean = true,
  color: string = 'white'
): TreeNode {
  if (resetIds) {
    resetNodeIdCounter();
  }

  return convertNodeRecursive(genNode, parentId, color);
}

function convertNodeRecursive(
  genNode: GeneratorNode,
  parentId: string | null,
  color: string
): TreeNode {
  const id = genNode.isRoot ? generateNodeId() : generateNodeId();

  // Estimate game counts from Lichess data
  let gameCount = 0;
  let whiteWins = 0;
  let blackWins = 0;
  let draws = 0;

  if (genNode.lichess) {
    gameCount = genNode.lichess.totalGames;
    whiteWins = Math.round(gameCount * ((color === 'white' ? genNode.lichess.winRate : genNode.lichess.lossRate) / 100));
    draws = Math.round(gameCount * (genNode.lichess.drawRate / 100));
    blackWins = gameCount - whiteWins - draws;
  }

  const comment = "";

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
    convertNodeRecursive(child, id, color)
  );

  return treeNode;
}
