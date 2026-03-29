import React, { createContext, useContext, useReducer, useEffect, ReactNode } from 'react';
import type { TreeNode, RepertoireState, RepertoireAction } from '../types';
import {
  findNodeById,
  getPathToNode,
  addMoveToTree,
  addLineToTree,
  removeNodeImmutable,
  createRootNode,
  cloneTreeWithFreshIds,
  findDuplicateNodeIds,
  syncNodeIdCounterToTree,
} from '../utils/treeBuilder';

// Create context
const RepertoireContext = createContext<{
  state: RepertoireState;
  dispatch: React.Dispatch<RepertoireAction>;
} | null>(null);

function resolveSelection(tree: TreeNode, targetId: string): Pick<RepertoireState, 'currentNode' | 'currentPath'> {
  const path = getPathToNode(tree, targetId) ?? [tree];
  return {
    currentNode: path[path.length - 1],
    currentPath: path,
  };
}

// Initial state
function getInitialState(): RepertoireState {
  const root = createRootNode();
  return {
    tree: root,
    currentNode: root,
    currentPath: [root],
    orientation: 'white',
    selectedColor: 'both',
  };
}

// Reducer
function repertoireReducer(state: RepertoireState, action: RepertoireAction): RepertoireState {
  switch (action.type) {
    case 'SET_TREE': {
      const normalizedTree = cloneTreeWithFreshIds(action.tree);
      syncNodeIdCounterToTree(normalizedTree);
      return {
        ...state,
        tree: normalizedTree,
        ...resolveSelection(normalizedTree, normalizedTree.id),
      };
    }

    case 'NAVIGATE_TO_NODE': {
      // If already at this node, no-op to prevent unnecessary re-renders
      if (state.currentNode.id === action.node.id) return state;

      const path = getPathToNode(state.tree, action.node.id);
      if (path) {
        return {
          ...state,
          ...resolveSelection(state.tree, action.node.id),
        };
      }
      return state;
    }

    case 'NAVIGATE_FORWARD': {
      const selection = resolveSelection(state.tree, state.currentNode.id);
      const liveCurrentNode = selection.currentNode;
      const childIndex = action.childIndex ?? 0;
      if (childIndex < liveCurrentNode.children.length) {
        const child = liveCurrentNode.children[childIndex];
        return {
          ...state,
          ...resolveSelection(state.tree, child.id),
        };
      }
      return state;
    }

    case 'NAVIGATE_BACK': {
      const selection = resolveSelection(state.tree, state.currentNode.id);
      if (selection.currentNode.parentId) {
        const parent = findNodeById(state.tree, selection.currentNode.parentId);
        if (parent) {
          return {
            ...state,
            ...resolveSelection(state.tree, parent.id),
          };
        }
      }
      return state;
    }

    case 'NAVIGATE_TO_START': {
      return {
        ...state,
        ...resolveSelection(state.tree, state.tree.id),
      };
    }

    case 'NAVIGATE_TO_END': {
      let current = resolveSelection(state.tree, state.currentNode.id).currentNode;

      while (current.children.length > 0) {
        current = current.children[0];
      }

      return {
        ...state,
        ...resolveSelection(state.tree, current.id),
      };
    }

    case 'FLIP_BOARD': {
      return {
        ...state,
        orientation: state.orientation === 'white' ? 'black' : 'white',
      };
    }

    case 'SET_ORIENTATION': {
      return {
        ...state,
        orientation: action.orientation,
      };
    }

    case 'SET_COMMENT': {
      const node = findNodeById(state.tree, action.nodeId);
      if (node) {
        node.comment = action.comment;
        // Update current node if it's the one being modified
        if (state.currentNode.id === action.nodeId) {
          return {
            ...state,
            ...resolveSelection(state.tree, action.nodeId),
          };
        }
      }
      return state;
    }

    case 'ADD_NAG': {
      const node = findNodeById(state.tree, action.nodeId);
      if (node && !node.nags.includes(action.nag)) {
        node.nags.push(action.nag);
        // Update current node if it's the one being modified
        if (state.currentNode.id === action.nodeId) {
          return {
            ...state,
            ...resolveSelection(state.tree, action.nodeId),
          };
        }
      }
      return state;
    }

    case 'REMOVE_NAG': {
      const node = findNodeById(state.tree, action.nodeId);
      if (node) {
        node.nags = node.nags.filter((n) => n !== action.nag);
        // Update current node if it's the one being modified
        if (state.currentNode.id === action.nodeId) {
          return {
            ...state,
            ...resolveSelection(state.tree, action.nodeId),
          };
        }
      }
      return state;
    }

    case 'ADD_MOVE': {
      const newNode = addMoveToTree(state.tree, action.parentId, action.move, action.fen);
      if (newNode) {
        // Create a new tree root reference so D3 detects the structural change
        // (the tree was mutated in place by addMoveToTree, but React compares
        // by reference — without this, the D3 useEffect may not re-render)
        const updatedTree = { ...state.tree };
        if (action.navigateToNewNode === false) {
          return {
            ...state,
            tree: updatedTree,
            ...resolveSelection(updatedTree, state.currentNode.id),
          };
        }
        return {
          ...state,
          tree: updatedTree,
          ...resolveSelection(updatedTree, newNode.id),
        };
      }
      return state;
    }

    case 'ADD_MOVE_LINE': {
      const lastNode = addLineToTree(state.tree, action.parentId, action.moves);
      if (lastNode) {
        const updatedTree = { ...state.tree };
        if (action.navigateToNewNode === false) {
          return {
            ...state,
            tree: updatedTree,
            ...resolveSelection(updatedTree, state.currentNode.id),
          };
        }
        return {
          ...state,
          tree: updatedTree,
          ...resolveSelection(updatedTree, lastNode.id),
        };
      }
      return state;
    }

    case 'SET_SELECTED_COLOR': {
      return {
        ...state,
        selectedColor: action.color,
      };
    }

    case 'DELETE_NODE': {
      // Cannot delete root
      if (state.tree.id === action.nodeId) return state;

      // Capture the parent ID before rebuilding the tree
      const nodeToDelete = findNodeById(state.tree, action.nodeId);
      if (!nodeToDelete || !nodeToDelete.parentId) return state;
      const parentId = nodeToDelete.parentId;

      // Build a fully new tree (all ancestors of the deleted node get new
      // object references) so React and D3 reliably detect the change.
      const newTree = removeNodeImmutable(state.tree, action.nodeId);
      if (!newTree) return state;

      // Resolve the parent node from the NEW tree so currentNode/currentPath
      // always reference objects that belong to the updated tree.
      const newParent = findNodeById(newTree, parentId) ?? newTree;
      const newParentPath = getPathToNode(newTree, newParent.id) ?? [newParent];

      // If the deleted node (or one of its ancestors) was on the current path,
      // navigate back to the parent.
      const isCurrentOrAncestor = state.currentPath.some((n) => n.id === action.nodeId);
      if (isCurrentOrAncestor) {
        return {
          ...state,
          tree: newTree,
          currentNode: newParent,
          currentPath: newParentPath,
        };
      }

      // Otherwise keep the current position but refresh references from the
      // new tree so there are no stale object pointers.
      const refreshedPath = getPathToNode(newTree, state.currentNode.id);
      if (refreshedPath) {
        return {
          ...state,
          tree: newTree,
          currentNode: refreshedPath[refreshedPath.length - 1],
          currentPath: refreshedPath,
        };
      }

      // Fallback: current node was somehow not found (shouldn't happen),
      // reset to root.
      return {
        ...state,
        tree: newTree,
        currentNode: newTree,
        currentPath: [newTree],
      };
    }

    default:
      return state;
  }
}

// Provider component
export function RepertoireProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(repertoireReducer, undefined, getInitialState);

  useEffect(() => {
    if (!import.meta.env.DEV) return;

    const duplicates = findDuplicateNodeIds(state.tree);
    if (duplicates.length > 0) {
      console.warn(
        '[main-line] Duplicate node IDs detected in live repertoire tree.',
        duplicates
      );
    }
  }, [state.tree]);

  return (
    <RepertoireContext.Provider value={{ state, dispatch }}>
      {children}
    </RepertoireContext.Provider>
  );
}

// Hook to use context
export function useRepertoire() {
  const context = useContext(RepertoireContext);
  if (!context) {
    throw new Error('useRepertoire must be used within RepertoireProvider');
  }
  return context;
}
