import type { TreeNode, RepertoireEval } from '../types';
import { analyzePosition, waitForReady, createAnalysisWorker } from './analyzer';

export type { RepertoireEval };

export interface RepertoireAnalysisOptions {
  depth?: number;
  onProgress?: (current: number, total: number) => void;
  onEval?: (fen: string, evalResult: RepertoireEval) => void;
  isCancelled?: () => boolean;
}

/**
 * Collect all unique FENs reachable from the tree root (BFS).
 * Includes the root position itself.
 */
export function collectFensFromTree(root: TreeNode): string[] {
  const seen = new Set<string>();
  const queue: TreeNode[] = [root];

  while (queue.length > 0) {
    const node = queue.shift()!;
    if (!seen.has(node.fen)) {
      seen.add(node.fen);
      for (const child of node.children) {
        queue.push(child);
      }
    }
  }

  return Array.from(seen);
}

/**
 * Analyse every unique position in the repertoire tree and return a map from
 * FEN to evaluation result.
 *
 * A dedicated Stockfish worker is created for this batch job so it does not
 * interfere with the interactive engine panel.
 */
export async function analyzeRepertoire(
  root: TreeNode,
  options: RepertoireAnalysisOptions = {}
): Promise<Map<string, RepertoireEval>> {
  const {
    depth = 18,
    onProgress,
    onEval,
    isCancelled = () => false,
  } = options;

  const fens = collectFensFromTree(root);
  const total = fens.length;
  const results = new Map<string, RepertoireEval>();

  if (total === 0) return results;

  // Spin up a dedicated worker for this batch
  const worker = await createAnalysisWorker();
  await waitForReady(worker);

  try {
    for (let i = 0; i < fens.length; i++) {
      if (isCancelled()) break;

      if (onProgress) onProgress(i, total);

      const fen = fens[i];
      const raw = await analyzePosition(worker, fen, depth);

      const evalResult: RepertoireEval = {
        score: raw.score,
        depth: raw.depth,
        isMate: raw.isMate,
        mateIn: raw.mateIn,
        bestMove: raw.bestMoveSan,
      };

      results.set(fen, evalResult);
      if (onEval) onEval(fen, evalResult);
    }
  } finally {
    worker.terminate();
  }

  if (onProgress) onProgress(total, total);
  return results;
}

/**
 * Format a centipawn score for display (e.g. +1.4 / -0.3 / M5 / -M3).
 */
export function formatEval(evalResult: RepertoireEval, whiteToMove: boolean): string {
  if (evalResult.isMate && evalResult.mateIn !== null) {
    const m = evalResult.mateIn;
    // mateIn is from White's perspective (positive = white mates)
    const abs = Math.abs(m);
    const sign = m > 0 ? '' : '-';
    return `${sign}M${abs}`;
  }

  // score is in centipawns, White's perspective
  const pawns = evalResult.score / 100;
  const sign = pawns > 0 ? '+' : '';
  return `${sign}${pawns.toFixed(1)}`;
}
