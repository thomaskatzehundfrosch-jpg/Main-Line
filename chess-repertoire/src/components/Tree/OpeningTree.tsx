import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as d3 from 'd3';
import { Chess } from 'chess.js';
import type { TreeNode } from '../../types';
import type { ImportedGame, MistakeTier } from '../../types/game';
import { MISTAKE_COLORS } from '../../types/game';
import { TreeTooltip } from './TreeTooltip';
import { useRepertoireEval } from '../../context/RepertoireEvalContext';

interface OpeningTreeProps {
  tree: TreeNode;
  currentNode: TreeNode;
  currentPath: TreeNode[];
  onNodeClick: (node: TreeNode) => void;
  onDeleteNode: (nodeId: string) => void;
  /** Callback to add a game move to the repertoire tree */
  onAddMove?: (parentId: string, move: string, fen: string) => void;
  /** Callback to add a line of moves to the repertoire tree */
  onAddLine?: (parentId: string, moves: { move: string; fen: string }[]) => void;
  /** Like onAddLine but does not navigate to the added node (used for overlay additions) */
  onAddOverlayLine?: (parentId: string, moves: { move: string; fen: string }[]) => void;
  /** Imported games for overlay */
  importedGames?: ImportedGame[];
  /** Whether to show the game overlay */
  showGameOverlay?: boolean;
  /** Called in explore mode when a greyed-out overlay node is clicked — receives its FEN for board display only, no tree mutation */
  onExploreFen?: (fen: string) => void;
}

interface D3TreeNode {
  data: TreeNode;
  x: number;
  y: number;
  children?: D3TreeNode[];
  _children?: D3TreeNode[];
  parent?: D3TreeNode;
  depth: number;
}

/** NAG values that flag a bad/dubious move (?, ??, ?!, !?) */
const MISTAKE_NAGS = new Set([2, 4, 5, 6]);

/**
 * Pre-compute the set of node IDs that either ARE a mistake-NAG node or have
 * one somewhere in their subtree. Used to trace visible paths to mistake nodes.
 */
function buildAncestorsOfMistakes(node: TreeNode, result: Set<string>): boolean {
  const isMistake = node.nags.some((n) => MISTAKE_NAGS.has(n));
  let hasBelow = isMistake;
  for (const child of node.children) {
    if (buildAncestorsOfMistakes(child, result)) hasBelow = true;
  }
  if (hasBelow) result.add(node.id);
  return hasBelow;
}

/**
 * Build the visible subset of the tree:
 *  - The full current path (root → currentNode) is always shown.
 *  - At each path node, direct branch siblings are shown as collapsed stubs.
 *  - Nodes with mistake NAGs (?, ??, ?!, !?) and their full subtrees are
 *    always shown, even when off the current path.
 *  - expandedNodes allows manual double-click to peek one level into a stub.
 *  - forceExpand=true is used internally when descending into a mistake subtree.
 *
 * IMPORTANT: Always create fresh children arrays so addOverlayNodes (which
 * pushes into .children) never mutates the real tree's arrays.
 */
function buildVisibleTree(
  node: TreeNode,
  currentPathIds: Set<string>,
  ancestorsOfMistakes: Set<string>,
  expandedNodes: Set<string>,
  forceExpand = false
): any {
  const result: any = {
    ...node,
    children: [],
    _originalChildren: node.children,
  };

  // Inside a mistake subtree: show everything unconditionally.
  if (forceExpand) {
    result.children = node.children.map((c) =>
      buildVisibleTree(c, currentPathIds, ancestorsOfMistakes, expandedNodes, true)
    );
    return result;
  }

  const onPath = currentPathIds.has(node.id);

  // Stub: not on path and not on the route to a mistake.
  if (!onPath && !ancestorsOfMistakes.has(node.id)) {
    if (expandedNodes.has(node.id)) {
      // Manually expanded — show one level of children as stubs.
      result.children = node.children.map((c) => ({
        ...c,
        children: [],
        _collapsed: c.children.length > 0,
        _originalChildren: c.children,
      }));
    } else if (node.children.length > 0) {
      result._collapsed = true;
    }
    return result;
  }

  for (const child of node.children) {
    const childOnPath = currentPathIds.has(child.id);
    const childIsMistake = child.nags.some((n) => MISTAKE_NAGS.has(n));
    const childLeadsToMistake = ancestorsOfMistakes.has(child.id);

    if (onPath) {
      if (childOnPath) {
        // Continue along the current path.
        result.children.push(
          buildVisibleTree(child, currentPathIds, ancestorsOfMistakes, expandedNodes, false)
        );
      } else if (childIsMistake) {
        // Mistake child — show full subtree.
        result.children.push(
          buildVisibleTree(child, currentPathIds, ancestorsOfMistakes, expandedNodes, true)
        );
      } else if (childLeadsToMistake) {
        // On the route to a mistake — show but don't force-expand.
        result.children.push(
          buildVisibleTree(child, currentPathIds, ancestorsOfMistakes, expandedNodes, false)
        );
      } else if (expandedNodes.has(child.id)) {
        // Manually expanded stub — show one extra level as stubs.
        const ec: any = { ...child, children: [], _originalChildren: child.children };
        ec.children = child.children.map((gc) => ({
          ...gc,
          children: [],
          _collapsed: gc.children.length > 0,
          _originalChildren: gc.children,
        }));
        result.children.push(ec);
      } else {
        // Branch stub — collapsed.
        result.children.push({
          ...child,
          children: [],
          _collapsed: child.children.length > 0,
          _originalChildren: child.children,
        });
      }
    } else {
      // Node is on the route to a mistake (not on current path).
      // Only follow children that are also on route to (or are) mistakes.
      if (childIsMistake) {
        result.children.push(
          buildVisibleTree(child, currentPathIds, ancestorsOfMistakes, expandedNodes, true)
        );
      } else if (childLeadsToMistake) {
        result.children.push(
          buildVisibleTree(child, currentPathIds, ancestorsOfMistakes, expandedNodes, false)
        );
      }
      // Other children of mistake-ancestor nodes are hidden.
    }
  }

  return result;
}

