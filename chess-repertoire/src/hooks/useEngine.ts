import { useEffect, useRef, useCallback } from 'react';
import { useEngineContext } from '../context/EngineContext';
import type { EngineLine } from '../types';
import { Chess } from 'chess.js';
import { logger } from '../utils/errorLogger';

/**
 * Create a Stockfish worker.
 * First tries loading the real Stockfish WASM engine from /stockfish/stockfish.js
 * (classic worker). If that file doesn't exist, falls back to the simulation
 * module worker.
 */
async function createStockfishWorker(): Promise<Worker> {
  return new Worker('/stockfish/stockfish.js#/stockfish/stockfish.wasm');
}

/**
 * Hook that manages Stockfish engine communication via Web Worker.
 * Automatically analyzes the current FEN when it changes.
 *
 * Uses a readyok-based protocol to avoid crashing the WASM engine:
 * 1. stop → ucinewgame → isready  (sent together; engine queues them)
 * 2. wait for readyok
 * 3. position fen … → go depth …  (only after readyok)
 *
 * On worker crash, the hook automatically recreates the worker.
 */
export function useEngine() {
  const { state, dispatch } = useEngineContext();
  const workerRef = useRef<Worker | null>(null);
  const currentAnalysisRef = useRef<string>('');
  const linesBufferRef = useRef<Map<number, EngineLine>>(new Map());
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initRef = useRef(false);

  // ─── Engine state-machine refs ──────────────────────────────────────
  // Whether the very first UCI handshake + setoption round has finished.
  const needsOptionsRef = useRef(true);
  // FEN queued for analysis (set in analyze(), consumed in readyok handler).
  const pendingFenRef = useRef<string | null>(null);
  // Guard to avoid spawning multiple recreations in parallel.
  const isRecreatingRef = useRef(false);
  // Mirror of state values accessed inside callbacks via ref (avoids stale closures).
  const depthRef = useRef(state.depth);
  const enabledRef = useRef(state.enabled);
  const multiPVRef = useRef(state.multiPV);
  const threadsRef = useRef(state.threads);

  // Keep refs in sync with React state on every render.
  depthRef.current = state.depth;
  enabledRef.current = state.enabled;
  multiPVRef.current = state.multiPV;
  threadsRef.current = state.threads;

  const sendCommand = useCallback((cmd: string) => {
    workerRef.current?.postMessage(cmd);
  }, []);

  /**
   * Convert UCI move (e.g., "e2e4") to SAN using chess.js
   */
  const uciToSan = useCallback((fen: string, uciMoves: string[]): string[] => {
    try {
      const chess = new Chess(fen);
      const sanMoves: string[] = [];
      for (const uci of uciMoves) {
        const from = uci.substring(0, 2);
        const to = uci.substring(2, 4);
        const promotion = uci.length > 4 ? uci[4] : undefined;
        try {
          const move = chess.move({ from, to, promotion });
          if (move) {
            sanMoves.push(move.san);
          } else {
            break;
          }
        } catch {
          break;
        }
      }
      return sanMoves;
    } catch {
      return [];
    }
  }, []);

  /**
   * Parse UCI info lines from the engine.
   */
  const handleEngineMessage = useCallback((message: string) => {
    if (message.startsWith('info') && message.includes('score') && message.includes(' pv ')) {
      const depthMatch = message.match(/depth (\d+)/);
      const scoreMatch = message.match(/score (cp|mate) (-?\d+)/);
      const pvMatch = message.match(/ pv ([a-h].+)/);
      const multipvMatch = message.match(/multipv (\d+)/);

      if (depthMatch && scoreMatch && pvMatch) {
        const depth = parseInt(depthMatch[1], 10);
        const scoreType = scoreMatch[1];
        const scoreValue = parseInt(scoreMatch[2], 10);
        const pvUci = pvMatch[1].trim().split(/\s+/);
        const multipv = multipvMatch ? parseInt(multipvMatch[1], 10) : 1;

        const fen = currentAnalysisRef.current;
        let pvSan = uciToSan(fen, pvUci);

        // Fallback: if SAN conversion fails, show just the destination square
        if (pvSan.length === 0 && pvUci.length > 0) {
          pvSan = pvUci.map((uci) => {
            const to = uci.substring(2, 4);
            return to;
          });
        }

        // Stockfish reports scores from the side-to-move's perspective.
        // Normalize to always be from White's perspective.
        const isBlackToMove = fen ? fen.split(' ')[1] === 'b' : false;
        const sign = isBlackToMove ? -1 : 1;

        const line: EngineLine = {
          depth,
          score: scoreType === 'cp' ? scoreValue * sign : 0,
          mate: scoreType === 'mate' ? scoreValue * sign : null,
          pv: pvSan,
          pvUci,
          multipv,
        };

        linesBufferRef.current.set(multipv, line);

        // Convert map to sorted array and dispatch
        const lines = Array.from(linesBufferRef.current.values()).sort(
          (a, b) => a.multipv - b.multipv
        );

        dispatch({ type: 'SET_LINES', lines });
        dispatch({ type: 'SET_THINKING', isThinking: true });
      }
    } else if (message.startsWith('bestmove')) {
      dispatch({ type: 'SET_THINKING', isThinking: false });
    } else if (message === 'uciok') {
      // Engine acknowledged UCI mode — ask if it's ready
      sendCommand('isready');
    } else if (message === 'readyok') {
      // ── Initial handshake: send options once, then wait for a 2nd readyok ──
      if (needsOptionsRef.current) {
        needsOptionsRef.current = false;
        sendCommand(`setoption name MultiPV value ${multiPVRef.current}`);
        sendCommand(`setoption name Threads value ${threadsRef.current}`);
        sendCommand('isready');
        return;
      }

      // ── Engine is idle and ready — mark worker as ready ──
      dispatch({ type: 'SET_WORKER_READY', ready: true });

      // ── Engine is idle and ready — start any pending analysis ──
      const fen = pendingFenRef.current;
      if (fen && enabledRef.current) {
        pendingFenRef.current = null;
        currentAnalysisRef.current = fen;
        dispatch({ type: 'SET_CURRENT_FEN', fen });
        sendCommand(`position fen ${fen}`);
        sendCommand(`go depth ${depthRef.current}`);
      }
    }
  }, [dispatch, sendCommand, uciToSan]);

  // ─── Worker setup helper (stored as ref so the error handler can call it
  //     to re-initialise a fresh worker without stale-closure issues) ────────
  const setupWorkerRef = useRef<(worker: Worker) => void>(() => {});
  setupWorkerRef.current = (worker: Worker) => {
    worker.onmessage = (e: MessageEvent<string>) => {
      handleEngineMessage(e.data);
    };

    worker.onerror = (error) => {
      logger.error(
        'engine',
        'Stockfish worker crashed — attempting recovery.',
        error.message || 'Unknown worker error'
      );

      if (!isRecreatingRef.current) {
        isRecreatingRef.current = true;

        // Kill the broken worker
        try { worker.terminate(); } catch { /* ignore */ }
        workerRef.current = null;
        dispatch({ type: 'SET_WORKER_READY', ready: false });

        // Re-create after a short cooldown
        setTimeout(() => {
          createStockfishWorker()
            .then((newWorker) => {
              workerRef.current = newWorker;
              needsOptionsRef.current = true;
              pendingFenRef.current = null;

              setupWorkerRef.current(newWorker);
              newWorker.postMessage('uci');
              isRecreatingRef.current = false;

              logger.info('engine', 'Stockfish worker recovered successfully.');
            })
            .catch((err) => {
              logger.error(
                'engine',
                'Failed to recreate Stockfish worker — engine analysis unavailable.',
                err instanceof Error ? err.message : String(err)
              );
              isRecreatingRef.current = false;
            });
        }, 500);
      }
    };
  };

  // Initialize worker (runs once)
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    createStockfishWorker().then((worker) => {
      workerRef.current = worker;
      setupWorkerRef.current(worker);

      // Start UCI handshake
      worker.postMessage('uci');
    }).catch((err) => {
      logger.error(
        'engine',
        'Failed to initialize Stockfish engine.',
        err instanceof Error ? err.message : String(err)
      );
    });

    return () => {
      if (workerRef.current) {
        workerRef.current.postMessage('quit');
        workerRef.current.terminate();
        workerRef.current = null;
      }
    };
  }, []);

  // Keep onmessage in sync when handleEngineMessage is recreated
  useEffect(() => {
    if (workerRef.current) {
      workerRef.current.onmessage = (e: MessageEvent<string>) => {
        handleEngineMessage(e.data);
      };
    }
  }, [handleEngineMessage]);

  /**
   * Start analysis of a position.
   *
   * Instead of firing stop → position → go in the same tick (which can
   * crash the WASM engine), we:
   *   1. Queue the FEN
   *   2. Send  stop → ucinewgame → isready
   *   3. When readyok arrives the handler picks up the queued FEN
   */
  const analyze = useCallback(
    (fen: string) => {
      if (!state.enabled || !workerRef.current) return;

      // Debounce rapid position changes
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }

      debounceTimerRef.current = setTimeout(() => {
        if (!workerRef.current) return;

        // Queue the FEN for the readyok handler
        pendingFenRef.current = fen;

        // Clear previous results in the UI
        linesBufferRef.current.clear();
        dispatch({ type: 'CLEAR_LINES' });
        dispatch({ type: 'SET_THINKING', isThinking: true });

        // Safely stop the current analysis, reset internal engine state,
        // and synchronise via isready / readyok.
        sendCommand('stop');
        sendCommand('ucinewgame');
        sendCommand('isready');
        // → readyok handler will send  position fen … → go depth …
      }, 150);
    },
    [state.enabled, sendCommand, dispatch]
  );

  /**
   * Stop current analysis.
   */
  const stopAnalysis = useCallback(() => {
    pendingFenRef.current = null;
    sendCommand('stop');
    dispatch({ type: 'SET_THINKING', isThinking: false });
  }, [sendCommand, dispatch]);

  /**
   * Toggle engine on/off.
   */
  const toggleEngine = useCallback(() => {
    const newEnabled = !state.enabled;
    dispatch({ type: 'SET_ENABLED', enabled: newEnabled });
    if (!newEnabled) {
      pendingFenRef.current = null;
      sendCommand('stop');
      dispatch({ type: 'CLEAR_LINES' });
      dispatch({ type: 'SET_THINKING', isThinking: false });
    }
  }, [state.enabled, sendCommand, dispatch]);

  /**
   * Set analysis depth.
   */
  const setDepth = useCallback(
    (depth: number) => {
      dispatch({ type: 'SET_DEPTH', depth: Math.min(depth, state.maxDepth) });
    },
    [dispatch, state.maxDepth]
  );

  /**
   * Set MultiPV count.
   */
  const setMultiPV = useCallback(
    (count: number) => {
      const clamped = Math.max(1, Math.min(5, count));
      dispatch({ type: 'SET_MULTIPV', multiPV: clamped });

      // Safely update the option and re-analyse via readyok protocol
      sendCommand('stop');
      sendCommand(`setoption name MultiPV value ${clamped}`);

      if (currentAnalysisRef.current && state.enabled) {
        pendingFenRef.current = currentAnalysisRef.current;
        linesBufferRef.current.clear();
        dispatch({ type: 'CLEAR_LINES' });
        sendCommand('isready');
        // → readyok handler will restart analysis with the new MultiPV
      }
    },
    [sendCommand, state.enabled, dispatch]
  );

  /**
   * Set thread count.
   * Requires the multi-threaded Stockfish WASM build.
   */
  const setThreads = useCallback(
    (count: number) => {
      const maxThreads = navigator?.hardwareConcurrency ?? 1;
      const clamped = Math.max(1, Math.min(maxThreads, count));
      dispatch({ type: 'SET_THREADS', threads: clamped });

      // Safely update the option and re-analyse via readyok protocol
      sendCommand('stop');
      sendCommand(`setoption name Threads value ${clamped}`);

      if (currentAnalysisRef.current && state.enabled) {
        pendingFenRef.current = currentAnalysisRef.current;
        linesBufferRef.current.clear();
        dispatch({ type: 'CLEAR_LINES' });
        sendCommand('isready');
      }
    },
    [sendCommand, state.enabled, dispatch]
  );

  return {
    ...state,
    workerRef,
    analyze,
    stopAnalysis,
    toggleEngine,
    setDepth,
    setMultiPV,
    setThreads,
  };
}
