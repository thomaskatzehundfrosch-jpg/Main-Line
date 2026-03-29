import { Chess } from 'chess.js';
import type { TreeNode } from '../types';

let nodeIdCounter = 0;

export function generateNodeId(): string {
  return `node_${++nodeIdCounter}`;
}

export function resetNodeIdCounter(): void {
  nodeIdCounter = 0;
}

export function syncNodeIdCounterToTree(tree: TreeNode): void {
  let maxId = nodeIdCounter;

  const visit = (node: TreeNode) => {
    const match = /^node_(\d+)$/.exec(node.id);
    if (match) {
      maxId = Math.max(maxId, Number(match[1]));
    }
    for (const child of node.children) {
      visit(child);
    }
  };

  visit(tree);
  nodeIdCounter = maxId;
}

export function createRootNode(): TreeNode {
  const chess = new Chess();
  return {
    id: generateNodeId(),
    move: '',
    fen: chess.fen(),
    children: [],
    parentId: null,
    gameCount: 0,
    whiteWins: 0,
    blackWins: 0,
    draws: 0,
    comment: '',
    nags: [],
    depth: 0,
  };
}

/**
 * Deep-clone a repertoire tree so editor state is detached from saved files.
 */
export function cloneTree(node: TreeNode): TreeNode {
  return {
    ...node,
    nags: [...node.nags],
    children: node.children.map(cloneTree),
  };
}

/**
 * Deep-clone a tree while assigning fresh node IDs and rebuilding parent/depth
 * metadata. This repairs older saved repertoires that may contain duplicate
 * IDs from previous sessions.
 */
export function cloneTreeWithFreshIds(node: TreeNode): TreeNode {
  let counter = 0;

  const rebuild = (
    current: TreeNode,
    parentId: string | null,
    depth: number
  ): TreeNode => {
    const id = `node_${++counter}`;
    const children = current.children
      .filter((child) => !(child as any)._isOverlay)
      .map((child) => rebuild(child, id, depth + 1));

    return {
      ...current,
      id,
      parentId,
      depth,
      nags: [...current.nags],
      children,
    };
  };

  return rebuild(node, null, 0);
}

/**
 * Find or create a child node with the given move from a parent node.
 */
function findOrCreateChild(parent: TreeNode, move: string, fen: string, depth: number): TreeNode {
  // Remove any overlay nodes that leaked from D3 visualization
  if (parent.children.some((c) => (c as any)._isOverlay)) {
    parent.children = parent.children.filter((c) => !(c as any)._isOverlay);
  }

  const existing = parent.children.find((c) => c.move === move);
  if (existing) {
    return existing;
  }

  const child: TreeNode = {
    id: generateNodeId(),
    move,
    fen,
    children: [],
    parentId: parent.id,
    gameCount: 0,
    whiteWins: 0,
    blackWins: 0,
    draws: 0,
    comment: '',
    nags: [],
    depth,
  };
  parent.children.push(child);
  return child;
}

/**
 * Result from a PGN game header
 */
function parseResult(result: string | undefined): 'white' | 'black' | 'draw' | null {
  if (!result) return null;
  if (result === '1-0') return 'white';
  if (result === '0-1') return 'black';
  if (result === '1/2-1/2') return 'draw';
  return null;
}

interface ParsedMove {
  notation: { notation: string };
  variations?: ParsedMove[][];
  commentAfter?: string;
  commentBefore?: string;
  nag?: string[];
}

interface ParsedGame {
  moves?: ParsedMove[];
  tags?: Record<string, string>;
}

/**
 * Process moves recursively, handling variations (RAVs).
 */
function processMoves(
  moves: ParsedMove[],
  parentNode: TreeNode,
  chess: Chess,
  result: 'white' | 'black' | 'draw' | null,
  depth: number,
  nodeMap: Map<string, TreeNode>
): void {
  let currentNode = parentNode;
  const chessClone = new Chess(chess.fen());

  for (const moveObj of moves) {
    const san = moveObj.notation?.notation;
    if (!san) continue;

    try {
      chessClone.move(san);
    } catch {
      // Invalid move, skip
      continue;
    }

    const fen = chessClone.fen();
    const childNode = findOrCreateChild(currentNode, san, fen, depth + 1);

    // Update statistics
    childNode.gameCount += 1;
    if (result === 'white') childNode.whiteWins += 1;
    else if (result === 'black') childNode.blackWins += 1;
    else if (result === 'draw') childNode.draws += 1;

    // Add comments
    if (moveObj.commentAfter && !childNode.comment) {
      childNode.comment = moveObj.commentAfter;
    }

    // Add NAGs
    if (moveObj.nag) {
      for (const nag of moveObj.nag) {
        const nagNum = parseInt(nag.replace('$', ''), 10);
        if (!isNaN(nagNum) && !childNode.nags.includes(nagNum)) {
          childNode.nags.push(nagNum);
        }
      }
    }

    nodeMap.set(childNode.id, childNode);

    // Process variations (RAVs)
    if (moveObj.variations && moveObj.variations.length > 0) {
      for (const variation of moveObj.variations) {
        // Variations start from the position BEFORE the current move
        const varChess = new Chess(currentNode.fen);
        processMoves(variation, currentNode, varChess, result, depth, nodeMap);
      }
    }

    currentNode = childNode;
    depth += 1;
  }
}