/**
 * Determine if a node represents a white or black move based on depth.
 * Depth 0 = root (starting position, no move)
 * Odd depths (1, 3, 5...) = white's move
 * Even depths > 0 (2, 4, 6...) = black's move
 */
function isWhiteMove(node: TreeNode): boolean {
  return node.depth % 2 === 1;
}

/**
 * Get color for a node based on which side made the move.
 * White moves get a light color, black moves get a dark color.
 * Falls back to neutral for root node.
 */
function getNodeColor(node: TreeNode): string {
  if (node.depth === 0) return '#1a2744'; // root: dark navy
  if (isWhiteMove(node)) return '#FFF5E1'; // white move: egg white
  return '#1a2744'; // black move: dark blue
}

/**
 * Get text color for repertoire nodes.
 */
function getNodeTextColor(node: TreeNode): string {
  if (node.depth === 0) return '#FFF5E1';
  if (isWhiteMove(node)) return '#1a2744'; // dark blue text on egg white
  return '#FFF5E1'; // egg white text on dark blue
}

/**
 * Overlay (greyed-out) nodes keep the old neutral colors.
 */
function getOverlayNodeColor(node: TreeNode): string {
  if (node.depth === 0) return '#4a5568';
  if (isWhiteMove(node)) return '#e8e8e8';
  return '#2a2a2a';
}

function getOverlayTextColor(node: TreeNode): string {
  if (node.depth === 0) return '#fff';
  if (isWhiteMove(node)) return '#1a1a1a';
  return '#f0f0f0';
}

/**
 * Get node radius based on game count.
 */
function getNodeRadius(node: TreeNode, maxGameCount: number): number {
  if (maxGameCount === 0) return 14;
  const ratio = node.gameCount / maxGameCount;
  return 12 + ratio * 6; // 12-18px range
}

/**
 * Build a map of FEN → worst mistake tier from all analyzed games.
 * Also store all mistakes at that FEN for tooltip.
 */
export interface OverlayMoveInfo {
  move: string;
  gameNames: string[];
  isWhiteMove: boolean;
}

export interface FenMistakeInfo {
  tier: MistakeTier;
  count: number;
  side: 'white' | 'black' | 'both';
  mistakes: {
    movePlayed: string;
    bestMove: string;
    evalDrop: number;
    tier: MistakeTier;
    gameName: string;
    reviewed: boolean;
  }[];
}

/**
 * Add overlay nodes to the prepared tree data for imported games.
 * Overlay nodes represent moves from imported games that are NOT in the repertoire.
 * They are marked with _isOverlay = true so they can be rendered differently (greyed out).
 */
