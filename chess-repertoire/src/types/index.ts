export interface TreeNode {
  id: string;
  move: string; // SAN notation, empty string for root
  fen: string;
  children: TreeNode[];
  parentId: string | null;
  gameCount: number;
  whiteWins: number;
  blackWins: number;
  draws: number;
  comment: string;
  nags: number[];
  depth: number;
}

export interface EngineLine {
  depth: number;
  score: number; // centipawns
  mate: number | null; // null if not mate, else moves to mate
  pv: string[]; // principal variation moves in SAN
  pvUci: string[]; // UCI format for arrows
  multipv: number;
}

export interface EngineState {
  enabled: boolean;
  workerReady: boolean;
  depth: number;
  maxDepth: number;
  multiPV: number;
  threads: number;
  lines: EngineLine[];
  isThinking: boolean;
  currentFen: string;
}

export interface RepertoireState {
  tree: TreeNode;
  currentNode: TreeNode;
  currentPath: TreeNode[];
  orientation: 'white' | 'black';
  selectedColor: 'white' | 'black' | 'both';
}

export type RepertoireAction =
  | { type: 'SET_TREE'; tree: TreeNode }
  | { type: 'NAVIGATE_TO_NODE'; node: TreeNode }
  | { type: 'NAVIGATE_FORWARD'; childIndex?: number }
  | { type: 'NAVIGATE_BACK' }
  | { type: 'NAVIGATE_TO_START' }
  | { type: 'NAVIGATE_TO_END' }
  | { type: 'FLIP_BOARD' }
  | { type: 'SET_ORIENTATION'; orientation: 'white' | 'black' }
  | { type: 'SET_COMMENT'; nodeId: string; comment: string }
  | { type: 'ADD_NAG'; nodeId: string; nag: number }
  | { type: 'REMOVE_NAG'; nodeId: string; nag: number }
  | { type: 'ADD_MOVE'; parentId: string; move: string; fen: string }
  | { type: 'ADD_MOVE_LINE'; parentId: string; moves: { move: string; fen: string }[]; noNavigate?: boolean }
  | { type: 'SET_SELECTED_COLOR'; color: 'white' | 'black' | 'both' }
  | { type: 'DELETE_NODE'; nodeId: string };

export type EngineAction =
  | { type: 'SET_ENABLED'; enabled: boolean }
  | { type: 'SET_DEPTH'; depth: number }
  | { type: 'SET_LINES'; lines: EngineLine[] }
  | { type: 'SET_THINKING'; isThinking: boolean }
  | { type: 'SET_CURRENT_FEN'; fen: string }
  | { type: 'SET_MULTIPV'; multiPV: number }
  | { type: 'SET_THREADS'; threads: number }
  | { type: 'CLEAR_LINES' }
  | { type: 'SET_WORKER_READY'; ready: boolean };

export interface OpeningInfo {
  eco: string;
  name: string;
}

export interface RepertoireEval {
  score: number;       // centipawns, White's perspective
  depth: number;
  isMate: boolean;
  mateIn: number | null;
  bestMove: string;    // SAN
}

export const NAG_SYMBOLS: Record<number, { symbol: string; meaning: string; className: string }> = {
  1: { symbol: '!', meaning: 'Good move', className: 'move-good' },
  2: { symbol: '?', meaning: 'Poor move', className: 'move-bad' },
  3: { symbol: '!!', meaning: 'Brilliant move', className: 'move-good' },
  4: { symbol: '??', meaning: 'Blunder', className: 'move-bad' },
  5: { symbol: '!?', meaning: 'Interesting move', className: 'move-interesting' },
  6: { symbol: '?!', meaning: 'Dubious move', className: 'move-interesting' },
  10: { symbol: '=', meaning: 'Equal position', className: 'text-text-secondary' },
  13: { symbol: '∞', meaning: 'Unclear position', className: 'text-text-secondary' },
  14: { symbol: '+=', meaning: 'White slightly better', className: 'move-good' },
  15: { symbol: '=+', meaning: 'Black slightly better', className: 'move-good' },
  16: { symbol: '±', meaning: 'White better', className: 'move-good' },
  17: { symbol: '∓', meaning: 'Black better', className: 'move-good' },
  18: { symbol: '+−', meaning: 'White winning', className: 'move-good' },
  19: { symbol: '−+', meaning: 'Black winning', className: 'move-good' },
};
