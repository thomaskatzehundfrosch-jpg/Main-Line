import React, { createContext, useContext, useReducer, ReactNode } from 'react';
import type { RepertoireEval } from '../types';
import type { MistakeTier } from '../types/game';

// ─── Node annotation ─────────────────────────────────────────────────────────

/** Eval-drop classification for a single repertoire move (keyed by node ID). */
export interface NodeAnnotation {
  /** inaccuracy / mistake / blunder */
  tier: MistakeTier;
  /** Eval lost by the mover in pawns (positive = bad for the side that moved). */
  evalDrop: number;
  /** Which side made the move. */
  side: 'white' | 'black';
}

// ─── State ───────────────────────────────────────────────────────────────────

export interface RepertoireEvalState {
  /** FEN → engine evaluation for every analysed position */
  evals: Map<string, RepertoireEval>;
  /** node ID → eval-drop annotation (populated after analysis finishes) */
  nodeAnnotations: Map<string, NodeAnnotation>;
  isAnalyzing: boolean;
  /** How many positions have been evaluated so far */
  progress: number;
  /** Total number of positions to evaluate */
  total: number;
  /** Set to true when the user clicks Cancel */
  cancelled: boolean;
}

// ─── Actions ─────────────────────────────────────────────────────────────────

type RepertoireEvalAction =
  | { type: 'START'; total: number }
  | { type: 'SET_EVAL'; fen: string; evalResult: RepertoireEval }
  | { type: 'SET_NODE_ANNOTATIONS'; annotations: Map<string, NodeAnnotation> }
  | { type: 'INCREMENT_PROGRESS' }
  | { type: 'FINISH' }
  | { type: 'CANCEL' }
  | { type: 'RESET_CANCEL' }
  | { type: 'CLEAR' };

// ─── Reducer ─────────────────────────────────────────────────────────────────

function reducer(
  state: RepertoireEvalState,
  action: RepertoireEvalAction
): RepertoireEvalState {
  switch (action.type) {
    case 'START':
      return {
        ...state,
        isAnalyzing: true,
        progress: 0,
        total: action.total,
        cancelled: false,
      };

    case 'SET_EVAL': {
      const next = new Map(state.evals);
      next.set(action.fen, action.evalResult);
      return { ...state, evals: next };
    }

    case 'SET_NODE_ANNOTATIONS':
      return { ...state, nodeAnnotations: action.annotations };

    case 'INCREMENT_PROGRESS':
      return { ...state, progress: state.progress + 1 };

    case 'FINISH':
      return { ...state, isAnalyzing: false };

    case 'CANCEL':
      return { ...state, cancelled: true };

    case 'RESET_CANCEL':
      return { ...state, cancelled: false };

    case 'CLEAR':
      return {
        evals: new Map(),
        nodeAnnotations: new Map(),
        isAnalyzing: false,
        progress: 0,
        total: 0,
        cancelled: false,
      };

    default:
      return state;
  }
}

// ─── Context ─────────────────────────────────────────────────────────────────

const RepertoireEvalContext = createContext<{
  state: RepertoireEvalState;
  dispatch: React.Dispatch<RepertoireEvalAction>;
} | null>(null);

function getInitialState(): RepertoireEvalState {
  return {
    evals: new Map(),
    nodeAnnotations: new Map(),
    isAnalyzing: false,
    progress: 0,
    total: 0,
    cancelled: false,
  };
}

// ─── Provider ────────────────────────────────────────────────────────────────

export function RepertoireEvalProvider({ children }: { children: ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, getInitialState);
  return (
    <RepertoireEvalContext.Provider value={{ state, dispatch }}>
      {children}
    </RepertoireEvalContext.Provider>
  );
}

// ─── Hook ────────────────────────────────────────────────────────────────────

export function useRepertoireEval() {
  const ctx = useContext(RepertoireEvalContext);
  if (!ctx) throw new Error('useRepertoireEval must be used within RepertoireEvalProvider');

  const { state, dispatch } = ctx;

  return {
    evals: state.evals,
    nodeAnnotations: state.nodeAnnotations,
    isAnalyzing: state.isAnalyzing,
    progress: state.progress,
    total: state.total,
    cancelled: state.cancelled,

    startAnalysis: (total: number) => dispatch({ type: 'START', total }),
    setEval: (fen: string, evalResult: RepertoireEval) =>
      dispatch({ type: 'SET_EVAL', fen, evalResult }),
    setNodeAnnotations: (annotations: Map<string, NodeAnnotation>) =>
      dispatch({ type: 'SET_NODE_ANNOTATIONS', annotations }),
    incrementProgress: () => dispatch({ type: 'INCREMENT_PROGRESS' }),
    finishAnalysis: () => dispatch({ type: 'FINISH' }),
    cancelAnalysis: () => dispatch({ type: 'CANCEL' }),
    resetCancel: () => dispatch({ type: 'RESET_CANCEL' }),
    clearEvals: () => dispatch({ type: 'CLEAR' }),

    /** Convenience: look up the eval for a given FEN */
    getEval: (fen: string): RepertoireEval | undefined => state.evals.get(fen),
    /** Convenience: look up the annotation for a given node ID */
    getNodeAnnotation: (nodeId: string): NodeAnnotation | undefined =>
      state.nodeAnnotations.get(nodeId),
  };
}