function addOverlayNodes(treeData: any, games: ImportedGame[], dismissedFens?: Set<string>): void {
  // Build a FEN → node map for the existing tree (including previously added overlay nodes)
  const fenToNode = new Map<string, any>();
  function indexTree(node: any) {
    fenToNode.set(node.fen, node);
    if (node.children) {
      for (const child of node.children) indexTree(child);
    }
  }
  indexTree(treeData);

  for (const game of games) {
    const chess = new Chess();
    let currentNode: any = fenToNode.get(chess.fen());
    if (!currentNode) continue;

    for (let i = 0; i < game.moves.length; i++) {
      try {
        chess.move(game.moves[i]);
      } catch {
        break;
      }
      const fenAfter = chess.fen();

      // Skip dismissed overlay moves (and stop following this game line)
      if (dismissedFens && dismissedFens.has(fenAfter)) break;

      const existingNode = fenToNode.get(fenAfter);

      if (existingNode) {
        // Node already exists (either repertoire or previously added overlay)
        const gameName = `${game.white} vs ${game.black}`;
        if (existingNode._isOverlay) {
          if (!existingNode._overlayGameNames.includes(gameName)) {
            existingNode._overlayGameNames.push(gameName);
          }
        } else {
          // Real repertoire node — mark it so D3 can show a visual cue
          // that this move also appears in imported games
          if (!existingNode._gameOverlapNames) existingNode._gameOverlapNames = [];
          if (!existingNode._gameOverlapNames.includes(gameName)) {
            existingNode._gameOverlapNames.push(gameName);
          }
        }
        currentNode = existingNode;
        continue;
      }

      // Create new overlay node
      const gameName = `${game.white} vs ${game.black}`;
      const overlayNode: any = {
        id: `overlay_${currentNode.id}_${game.moves[i]}`,
        move: game.moves[i],
        fen: fenAfter,
        children: [],
        parentId: currentNode.id,
        gameCount: 0,
        whiteWins: 0,
        blackWins: 0,
        draws: 0,
        comment: '',
        nags: [],
        depth: (currentNode.depth || 0) + 1,
        _isOverlay: true,
        _overlayGameNames: [gameName],
      };

      if (!currentNode.children) currentNode.children = [];
      currentNode.children.push(overlayNode);
      fenToNode.set(fenAfter, overlayNode);
      currentNode = overlayNode;
    }
  }
}

/**
 * Walk up the D3 hierarchy from an overlay node to collect the chain of
 * overlay moves back to the first repertoire ancestor.
 * Returns { repertoireParentId, moves } or null.
 */
function collectOverlayChain(d3Node: any): {
  repertoireParentId: string;
  moves: { move: string; fen: string }[];
} | null {
  const chain: { move: string; fen: string }[] = [];
  let node = d3Node;
  while (node && node.data._isOverlay) {
    chain.unshift({ move: node.data.move, fen: node.data.fen });
    node = node.parent;
  }
  if (!node) return null;
  return { repertoireParentId: node.data.id, moves: chain };
}

function buildMistakeMap(games: ImportedGame[]): Map<string, FenMistakeInfo> {
  const map = new Map<string, FenMistakeInfo>();
  const tierSeverity: Record<MistakeTier, number> = {
    inaccuracy: 0,
    mistake: 1,
    blunder: 2,
  };

  for (const game of games) {
    if (!game.analyzed) continue;
    const gameName = `${game.white} vs ${game.black}`;

    for (const m of game.mistakes) {
      const existing = map.get(m.fen);
      const entry = {
        movePlayed: m.movePlayed,
        bestMove: m.bestMove,
        evalDrop: m.evalDrop,
        tier: m.tier,
        gameName,
        reviewed: m.reviewed,
      };

      if (existing) {
        existing.count += 1;
        existing.mistakes.push(entry);
        if (tierSeverity[m.tier] > tierSeverity[existing.tier]) {
          existing.tier = m.tier;
        }
        if (existing.side !== 'both' && existing.side !== m.side) {
          existing.side = 'both';
        }
      } else {
        map.set(m.fen, {
          tier: m.tier,
          count: 1,
          side: m.side,
          mistakes: [entry],
        });
      }
    }
  }

  return map;
}

