/// <reference lib="webworker" />

/**
 * Stockfish Web Worker wrapper.
 *
 * This worker loads the Stockfish WASM engine and proxies UCI commands
 * between the main thread and the engine.
 *
 * Messages from main thread: UCI command strings
 * Messages to main thread: UCI output strings
 */

declare const self: DedicatedWorkerGlobalScope;

import { Chess } from 'chess.js';

let stockfish: Worker | null = null;
let isReady = false;

// Try to load Stockfish
// The actual stockfish.js file should be placed in public/stockfish/
// For the WASM version, we need stockfish.js and stockfish.wasm in the same directory

/**
 * Attempt to load a Stockfish script and initialize it.
 * Returns true if successful.
 */
function tryLoadStockfish(path: string): boolean {
  try {
    // @ts-ignore
    importScripts(path);
    // @ts-ignore
    if (typeof Stockfish === 'function') {
      // @ts-ignore
      const sf = Stockfish();
      sf.addMessageListener((msg: string) => {
        self.postMessage(msg);
        if (msg === 'readyok') {
          isReady = true;
        }
      });

      // Store reference for sending commands
      // @ts-ignore
      self._sendCommand = (cmd: string) => sf.postMessage(cmd);

      // Initialize
      sf.postMessage('uci');
      return true;
    }
  } catch {
    // This path didn't work
  }
  return false;
}

function initEngine() {
  // @ts-ignore
  if (typeof importScripts !== 'function') {
    self.postMessage('info string ERROR: importScripts not available');
    return;
  }

  // Try multiple paths in order of preference:
  // 1. stockfish.js (setup script copies files here with this name)
  // 2. Any NNUE 17.x files that might exist with original names
  // 3. Older naming conventions
  const paths = [
    '/stockfish/stockfish.js',
    '/stockfish/stockfish-nnue-17.js',
    '/stockfish/stockfish-nnue-16.js',
    '/stockfish/stockfish.wasm.js',
  ];

  for (const path of paths) {
    if (tryLoadStockfish(path)) {
      return;
    }
  }

  // No engine found — fall back to simulation
  self.postMessage('info string WARNING: Stockfish engine not found! Running in SIMULATION mode.');
  self.postMessage('info string Run ./setup-stockfish.sh to install Stockfish 17.1 WASM.');
}

// Handle messages from main thread (UCI commands)
self.onmessage = (e: MessageEvent<string>) => {
  const command = e.data;

  // @ts-ignore
  if (self._sendCommand) {
    // @ts-ignore
    self._sendCommand(command);
  } else {
    // Simple echo/simulation mode when Stockfish isn't available
    handleSimulatedCommand(command);
  }
};

// ---- Simulation state ----
let simCurrentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
let simMultiPV = 3;

/**
 * Simple FEN hash to produce varied evaluations.
 */
function fenHash(fen: string): number {
  let hash = 0;
  for (let i = 0; i < fen.length; i++) {
    hash = ((hash << 5) - hash) + fen.charCodeAt(i);
    hash |= 0; // Convert to 32-bit integer
  }
  return hash;
}

/**
 * Generate legal UCI move sequences from a position using chess.js.
 * Each line starts with a different legal first move, then continues
 * with legal responses to build a realistic-looking PV.
 */
function generateLegalMoveLines(fen: string, count: number): string[][] {
  const hash = Math.abs(fenHash(fen));
  const results: string[][] = [];

  try {
    const chess = new Chess(fen);
    const legalMoves = chess.moves({ verbose: true });

    if (legalMoves.length === 0) return [];

    // Sort moves deterministically using hash for variety
    const sortedMoves = [...legalMoves].sort((a, b) => {
      const aScore = hashMoveScore(a, hash);
      const bScore = hashMoveScore(b, hash);
      return bScore - aScore;
    });

    for (let line = 0; line < Math.min(count, sortedMoves.length); line++) {
      const moves: string[] = [];
      const lineChess = new Chess(fen);

      // Pick a different starting move for each line
      const startIdx = line % sortedMoves.length;
      const firstMove = sortedMoves[startIdx];

      try {
        lineChess.move(firstMove.san);
        moves.push(firstMove.from + firstMove.to + (firstMove.promotion || ''));
      } catch {
        continue;
      }

      // Continue with 2-4 more moves
      const moveCount = 2 + (hash + line) % 3;
      for (let m = 1; m < moveCount; m++) {
        const nextMoves = lineChess.moves({ verbose: true });
        if (nextMoves.length === 0) break;

        // Pick a move using hash for deterministic variety
        const idx = (hash + line * 7 + m * 13) % nextMoves.length;
        const nextMove = nextMoves[idx];

        try {
          lineChess.move(nextMove.san);
          moves.push(nextMove.from + nextMove.to + (nextMove.promotion || ''));
        } catch {
          break;
        }
      }

      if (moves.length > 0) {
        results.push(moves);
      }
    }
  } catch {
    // If chess.js fails, return empty
  }

  return results;
}

