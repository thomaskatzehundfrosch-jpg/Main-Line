/**
 * React hook wrapping the generator tree builder with React state management.
 * Also supports manual tree building by playing moves on the board.
 */

import { useState, useRef, useCallback } from 'react';
import type {
  GeneratorNode,
  GeneratorSettings,
  GeneratorProgress,
  GeneratorLogEntry,
} from '../types/generator';
import { buildTree } from '../engine/generatorTreeBuilder';

/* ------------------------------------------------------------------ */
/*  Helper utilities for manual tree building                         */
/* ------------------------------------------------------------------ */

const DEFAULT_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

let _manualNodeId = 0;

function findNodeInTree(root: GeneratorNode, id: string): GeneratorNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNodeInTree(child, id);
    if (found) return found;
  }
  return null;
}

function findParentInTree(root: GeneratorNode, childId: string): GeneratorNode | null {
  for (const child of root.children) {
    if (child.id === childId) return root;
    const found = findParentInTree(child, childId);
    if (found) return found;
  }
  return null;
}

function deepCloneNode(node: GeneratorNode): GeneratorNode {
  return {
    ...node,
    stockfish: node.stockfish ? { ...node.stockfish } : null,
    lichess: node.lichess ? { ...node.lichess } : null,
    children: node.children.map(deepCloneNode),
  };
}

/** Extract all root-to-leaf paths as SAN move arrays (for use as generation seeds). */
export function extractLeafPaths(node: GeneratorNode, path: string[] = []): string[][] {
  if (node.children.length === 0) {
    return path.length > 0 ? [path] : [];
  }
  const paths: string[][] = [];
  for (const child of node.children) {
    if (child.san) {
      paths.push(...extractLeafPaths(child, [...path, child.san]));
    }
  }
  return paths.length > 0 ? paths : (path.length > 0 ? [path] : []);
}

function createRootNode(color: 'white' | 'black'): GeneratorNode {
  return {
    id: 'root',
    san: null,
    uci: '',
    fen: DEFAULT_FEN,
    fullMoveNumber: 0,
    isOurMove: color === 'white',
    depth: 0,
    stockfish: null,
    lichess: null,
    isMainLine: false,
    isDangerous: false,
    cappedByMoveLimit: false,
    children: [],
    isRoot: true,
  };
}

/* ------------------------------------------------------------------ */
/*  Module-level cache — survives component unmount/remount           */
/* ------------------------------------------------------------------ */

let _cachedTree: GeneratorNode | null = null;
let _cachedSelectedNodeId: string | null = null;

/* ------------------------------------------------------------------ */
/*  Hook interface                                                     */
/* ------------------------------------------------------------------ */

export interface UseGeneratorReturn {
  tree: GeneratorNode | null;
  setTree: React.Dispatch<React.SetStateAction<GeneratorNode | null>>;
  selectedNode: GeneratorNode | null;
  setSelectedNode: React.Dispatch<React.SetStateAction<GeneratorNode | null>>;
  isGenerating: boolean;
  progress: GeneratorProgress;
  errorLog: GeneratorLogEntry[];
  setErrorLog: React.Dispatch<React.SetStateAction<GeneratorLogEntry[]>>;
  startGeneration: (settings: GeneratorSettings, pgnSeeds: string[][] | null, sfWorker: Worker | null) => void;
  stopGeneration: () => void;
  clearTree: () => void;
  stopRef: React.MutableRefObject<boolean>;
  addLogEntry: (entry: GeneratorLogEntry) => void;
  /* Manual tree building */
  addManualMove: (san: string, uci: string, newFen: string, color: 'white' | 'black') => boolean;
  goToParent: () => void;
  goToChild: (index?: number) => void;
  goToRoot: () => void;
  deleteSelected: () => void;
  getSeeds: () => string[][];
}

const INITIAL_PROGRESS: GeneratorProgress = {
  nodes: 0,
  maxNodes: 300,
  status: '',
  apiCalls: 0,
};

