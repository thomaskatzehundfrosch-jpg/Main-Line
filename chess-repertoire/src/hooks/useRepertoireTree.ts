import { useCallback } from 'react';
import { useRepertoire } from '../context/RepertoireContext';
import type { TreeNode } from '../types';

/**
 * Hook providing convenient tree operations on top of the RepertoireContext.
 */
export function useRepertoireTree() {
  const { state, dispatch } = useRepertoire();

  const setTree = useCallback(
    (tree: TreeNode) => {
      dispatch({ type: 'SET_TREE', tree });
    },
    [dispatch]
  );

  const navigateToNode = useCallback(
    (node: TreeNode) => {
      dispatch({ type: 'NAVIGATE_TO_NODE', node });
    },
    [dispatch]
  );

  const navigateForward = useCallback(
    (childIndex?: number) => {
      dispatch({ type: 'NAVIGATE_FORWARD', childIndex });
    },
    [dispatch]
  );

  const navigateBack = useCallback(() => {
    dispatch({ type: 'NAVIGATE_BACK' });
  }, [dispatch]);

  const navigateToStart = useCallback(() => {
    dispatch({ type: 'NAVIGATE_TO_START' });
  }, [dispatch]);

  const navigateToEnd = useCallback(() => {
    dispatch({ type: 'NAVIGATE_TO_END' });
  }, [dispatch]);

  const flipBoard = useCallback(() => {
    dispatch({ type: 'FLIP_BOARD' });
  }, [dispatch]);

  const setComment = useCallback(
    (nodeId: string, comment: string) => {
      dispatch({ type: 'SET_COMMENT', nodeId, comment });
    },
    [dispatch]
  );

  const addNag = useCallback(
    (nodeId: string, nag: number) => {
      dispatch({ type: 'ADD_NAG', nodeId, nag });
    },
    [dispatch]
  );

  const removeNag = useCallback(
    (nodeId: string, nag: number) => {
      dispatch({ type: 'REMOVE_NAG', nodeId, nag });
    },
    [dispatch]
  );

  const addMove = useCallback(
    (move: string, fen: string) => {
      dispatch({
        type: 'ADD_MOVE',
        parentId: state.currentNode.id,
        move,
        fen,
      });
    },
    [dispatch, state.currentNode.id]
  );

  const addMoveToNode = useCallback(
    (parentId: string, move: string, fen: string) => {
      dispatch({
        type: 'ADD_MOVE',
        parentId,
        move,
        fen,
      });
    },
    [dispatch]
  );

  const addLineToNode = useCallback(
    (parentId: string, moves: { move: string; fen: string }[]) => {
      dispatch({ type: 'ADD_MOVE_LINE', parentId, moves });
    },
    [dispatch]
  );

  const addLineToNodeNoNavigate = useCallback(
    (parentId: string, moves: { move: string; fen: string }[]) => {
      dispatch({ type: 'ADD_MOVE_LINE', parentId, moves, noNavigate: true });
    },
    [dispatch]
  );

  const deleteNode = useCallback(
    (nodeId: string) => {
      dispatch({ type: 'DELETE_NODE', nodeId });
    },
    [dispatch]
  );

  const setSelectedColor = useCallback(
    (color: 'white' | 'black' | 'both') => {
      dispatch({ type: 'SET_SELECTED_COLOR', color });
    },
    [dispatch]
  );

  /**
   * Get win/draw/loss percentages for a node.
   */
  const getNodeStats = useCallback((node: TreeNode) => {
    const total = node.gameCount;
    if (total === 0) return { whiteWinPct: 0, blackWinPct: 0, drawPct: 0 };
    return {
      whiteWinPct: (node.whiteWins / total) * 100,
      blackWinPct: (node.blackWins / total) * 100,
      drawPct: (node.draws / total) * 100,
    };
  }, []);

  /**
   * Check if a node is in the current path.
   */
  const isInCurrentPath = useCallback(
    (nodeId: string) => {
      return state.currentPath.some((n) => n.id === nodeId);
    },
    [state.currentPath]
  );

  /**
   * Get current move number (1-based).
   */
  const currentMoveNumber = Math.ceil(state.currentNode.depth / 2);
  const isWhiteToMove = state.currentNode.depth % 2 === 0;

  return {
    tree: state.tree,
    currentNode: state.currentNode,
    currentPath: state.currentPath,
    orientation: state.orientation,
    selectedColor: state.selectedColor,
    currentMoveNumber,
    isWhiteToMove,
    setTree,
    navigateToNode,
    navigateForward,
    navigateBack,
    navigateToStart,
    navigateToEnd,
    flipBoard,
    setComment,
    addNag,
    removeNag,
    addMove,
    addMoveToNode,
    addLineToNode,
    addLineToNodeNoNavigate,
    deleteNode,
    setSelectedColor,
    getNodeStats,
    isInCurrentPath,
  };
}
