/**
 * Figurine notation utilities.
 * Converts SAN piece letters (K, Q, R, B, N) to Unicode chess symbols.
 *
 * We use the SAME set of symbols for both white and black (the outlined/white set)
 * because on a dark background, the filled/black Unicode pieces (♚♛♜♝♞) are
 * nearly invisible. Instead, we differentiate by CSS class.
 *
 * White pieces render in a light color, black pieces in a distinct darker/colored tone.
 */

const PIECE_SYMBOLS: Record<string, string> = {
  K: '♚',
  Q: '♛',
  R: '♜',
  B: '♝',
  N: '♞',
};

/**
 * Convert a SAN move string to figurine notation.
 * Returns the symbol and whether it's a white or black piece,
 * so the caller can apply CSS styling.
 *
 * @param san - Move in Standard Algebraic Notation (e.g., "Nf3", "e4", "O-O")
 * @param isWhite - Whether the moving side is white
 * @returns Move string with figurine piece symbol
 */
export function toFigurine(san: string, isWhite: boolean): string {
  if (!san || san.length === 0) return san;

  // Castling - leave as-is
  if (san.startsWith('O-O')) return san;

  const firstChar = san[0];

  if (PIECE_SYMBOLS[firstChar]) {
    return PIECE_SYMBOLS[firstChar] + san.slice(1);
  }

  return san;
}

/**
 * Check if a SAN move starts with a piece letter (not a pawn move).
 */
export function hasPieceSymbol(san: string): boolean {
  if (!san || san.length === 0) return false;
  if (san.startsWith('O-O')) return false;
  return !!PIECE_SYMBOLS[san[0]];
}

/**
 * Format an array of PV moves with move numbers and figurine notation.
 *
 * @param moves - Array of SAN moves
 * @param startingWhite - Whether the first move is by white
 * @param maxMoves - Maximum number of moves to show
 * @returns Formatted string with move numbers and figurines
 */
export function formatPVWithNumbers(
  moves: string[],
  startingWhite: boolean,
  maxMoves: number = 14
): string {
  if (moves.length === 0) return '';

  const parts: string[] = [];
  let isWhite = startingWhite;
  let moveNumber = 1;

  for (let i = 0; i < Math.min(moves.length, maxMoves); i++) {
    const figurine = toFigurine(moves[i], isWhite);

    if (isWhite) {
      parts.push(`${moveNumber}.${figurine}`);
    } else {
      if (i === 0) {
        parts.push(`${moveNumber}...${figurine}`);
      } else {
        parts.push(figurine);
      }
      moveNumber++;
    }

    isWhite = !isWhite;
  }

  return parts.join(' ');
}

/**
 * Format PV moves as React elements with move numbers and figurine notation.
 * Returns an array of spans for more granular styling.
 */
export function formatPVElements(
  moves: string[],
  startingWhite: boolean,
  maxMoves: number = 14
): Array<{ text: string; isMoveNumber: boolean; isWhiteMove: boolean }> {
  const elements: Array<{ text: string; isMoveNumber: boolean; isWhiteMove: boolean }> = [];

  let isWhite = startingWhite;
  let moveNumber = 1;

  for (let i = 0; i < Math.min(moves.length, maxMoves); i++) {
    const figurine = toFigurine(moves[i], isWhite);

    if (isWhite) {
      elements.push({ text: `${moveNumber}.`, isMoveNumber: true, isWhiteMove: true });
      elements.push({ text: figurine, isMoveNumber: false, isWhiteMove: true });
    } else {
      if (i === 0) {
        elements.push({ text: `${moveNumber}...`, isMoveNumber: true, isWhiteMove: false });
      }
      elements.push({ text: figurine, isMoveNumber: false, isWhiteMove: false });
      moveNumber++;
    }

    isWhite = !isWhite;
  }

  return elements;
}
