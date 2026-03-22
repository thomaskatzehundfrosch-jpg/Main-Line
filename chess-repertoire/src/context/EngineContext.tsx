import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import type { EngineState, EngineAction } from '../types';

// Create context
const EngineContext = createContext<{
  state: EngineState;
  dispatch: React.Dispatch<EngineAction>;
} | null>(null);

// Initial state
function getInitialState(): EngineState {
  // Default to half of logical cores, clamped 1–16
  const defaultThreads = Math.max(1, Math.min(16, Math.floor((navigator?.hardwareConcurrency ?? 2) / 2)));
  return {
    enabled: true,
    workerReady: false,
    depth: 25,
    maxDepth: 40,
    multiPV: 3,
    threads: defaultThreads,
    lines: [],
    isThinking: false,
    currentFen: 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1',
  };
}

// Reducer
function engineReducer(state: EngineState, action: EngineAction): EngineState {
  switch (action.type) {
    case 'SET_ENABLED': {
      return {
        ...state,
        enabled: action.enabled,
      };
    }

    case 'SET_DEPTH': {
      return {
        ...state,
        depth: action.depth,
      };
    }

    case 'SET_LINES': {
      return {
        ...state,
        lines: action.lines,
      };
    }

    case 'SET_THINKING': {
      return {
        ...state,
        isThinking: action.isThinking,
      };
    }

    case 'SET_CURRENT_FEN': {
      return {
        ...state,
        currentFen: action.fen,
      };
    }

    case 'SET_MULTIPV': {
      return {
        ...state,
        multiPV: action.multiPV,
      };
    }

    case 'SET_THREADS': {
      return {
        ...state,
        threads: action.threads,
      };
    }

    case 'CLEAR_LINES': {
      return {
        ...state,
        lines: [],
      };
    }

    case 'SET_WORKER_READY': {
      return {
        ...state,
        workerReady: action.ready,
      };
    }

    default:
      return state;
  }
}

// Provider component
export function EngineProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(engineReducer, undefined, getInitialState);

  return (
    <EngineContext.Provider value={{ state, dispatch }}>
      {children}
    </EngineContext.Provider>
  );
}

// Hook to use context
export function useEngineContext() {
  const context = useContext(EngineContext);
  if (!context) {
    throw new Error('useEngineContext must be used within EngineProvider');
  }
  return context;
}
