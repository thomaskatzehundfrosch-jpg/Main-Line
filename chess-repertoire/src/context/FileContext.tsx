import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef, ReactNode } from 'react';
import type { RepertoireFile } from '../types/repertoireFile';
import type { TreeNode } from '../types';
import type { ImportedGame } from '../types/game';
import { generateFileId } from '../types/repertoireFile';
import { cloneTreeWithFreshIds, countNodes } from '../utils/treeBuilder';
import { safePersist, logger } from '../utils/errorLogger';
import { useAuth } from './AuthContext';
import {
  fetchRemoteFiles,
  upsertRemoteFile,
  deleteRemoteFile,
  pushAllFilesToCloud,
} from '../lib/supabaseSync';

const STORAGE_KEY = 'main-line-files';
const ACTIVE_KEY = 'main-line-active-file';
const DEBOUNCE_MS = 500;

// ─── State ────────────────────────────────────────────────────────────
export interface FileState {
  files: RepertoireFile[];
  activeFileId: string | null; // which file is currently loaded
}

// ─── Actions ──────────────────────────────────────────────────────────
export type FileAction =
  | { type: 'SET_FILES'; files: RepertoireFile[] }
  | { type: 'SAVE_FILE'; file: RepertoireFile }
  | { type: 'UPDATE_FILE'; id: string; tree: TreeNode }
  | { type: 'UPDATE_FILE_GAMES'; id: string; games: ImportedGame[] }
  | { type: 'DELETE_FILE'; id: string }
  | { type: 'RENAME_FILE'; id: string; name: string }
  | { type: 'SET_ACTIVE'; id: string | null };

// ─── Reducer ──────────────────────────────────────────────────────────
function fileReducer(state: FileState, action: FileAction): FileState {
  switch (action.type) {
    case 'SET_FILES':
      return { ...state, files: action.files };

    case 'SAVE_FILE': {
      const exists = state.files.find((f) => f.id === action.file.id);
      if (exists) {
        return {
          ...state,
          files: state.files.map((f) =>
            f.id === action.file.id ? action.file : f
          ),
          activeFileId: action.file.id,
        };
      }
      return {
        ...state,
        files: [...state.files, action.file],
        activeFileId: action.file.id,
      };
    }

    case 'UPDATE_FILE':
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.id
            ? {
                ...f,
                tree: action.tree,
                nodeCount: countNodes(action.tree),
                updatedAt: new Date().toISOString(),
              }
            : f
        ),
      };

    case 'DELETE_FILE': {
      const newFiles = state.files.filter((f) => f.id !== action.id);
      return {
        ...state,
        files: newFiles,
        activeFileId:
          state.activeFileId === action.id ? null : state.activeFileId,
      };
    }

    case 'UPDATE_FILE_GAMES':
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.id ? { ...f, importedGames: action.games } : f
        ),
      };

    case 'RENAME_FILE':
      return {
        ...state,
        files: state.files.map((f) =>
          f.id === action.id
            ? { ...f, name: action.name, updatedAt: new Date().toISOString() }
            : f
        ),
      };

    case 'SET_ACTIVE':
      return { ...state, activeFileId: action.id };

    default:
      return state;
  }
}

// ─── Persistence ──────────────────────────────────────────────────────

function loadFiles(): RepertoireFile[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const files = JSON.parse(raw) as RepertoireFile[];
      return files.map((file) => {
        const tree = cloneTreeWithFreshIds(file.tree);
        return {
          ...file,
          tree,
          nodeCount: countNodes(tree),
        };
      });
    }
  } catch (err) {
    logger.error(
      'storage',
      'Failed to load repertoire files — starting fresh.',
      err instanceof Error ? err.message : String(err)
    );
  }
  return [];
}

function saveFiles(files: RepertoireFile[]) {
  safePersist(STORAGE_KEY, JSON.stringify(files));
}

function loadActiveId(): string | null {
  try {
    return localStorage.getItem(ACTIVE_KEY);
  } catch (err) {
    logger.warn(
      'storage',
      'Could not read active file ID from storage.',
      err instanceof Error ? err.message : String(err)
    );
    return null;
  }
}

function saveActiveId(id: string | null) {
  try {
    if (id) {
      localStorage.setItem(ACTIVE_KEY, id);
    } else {
      localStorage.removeItem(ACTIVE_KEY);
    }
  } catch (err) {
    logger.warn(
      'storage',
      'Could not save active file ID.',
      err instanceof Error ? err.message : String(err)
    );
  }
}

// ─── Initial State ────────────────────────────────────────────────────
function getInitialState(): FileState {
  const files = loadFiles();
  const activeFileId = loadActiveId();
  return {
    files,
    activeFileId: activeFileId && files.some((f) => f.id === activeFileId) ? activeFileId : null,
  };
}

