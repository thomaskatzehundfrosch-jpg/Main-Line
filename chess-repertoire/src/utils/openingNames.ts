import type { OpeningInfo } from '../types';

// Common ECO opening names by FEN prefix (first few moves)
// This is a subset; a full database would be loaded from a file
const OPENING_DB: Record<string, OpeningInfo> = {
  'rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq': { eco: 'B00', name: "King's Pawn Opening" },
  'rnbqkbnr/pppppppp/8/8/3P4/8/PPP1PPPP/RNBQKBNR b KQkq': { eco: 'A40', name: "Queen's Pawn Opening" },
  'rnbqkbnr/pppppppp/8/8/2P5/8/PP1PPPPP/RNBQKBNR b KQkq': { eco: 'A10', name: 'English Opening' },
  'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq': { eco: 'A04', name: "Réti Opening" },
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq': { eco: 'C20', name: "King's Pawn Game" },
  'rnbqkbnr/pppp1ppp/8/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq': { eco: 'C40', name: "King's Knight Opening" },
  'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq': { eco: 'C44', name: "Open Game" },
  'r1bqkbnr/pppp1ppp/2n5/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R b KQkq': { eco: 'C50', name: 'Italian Game' },
  'r1bqkb1r/pppp1ppp/2n2n2/4p3/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq': { eco: 'C54', name: 'Italian Game: Giuoco Piano' },
  'r1bqkbnr/pppp1ppp/2n5/4p3/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq': { eco: 'C44', name: "King's Knight Game" },
  'r1bqkbnr/pppp1ppp/2n5/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R b KQkq': { eco: 'C60', name: 'Ruy Lopez' },
  'r1bqkb1r/pppp1ppp/2n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq': { eco: 'C65', name: 'Ruy Lopez: Berlin Defense' },
  'r1bqkb1r/1ppp1ppp/p1n2n2/1B2p3/4P3/5N2/PPPP1PPP/RNBQK2R w KQkq': { eco: 'C70', name: 'Ruy Lopez: Morphy Defense' },
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/8/PPPP1PPP/RNBQKBNR w KQkq': { eco: 'B20', name: 'Sicilian Defense' },
  'rnbqkbnr/pp1ppppp/8/2p5/4P3/5N2/PPPP1PPP/RNBQKB1R b KQkq': { eco: 'B27', name: 'Sicilian Defense' },
  'rnbqkbnr/pp1ppppp/3p4/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq': { eco: 'B50', name: 'Sicilian Defense' },
  'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/8/PPP2PPP/RNBQKB1R w KQkq': { eco: 'B40', name: 'Sicilian Defense: Open' },
  'rnbqkb1r/pp2pppp/3p1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R b KQkq': { eco: 'B40', name: 'Sicilian Defense: Open' },
  'r1bqkb1r/pp2pppp/2np1n2/8/3NP3/2N5/PPP2PPP/R1BQKB1R w KQkq': { eco: 'B60', name: 'Sicilian Defense: Richter-Rauzer' },
  'rnbqkbnr/pppp1ppp/4p3/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq': { eco: 'C00', name: 'French Defense' },
  'rnbqkbnr/pppp1ppp/4p3/8/4PP2/8/PPPP2PP/RNBQKBNR b KQkq': { eco: 'C00', name: 'French Defense' },
  'rnbqkbnr/pppp1ppp/4p3/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq': { eco: 'C01', name: 'French Defense' },
  'rnbqkbnr/ppp1pppp/3p4/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq': { eco: 'B06', name: "Pirc Defense" },
  'rnbqkbnr/ppp1pppp/3p4/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq': { eco: 'B07', name: "Pirc Defense" },
  'rnbqkb1r/pppppppp/5n2/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq': { eco: 'B02', name: "Alekhine's Defense" },
  'rnbqkbnr/pp1ppppp/2p5/8/4P3/8/PPPP1PPP/RNBQKBNR w KQkq': { eco: 'B10', name: 'Caro-Kann Defense' },
  'rnbqkbnr/pp1ppppp/2p5/8/3PP3/8/PPP2PPP/RNBQKBNR b KQkq': { eco: 'B12', name: 'Caro-Kann Defense' },
  'rnbqkbnr/ppp1pppp/8/3p4/3P4/8/PPP1PPPP/RNBQKBNR w KQkq': { eco: 'D00', name: "Queen's Pawn Game" },
  'rnbqkbnr/ppp1pppp/8/3p4/2PP4/8/PP2PPPP/RNBQKBNR b KQkq': { eco: 'D06', name: "Queen's Gambit" },
  'rnbqkbnr/ppp2ppp/4p3/3p4/2PP4/8/PP2PPPP/RNBQKBNR w KQkq': { eco: 'D30', name: "Queen's Gambit Declined" },
  'rnbqkbnr/ppp2ppp/8/3pP3/3P4/8/PPP2PPP/RNBQKBNR b KQkq': { eco: 'C02', name: 'French Defense: Advance Variation' },
  'rnbqkb1r/pppppppp/5n2/8/3P4/8/PPP1PPPP/RNBQKBNR w KQkq': { eco: 'A45', name: "Indian Defense" },
  'rnbqkb1r/pppppppp/5n2/8/2PP4/8/PP2PPPP/RNBQKBNR b KQkq': { eco: 'A50', name: "Indian Defense" },
  'rnbqkb1r/pppppp1p/5np1/8/2PP4/8/PP2PPPP/RNBQKBNR w KQkq': { eco: 'E60', name: "King's Indian Defense" },
  'rnbqkb1r/pppppp1p/5np1/8/2PP4/2N5/PP2PPPP/R1BQKBNR b KQkq': { eco: 'E61', name: "King's Indian Defense" },
  'rnbqk2r/ppppppbp/5np1/8/2PP4/2N5/PP2PPPP/R1BQKBNR w KQkq': { eco: 'E70', name: "King's Indian Defense" },
  'rnbqkb1r/p1pppppp/1p3n2/8/2PP4/8/PP2PPPP/RNBQKBNR w KQkq': { eco: 'E10', name: "Queen's Indian Defense" },
  'rnbqkb1r/pppp1ppp/4pn2/8/2PP4/8/PP2PPPP/RNBQKBNR w KQkq': { eco: 'E00', name: 'Nimzo-Indian / Catalan' },
  'rnbqk2r/pppp1ppp/4pn2/8/1bPP4/2N5/PP2PPPP/R1BQKBNR w KQkq': { eco: 'E20', name: 'Nimzo-Indian Defense' },
  'rnbqkbnr/pppp1ppp/8/4p3/2P5/8/PP1PPPPP/RNBQKBNR w KQkq': { eco: 'A20', name: 'English Opening: Reversed Sicilian' },
  'rnbqkbnr/pppppppp/8/8/8/5N2/PPPPPPPP/RNBQKB1R b KQkq': { eco: 'A04', name: "Réti Opening" },
  'rnbqkbnr/pppppppp/8/8/8/1P6/P1PPPPPP/RNBQKBNR b KQkq': { eco: 'A01', name: "Larsen's Opening" },
  'rnbqkbnr/pppppppp/8/8/8/6P1/PPPPPP1P/RNBQKBNR b KQkq': { eco: 'A00', name: "King's Fianchetto Opening" },
  'rnbqkbnr/pppppppp/8/8/P7/8/1PPPPPPP/RNBQKBNR b KQkq': { eco: 'A00', name: 'Ware Opening' },
  'rnbqkbnr/pppppppp/8/8/1P6/8/P1PPPPPP/RNBQKBNR b KQkq': { eco: 'A00', name: 'Polish Opening' },
};

/**
 * Look up the opening name for a given FEN.
 * We strip the move counters and halfmove clock to match more flexibly.
 */
export function getOpeningInfo(fen: string): OpeningInfo | null {
  // Strip halfmove clock and fullmove number for matching
  const parts = fen.split(' ');
  const shortFen = parts.slice(0, 4).join(' ');

  if (OPENING_DB[shortFen]) {
    return OPENING_DB[shortFen];
  }

  // Try even shorter match (just position + side to move)
  const shorterFen = parts.slice(0, 2).join(' ');
  for (const [key, value] of Object.entries(OPENING_DB)) {
    const keyShort = key.split(' ').slice(0, 2).join(' ');
    if (keyShort === shorterFen) {
      return value;
    }
  }

  return null;
}

/**
 * Get the best matching opening name for a path of FENs.
 * Returns the deepest match found.
 */
export function getOpeningForPath(fens: string[]): OpeningInfo | null {
  let lastMatch: OpeningInfo | null = null;
  for (const fen of fens) {
    const info = getOpeningInfo(fen);
    if (info) {
      lastMatch = info;
    }
  }
  return lastMatch;
}
