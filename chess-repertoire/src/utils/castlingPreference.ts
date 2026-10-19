import { Chess } from 'chess.js';
import type { Square } from 'chess.js';

type Move = { uci: string; fen: string };
const rights = (fen: string) => {
  const parts = fen.split(' ');
  return [...parts[2]].filter(c => parts[1] === 'w' ? /[KQ]/.test(c) : /[kq]/.test(c));
};

/** Only penalize voluntary king moves that abandon an existing castling right. */
export function abandonsCastling(fen: string, move: Move): boolean {
  const before = rights(fen);
  if (!before.length || new Chess(fen).get(move.uci.slice(0, 2) as Square)?.type !== 'k') return false;
  // Castling itself is not an abandonment.
  if (Math.abs(move.uci.charCodeAt(0) - move.uci.charCodeAt(2)) === 2) return false;
  return before.some(right => !move.fen.split(' ')[2].includes(right));
}

export function preservesCastling(fen: string, move: Move): boolean {
  const before = rights(fen);
  const after = move.fen.split(' ')[2];
  return before.every(right => after.includes(right)) ||
    (new Chess(fen).get(move.uci.slice(0, 2) as Square)?.type === 'k' &&
      Math.abs(move.uci.charCodeAt(0) - move.uci.charCodeAt(2)) === 2);
}

export const CASTLING_PREFERENCE_MARGIN = 0.3;
