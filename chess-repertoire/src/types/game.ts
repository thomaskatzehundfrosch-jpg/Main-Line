export type MistakeTier = 'inaccuracy' | 'mistake' | 'blunder';

export interface MistakeRecord {
  id: string;
  gameId: string;
  moveNumber: number;
  fen: string;
  side: 'white' | 'black';
  movePlayed: string;
  bestMove: string;
  evalBefore: number;
  evalAfter: number;
  evalDrop: number;
  tier: MistakeTier;
  reviewed: boolean;
}

export interface ImportedGame {
  id: string;
  pgn: string;
  white: string;
  black: string;
  date?: string;
  result?: string;
  moves: string[];
  mistakes: MistakeRecord[];
  analyzed: boolean;
}

/** Default thresholds for mistake classification (eval drop in pawns) */
export const MISTAKE_THRESHOLDS = {
  inaccuracy: 0.4,
  mistake: 1.0,
  blunder: 2.0,
} as const;

/** Colors for each mistake tier */
export const MISTAKE_COLORS: Record<MistakeTier, string> = {
  inaccuracy: '#faff00', // bright yellow
  mistake: '#e67e22',    // orange
  blunder: '#e74c3c',    // red
};

export function classifyMistake(evalDrop: number): MistakeTier | null {
  if (evalDrop >= MISTAKE_THRESHOLDS.blunder) return 'blunder';
  if (evalDrop >= MISTAKE_THRESHOLDS.mistake) return 'mistake';
  if (evalDrop >= MISTAKE_THRESHOLDS.inaccuracy) return 'inaccuracy';
  return null;
}

export function generateGameId(): string {
  return `game_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

export function generateMistakeId(): string {
  return `mistake_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}
