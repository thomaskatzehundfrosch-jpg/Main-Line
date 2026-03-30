import React, { createContext, useContext, useReducer, useEffect, useCallback, useRef, ReactNode } from 'react';
import type { ImportedGame, MistakeRecord } from '../types/game';
import { safePersist, logger } from '../utils/errorLogger';

const STORAGE_KEY = 'main-line-games';
const DEBOUNCE_MS = 500;

// ─── State ────────────────────────────────────────────────────────────
export interface GameState {
  importedGames: ImportedGame[];
  /** ID of game currently being analyzed, or null */
  analyzingGameId: string | null;
  /** Progress of current analysis: [current move, total moves] */
  analysisProgress: [number, number] | null;
  /** Whether batch analysis should be cancelled */
  analysisCancelled: boolean;
  /** Whether the game overlay is visible on the tree */
  showGameOverlay: boolean;
}

// ─── Actions ──────────────────────────────────────────────────────────
export type GameAction =
  | { type: 'SET_GAMES'; games: ImportedGame[] }
  | { type: 'ADD_GAMES'; games: ImportedGame[] }
  | { type: 'REMOVE_GAME'; gameId: string }
  | { type: 'SET_GAME_ANALYZED'; gameId: string; mistakes: MistakeRecord[] }
  | { type: 'SET_ANALYZING'; gameId: string | null }
  | { type: 'SET_ANALYSIS_PROGRESS'; progress: [number, number] | null }
  | { type: 'SET_ANALYSIS_CANCELLED'; cancelled: boolean }
  | { type: 'TOGGLE_REVIEWED'; mistakeId: string; gameId: string }
  | { type: 'TOGGLE_GAME_OVERLAY' }
  | { type: 'CLEAR_ALL_GAMES' };

// ─── Reducer ──────────────────────────────────────────────────────────
function gameReducer(state: GameState, action: GameAction): GameState {
  switch (action.type) {
    case 'SET_GAMES':
      return { ...state, importedGames: action.games };

    case 'ADD_GAMES':
      return { ...state, importedGames: [...state.importedGames, ...action.games] };

    case 'REMOVE_GAME':
      return {
        ...state,
        importedGames: state.importedGames.filter((g) => g.id !== action.gameId),
      };

    case 'SET_GAME_ANALYZED':
      return {
        ...state,
        importedGames: state.importedGames.map((g) =>
          g.id === action.gameId
            ? { ...g, analyzed: true, mistakes: action.mistakes }
            : g
        ),
      };

    case 'SET_ANALYZING':
      return { ...state, analyzingGameId: action.gameId };

    case 'SET_ANALYSIS_PROGRESS':
      return { ...state, analysisProgress: action.progress };

    case 'SET_ANALYSIS_CANCELLED':
      return { ...state, analysisCancelled: action.cancelled };

    case 'TOGGLE_REVIEWED':
      return {
        ...state,
        importedGames: state.importedGames.map((g) =>
          g.id === action.gameId
            ? {
                ...g,
                mistakes: g.mistakes.map((m) =>
                  m.id === action.mistakeId ? { ...m, reviewed: !m.reviewed } : m
                ),
              }
            : g
        ),
      };

    case 'TOGGLE_GAME_OVERLAY':
      return { ...state, showGameOverlay: !state.showGameOverlay };

    case 'CLEAR_ALL_GAMES':
      return {
        ...state,
        importedGames: [],
        analyzingGameId: null,
        analysisProgress: null,
      };

    default:
      return state;
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────
/** Coerce a PGN tag value (may be object {value, year, month, day}) to string. */
function coerceToString(val: unknown): string | undefined {
  if (val == null) return undefined;
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && val !== null && 'value' in val) {
    return String((val as Record<string, unknown>).value);
  }
  return String(val);
}

/** Sanitize a game loaded from localStorage so every rendered field is a string. */
function sanitizeGame(game: ImportedGame): ImportedGame {
  return {
    ...game,
    date: coerceToString(game.date),
    result: coerceToString(game.result),
    white: coerceToString(game.white) ?? 'Unknown',
    black: coerceToString(game.black) ?? 'Unknown',
  };
}

// ─── Persistence ──────────────────────────────────────────────────────
function loadGames(): ImportedGame[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as ImportedGame[];
      return parsed.map(sanitizeGame);
    }
  } catch (err) {
    logger.error(
      'storage',
      'Failed to load saved games — starting with an empty list.',
      err instanceof Error ? err.message : String(err)
    );
  }
  return [];
}

