import { Chess } from 'chess.js';

/** Explorer uses king-to-rook UCI for castling; chess.js uses king destination. */
export function normalizeExplorerUci(fen, move) {
  if (typeof move !== 'string' || !/^[e][18][ah][18]$/.test(move) || move[1] !== move[3]) return move;
  const board = new Chess(fen);
  const king = board.get(move.slice(0, 2)), rook = board.get(move.slice(2, 4));
  if (king?.type !== 'k' || rook?.type !== 'r' || king.color !== rook.color) return move;
  const castle = board.moves({ square: move.slice(0, 2), verbose: true })
    .find(candidate => candidate.flags.includes(move[2] === 'h' ? 'k' : 'q'));
  return castle ? castle.from + castle.to : move;
}