export function useGenerator(): UseGeneratorReturn {
  // Restore from module-level cache so state survives navigating away and back
  const [tree, _setTree] = useState<GeneratorNode | null>(() => _cachedTree);
  const [selectedNode, _setSelectedNode] = useState<GeneratorNode | null>(() => {
    if (_cachedTree && _cachedSelectedNodeId) {
      return findNodeInTree(_cachedTree, _cachedSelectedNodeId);
    }
    return null;
  });
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState<GeneratorProgress>(INITIAL_PROGRESS);
  const [errorLog, setErrorLog] = useState<GeneratorLogEntry[]>([]);
  const stopRef = useRef(false);

  // Wrapped setters that also update the module-level cache
  const setTree = useCallback((val: GeneratorNode | null | ((prev: GeneratorNode | null) => GeneratorNode | null)) => {
    _setTree((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      _cachedTree = next;
      return next;
    });
  }, []);

  const setSelectedNode = useCallback((val: GeneratorNode | null | ((prev: GeneratorNode | null) => GeneratorNode | null)) => {
    _setSelectedNode((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      _cachedSelectedNodeId = next?.id ?? null;
      return next;
    });
  }, []);

  const addLogEntry = useCallback((entry: GeneratorLogEntry) => {
    setErrorLog((prev) => [...prev, entry]);
  }, []);

  const startGeneration = useCallback(
    (settings: GeneratorSettings, pgnSeeds: string[][] | null, sfWorker: Worker | null) => {
      stopRef.current = false;
      setIsGenerating(true);
      setErrorLog([]);
      setProgress({
        nodes: 0,
        maxNodes: settings.maxNodes || 300,
        status: 'Starting...',
        apiCalls: 0,
      });
      setTree(null);
      setSelectedNode(null);

      const callbacks = {
        onNodeAdded: (updatedRoot: GeneratorNode) => {
          setTree(updatedRoot);
        },
        onLog: (entry: GeneratorLogEntry) => {
          addLogEntry(entry);
        },
        onProgress: (prog: GeneratorProgress) => {
          setProgress(prog);
        },
        onComplete: (finalRoot: GeneratorNode) => {
          setTree(finalRoot);
          setIsGenerating(false);
        },
      };

      buildTree(pgnSeeds, settings, callbacks, stopRef, sfWorker).catch((err: any) => {
        addLogEntry({
          id: `log_error_${Date.now()}`,
          timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
          level: 'error',
          message: `Tree building failed: ${err.message}`,
          context: null,
        });
        setIsGenerating(false);
      });
    },
    [addLogEntry]
  );

  const stopGeneration = useCallback(() => {
    stopRef.current = true;
    setIsGenerating(false);
    addLogEntry({
      id: `log_stop_${Date.now()}`,
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
      level: 'info',
      message: 'Generation stopped by user.',
      context: null,
    });
  }, [addLogEntry]);

  const clearTree = useCallback(() => {
    _cachedTree = null;
    _cachedSelectedNodeId = null;
    setTree(null);
    setSelectedNode(null);
    setErrorLog([]);
    setProgress(INITIAL_PROGRESS);
  }, [setTree, setSelectedNode]);

  /* -------------------------------------------------------------- */
  /*  Manual tree building methods                                   */
  /* -------------------------------------------------------------- */

  const addManualMove = useCallback(
    (san: string, uci: string, newFen: string, color: 'white' | 'black'): boolean => {
      let currentTree = tree;
      let currentSelected = selectedNode;

      // Auto-initialize tree on first move
      if (!currentTree) {
        currentTree = createRootNode(color);
        currentSelected = currentTree;
      }
      if (!currentSelected) currentSelected = currentTree;

      // If the move already exists as a child, just navigate to it
      const existing = currentSelected.children.find((c) => c.san === san);
      if (existing) {
        const cloned = deepCloneNode(currentTree);
        const target = findNodeInTree(cloned, existing.id);
        setTree(cloned);
        if (target) setSelectedNode(target);
        return true;
      }

      // Determine isOurMove from who just moved
      const parentTurn = currentSelected.fen.split(' ')[1]; // 'w' or 'b'
      const isOurMove =
        (parentTurn === 'w' && color === 'white') ||
        (parentTurn === 'b' && color === 'black');

      const parentFullMove = parseInt(currentSelected.fen.split(' ')[5], 10) || 1;

      const newNode: GeneratorNode = {
        id: `manual_${++_manualNodeId}_${Date.now()}`,
        san,
        uci,
        fen: newFen,
        fullMoveNumber: parentFullMove,
        isOurMove,
        depth: (currentSelected.depth || 0) + 1,
        stockfish: null,
        lichess: null,
        isMainLine: currentSelected.children.length === 0,
        isDangerous: false,
        cappedByMoveLimit: false,
        children: [],
      };

      // Clone tree → mutate clone → set state
      const cloned = deepCloneNode(currentTree);
      const parentInClone = findNodeInTree(cloned, currentSelected.id);
      if (!parentInClone) return false;

      parentInClone.children.push(newNode);
      setTree(cloned);

      const added = findNodeInTree(cloned, newNode.id);
      if (added) setSelectedNode(added);
      return true;
    },
    [tree, selectedNode]
  );

  const goToParent = useCallback(() => {
    if (!tree || !selectedNode || selectedNode.isRoot) return;
    const parent = findParentInTree(tree, selectedNode.id);
    if (parent) setSelectedNode(parent);
  }, [tree, selectedNode]);

  const goToChild = useCallback(
    (index: number = 0) => {
      if (!selectedNode || selectedNode.children.length === 0) return;
      const idx = Math.min(index, selectedNode.children.length - 1);
      setSelectedNode(selectedNode.children[idx]);
    },
    [selectedNode]
  );

  const goToRoot = useCallback(() => {
    if (tree) setSelectedNode(tree);
  }, [tree]);

  const deleteSelected = useCallback(() => {
    if (!tree || !selectedNode || selectedNode.isRoot) return;
    const parent = findParentInTree(tree, selectedNode.id);
    if (!parent) return;

    const cloned = deepCloneNode(tree);
    const parentInClone = findNodeInTree(cloned, parent.id);
    if (!parentInClone) return;

    parentInClone.children = parentInClone.children.filter(
      (c) => c.id !== selectedNode.id
    );
    setTree(cloned);
    setSelectedNode(parentInClone);
  }, [tree, selectedNode]);

  const getSeeds = useCallback((): string[][] => {
    if (!tree) return [];
    return extractLeafPaths(tree);
  }, [tree]);

  return {
    tree,
    setTree,
    selectedNode,
    setSelectedNode,
    isGenerating,
    progress,
    errorLog,
    setErrorLog,
    startGeneration,
    stopGeneration,
    clearTree,
    stopRef,
    addLogEntry,
    addManualMove,
    goToParent,
    goToChild,
    goToRoot,
    deleteSelected,
    getSeeds,
  };
}