function saveGames(games: ImportedGame[]) {
  safePersist(STORAGE_KEY, JSON.stringify(games));
}

// ─── Initial State ────────────────────────────────────────────────────
function getInitialState(): GameState {
  return {
    importedGames: loadGames(),
    analyzingGameId: null,
    analysisProgress: null,
    analysisCancelled: false,
    showGameOverlay: true,
  };
}

// ─── Context ──────────────────────────────────────────────────────────
const GameContext = createContext<{
  state: GameState;
  dispatch: React.Dispatch<GameAction>;
} | null>(null);

export function GameProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(gameReducer, undefined, getInitialState);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestGamesRef = useRef(state.importedGames);

  // Keep ref in sync so the unmount handler always has the latest data
  latestGamesRef.current = state.importedGames;

  // Debounced persistence
  useEffect(() => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveGames(state.importedGames);
      saveTimerRef.current = null;
    }, DEBOUNCE_MS);
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [state.importedGames]);

  // Flush any pending save on unmount so analysis results are never lost
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveGames(latestGamesRef.current);
      }
    };
  }, []);

  // Flush pending save on page refresh / navigation — React cleanup is NOT
  // guaranteed to run during beforeunload, so we need this explicit listener.
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        saveGames(latestGamesRef.current);
      }
    };
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, []);

  return (
    <GameContext.Provider value={{ state, dispatch }}>
      {children}
    </GameContext.Provider>
  );
}

// ─── Hook ─────────────────────────────────────────────────────────────
export function useGameContext() {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error('useGameContext must be used within GameProvider');
  }
  return context;
}

/**
 * Higher-level hook with convenience methods.
 */
export function useGames() {
  const { state, dispatch } = useGameContext();

  const setGames = useCallback(
    (games: ImportedGame[]) => dispatch({ type: 'SET_GAMES', games }),
    [dispatch]
  );

  const addGames = useCallback(
    (games: ImportedGame[]) => dispatch({ type: 'ADD_GAMES', games }),
    [dispatch]
  );

  const removeGame = useCallback(
    (gameId: string) => dispatch({ type: 'REMOVE_GAME', gameId }),
    [dispatch]
  );

  const setGameAnalyzed = useCallback(
    (gameId: string, mistakes: MistakeRecord[]) =>
      dispatch({ type: 'SET_GAME_ANALYZED', gameId, mistakes }),
    [dispatch]
  );

  const setAnalyzing = useCallback(
    (gameId: string | null) => dispatch({ type: 'SET_ANALYZING', gameId }),
    [dispatch]
  );

  const setAnalysisProgress = useCallback(
    (progress: [number, number] | null) =>
      dispatch({ type: 'SET_ANALYSIS_PROGRESS', progress }),
    [dispatch]
  );

  const cancelAnalysis = useCallback(
    () => dispatch({ type: 'SET_ANALYSIS_CANCELLED', cancelled: true }),
    [dispatch]
  );

  const resetCancellation = useCallback(
    () => dispatch({ type: 'SET_ANALYSIS_CANCELLED', cancelled: false }),
    [dispatch]
  );

  const toggleReviewed = useCallback(
    (mistakeId: string, gameId: string) =>
      dispatch({ type: 'TOGGLE_REVIEWED', mistakeId, gameId }),
    [dispatch]
  );

  const toggleGameOverlay = useCallback(
    () => dispatch({ type: 'TOGGLE_GAME_OVERLAY' }),
    [dispatch]
  );

  const clearAllGames = useCallback(
    () => dispatch({ type: 'CLEAR_ALL_GAMES' }),
    [dispatch]
  );

  // Aggregate all mistakes across all games
  const allMistakes: (MistakeRecord & { gameName: string })[] = state.importedGames
    .filter((g) => g.analyzed)
    .flatMap((g) =>
      g.mistakes.map((m) => ({
        ...m,
        gameName: `${g.white} vs ${g.black}`,
      }))
    );

  const reviewedCount = allMistakes.filter((m) => m.reviewed).length;

  return {
    ...state,
    setGames,
    addGames,
    removeGame,
    setGameAnalyzed,
    setAnalyzing,
    setAnalysisProgress,
    cancelAnalysis,
    resetCancellation,
    toggleReviewed,
    toggleGameOverlay,
    clearAllGames,
    allMistakes,
    reviewedCount,
    totalMistakes: allMistakes.length,
  };
}
