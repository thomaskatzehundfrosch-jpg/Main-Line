import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import type { TreeNode, RepertoireState, RepertoireAction } from '../types';
import {
  findNodeById,
  getPathToNode,
  addMoveToTree,
  addLineToTree,
  removeNodeImmutable,
  createRootNode,
} from '../utils/treeBuilder';

// Create context
const RepertoireContext = createContext<{
  state: RepertoireState;
  dispatch: React.Dispatch<RepertoireAction>;
} | null>(null);

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
      return {
        ...state,
        tree: action.tree,
        currentNode: action.tree,
        currentPath: [action.tree],
      };
    }

    case 'NAVIGATE_TO_NODE': {
      // If already at this node, no-op to prevent unnecessary re-renders
      if (state.currentNode.id === action.node.id) return state;

      const path = getPathToNode(state.tree, action.node.id);
      if (path) {
        return {
          ...state,
          // Use the actual tree node (last element of path) rather than the
          // action's node, which might be a D3 visualization copy with empty children
          currentNode: path[path.length - 1],
          currentPath: path,
        };
      }
      return state;
    }

    case 'NAVIGATE_FORWARD': {
      const childIndex = action.childIndex ?? 0;
      if (childIndex < state.currentNode.children.length) {
        const child = state.currentNode.children[childIndex];
        const path = getPathToNode(state.tree, child.id);
        return {
          ...state,
          currentNode: child,
          currentPath: path || [...state.currentPath, child],
        };
      }
      return state;
    }

    case 'NAVIGATE_BACK': {
      if (state.currentNode.parentId) {
        const parent = findNodeById(state.tree, state.currentNode.parentId);
        if (parent) {
          const path = getPathToNode(state.tree, parent.id);
          return {
            ...state,
            currentNode: parent,
            currentPath: path || [parent],
          };
        }
      }
      return state;
    }

    case 'NAVIGATE_TO_START': {
      return {
        ...state,
        currentNode: state.tree,
        currentPath: [state.tree],
      };
    }

    case 'NAVIGATE_TO_END': {
      let current = state.currentNode;
      let path = state.currentPath;

      while (current.children.length > 0) {
        const next = current.children[0];
        const newPath = getPathToNode(state.tree, next.id);
        path = newPath || [...path, next];
        current = next;
      }

      return {
        ...state,
        currentNode: current,
        currentPath: path,
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
            currentNode: { ...state.currentNode, comment: action.comment },
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
            currentNode: { ...state.currentNode, nags: [...node.nags] },
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
            currentNode: { ...state.currentNode, nags: [...node.nags] },
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
        const path = getPathToNode(updatedTree, newNode.id);
        return {
          ...state,
          tree: updatedTree,
          currentNode: newNode,
          currentPath: path || [...state.currentPath, newNode],
        };
      }
      return state;
    }

    case 'ADD_MOVE_LINE': {
      const lastNode = addLineToTree(state.tree, action.parentId, action.moves);
      if (lastNode) {
        const updatedTree = { ...state.tree };
        if (action.noNavigate) {
          // Structural change only — keep the current position in the tree.
          return { ...state, tree: updatedTree };
        }
        const path = getPathToNode(updatedTree, lastNode.id);
        return {
          ...state,
          tree: updatedTree,
          currentNode: lastNode,
          currentPath: path || state.currentPath,
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