/**
 * Score a move for sorting purposes (higher = more likely to be picked first).
 * Uses hash to vary the selection per position.
 */
function hashMoveScore(move: { from: string; to: string; san: string; flags: string; captured?: string }, hash: number): number {
  let score = (hash + move.from.charCodeAt(0) + move.to.charCodeAt(1)) % 100;
  // Prefer captures and checks slightly
  if (move.captured) score += 20;
  if (move.san.includes('+')) score += 15;
  return score;
}

/**
 * When Stockfish isn't available, provide a basic simulation
 * so the UI still works.
 */
function handleSimulatedCommand(command: string) {
  if (command === 'uci') {
    self.postMessage('id name Stockfish SIMULATION (not real engine - run setup-stockfish.sh)');
    self.postMessage('id author Simulation - moves are NOT real analysis');
    self.postMessage('uciok');
  } else if (command === 'isready') {
    self.postMessage('readyok');
  } else if (command.startsWith('position')) {
    // Track the current position
    const fenMatch = command.match(/position fen (.+?)(?:\s+moves|$)/);
    if (fenMatch) {
      simCurrentFen = fenMatch[1].trim();
    } else if (command.includes('startpos')) {
      simCurrentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
    }
  } else if (command === 'ucinewgame') {
    // Reset simulation state
    simCurrentFen = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
  } else if (command.startsWith('setoption')) {
    const mpvMatch = command.match(/MultiPV value (\d+)/);
    if (mpvMatch) {
      simMultiPV = parseInt(mpvMatch[1], 10);
    }
  } else if (command.startsWith('go')) {
    const depthMatch = command.match(/depth (\d+)/);
    const maxDepth = depthMatch ? parseInt(depthMatch[1], 10) : 20;

    // Generate varied eval based on FEN
    const hash = Math.abs(fenHash(simCurrentFen));
    const baseScore = ((hash % 200) - 100); // range: -100 to +99 centipawns

    // Generate legal moves for each PV line
    const moveLines = generateLegalMoveLines(simCurrentFen, simMultiPV);

    setTimeout(() => {
      const actualLines = Math.min(simMultiPV, moveLines.length);

      for (let d = 1; d <= Math.min(maxDepth, 2); d++) {
        for (let pv = 0; pv < actualLines; pv++) {
          // Vary score per line (each subsequent line is slightly worse)
          const lineScore = baseScore - (pv * 15) + ((hash + d) % 10);
          const pvMoves = moveLines[pv] && moveLines[pv].length > 0 ? moveLines[pv].join(' ') : 'e2e4';

          self.postMessage(
            `info depth ${d} seldepth ${d + 1} multipv ${pv + 1} score cp ${lineScore} nodes ${d * 100 + pv * 30} time ${d * 50} pv ${pvMoves}`
          );
        }
      }

      // Best move is the first move of the first line
      const bestMove = moveLines[0] && moveLines[0][0] ? moveLines[0][0] : 'e2e4';
      self.postMessage(`bestmove ${bestMove}`);
    }, 100);
  } else if (command === 'stop') {
    const hash = Math.abs(fenHash(simCurrentFen));
    const moveLines = generateLegalMoveLines(simCurrentFen, 1);
    const bestMove = moveLines[0] && moveLines[0][0] ? moveLines[0][0] : 'e2e4';
    self.postMessage(`bestmove ${bestMove}`);
  }
}

// Initialize on load
initEngine();