// ─── Context ──────────────────────────────────────────────────────────
const FileContext = createContext<{
  state: FileState;
  dispatch: React.Dispatch<FileAction>;
} | null>(null);

export function FileProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(fileReducer, undefined, getInitialState);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { user } = useAuth();
  const prevUserRef = useRef<string | null>(null);

  // ── Cloud sync: when user signs in, fetch remote files and merge ──────
  useEffect(() => {
    const userId = user?.id ?? null;
    if (userId && userId !== prevUserRef.current) {
      // New sign-in: push local files up, then fetch merged set from cloud
      (async () => {
        const localFiles = loadFiles();
        if (localFiles.length > 0) {
          await pushAllFilesToCloud(userId, localFiles);
        }
        const remoteFiles = await fetchRemoteFiles(userId);
        if (remoteFiles.length > 0) {
          // Merge: remote wins for any overlapping IDs (more recent)
          const localById = new Map(localFiles.map((f) => [f.id, f]));
          const merged: RepertoireFile[] = [...remoteFiles];
          for (const [id, lf] of localById) {
            if (!merged.find((r) => r.id === id)) merged.push(lf);
          }
          dispatch({ type: 'SET_FILES', files: merged });
          saveFiles(merged);
        }
      })();
    }
    prevUserRef.current = userId;
  }, [user]);

  // ── Debounced localStorage persistence ───────────────────────────────
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveFiles(state.files);
    }, DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [state.files]);

  // Save active file ID
  useEffect(() => {
    saveActiveId(state.activeFileId);
  }, [state.activeFileId]);

  return (
    <FileContext.Provider value={{ state, dispatch }}>
      {children}
    </FileContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────
export function useFileContext() {
  const context = useContext(FileContext);
  if (!context) {
    throw new Error('useFileContext must be used within FileProvider');
  }
  return context;
}

export function useFiles() {
  const { state, dispatch } = useFileContext();
  const { user } = useAuth();

  const saveFile = useCallback(
    (name: string, tree: TreeNode, importedGames?: ImportedGame[]) => {
      const now = new Date().toISOString();
      const normalizedTree = cloneTreeWithFreshIds(tree);
      const file: RepertoireFile = {
        id: generateFileId(),
        name,
        createdAt: now,
        updatedAt: now,
        nodeCount: countNodes(normalizedTree),
        tree: normalizedTree,
        importedGames: importedGames ?? [],
      };
      dispatch({ type: 'SAVE_FILE', file });
      if (user) upsertRemoteFile(user.id, file);
      return file;
    },
    [dispatch, user]
  );

  const updateFile = useCallback(
    (id: string, tree: TreeNode) => {
      const clonedTree = cloneTreeWithFreshIds(tree);
      dispatch({ type: 'UPDATE_FILE', id, tree: clonedTree });
      if (user) {
        // Build the updated file for cloud sync
        const existing = state.files.find((f) => f.id === id);
        if (existing) {
          const updated = {
            ...existing,
            tree: clonedTree,
            nodeCount: countNodes(clonedTree),
            updatedAt: new Date().toISOString(),
          };
          upsertRemoteFile(user.id, updated);
        }
      }
    },
    [dispatch, user, state.files]
  );

  const updateFileGames = useCallback(
    (id: string, games: ImportedGame[]) => {
      dispatch({ type: 'UPDATE_FILE_GAMES', id, games });
      if (user) {
        const existing = state.files.find((f) => f.id === id);
        if (existing) {
          upsertRemoteFile(user.id, { ...existing, importedGames: games });
        }
      }
    },
    [dispatch, user, state.files]
  );

  const deleteFile = useCallback(
    (id: string) => {
      dispatch({ type: 'DELETE_FILE', id });
      if (user) deleteRemoteFile(user.id, id);
    },
    [dispatch, user]
  );

  const renameFile = useCallback(
    (id: string, name: string) => {
      dispatch({ type: 'RENAME_FILE', id, name });
      if (user) {
        const existing = state.files.find((f) => f.id === id);
        if (existing) {
          upsertRemoteFile(user.id, {
            ...existing,
            name,
            updatedAt: new Date().toISOString(),
          });
        }
      }
    },
    [dispatch, user, state.files]
  );

  const setActive = useCallback(
    (id: string | null) => dispatch({ type: 'SET_ACTIVE', id }),
    [dispatch]
  );

  const getActiveFile = useCallback((): RepertoireFile | null => {
    if (!state.activeFileId) return null;
    return state.files.find((f) => f.id === state.activeFileId) || null;
  }, [state.files, state.activeFileId]);

  return {
    files: state.files,
    activeFileId: state.activeFileId,
    saveFile,
    updateFile,
    updateFileGames,
    deleteFile,
    renameFile,
    setActive,
    getActiveFile,
  };
}
