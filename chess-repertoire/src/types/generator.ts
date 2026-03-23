/**
 * Types for the auto-repertoire generator.
 */

export type AnalysisMode = 'stockfish' | 'lichess+stockfish';
export type RepertoireStyle = 'aggressive' | 'solid' | 'balanced';

/** Settings controlling repertoire generation. */
export interface GeneratorSettings {
  color: 'white' | 'black';
  analysisMode: AnalysisMode;
  targetDepth: number;            // max tree depth in plies (4–50)
  maxMoveNumber: number;          // stop expanding after move N (5–40)
  depthDecay: boolean;            // reduce depth for sidelines by 4 plies
  maxBranchesOur: number;         // top N of our candidate moves (1–3)
  maxOpponentResponses: number;   // top N opponent responses (1–3)
  maxNodes: number;               // total node limit (10–2000)
  sfDepth: number;                // Stockfish search depth (8–25)
  evalThreshold: number;          // min acceptable eval for our moves (pawns)
  flagDangerousResponses: boolean;
  smartFiltering: boolean;         // skip weak opponent responses when eval gap is large
  /**
   * Continuous style bias on a −2 … +2 integer scale.
   *   −2 = very aggressive (loosest eval threshold, prefers high win-rate / sharp lines)
   *   −1 = aggressive
   *    0 = balanced  (engine-first, no bias)
   *   +1 = solid
   *   +2 = very solid (strictest eval threshold, minimises losing chances)
   */
  styleValue: number;
  // Lichess settings
  useMasters: boolean;            // use /masters endpoint instead of /lichess
  ratingMin: number;              // 1000–2500
  ratingMax: number;              // 1000–2500
  speeds: string[];               // 'bullet'|'blitz'|'rapid'|'classical'
  minGames: number;               // min Lichess games per move
  minWinRate: number;             // min win rate (%) for our moves in Lichess mode (0–60)
  lichessToken: string;           // optional Lichess personal API token (for auth)
  // Maia settings
  maiaLevel: 1100 | 1300 | 1500 | 1700 | 1900 | 2100; // target human skill level
  maiaApiUrl: string;             // Maia API endpoint (default: maiachess.com)
  maiaSfMaxDrop: number;          // max eval drop vs SF best (pawns) in Maia+SF mode
  // Trickyness settings
  /**
   * How strongly to prefer moves that put the opponent in tricky positions.
   * Measured as the weighted fraction of opponent play that falls ≥0.5 pawns
   * below the best response (opponent error rate), computed via Stockfish MultiPV.
   *   0 = disabled (no trickyness preference)
   *   1 = subtle bonus for tricky positions
   *   5 = maximum — may surface lower-eval moves if they're trickier
   */
  trickynessWeight: number;       // 0–5
}

/** Stockfish evaluation attached to a generator node. */
export interface GeneratorSfEval {
  eval: number | null;  // pawns from White's perspective
  depth: number;
}

/** Lichess statistics attached to a generator node. */
export interface GeneratorLichessStats {
  totalGames: number;
  winRate: number;
  lossRate: number;
  drawRate: number;
  averageRating: number | null;
}

/** A node in the generator's tree (intermediate, maps to TreeNode for import). */
export interface GeneratorNode {
  id: string;
  san: string | null;
  uci: string;
  fen: string;
  children: GeneratorNode[];
  depth: number;
  fullMoveNumber: number;
  isOurMove: boolean;
  isMainLine: boolean;
  isDangerous: boolean;
  cappedByMoveLimit: boolean;
  stockfish: GeneratorSfEval | null;
  lichess: GeneratorLichessStats | null;
  isRoot?: boolean;
  isSeed?: boolean;
}

/** Progress tracking during generation. */
export interface GeneratorProgress {
  nodes: number;
  maxNodes: number;
  status: string;
  apiCalls: number;
}

/** A single log entry from the generator. */
export interface GeneratorLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  context: string | null;
}

/** Callbacks passed to the tree builder. */
export interface GeneratorCallbacks {
  onNodeAdded?: (root: GeneratorNode) => void;
  /** Fired with a shallow copy of each newly-created node (no children).
   *  Used for live board animation: the node carries the FEN and UCI of the
   *  move just played so the board can animate to it immediately. */
  onNewNode?: (node: GeneratorNode) => void;
  onLog?: (entry: GeneratorLogEntry) => void;
  onProgress?: (progress: GeneratorProgress) => void;
  onComplete?: (root: GeneratorNode) => void;
}

/** Maia move prediction attached to a candidate. */
export interface GeneratorMaiaStats {
  probability: number; // 0–1, predicted probability from Maia
}

/** A move candidate from Stockfish, Lichess, and/or Maia. */
export interface MoveCandidate {
  san: string;
  uci: string;
  _sfEval?: number | null;
  _sfDepth?: number;
  _lichess?: GeneratorLichessStats | null;
  _maia?: GeneratorMaiaStats | null;
  /** Fraction of opponent play (0–1) that falls ≥0.5 pawns below the best
   *  response in the position reached after this move. Computed on-demand
   *  when trickynessWeight > 0. */
  _trickynessErrorRate?: number | null;
}

/** Default generator settings. */
export const DEFAULT_GENERATOR_SETTINGS: GeneratorSettings = {
  color: 'white',
  analysisMode: 'lichess+stockfish',
  targetDepth: 30,
  maxMoveNumber: 15,
  depthDecay: false,
  maxBranchesOur: 1,
  maxOpponentResponses: 2,
  maxNodes: 300,
  sfDepth: 20,
  evalThreshold: -0.6,
  flagDangerousResponses: true,
  smartFiltering: true,
  styleValue: -1,
  useMasters: true,
  ratingMin: 1600,
  ratingMax: 2500,
  speeds: ['blitz', 'rapid', 'classical'],
  minGames: 6,
  minWinRate: 40,
  lichessToken: '',
  maiaLevel: 2100,
  maiaApiUrl: 'https://maiachess.com/api/maia_move',
  maiaSfMaxDrop: 1.5,
  trickynessWeight: 0,
};