/**
 * Merge a parsed PGN game into the tree.
 */
export function mergeGameIntoTree(
  tree: TreeNode,
  game: ParsedGame,
  nodeMap: Map<string, TreeNode>
): void {
  const result = parseResult(game.tags?.Result);
  const moves = game.moves;

  if (!moves || moves.length === 0) return;

  tree.gameCount += 1;
  if (result === 'white') tree.whiteWins += 1;
  else if (result === 'black') tree.blackWins += 1;
  else if (result === 'draw') tree.draws += 1;

  const chess = new Chess();
  processMoves(moves, tree, chess, result, 0, nodeMap);
}

/**
 * Build a complete opening tree from an array of parsed PGN games.
 */
export function buildTreeFromGames(
  games: ParsedGame[]
): { tree: TreeNode; nodeMap: Map<string, TreeNode> } {
  resetNodeIdCounter();
  const tree = createRootNode();
  const nodeMap = new Map<string, TreeNode>();
  nodeMap.set(tree.id, tree);

  for (const game of games) {
    mergeGameIntoTree(tree, game, nodeMap);
  }

  return { tree, nodeMap };
}

/**
 * Find a node by ID in the tree.
 */
export function findNodeById(tree: TreeNode, id: string): TreeNode | null {
  if (tree.id === id) return tree;
  for (const child of tree.children) {
    const found = findNodeById(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * Get the path from root to a given node.
 */
export function getPathToNode(tree: TreeNode, targetId: string): TreeNode[] | null {
  if (tree.id === targetId) return [tree];
  for (const child of tree.children) {
    const path = getPathToNode(child, targetId);
    if (path) return [tree, ...path];
  }
  return null;
}

/**
 * Add a new move to the tree at a given parent.
 */
export function addMoveToTree(
  tree: TreeNode,
  parentId: string,
  move: string,
  fen: string
): TreeNode | null {
  syncNodeIdCounterToTree(tree);
  const parent = findNodeById(tree, parentId);
  if (!parent) return null;

  // Actively remove any overlay nodes that leaked into the real tree
  if (parent.children.some((c) => (c as any)._isOverlay)) {
    parent.children = parent.children.filter(
      (c) => !(c as any)._isOverlay
    );
  }

  // Check if child already exists
  const existing = parent.children.find((c) => c.move === move);
  if (existing) return existing;

  const child: TreeNode = {
    id: generateNodeId(),
    move,
    fen,
    children: [],
    parentId: parent.id,
    gameCount: 0,
    whiteWins: 0,
    blackWins: 0,
    draws: 0,
    comment: '',
    nags: [],
    depth: parent.depth + 1,
  };
  parent.children.push(child);
  return child;
}

/**
 * Add a line of moves to the tree starting from a given parent.
 * Each move is added as a child of the previous one.
 * Returns the last node in the chain (or null if parentId not found).
 */
export function addLineToTree(
  tree: TreeNode,
  parentId: string,
  moves: { move: string; fen: string }[]
): TreeNode | null {
  let currentParentId = parentId;
  let lastNode: TreeNode | null = null;

  for (const { move, fen } of moves) {
    const newNode = addMoveToTree(tree, currentParentId, move, fen);
    if (!newNode) return lastNode;
    lastNode = newNode;
    currentParentId = newNode.id;
  }

  return lastNode;
}

/**
 * Remove a node (and its subtree) from the tree by ID.
 * Returns the parent node if found and removed, null otherwise.
 * Cannot remove the root node.
 * @deprecated Use removeNodeImmutable for reliable React/D3 re-renders.
 */
export function removeNodeFromTree(tree: TreeNode, nodeId: string): TreeNode | null {
  for (let i = 0; i < tree.children.length; i++) {
    if (tree.children[i].id === nodeId) {
      tree.children.splice(i, 1);
      return tree;
    }
    const result = removeNodeFromTree(tree.children[i], nodeId);
    if (result) return result;
  }
  return null;
}

/**
 * Remove a node (and all its descendants) from the tree, returning a brand-new
 * tree where every node on the path from root to the deleted node is a new
 * object. This guarantees React reference-equality checks and D3 useEffect
 * dependency comparisons always detect the structural change.
 *
 * Returns null if nodeId equals the root (cannot remove root).
 * Returns the original root unchanged if nodeId is not found.
 */
export function removeNodeImmutable(root: TreeNode, nodeId: string): TreeNode | null {
  if (root.id === nodeId) return null;

  function rebuild(node: TreeNode): TreeNode {
    return {
      ...node,
      children: node.children
        .filter((c) => c.id !== nodeId)
        .map((c) => rebuild(c)),
    };
  }

  return rebuild(root);
}

/**
 * Count total nodes in the tree.
 */
export function countNodes(node: TreeNode): number {
  let count = 1;
  for (const child of node.children) {
    if ((child as any)._isOverlay) continue; // skip leaked overlays
    count += countNodes(child);
  }
  return count;
}

/**
 * Get the maximum depth of the tree.
 */
export function getMaxDepth(node: TreeNode): number {
  if (node.children.length === 0) return node.depth;
  return Math.max(...node.children.map(getMaxDepth));
}