export const OpeningTree: React.FC<OpeningTreeProps> = ({
  tree,
  currentNode,
  currentPath,
  onNodeClick,
  onDeleteNode,
  onAddMove,
  onAddLine,
  onAddOverlayLine,
  importedGames = [],
  showGameOverlay = false,
  onExploreFen,
}) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [tooltip, setTooltip] = useState<{
    node: TreeNode | null;
    overlayMove?: OverlayMoveInfo | null;
    mistakeInfo?: FenMistakeInfo | null;
    x: number;
    y: number;
    visible: boolean;
  }>({ node: null, x: 0, y: 0, visible: false });
  const [contextMenu, setContextMenu] = useState<{
    node: TreeNode | null;
    isOverlay: boolean;
    overlayFen?: string;
    x: number;
    y: number;
    visible: boolean;
  }>({ node: null, isOverlay: false, x: 0, y: 0, visible: false });
  const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
  const [dismissedOverlayFens, setDismissedOverlayFens] = useState<Set<string>>(new Set());
  const [exploreMode, setExploreMode] = useState(false);
  const exploreModeRef = useRef(false);
  const zoomRef = useRef<d3.ZoomBehavior<SVGSVGElement, unknown> | null>(null);
  const transformRef = useRef<d3.ZoomTransform | null>(null);

  // When the current path changes (e.g. user adds a move in a different branch),
  // preserve expansion of deep nodes from the previous path so they don't collapse.
  const prevPathRef = useRef<TreeNode[]>([]);
  useEffect(() => {
    // When navigating away from a path, preserve manual expansions the user
    // had opened on nodes that are no longer on the new path.
    prevPathRef.current = currentPath;
  }, [currentPath]);

  // Keep explore mode ref in sync so the D3 click handler can read it
  // without the entire D3 effect needing to re-run on every toggle.
  useEffect(() => {
    exploreModeRef.current = exploreMode;
  }, [exploreMode]);

  // Build mistake map from imported games (memoized).
  // We use a stringified key to avoid reference-equality issues with Map
  // that would cause the D3 effect to re-run and flash the tree.
  const mistakeMap = useMemo(
    () => (showGameOverlay ? buildMistakeMap(importedGames) : new Map<string, FenMistakeInfo>()),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [showGameOverlay, importedGames.length, importedGames.filter(g => g.analyzed).length,
     importedGames.reduce((s, g) => s + g.mistakes.filter(m => m.reviewed).length, 0)]
  );
  const mistakeMapRef = useRef(mistakeMap);
  mistakeMapRef.current = mistakeMap;

  // Repertoire eval-drop annotations (inaccuracy / mistake / blunder rings)
  const { nodeAnnotations } = useRepertoireEval();
  const nodeAnnotationsRef = useRef(nodeAnnotations);
  nodeAnnotationsRef.current = nodeAnnotations;

  // Close context menu on click anywhere
  useEffect(() => {
    const handleClick = () => setContextMenu((prev) => ({ ...prev, visible: false, isOverlay: false }));
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, []);

  const currentPathIds = new Set(currentPath.map((n) => n.id));

  // Find max game count for sizing
  const getMaxGameCount = useCallback((node: TreeNode): number => {
    let max = node.gameCount;
    for (const child of node.children) {
      max = Math.max(max, getMaxGameCount(child));
    }
    return max;
  }, []);

  const toggleExpand = useCallback((nodeId: string) => {
    setExpandedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(nodeId)) {
        next.delete(nodeId);
      } else {
        next.add(nodeId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    if (!svgRef.current || !containerRef.current) return;

    const container = containerRef.current;
    const width = container.clientWidth;
    const height = container.clientHeight;
    const maxGameCount = getMaxGameCount(tree);

    // Clear previous render
    d3.select(svgRef.current).selectAll('*').remove();

    const svg = d3
      .select(svgRef.current)
      .attr('width', width)
      .attr('height', height);

    // Create a group for zoom/pan
    const g = svg.append('g').attr('transform', 'translate(60, 0)');

    // Set up zoom behavior
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.2, 3])
      .on('zoom', (event) => {
        g.attr('transform', event.transform);
        transformRef.current = event.transform;
      });

    svg.call(zoom);
    zoomRef.current = zoom;

    // Restore previous transform or set initial (only reset on first render)
    if (transformRef.current) {
      svg.call(zoom.transform, transformRef.current);
    } else {
      svg.call(zoom.transform, d3.zoomIdentity.translate(60, height / 2).scale(0.9));
    }

    // Prepare hierarchy data — show the full "current line":
    //   • the path from root → currentNode (backward)
    //   • the continuation from currentNode → end of its variation, following
    //     the first child at each step (forward)
    // Branch siblings at any point on this line appear as collapsed stubs.
    // Mistake-NAG nodes (?, ??, ?!, !?) and their full subtrees are always shown.
    const pathIds = new Set(currentPath.map((n) => n.id));

    // Extend forward: follow first children from currentNode to the leaf.
    let fwdNode: TreeNode = currentNode;
    while (fwdNode.children.length > 0) {
      fwdNode = fwdNode.children[0];
      pathIds.add(fwdNode.id);
    }

    const ancestorsOfMistakesSet = new Set<string>();
    buildAncestorsOfMistakes(tree, ancestorsOfMistakesSet);
    const treeData = buildVisibleTree(tree, pathIds, ancestorsOfMistakesSet, expandedNodes);

    // Add overlay nodes from imported games (full lines, not just first divergence)
    if (showGameOverlay && importedGames.length > 0) {
      addOverlayNodes(treeData, importedGames, dismissedOverlayFens);
    }

    const root = d3.hierarchy(treeData);

    // Create tree layout (left-to-right)
    const treeLayout = d3
      .tree<any>()
      .nodeSize([36, 70])
      .separation((a, b) => {
        return a.parent === b.parent ? 1 : 1.2;
      });

    treeLayout(root);

    // ─── Links (repertoire + overlay) ─────────────────────────────────
    g.selectAll('.link')
      .data(root.links())
      .enter()
      .append('path')
      .attr('class', (d: any) => {
        if (d.target.data._isOverlay) return 'tree-link tree-link-overlay';
        const sourceId = d.source.data.id;
        const targetId = d.target.data.id;
        const isActive = currentPathIds.has(sourceId) && currentPathIds.has(targetId);
        return isActive ? 'tree-link tree-link-active' : 'tree-link';
      })
      .attr('d', (d: any) => {
        return `M${d.source.y},${d.source.x}
                C${(d.source.y + d.target.y) / 2},${d.source.x}
                 ${(d.source.y + d.target.y) / 2},${d.target.x}
                 ${d.target.y},${d.target.x}`;
      })
      .attr('stroke-dasharray', (d: any) => d.target.data._isOverlay ? '4,3' : null)
      .attr('opacity', (d: any) => d.target.data._isOverlay ? 0.45 : null);

    // ─── Repertoire Nodes ─────────────────────────────────────────────
    const nodeGroups = g
      .selectAll('.node')
      .data(root.descendants())
      .enter()
      .append('g')
      .attr('class', 'node')
      .attr('transform', (d: any) => `translate(${d.y},${d.x})`)
      .style('cursor', 'pointer')
      .on('click', (_event: any, d: any) => {
        if (d.data._isOverlay) {
          if (exploreModeRef.current) {
            // Explore mode: show this position on the board without touching the tree
            onExploreFen?.(d.data.fen);
          } else {
            // Normal mode: clicking an overlay node adds the entire chain to the
            // repertoire WITHOUT navigating away from the current position.
            const chain = collectOverlayChain(d);
            const addLineFn = onAddOverlayLine ?? onAddLine;
            if (chain && addLineFn) {
              addLineFn(chain.repertoireParentId, chain.moves);
            } else if (chain && chain.moves.length === 1 && onAddMove) {
              onAddMove(chain.repertoireParentId, chain.moves[0].move, chain.moves[0].fen);
            }
          }
          return;
        }
        onNodeClick(d.data);
      })
      .on('dblclick', (_event: any, d: any) => {
        if (d.data._isOverlay) return;
        if (d.data._collapsed || (d.data.children && d.data.children.length > 0)) {
          toggleExpand(d.data.id);
        }
      })
      .on('mouseover', (event: MouseEvent, d: any) => {
        const mi = mistakeMapRef.current.get(d.data.fen) || null;
        if (d.data._isOverlay) {
          setTooltip({
            node: null,
            overlayMove: {
              move: d.data.move,
              gameNames: d.data._overlayGameNames || [],
              isWhiteMove: d.data.depth % 2 === 1,
            },
            mistakeInfo: mi,
            x: event.clientX,
            y: event.clientY,
            visible: true,
          });
          return;
        }
        setTooltip({
          node: d.data,
          mistakeInfo: mi,
          x: event.clientX,
          y: event.clientY,
          visible: true,
        });
      })
      .on('mousemove', (event: MouseEvent, d: any) => {
        if (d.data._isOverlay) {
          const mi = mistakeMapRef.current.get(d.data.fen) || null;
          setTooltip((prev) => ({ ...prev, x: event.clientX, y: event.clientY, mistakeInfo: mi }));
          return;
        }
        const mi = mistakeMapRef.current.get(d.data.fen) || null;
        setTooltip({
          node: d.data,
          mistakeInfo: mi,
          x: event.clientX,
          y: event.clientY,
          visible: true,
        });
      })
      .on('mouseout', () => {
        setTooltip({ node: null, x: 0, y: 0, visible: false });
      })
      .on('contextmenu', (event: MouseEvent, d: any) => {
        event.preventDefault();
        if (!d.data._isOverlay && d.data.parentId === null) return; // skip root only
        setTooltip({ node: null, x: 0, y: 0, visible: false });
        setContextMenu({
          node: d.data,
          isOverlay: !!d.data._isOverlay,
          overlayFen: d.data._isOverlay ? d.data.fen : undefined,
          x: event.clientX,
          y: event.clientY,
          visible: true,
        });
      });

    // ─── Mistake Rings (drawn under the node circle) ──────────────────
    if (showGameOverlay) {
      nodeGroups.each(function (this: SVGGElement, d: any) {
        let mi = mistakeMapRef.current.get(d.data.fen);

        // If this node's FEN is in the mistake map, but the actual mistake
        // move is represented by an overlay child, suppress the highlight
        // here so it appears on the overlay move node instead.
        if (mi && d.children) {
          const remaining = mi.mistakes.filter((m: any) => {
            return !d.children.some(
              (c: any) => c.data.move === m.movePlayed
            );
          });
          if (remaining.length === 0) {
            mi = undefined;
          } else if (remaining.length < mi.mistakes.length) {
            const sev: Record<string, number> = { inaccuracy: 0, mistake: 1, blunder: 2 };
            mi = {
              tier: remaining.reduce(
                (w: MistakeTier, m: any) => (sev[m.tier] > sev[w] ? m.tier : w),
                remaining[0].tier as MistakeTier
              ),
              count: remaining.length,
              side: mi.side,
              mistakes: remaining,
            };
          }
        }

        // For any child node (overlay or real), check if THIS node IS the mistake move:
        // look up the parent's FEN in the mistake map and match movePlayed
        // to this node's move, so the ring highlights the actual bad move.
        if (!mi && d.parent?.data) {
          const parentMi = mistakeMapRef.current.get(d.parent.data.fen);
          if (parentMi) {
            const relevant = parentMi.mistakes.filter(
              (m: any) => m.movePlayed === d.data.move
            );
            if (relevant.length > 0) {
              const sev: Record<string, number> = { inaccuracy: 0, mistake: 1, blunder: 2 };
              mi = {
                tier: relevant.reduce(
                  (w: MistakeTier, m: any) => (sev[m.tier] > sev[w] ? m.tier : w),
                  relevant[0].tier as MistakeTier
                ),
                count: relevant.length,
                side: parentMi.side,
                mistakes: relevant,
              };
            }
          }
        }

        if (!mi) return;

        const baseRadius = d.data._isOverlay ? 13 : getNodeRadius(d.data, maxGameCount);
        const radius = baseRadius + 4;
        const color = MISTAKE_COLORS[mi.tier];
        const allReviewed = mi.mistakes.every((m) => m.reviewed);

        const group = d3.select(this);

        // Glow effect for blunders
        if (mi.tier === 'blunder') {
          group
            .insert('circle', ':first-child')
            .attr('r', radius + 3)
            .attr('fill', 'none')
            .attr('stroke', color)
            .attr('stroke-width', 1)
            .attr('opacity', allReviewed ? 0.15 : 0.3)
            .style('filter', `drop-shadow(0 0 4px ${color})`);
        }

        // Mistake ring — always solid circle
        group
          .insert('circle', ':first-child')
          .attr('r', radius)
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', 2.5)
          .attr('opacity', allReviewed ? 0.25 : 0.9);

        // Count badge for multiple mistakes
        if (mi.count > 1) {
          group
            .append('circle')
            .attr('cx', radius - 2)
            .attr('cy', -(radius - 2))
            .attr('r', 6)
            .attr('fill', color)
            .attr('stroke', '#0f0f17')
            .attr('stroke-width', 1);

          group
            .append('text')
            .attr('x', radius - 2)
            .attr('y', -(radius - 2) + 1)
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'middle')
            .attr('font-size', '8px')
            .attr('font-weight', 'bold')
            .attr('fill', '#fff')
            .attr('pointer-events', 'none')
            .text(mi.count.toString());
        }
      });
    }

    // ─── Repertoire engine-check annotation rings ──────────────────────
    // Drawn unconditionally whenever the analysis has produced annotations.
    // Uses the same MISTAKE_COLORS as game-mistake rings but keyed by node ID
    // instead of FEN, and rendered at a slightly larger radius so both rings
    // can coexist when a node also has a game-mistake highlight.
    nodeGroups.each(function (this: SVGGElement, d: any) {
      if (d.data._isOverlay) return;
      const ann = nodeAnnotationsRef.current.get(d.data.id);
      if (!ann) return;

      const baseRadius = getNodeRadius(d.data, maxGameCount);
      // Push the repertoire-eval ring outward when there is also a game-mistake
      // ring at the same node so the two don't paint on top of each other.
      const hasMistakeRing =
        showGameOverlay && !!mistakeMapRef.current.get(d.data.fen);
      const ringRadius = baseRadius + (hasMistakeRing ? 9 : 4);
      const color = MISTAKE_COLORS[ann.tier];

      const group = d3.select(this);

      // Soft glow for blunders
      if (ann.tier === 'blunder') {
        group
          .insert('circle', ':first-child')
          .attr('r', ringRadius + 3)
          .attr('fill', 'none')
          .attr('stroke', color)
          .attr('stroke-width', 1)
          .attr('opacity', 0.28)
          .style('filter', `drop-shadow(0 0 5px ${color})`);
      }

      // Always solid circle ring
      group
        .insert('circle', ':first-child')
        .attr('r', ringRadius)
        .attr('fill', 'none')
        .attr('stroke', color)
        .attr('stroke-width', ann.tier === 'blunder' ? 2.5 : 2)
        .attr('opacity', 0.9)
        .attr('pointer-events', 'none');
    });

    // Node shapes — circles for repertoire nodes, squares for overlay nodes
    // Repertoire nodes (circles)
    nodeGroups
      .filter((d: any) => !d.data._isOverlay)
      .append('circle')
      .attr('r', (d: any) => getNodeRadius(d.data, maxGameCount))
      .attr('fill', (d: any) => {
        if (d.data.id === currentNode.id) return '#00d4aa';
        return getNodeColor(d.data);
      })
      .attr('stroke', (d: any) => {
        if (d.data.id === currentNode.id) return '#00d4aa';
        if (currentPathIds.has(d.data.id)) return '#00d4aa';
        if (d.data.depth > 0 && isWhiteMove(d.data)) return '#d4c5a0';
        if (d.data.depth > 0) return '#2d4070';
        return 'transparent';
      })
      .attr('stroke-width', (d: any) => {
        if (d.data.id === currentNode.id) return 3;
        if (currentPathIds.has(d.data.id)) return 2;
        if (d.data.depth > 0) return 1.5;
        return 0;
      })
      .attr('opacity', (d: any) => {
        if (currentPathIds.has(d.data.id)) return 1;
        return 0.8;
      })
      .classed('tree-node-glow', (d: any) => d.data.id === currentNode.id);

    // Overlay nodes (squares) — greyed-out, slightly smaller
    const overlaySize = 18; // side length of the square
    nodeGroups
      .filter((d: any) => d.data._isOverlay)
      .append('rect')
      .attr('x', -overlaySize / 2)
      .attr('y', -overlaySize / 2)
      .attr('width', overlaySize)
      .attr('height', overlaySize)
      .attr('rx', 3)
      .attr('ry', 3)
      .attr('fill', (d: any) => getOverlayNodeColor(d.data))
      .attr('stroke', (d: any) => {
        if (isWhiteMove(d.data)) return '#b0b0b0';
        return '#555';
      })
      .attr('stroke-width', 1.2)
      .attr('stroke-dasharray', '3,2')
      .attr('opacity', 0.7);

    // Game-overlap ring: dashed outer ring on real nodes that also appear in imported games
    nodeGroups
      .filter((d: any) => !d.data._isOverlay && d.data._gameOverlapNames && d.data._gameOverlapNames.length > 0)
      .append('circle')
      .attr('r', (d: any) => getNodeRadius(d.data, maxGameCount) + 4)
      .attr('fill', 'none')
      .attr('stroke', '#6a6a80')
      .attr('stroke-width', 1.2)
      .attr('stroke-dasharray', '3,2')
      .attr('opacity', 0.7)
      .attr('pointer-events', 'none');

    // Collapse indicator (+ symbol for collapsed nodes, skip overlay)
    nodeGroups
      .filter((d: any) => d.data._collapsed && !d.data._isOverlay)
      .append('text')
      .attr('x', 0)
      .attr('y', 1)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-size', '10px')
      .attr('font-weight', 'bold')
      .attr('fill', (d: any) => getNodeTextColor(d.data))
      .attr('pointer-events', 'none')
      .text('+');

    // Move labels — rendered inside the node circle
    nodeGroups
      .filter((d: any) => d.data.move !== '')
      .append('text')
      .attr('x', 0)
      .attr('y', 1)
      .attr('text-anchor', 'middle')
      .attr('dominant-baseline', 'middle')
      .attr('font-family', '"JetBrains Mono", monospace')
      .attr('font-size', (d: any) => d.data._isOverlay ? '9px' : '10px')
      .attr('font-weight', '600')
      .attr('fill', (d: any) => {
        if (d.data._isOverlay) return getOverlayTextColor(d.data);
        if (d.data.id === currentNode.id) return '#0f0f17';
        return getNodeTextColor(d.data);
      })
      .attr('opacity', (d: any) => d.data._isOverlay ? 0.85 : 1)
      .attr('pointer-events', 'none')
      .text((d: any) => d.data.move);

    // Game count labels (for nodes with significant counts, skip overlay nodes)
    nodeGroups
      .filter((d: any) => !d.data._isOverlay && d.data.gameCount > 0)
      .append('text')
      .attr('x', 0)
      .attr('y', (d: any) => getNodeRadius(d.data, maxGameCount) + 12)
      .attr('text-anchor', 'middle')
      .attr('font-family', '"JetBrains Mono", monospace')
      .attr('font-size', '8px')
      .attr('fill', '#6a6a82')
      .attr('pointer-events', 'none')
      .text((d: any) => {
        if (d.data.gameCount >= 1000) return `${(d.data.gameCount / 1000).toFixed(1)}k`;
        return d.data.gameCount.toString();
      });
  // Note: We intentionally exclude mistakeMap from deps — it's accessed via ref
  // to avoid full D3 re-render on every game import / review toggle.
  // The separate useMemo above ensures mistakeMap is current on each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, currentNode, currentPath, expandedNodes, getMaxGameCount, onNodeClick, onAddMove, onAddLine, onAddOverlayLine, toggleExpand, showGameOverlay,
      importedGames.length, importedGames.filter(g => g.analyzed).length,
      importedGames.reduce((s, g) => s + g.mistakes.filter(m => m.reviewed).length, 0),
      dismissedOverlayFens,
      nodeAnnotations.size]);

  return (
    <div ref={containerRef} className="w-full h-full relative overflow-hidden">
      <svg
        ref={svgRef}
        className="w-full h-full"
        style={{ background: 'transparent' }}
      />
      <TreeTooltip
        node={tooltip.node}
        overlayMove={tooltip.overlayMove || undefined}
        x={tooltip.x}
        y={tooltip.y}
        visible={tooltip.visible}
        mistakeInfo={tooltip.mistakeInfo || undefined}
      />
      {/* Context menu */}
      {contextMenu.visible && contextMenu.node && (
        <div
          className="fixed z-50 bg-bg-surface border border-border-subtle rounded-lg shadow-xl py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-xs text-text-muted border-b border-border-subtle font-mono">
            {contextMenu.node.move}
            {contextMenu.isOverlay && (
              <span className="ml-1.5 text-[9px] opacity-60">(game)</span>
            )}
          </div>
          {contextMenu.isOverlay ? (
            <button
              className="w-full text-left px-3 py-2 text-sm text-text-secondary hover:bg-bg-hover transition-colors flex items-center gap-2"
              onClick={() => {
                if (contextMenu.overlayFen) {
                  setDismissedOverlayFens((prev) => {
                    const next = new Set(prev);
                    next.add(contextMenu.overlayFen!);
                    return next;
                  });
                }
                setContextMenu({ node: null, isOverlay: false, x: 0, y: 0, visible: false });
              }}
            >
              <span>✕</span>
              <span>Hide move</span>
            </button>
          ) : exploreMode ? (
            <div className="px-3 py-2 text-xs text-text-muted italic">
              Explore mode — editing disabled
            </div>
          ) : (
            <button
              className="w-full text-left px-3 py-2 text-sm text-accent-red hover:bg-bg-hover transition-colors flex items-center gap-2"
              onClick={() => {
                if (contextMenu.node) {
                  onDeleteNode(contextMenu.node.id);
                }
                setContextMenu({ node: null, isOverlay: false, x: 0, y: 0, visible: false });
              }}
            >
              <span>✕</span>
              <span>Delete move</span>
            </button>
          )}
        </div>
      )}
      {/* Explore mode banner */}
      {exploreMode && (
        <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-mono bg-[#00d4aa]/15 border border-[#00d4aa]/40 text-[#00d4aa] pointer-events-none select-none">
          <span>Explore mode — clicks navigate only</span>
        </div>
      )}
      {/* Zoom controls */}
      <div className="absolute bottom-3 right-3 flex flex-col gap-1">
        <button
          className="btn-icon bg-bg-surface/80 backdrop-blur-sm border border-border-subtle w-7 h-7 flex items-center justify-center text-xs font-mono"
          onClick={() => {
            if (svgRef.current && zoomRef.current) {
              d3.select(svgRef.current)
                .transition()
                .duration(300)
                .call(zoomRef.current.scaleBy, 1.3);
            }
          }}
          title="Zoom in"
        >
          +
        </button>
        <button
          className="btn-icon bg-bg-surface/80 backdrop-blur-sm border border-border-subtle w-7 h-7 flex items-center justify-center text-xs font-mono"
          onClick={() => {
            if (svgRef.current && zoomRef.current) {
              d3.select(svgRef.current)
                .transition()
                .duration(300)
                .call(zoomRef.current.scaleBy, 0.7);
            }
          }}
          title="Zoom out"
        >
          −
        </button>
        <button
          className="btn-icon bg-bg-surface/80 backdrop-blur-sm border border-border-subtle w-7 h-7 flex items-center justify-center text-[9px] font-mono"
          onClick={() => {
            if (svgRef.current && zoomRef.current && containerRef.current) {
              const height = containerRef.current.clientHeight;
              const resetTransform = d3.zoomIdentity.translate(60, height / 2).scale(0.9);
              transformRef.current = resetTransform;
              d3.select(svgRef.current)
                .transition()
                .duration(500)
                .call(
                  zoomRef.current.transform,
                  resetTransform
                );
            }
          }}
          title="Reset view"
        >
          ⟲
        </button>
        <button
          className={`btn-icon backdrop-blur-sm border w-7 h-7 flex items-center justify-center text-[8px] font-mono font-bold transition-colors ${
            exploreMode
              ? 'bg-[#00d4aa]/20 border-[#00d4aa]/60 text-[#00d4aa]'
              : 'bg-bg-surface/80 border-border-subtle text-text-muted'
          }`}
          onClick={() => setExploreMode((prev) => !prev)}
          title={exploreMode ? 'Explore mode ON — click to disable' : 'Enable explore mode (navigate without adding moves)'}
        >
          expl.
        </button>
      </div>
    </div>
  );
};
