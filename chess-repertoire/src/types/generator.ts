/** Settings and results for repertoire continuation generation. */
export type AnalysisMode = 'stockfish' | 'lichess+stockfish';
export type StudySize = 'compact' | 'standard' | 'broad';

export interface GeneratorSettings {
  color: 'white' | 'black';
  analysisMode: AnalysisMode;
  maxMoveNumber: number;
  studySize: StudySize;
  /** One depth for discovery and verification. Generator analysis is local. */
  sfDepth: number;
  /** Maximum loss in pawns relative to the position evaluation before your move, from your side’s perspective. */
  maxEvalLoss: number;
  evaluationFloorEnabled: boolean;
  evaluationFloor: number;
  trickiness: 'off' | 'balanced' | 'high';
  trickinessMinLoss: number;
  trickinessMaxLoss: number;
  tacticalExtension: number;
  avoidQueenTrades: boolean;
  useMasters: boolean;
  ratingMin: number;
  ratingMax: number;
  speeds: string[];
  minGames: number;
  /** Include supported opponent replies at or above this local play percentage. */
  opponentMinPlayRate: number;
  adaptiveOpponentDepth: boolean;
  branchDecay: 'off' | 'gentle' | 'balanced';
}

export const STUDY_SIZES = {
  compact: { maxNodes: 150, coverage: 0.7, maxReplies: 3 },
  standard: { maxNodes: 500, coverage: 0.85, maxReplies: 5 },
  broad: { maxNodes: 1200, coverage: 0.95, maxReplies: 8 },
} as const;

export const DEFAULT_GENERATOR_SETTINGS: GeneratorSettings = {
  color: 'white', analysisMode: 'lichess+stockfish', maxMoveNumber: 15,
  studySize: 'standard', sfDepth: 16, maxEvalLoss: 0.5,
  tacticalExtension: 2, avoidQueenTrades: false,
  useMasters: false, ratingMin: 2200, ratingMax: 2500,
  speeds: ['blitz', 'rapid', 'classical'], minGames: 10,
  evaluationFloorEnabled: true, evaluationFloor: -0.4,
  trickiness: 'high', trickinessMinLoss: 0, trickinessMaxLoss: 0.5,
  opponentMinPlayRate: 5, adaptiveOpponentDepth: true, branchDecay: 'balanced',
};

export function normalizeGeneratorSettings(input: GeneratorSettings): GeneratorSettings {
  const number = (value: number, fallback: number, min: number, max: number) =>
    Math.min(max, Math.max(min, Number.isFinite(value) ? value : fallback));
  const min = number(input.ratingMin, 2200, 1000, 2500);
  const max = number(input.ratingMax, 2500, 1000, 2500);
  const speeds = [...new Set(input.speeds.filter(s => ['bullet', 'blitz', 'rapid', 'classical'].includes(s)))];
  return {
    ...input,
    color: input.color === 'black' ? 'black' : 'white',
    analysisMode: input.analysisMode === 'stockfish' ? 'stockfish' : 'lichess+stockfish',
    studySize: input.studySize in STUDY_SIZES ? input.studySize : 'standard',
    maxMoveNumber: Math.round(number(input.maxMoveNumber, 15, 1, 40)),
    sfDepth: Math.round(number(input.sfDepth, 16, 8, 25)),
    maxEvalLoss: number(input.maxEvalLoss, 0.5, 0, 1),
    evaluationFloorEnabled: input.evaluationFloorEnabled ?? true,
    evaluationFloor: number(input.evaluationFloor, -0.4, -10, 10),
    trickiness: input.trickiness === 'balanced' || input.trickiness === 'off' ? input.trickiness : 'high',
    trickinessMinLoss: Math.min(number(input.trickinessMinLoss, 0, 0, 5), number(input.trickinessMaxLoss, 0.5, 0, 5)),
    trickinessMaxLoss: Math.max(number(input.trickinessMinLoss, 0, 0, 5), number(input.trickinessMaxLoss, 0.5, 0, 5)),
    tacticalExtension: Math.round(number(input.tacticalExtension, 2, 0, 4)),
    opponentMinPlayRate: number(input.opponentMinPlayRate, 5, 1, 100),
    adaptiveOpponentDepth: input.adaptiveOpponentDepth ?? true,
    branchDecay: input.branchDecay === 'off' || input.branchDecay === 'gentle' ? input.branchDecay : 'balanced',
    minGames: Math.round(number(input.minGames, 10, 1, 10000)),
    ratingMin: Math.min(min, max), ratingMax: Math.max(min, max),
    speeds: speeds.length ? speeds : ['rapid'],
  };
}

export interface GeneratorSfEval { eval: number | null; depth: number; }
/** Win/loss rates are from the repertoire side's perspective. */
export interface GeneratorLichessStats {
  totalGames: number;
  winRate: number;
  lossRate: number;
  drawRate: number;
  averageRating: number | null;
}
export type GeneratorEndReason = 'target' | 'adaptive-depth' | 'terminal' | 'repetition' | 'budget' | 'stopped' | 'analysis-failed' | 'extension-limit';
export const END_REASON_LABELS: Record<GeneratorEndReason, string> = {
  'adaptive-depth': 'Rare reply — shorter study depth reached',
  repetition: 'Repeated position — line ends here',
  target: 'Target length reached', terminal: 'Game over', budget: 'Study budget reached — continuation unfinished',
  stopped: 'Stopped — continuation unfinished', 'analysis-failed': 'Analysis failed — continuation unfinished',
  'extension-limit': 'Tactical extension limit reached — review this position',
};
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
  reason?: string;
  warning?: string;
  endReason?: GeneratorEndReason;
  /** At opponent positions, fraction of database games covered by the children. */
  responseCoverage?: number;
  coverageLimited?: boolean;
  repertoireColor?: 'white' | 'black';
}
export interface GeneratorProgress {
  nodes: number;
  maxNodes: number;
  status: string;
  apiCalls: number;
  outcome?: 'running' | 'complete' | 'partial' | 'stopped' | 'failed';
  unfinished?: number;
  /** Mean local reply coverage, not whole-repertoire probability. */
  averageResponseCoverage?: number;
  coveragePositions?: number;
  coverageGaps?: number;
}
export interface GeneratorLogEntry {
  id: string;
  timestamp: string;
  level: 'info' | 'warning' | 'error';
  message: string;
  context: string | null;
}
export interface GeneratorCallbacks {
  onNodeAdded?: (root: GeneratorNode) => void;
  onNewNode?: (node: GeneratorNode) => void;
  onLog?: (entry: GeneratorLogEntry) => void;
  onProgress?: (progress: GeneratorProgress) => void;
  onComplete?: (root: GeneratorNode) => void;
}
