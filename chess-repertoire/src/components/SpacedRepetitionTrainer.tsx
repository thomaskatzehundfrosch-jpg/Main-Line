import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import type { Square, Piece, Arrow } from 'react-chessboard/dist/chessboard/types';
import {
  RotateCcw,
  ChevronLeft,
  ChevronRight,
  Trophy,
  Brain,
  ChevronDown,
  ChevronUp,
  FolderOpen,
  Download,
  Check,
  Trash2,
  Eye,
  Play,
  SkipForward,
  X,
  ArrowRight,
} from 'lucide-react';
import type { Card } from '../lib/srScheduler';
import { reviewCard, getDueCards } from '../lib/srScheduler';
import {
  loadCards,
  saveCards,
  addCards as storageAddCards,
  clearAllCards,
  loadStats,
  saveSessionStats,
} from '../lib/srStorage';
import type { SRLifetimeStats } from '../lib/srStorage';
import { treeToCards } from '../lib/srTreeImport';
import { useFiles } from '../context/FileContext';
import { useEngine } from '../hooks/useEngine';
import EvalBar from './Board/EvalBar';
import { SRCardImporter } from './SRCardImporter';
import type { TreeNode } from '../types';

// ---------------------------------------------------------------------------
// Reusable Chess instance to avoid re-creating per move (perf optimisation)
// ---------------------------------------------------------------------------
const _chess = new Chess();

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Phase = 'idle' | 'question' | 'answer' | 'grading' | 'complete' | 'replay' | 'walking';

interface SessionStats {
  correct: number;
  incorrect: number;
}

interface SessionHistoryEntry {
  card: Card;
  userMove: string | null;
  correct: boolean;
}

interface SpacedRepetitionTrainerProps {
  onClose?: () => void;
}

interface ImportFeedback {
  fileName: string;
  added: number;
  skipped: number;
}

/** State for a walk-mode training session (play through a repertoire from move 1). */
interface WalkSession {
  /** All root-to-leaf paths through the repertoire tree. */
  paths: TreeNode[][];
  /** Index of the path currently being drilled. */
  pathIdx: number;
  /**
   * 1-based index into `paths[pathIdx]` of the node whose move we are about
   * to present or auto-play.  Index 0 is the root (no move), so we start at 1.
   */
  stepIdx: number;
  drillColor: 'white' | 'black';
  /** Set of `parentFen|||uci` keys for moves already shown in this session. */
  sessionPlayed: Set<string>;
  fileName: string;
  stats: SessionStats;
  /**
   * When true, a brief "new line" pause is shown before the first move of a
   * new path so the user can clearly see they have moved to the next line.
   */
  lineStarting: boolean;
}

// ---------------------------------------------------------------------------
// Helpers (outside component for stable identity)
// ---------------------------------------------------------------------------

/** Convert a UCI move string to algebraic notation using the shared Chess instance. */
function uciToSan(fen: string, uci: string): string {
  try {
    _chess.load(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const move = _chess.move({ from, to, promotion } as {
      from: string;
      to: string;
      promotion?: string;
    });
    return move ? move.san : uci;
  } catch {
    return uci;
  }
}

/** Collect every root-to-leaf path through a repertoire tree. */
function buildAllPaths(root: TreeNode): TreeNode[][] {
  const paths: TreeNode[][] = [];
  function dfs(node: TreeNode, path: TreeNode[]) {
    const p = [...path, node];
    if (node.children.length === 0) {
      paths.push(p);
    } else {
      for (const child of node.children) {
        dfs(child, p);
      }
    }
  }
  dfs(root, []);
  return paths;
}

/**
 * Re-order paths so that consecutive paths diverge as early as possible.
 *
 * Uses a greedy nearest-neighbour approach: from the remaining pool of paths,
 * always pick the one whose first differing move from the last selected path
 * occurs at the shallowest depth.  This way lines that look different come
 * back-to-back instead of many nearly-identical openings in a row.
 */
function sortPathsByDivergence(paths: TreeNode[][]): TreeNode[][] {
  if (paths.length <= 1) return paths;

  /** Index of the first node (depth ≥ 1) where two paths differ by FEN. */
  function divergenceDepth(a: TreeNode[], b: TreeNode[]): number {
    const len = Math.min(a.length, b.length);
    for (let i = 1; i < len; i++) {
      if (a[i].fen !== b[i].fen) return i;
    }
    // One path is a prefix of the other — treat as diverging at the end
    return len;
  }

  const remaining = paths.slice(1);
  const sorted: TreeNode[][] = [paths[0]];

  while (remaining.length > 0) {
    const last = sorted[sorted.length - 1];
    // Pick the path that diverges earliest (smallest depth) from `last`
    let bestIdx = 0;
    let bestDepth = divergenceDepth(last, remaining[0]);
    for (let i = 1; i < remaining.length; i++) {
      const d = divergenceDepth(last, remaining[i]);
      if (d < bestDepth) {
        bestDepth = d;
        bestIdx = i;
      }
    }
    sorted.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }

  return sorted;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export const SpacedRepetitionTrainer: React.FC<SpacedRepetitionTrainerProps> = ({
  onClose,
}) => {
  // ── Context ─────────────────────────────────────────────────────────
  const { files } = useFiles();
  const engine = useEngine();

  // ── State ────────────────────────────────────────────────────────────
  const [cards, setCards] = useState<Card[]>([]);
  const [sessionCards, setSessionCards] = useState<Card[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [userMove, setUserMove] = useState<string | null>(null);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>(
    'white',
  );
  const [stats, setStats] = useState<SessionStats>({
    correct: 0,
    incorrect: 0,
  });

  // Lifetime stats
  const [lifetimeStats, setLifetimeStats] = useState<SRLifetimeStats>(loadStats);

  // UI panels
  const [repertoireListOpen, setRepertoireListOpen] = useState(true);
  const [importerOpen, setImporterOpen] = useState(false);
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null);

  // Board sizing
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(400);

  // Auto-advance timer
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Click-to-move state
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);

  // Show Solution state (manual reveal, not auto)
  const [showSolution, setShowSolution] = useState(false);

  // Session history for replay
  const [sessionHistory, setSessionHistory] = useState<SessionHistoryEntry[]>([]);
  const [replayIndex, setReplayIndex] = useState(0);

  // Deferred save ref – persist cards to storage asynchronously
  const pendingSaveRef = useRef<Card[] | null>(null);

  // Walk-mode session state
  const [walkSession, setWalkSession] = useState<WalkSession | null>(null);
  const [walkSpeed, setWalkSpeed] = useState<'slow' | 'normal' | 'fast'>('normal');
  // Brief "wrong move" flash shown while the user is still in question phase
  const [walkTryAgain, setWalkTryAgain] = useState(false);
  const walkTryAgainRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Session initialisation ──────────────────────────────────────────
  const initializeSession = useCallback(() => {
    setWalkSession(null);
    const loaded = loadCards();
    setCards(loaded);
    const due = getDueCards(loaded, 20);
    setSessionCards(due);
    setCurrentIndex(0);
    setUserMove(null);
    setShowSolution(false);
    setSessionHistory([]);
    setReplayIndex(0);
    setStats({ correct: 0, incorrect: 0 });
    if (due.length > 0) {
      setPhase('question');
      const activeColor = due[0].front.split(' ')[1];
      setBoardOrientation(activeColor === 'b' ? 'black' : 'white');
    } else {
      setPhase('idle');
    }
  }, []);

  useEffect(() => {
    initializeSession();
  }, [initializeSession]);

  // ── Resize board to container ───────────────────────────────────────
  useEffect(() => {
    const updateWidth = () => {
      if (boardContainerRef.current) {
        const w = boardContainerRef.current.offsetWidth;
        setBoardWidth(Math.max(280, Math.min(560, w - 50)));
      }
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    if (boardContainerRef.current) {
      observer.observe(boardContainerRef.current);
    }
    return () => observer.disconnect();
  }, []);

  // ── Deferred localStorage save (runs async, not in hot path) ───────
  useEffect(() => {
    if (pendingSaveRef.current) {
      const data = pendingSaveRef.current;
      pendingSaveRef.current = null;
      requestAnimationFrame(() => saveCards(data));
    }
  });

  // ── Derived card-mode values ────────────────────────────────────────
  const currentCard: Card | null = sessionCards[currentIndex] ?? null;
  const replayCard: Card | null = phase === 'replay' && sessionHistory[replayIndex]
    ? sessionHistory[replayIndex].card
    : null;

  // ── Walk-mode derived values ────────────────────────────────────────
  const walkCurrentPath = walkSession ? walkSession.paths[walkSession.pathIdx] : null;
  const walkTargetNode = walkCurrentPath && walkSession
    ? walkCurrentPath[walkSession.stepIdx] ?? null
    : null;
  const walkBoardFen = walkCurrentPath && walkSession
    ? walkCurrentPath[walkSession.stepIdx - 1]?.fen ?? INITIAL_FEN
    : INITIAL_FEN;

  /** A virtual SR card synthesised from the current walk position. */
  const walkVirtualCard: Card | null = useMemo(() => {
    if (!walkSession || !walkCurrentPath || !walkTargetNode) return null;
    const parentNode = walkCurrentPath[walkSession.stepIdx - 1];
    if (!parentNode) return null;
    const parentFen = parentNode.fen;
    try {
      _chess.load(parentFen);
      const move = _chess.move(walkTargetNode.move);
      if (!move) return null;
      const uci = move.from + move.to + (move.promotion || '');
      return {
        id: 'walk-virtual',
        front: parentFen,
        back: uci,
        interval: 1,
        repetitions: 0,
        easeFactor: 2.5,
        dueDate: Date.now(),
        lastReviewed: null,
        lineName: walkSession.fileName,
      };
    } catch {
      return null;
    }
  }, [walkSession, walkCurrentPath, walkTargetNode]);

  /** The card currently in play – either from the walk tree or the card deck. */
  const effectiveCard: Card | null = useMemo(
    () => (walkSession ? walkVirtualCard : currentCard),
    [walkSession, walkVirtualCard, currentCard],
  );

  // ── Display FEN ─────────────────────────────────────────────────────
  const displayFen = phase === 'replay'
    ? (replayCard?.front ?? INITIAL_FEN)
    : walkSession
      ? walkBoardFen
      : (currentCard?.front ?? INITIAL_FEN);

  // ── Click-to-move helpers ─────────────────────────────────────────
  const getLegalMovesForSquare = useCallback(
    (square: string): string[] => {
      if (!effectiveCard) return [];
      try {
        _chess.load(effectiveCard.front);
        const moves = _chess.moves({ square: square as any, verbose: true });
        return moves.map((m) => m.to);
      } catch {
        return [];
      }
    },
    [effectiveCard],
  );

  const isOwnPiece = useCallback(
    (square: string): boolean => {
      if (!effectiveCard) return false;
      try {
        _chess.load(effectiveCard.front);
        const piece = _chess.get(square as any);
        if (!piece) return false;
        return piece.color === _chess.turn();
      } catch {
        return false;
      }
    },
    [effectiveCard],
  );

  // Clear click-to-move selection, solution and try-again flag when the position changes
  useEffect(() => {
    setSelectedSquare(null);
    setLegalMoves([]);
    setShowSolution(false);
    setWalkTryAgain(false);
    if (walkTryAgainRef.current) {
      clearTimeout(walkTryAgainRef.current);
      walkTryAgainRef.current = null;
    }
  }, [currentIndex, phase]);

  // ── Engine analysis on position change ──────────────────────────────
  useEffect(() => {
    if (engine.enabled && effectiveCard) {
      engine.analyze(effectiveCard.front);
    }
  }, [effectiveCard?.front, engine.enabled]);

  const isWhiteToMove = useMemo(() => {
    if (!effectiveCard) return true;
    return effectiveCard.front.split(' ')[1] === 'w';
  }, [effectiveCard]);

  const correctMoveSan = useMemo(() => {
    if (!effectiveCard) return '';
    return uciToSan(effectiveCard.front, effectiveCard.back);
  }, [effectiveCard]);

  const userMoveSan = useMemo(() => {
    if (!effectiveCard || !userMove) return '';
    return uciToSan(effectiveCard.front, userMove);
  }, [effectiveCard, userMove]);

  const isCorrect = userMove !== null && userMove === effectiveCard?.back;

  /** Green arrow showing the correct move – only when showSolution is true, or during replay. */
  const customArrows: Arrow[] = useMemo(() => {
    if (phase === 'replay' && sessionHistory[replayIndex]) {
      const card = sessionHistory[replayIndex].card;
      const uci = card.back;
      const from = uci.slice(0, 2) as Square;
      const to = uci.slice(2, 4) as Square;
      const arrows: Arrow[] = [[from, to, 'rgba(59, 98, 160, 0.8)']];
      const entry = sessionHistory[replayIndex];
      if (!entry.correct && entry.userMove) {
        const uf = entry.userMove.slice(0, 2) as Square;
        const ut = entry.userMove.slice(2, 4) as Square;
        arrows.push([uf, ut, 'rgba(220, 38, 38, 0.6)']);
      }
      return arrows;
    }

    if (!effectiveCard) return [];

    if (phase === 'grading' && isCorrect) {
      const uci = effectiveCard.back;
      const from = uci.slice(0, 2) as Square;
      const to = uci.slice(2, 4) as Square;
      return [[from, to, 'rgba(59, 98, 160, 0.8)']];
    }

    if (showSolution) {
      const uci = effectiveCard.back;
      const from = uci.slice(0, 2) as Square;
      const to = uci.slice(2, 4) as Square;
      return [[from, to, 'rgba(59, 98, 160, 0.8)']];
    }

    return [];
  }, [effectiveCard, phase, showSolution, isCorrect, sessionHistory, replayIndex]);

  /** Click-to-move square styles (selected piece + legal move dots). */
  const clickToMoveStyles: Record<string, React.CSSProperties> = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (!selectedSquare) return styles;

    styles[selectedSquare] = { backgroundColor: 'rgba(59,98,160,0.35)' };

    if (effectiveCard) {
      try {
        _chess.load(effectiveCard.front);
        for (const sq of legalMoves) {
          const target = _chess.get(sq as any);
          if (target) {
            styles[sq] = {
              background:
                'radial-gradient(circle, transparent 55%, rgba(59,98,160,0.4) 55%)',
            };
          } else {
            styles[sq] = {
              background:
                'radial-gradient(circle, rgba(59,98,160,0.35) 25%, transparent 25%)',
            };
          }
        }
      } catch {
        // ignore
      }
    }
    return styles;
  }, [selectedSquare, legalMoves, effectiveCard]);

  const dueCount = useMemo(() => getDueCards(cards).length, [cards]);

  const progressPercent =
    sessionCards.length > 0
      ? ((currentIndex + (phase === 'complete' ? 1 : 0)) / sessionCards.length) *
        100
      : 0;

  /** Timing delays (ms) for the current speed setting. */
  const walkDelays = useMemo(() => {
    switch (walkSpeed) {
      case 'slow':   return { opponent: 1000, known: 700, correct: 500, incorrect: 2500 };
      case 'fast':   return { opponent: 150,  known: 100, correct: 100, incorrect: 700  };
      default:       return { opponent: 500,  known: 350, correct: 300, incorrect: 1500 };
    }
  }, [walkSpeed]);

  // Walk-mode progress
  const walkTotalPaths = walkSession?.paths.length ?? 0;
  const walkCurrentPathLength = walkCurrentPath ? walkCurrentPath.length - 1 : 0; // minus root
  const walkStepDisplay = walkSession ? Math.min(walkSession.stepIdx, walkCurrentPathLength) : 0;

  // ── Handlers ────────────────────────────────────────────────────────

  /** Auto-grade, persist, update stats, and advance to next card or complete. */
  const advanceToNext = useCallback(() => {
    // ── Walk mode ─────────────────────────────────────────────────────
    if (walkSession && walkVirtualCard) {
      const card = walkVirtualCard;
      const correct = userMove !== null && userMove === card.back;

      // Mark this move as "seen" so future paths auto-advance through it
      const key = `${card.front}|||${card.back}`;
      const newPlayed = new Set(walkSession.sessionPlayed);
      newPlayed.add(key);

      // Update the underlying SR card if one exists in storage
      const matchingCard = cards.find(
        (c) => c.front === card.front && c.back === card.back,
      );
      if (matchingCard) {
        const grade: 0 | 2 = correct ? 2 : 0;
        const updated = reviewCard(matchingCard, grade);
        const newCards = cards.map((c) => (c.id === updated.id ? updated : c));
        setCards(newCards);
        pendingSaveRef.current = newCards;
      }

      const newStats: SessionStats = {
        correct: walkSession.stats.correct + (correct ? 1 : 0),
        incorrect: walkSession.stats.incorrect + (correct ? 0 : 1),
      };

      setWalkSession((prev) =>
        prev
          ? {
              ...prev,
              stepIdx: prev.stepIdx + 1,
              sessionPlayed: newPlayed,
              stats: newStats,
            }
          : null,
      );
      setUserMove(null);
      setShowSolution(false);
      setPhase('walking');
      return;
    }

    // ── Card mode ─────────────────────────────────────────────────────
    if (!currentCard) return;

    const correct = userMove !== null && userMove === currentCard.back;

    setSessionHistory((prev) => [
      ...prev,
      { card: currentCard, userMove, correct },
    ]);

    const grade = correct ? 2 : 0;
    const updated = reviewCard(currentCard, grade as 0 | 2);

    const newCards = cards.map((c) => (c.id === updated.id ? updated : c));
    setCards(newCards);
    pendingSaveRef.current = newCards;

    const newStats = {
      correct: stats.correct + (correct ? 1 : 0),
      incorrect: stats.incorrect + (correct ? 0 : 1),
    };
    setStats(newStats);

    setShowSolution(false);

    const nextIndex = currentIndex + 1;
    if (nextIndex >= sessionCards.length) {
      const updatedStats = saveSessionStats(newStats.correct, newStats.incorrect);
      setLifetimeStats(updatedStats);
      setPhase('complete');
    } else {
      setCurrentIndex(nextIndex);
      setUserMove(null);
      setPhase('question');
      const nextCard = sessionCards[nextIndex];
      const activeColor = nextCard.front.split(' ')[1];
      setBoardOrientation(activeColor === 'b' ? 'black' : 'white');
    }
  }, [walkSession, walkVirtualCard, userMove, cards, currentCard, stats, currentIndex, sessionCards]);

  /** Shared move submission – used by both drag-drop and click-to-move. */
  const submitMove = useCallback(
    (from: string, to: string, piece?: string): boolean => {
      if (phase !== 'question') return false;
      const card = effectiveCard;
      if (!card) return false;

      try {
        _chess.load(card.front);
        const isPromotion =
          piece
            ? piece[1] === 'P' && (to[1] === '8' || to[1] === '1')
            : (() => {
                const p = _chess.get(from as any);
                return p?.type === 'p' && (to[1] === '8' || to[1] === '1');
              })();
        const promotion = isPromotion ? 'q' : undefined;
        const move = _chess.move({ from, to, promotion });
        if (!move) return false;

        const uci = from + to + (promotion || '');

        // When solution is shown: only the correct move is accepted.
        // Playing it advances (counts as incorrect — solution was peeked).
        if (showSolution) {
          if (uci === card.back) {
            advanceToNext();
            return true;
          }
          return false; // snap wrong moves back
        }

        // Walk mode: wrong move — snap piece back, show "try again", stay in question
        if (walkSession && uci !== effectiveCard!.back) {
          if (walkTryAgainRef.current) clearTimeout(walkTryAgainRef.current);
          setWalkTryAgain(true);
          walkTryAgainRef.current = setTimeout(() => setWalkTryAgain(false), 800);
          return false; // snap the piece back
        }

        setUserMove(uci);
        setPhase('grading');
        return true;
      } catch {
        return false;
      }
    },
    [phase, effectiveCard, walkSession, showSolution, advanceToNext],
  );

  /** Handle a piece drop on the board (drag-and-drop move). */
  const handlePieceDrop = useCallback(
    (sourceSquare: Square, targetSquare: Square, piece: Piece): boolean => {
      setSelectedSquare(null);
      setLegalMoves([]);
      return submitMove(sourceSquare, targetSquare, piece);
    },
    [submitMove],
  );

  /** Handle click-to-move (select piece, then click target). */
  const handleSquareClick = useCallback(
    (square: Square) => {
      if (phase !== 'question' || !effectiveCard) {
        setSelectedSquare(null);
        setLegalMoves([]);
        return;
      }

      if (selectedSquare && legalMoves.includes(square)) {
        const success = submitMove(selectedSquare, square);
        setSelectedSquare(null);
        setLegalMoves([]);
        if (success) return;
      }

      if (isOwnPiece(square)) {
        if (selectedSquare === square) {
          setSelectedSquare(null);
          setLegalMoves([]);
        } else {
          setSelectedSquare(square);
          setLegalMoves(getLegalMovesForSquare(square));
        }
        return;
      }

      setSelectedSquare(null);
      setLegalMoves([]);
    },
    [phase, effectiveCard, selectedSquare, legalMoves, isOwnPiece, getLegalMovesForSquare, submitMove],
  );

  /** Forward piece-click events to square-click handler. */
  const handlePieceClick = useCallback(
    (_piece: Piece, square: Square) => {
      handleSquareClick(square);
    },
    [handleSquareClick],
  );

  // ── Auto-advance after grading ─────────────────────────────────────
  useEffect(() => {
    if (phase !== 'grading') return;

    const correct = userMove !== null && userMove === effectiveCard?.back;

    if (correct) {
      // Always auto-advance after a correct answer
      const delay = walkSession ? walkDelays.correct : 300;
      autoAdvanceRef.current = setTimeout(() => advanceToNext(), delay);
    } else if (walkSession && userMove !== null) {
      // Walk mode wrong move: reveal solution arrow then auto-advance
      setShowSolution(true);
      autoAdvanceRef.current = setTimeout(() => advanceToNext(), walkDelays.incorrect);
    }
    // Card mode + incorrect: user stays in control
    // Walk mode + solution shown manually (userMove === null): user stays in control

    return () => {
      if (autoAdvanceRef.current) {
        clearTimeout(autoAdvanceRef.current);
        autoAdvanceRef.current = null;
      }
    };
  }, [phase, advanceToNext, userMove, effectiveCard?.back, walkSession, walkDelays]);

  // ── Walk-mode auto-advance (handles opponent moves & known user moves) ──
  useEffect(() => {
    if (phase !== 'walking' || !walkSession) return;

    const currentPath = walkSession.paths[walkSession.pathIdx];

    // ── "New line" pause at the start of each new path ────────────────
    // Give the user a clear 2.5 s visual break so they know the next line
    // is starting, even when the opening moves are identical.
    if (walkSession.lineStarting) {
      const timer = setTimeout(() => {
        setWalkSession((prev) =>
          prev ? { ...prev, lineStarting: false } : null,
        );
      }, 2500);
      return () => clearTimeout(timer);
    }

    // ── Line complete: advance to next path or finish session ──────────
    if (!currentPath || walkSession.stepIdx >= currentPath.length) {
      const nextPathIdx = walkSession.pathIdx + 1;
      if (nextPathIdx >= walkSession.paths.length) {
        // All lines drilled — session complete
        const updatedStats = saveSessionStats(
          walkSession.stats.correct,
          walkSession.stats.incorrect,
        );
        setLifetimeStats(updatedStats);
        setStats(walkSession.stats);
        setWalkSession(null);
        setPhase('complete');
      } else {
        // Move to next path, always starting from move 1.
        // Set lineStarting so the UI shows a brief "new line" notice before
        // the first move of the next path.
        setWalkSession((prev) =>
          prev ? { ...prev, pathIdx: nextPathIdx, stepIdx: 1, lineStarting: true } : null,
        );
        // stay in 'walking' phase — effect re-fires when walkSession changes
      }
      return;
    }

    const parentNode = currentPath[walkSession.stepIdx - 1];
    if (!parentNode) {
      setWalkSession((prev) => (prev ? { ...prev, stepIdx: prev.stepIdx + 1 } : null));
      return;
    }

    const parentFen = parentNode.fen;
    const targetNode = currentPath[walkSession.stepIdx];
    const activeColor = parentFen.split(' ')[1]; // 'w' or 'b'
    const isUserTurn =
      (walkSession.drillColor === 'white' && activeColor === 'w') ||
      (walkSession.drillColor === 'black' && activeColor === 'b');

    if (!isUserTurn) {
      // Opponent's move — auto-play after a brief pause so the user can follow
      const timer = setTimeout(() => {
        setWalkSession((prev) => (prev ? { ...prev, stepIdx: prev.stepIdx + 1 } : null));
      }, walkDelays.opponent);
      return () => clearTimeout(timer);
    }

    // User's turn — check if we already drilled this exact position+move
    // earlier in the session (shared prefix). If so, auto-advance instead
    // of asking the user the same question again.
    try {
      _chess.load(parentFen);
      const moveResult = _chess.move(targetNode.move);
      if (!moveResult) {
        // Can't parse move — skip
        setWalkSession((prev) => (prev ? { ...prev, stepIdx: prev.stepIdx + 1 } : null));
        return;
      }

      const uci = moveResult.from + moveResult.to + (moveResult.promotion || '');
      const key = `${parentFen}|||${uci}`;

      if (walkSession.sessionPlayed.has(key)) {
        // Already answered this position — auto-advance through it
        const timer = setTimeout(() => {
          setWalkSession((prev) => (prev ? { ...prev, stepIdx: prev.stepIdx + 1 } : null));
        }, walkDelays.known);
        return () => clearTimeout(timer);
      }

      setPhase('question');
    } catch {
      setWalkSession((prev) => (prev ? { ...prev, stepIdx: prev.stepIdx + 1 } : null));
    }
  }, [phase, walkSession, walkDelays]);

  /**
   * Show Solution during question phase — reveals the arrow on the board
   * so the user can study the move. Does NOT auto-advance; user presses
   * "Next" manually when ready.
   */
  const handleShowSolutionFromQuestion = useCallback(() => {
    if (phase !== 'question' || !effectiveCard) return;
    setShowSolution(true);
    // Stay in question phase — the arrow is shown, user takes their time,
    // then clicks the "Next" button that appears.
  }, [phase, effectiveCard]);

  /**
   * Called when user clicks "Next" after Show Solution (still in question phase).
   * Counts as incorrect and advances.
   */
  const handleSolutionNext = useCallback(() => {
    if (!showSolution) return;
    // userMove stays null — advanceToNext treats null as incorrect
    advanceToNext();
  }, [showSolution, advanceToNext]);

  /** Toggle solution visibility during grading (incorrect). */
  const handleToggleSolution = useCallback(() => {
    setShowSolution((prev) => !prev);
  }, []);

  /** Enter replay mode from the complete screen. */
  const handleStartReplay = useCallback(() => {
    if (sessionHistory.length === 0) return;
    setReplayIndex(0);
    setPhase('replay');
    const card = sessionHistory[0].card;
    const activeColor = card.front.split(' ')[1];
    setBoardOrientation(activeColor === 'b' ? 'black' : 'white');
  }, [sessionHistory]);

  /** Navigate replay forward / backward. */
  const handleReplayNav = useCallback(
    (direction: 'prev' | 'next') => {
      const newIdx = direction === 'next' ? replayIndex + 1 : replayIndex - 1;
      if (newIdx < 0 || newIdx >= sessionHistory.length) return;
      setReplayIndex(newIdx);
      const card = sessionHistory[newIdx].card;
      const activeColor = card.front.split(' ')[1];
      setBoardOrientation(activeColor === 'b' ? 'black' : 'white');
    },
    [replayIndex, sessionHistory],
  );

  /** Exit replay back to complete screen. */
  const handleExitReplay = useCallback(() => {
    setPhase('complete');
  }, []);

  const flipBoard = useCallback(() => {
    setBoardOrientation((prev) => (prev === 'white' ? 'black' : 'white'));
  }, []);

  const handleNewSession = useCallback(() => {
    initializeSession();
  }, [initializeSession]);

  /**
   * Start a walk-mode session: play through the repertoire from move 1.
   */
  const handleStartWalk = useCallback(
    (fileId: string, drillColor: 'white' | 'black') => {
      const file = files.find((f) => f.id === fileId);
      if (!file) return;

      // ── Flush all pending timers so nothing from the old session fires ──
      if (autoAdvanceRef.current) {
        clearTimeout(autoAdvanceRef.current);
        autoAdvanceRef.current = null;
      }
      if (walkTryAgainRef.current) {
        clearTimeout(walkTryAgainRef.current);
        walkTryAgainRef.current = null;
      }

      const allPaths = buildAllPaths(file.tree);

      // Keep only paths that contain at least one user-colour move
      const relevantPaths = allPaths.filter((path) =>
        path.slice(1).some((_, i) => {
          const parentFen = path[i].fen;
          const activeColor = parentFen.split(' ')[1];
          return drillColor === 'white' ? activeColor === 'w' : activeColor === 'b';
        }),
      );

      if (relevantPaths.length === 0) return;

      // Sort so consecutive lines diverge as early as possible, reducing the
      // feeling of repetition when many lines share a long common prefix.
      const sortedPaths = sortPathsByDivergence(relevantPaths);

      // ── Reset all interaction state before handing off to the new session ──
      setWalkTryAgain(false);
      setSelectedSquare(null);
      setLegalMoves([]);
      setUserMove(null);
      setShowSolution(false);
      setSessionHistory([]);
      setStats({ correct: 0, incorrect: 0 });
      setBoardOrientation(drillColor);

      setWalkSession({
        paths: sortedPaths,
        pathIdx: 0,
        stepIdx: 1,
        drillColor,
        sessionPlayed: new Set(),
        fileName: file.name,
        stats: { correct: 0, incorrect: 0 },
        lineStarting: false,
      });

      setPhase('walking');
    },
    [files],
  );

  /** Stop walk mode and return to idle. */
  const handleStopWalk = useCallback(() => {
    setWalkSession(null);
    setUserMove(null);
    setShowSolution(false);
    setPhase('idle');
  }, []);

  /** Import cards from a repertoire file for the given colour. */
  const handleImportRepertoire = useCallback(
    (fileId: string, drillColor: 'white' | 'black') => {
      const file = files.find((f) => f.id === fileId);
      if (!file) return;

      const existing = loadCards();
      const result = treeToCards(file.tree, drillColor, file.name, existing);

      if (result.newCards.length > 0) {
        const merged = storageAddCards(result.newCards);
        setCards(merged);

        if (phase === 'idle' && !walkSession) {
          const due = getDueCards(merged, 20);
          if (due.length > 0) {
            setSessionCards(due);
            setCurrentIndex(0);
            setUserMove(null);
            setPhase('question');
            const activeColor = due[0].front.split(' ')[1];
            setBoardOrientation(activeColor === 'b' ? 'black' : 'white');
          }
        }
      }

      setImportFeedback({
        fileName: file.name,
        added: result.newCards.length,
        skipped: result.duplicatesSkipped,
      });
      setTimeout(() => setImportFeedback(null), 4000);
    },
    [files, phase, walkSession],
  );

  /** Refresh card list after the manual importer adds a card. */
  const handleCardsImported = useCallback(() => {
    const loaded = loadCards();
    setCards(loaded);
    if (phase === 'idle' && !walkSession) {
      const due = getDueCards(loaded, 20);
      if (due.length > 0) {
        setSessionCards(due);
        setCurrentIndex(0);
        setUserMove(null);
        setPhase('question');
        const activeColor = due[0].front.split(' ')[1];
        setBoardOrientation(activeColor === 'b' ? 'black' : 'white');
      }
    }
  }, [phase, walkSession]);

  /** Clear all SR cards. */
  const handleClearCards = useCallback(() => {
    if (!window.confirm('Remove all spaced-repetition cards? This cannot be undone.')) return;
    clearAllCards();
    setCards([]);
    setSessionCards([]);
    setCurrentIndex(0);
    setPhase('idle');
  }, []);

  // ── Render ──────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col bg-bg-primary min-h-0">
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 bg-bg-surface border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-3">
          {onClose && (
            <button
              onClick={onClose}
              className="btn-icon p-1.5"
              title="Back to repertoire"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          )}
          <Brain className="w-4 h-4 text-accent-teal" />
          <h2 className="font-mono text-sm uppercase tracking-wider text-text-secondary">
            Spaced Repetition Trainer
          </h2>
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span>{dueCount} due</span>
          <span className="text-border-subtle">|</span>
          <span>{cards.length} total</span>
          {cards.length > 0 && (
            <>
              <span className="text-border-subtle">|</span>
              <button
                onClick={handleClearCards}
                className="btn-icon p-1"
                title="Clear all cards"
              >
                <Trash2 className="w-3.5 h-3.5 hover:text-accent-red transition-colors" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* ─── Active session banner ──────────────────────────────────── */}
      {walkSession && (
        <div className={`flex items-center justify-between px-4 py-2 border-b flex-shrink-0 transition-colors duration-300 ${
          walkSession.lineStarting
            ? 'bg-accent-teal/20 border-accent-teal/50'
            : 'bg-accent-teal/5 border-accent-teal/20'
        }`}>
          <div className="flex items-center gap-2 text-sm">
            <span className="text-accent-teal font-semibold">
              {walkSession.drillColor === 'white' ? '♔' : '♚'}
            </span>
            <span className="text-text-primary font-medium truncate">
              {walkSession.fileName}
            </span>
            {walkSession.lineStarting ? (
              <span className="text-accent-teal text-xs font-semibold animate-pulse">
                ▶ Starting line {walkSession.pathIdx + 1} of {walkTotalPaths}…
              </span>
            ) : (
              <span className="text-text-muted text-xs">
                — playing as {walkSession.drillColor}
              </span>
            )}
          </div>
          <div className="flex items-center gap-3 text-xs text-text-muted">
            <span className={walkSession.lineStarting ? 'text-accent-teal font-semibold' : ''}>
              Line {walkSession.pathIdx + 1} / {walkTotalPaths}
            </span>
            <button
              onClick={handleStopWalk}
              className="flex items-center gap-1 text-text-muted hover:text-accent-red transition-colors ml-1"
              title="Stop training session"
            >
              <X className="w-3.5 h-3.5" />
              Stop
            </button>
          </div>
        </div>
      )}

      {/* ─── Import feedback toast ──────────────────────────────────── */}
      {importFeedback && (
        <div className="mx-4 mt-3 px-3 py-2 bg-accent-teal/5 border border-accent-teal/30 rounded-lg text-xs text-accent-teal flex items-center gap-2 flex-shrink-0">
          <Check className="w-3.5 h-3.5 flex-shrink-0" />
          <span>
            <strong>{importFeedback.fileName}</strong>: {importFeedback.added} card
            {importFeedback.added !== 1 ? 's' : ''} added
            {importFeedback.skipped > 0 && (
              <span className="text-text-muted">
                {' '}({importFeedback.skipped} duplicate{importFeedback.skipped !== 1 ? 's' : ''} skipped)
              </span>
            )}
          </span>
        </div>
      )}

      {/* ─── Main content ───────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-auto">
        {/* Left column — Eval Bar + Chessboard */}
        <div
          ref={boardContainerRef}
          className="flex flex-col items-center p-4 lg:flex-1 lg:min-w-[400px]"
        >
          <div className="flex items-start gap-0 w-full max-w-[560px]">
            <div className="mr-1">
              <EvalBar
                score={engine.lines.length > 0 ? engine.lines[0].score : 0}
                mate={engine.lines.length > 0 ? engine.lines[0].mate : null}
                height={boardWidth}
              />
            </div>
            <div className="flex-1 relative">
              <Chessboard
                position={displayFen}
                onPieceDrop={handlePieceDrop}
                onSquareClick={handleSquareClick}
                onPieceClick={handlePieceClick}
                boardWidth={boardWidth}
                boardOrientation={boardOrientation}
                isDraggablePiece={() => phase === 'question'}
                customDarkSquareStyle={{ backgroundColor: '#4b6fa0' }}
                customLightSquareStyle={{ backgroundColor: '#e8dcc0' }}
                customBoardStyle={{
                  borderRadius: '4px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.10)',
                }}
                customDropSquareStyle={{
                  boxShadow: 'inset 0 0 1px 6px rgba(59,98,160,0.5)',
                }}
                customSquareStyles={clickToMoveStyles}
                animationDuration={100}
                customArrows={customArrows.length > 0 ? customArrows : undefined}
              />
              {/* New-line overlay — shown for 2.5 s when advancing to the next path */}
              {walkSession?.lineStarting && (
                <div
                  className="absolute inset-0 flex flex-col items-center justify-center rounded"
                  style={{ backgroundColor: 'rgba(0,0,0,0.72)' }}
                >
                  <span className="text-white text-2xl font-bold mb-1">
                    Line {walkSession.pathIdx + 1} / {walkTotalPaths}
                  </span>
                  <span className="text-accent-teal text-sm font-semibold animate-pulse">
                    New line starting…
                  </span>
                  <span className="text-text-muted text-xs mt-2">
                    Play every move from the beginning
                  </span>
                </div>
              )}
            </div>
          </div>

          <button
            onClick={flipBoard}
            className="btn-secondary mt-3 flex items-center gap-1.5 text-xs py-1.5 px-3"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Flip Board
          </button>
        </div>

        {/* Right column — Controls / info */}
        <div className="lg:w-[400px] lg:min-w-[340px] flex flex-col p-4 gap-4 lg:border-l lg:border-border-subtle overflow-auto">

          {/* Walk-mode progress bar + speed control */}
          {walkSession && phase !== 'complete' && (
            <div className="flex flex-col gap-2">
              <div className="flex justify-between text-xs text-text-muted mb-1.5">
                <span>Step {walkStepDisplay} / {walkCurrentPathLength}</span>
                <span>{walkSession.stats.correct}✓ {walkSession.stats.incorrect}✗</span>
              </div>
              <div className="w-full h-2 bg-bg-panel rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-teal rounded-full transition-all duration-200"
                  style={{
                    width: walkCurrentPathLength > 0
                      ? `${(walkStepDisplay / walkCurrentPathLength) * 100}%`
                      : '0%',
                  }}
                />
              </div>
              {/* Speed control */}
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-text-muted">Speed:</span>
                {(['slow', 'normal', 'fast'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setWalkSpeed(s)}
                    className={`px-2 py-0.5 text-[10px] rounded capitalize transition-colors ${
                      walkSpeed === s
                        ? 'bg-accent-teal text-white'
                        : 'bg-bg-panel text-text-muted hover:text-text-primary'
                    }`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Card-mode progress bar */}
          {!walkSession && sessionCards.length > 0 && phase !== 'idle' && phase !== 'complete' && phase !== 'replay' && (
            <div>
              <div className="flex justify-between text-xs text-text-muted mb-1.5">
                <span>Session Progress</span>
                <span>
                  {Math.min(currentIndex + 1, sessionCards.length)} /{' '}
                  {sessionCards.length}
                </span>
              </div>
              <div className="w-full h-2 bg-bg-panel rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-teal rounded-full transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* ── Phase: idle ─────────────────────────────────────────── */}
          {phase === 'idle' && (
            <div className="flex flex-col items-center justify-center gap-4 py-6">
              <Brain className="w-12 h-12 text-text-muted opacity-40" />
              <p className="text-text-muted text-center text-sm">
                {cards.length === 0
                  ? 'No cards yet. Start a repertoire below, or import cards for later review.'
                  : 'No cards due for review right now. Start a repertoire below to keep training!'}
              </p>
              {cards.length > 0 && (
                <p className="text-text-muted text-xs">
                  {cards.length} card{cards.length !== 1 ? 's' : ''} in your
                  collection
                </p>
              )}
            </div>
          )}

          {/* ── Phase: walking (auto-advancing) ─────────────────────── */}
          {phase === 'walking' && walkSession && (
            <div className="panel p-4">
              <p className="text-text-secondary text-sm animate-pulse-subtle">
                Playing through moves…
              </p>
              <p className="text-text-muted text-xs mt-1">
                You'll be asked when a new move appears
              </p>
            </div>
          )}

          {/* ── Phase: question ─────────────────────────────────────── */}
          {phase === 'question' && effectiveCard && (
            <div className="panel p-4">
              {effectiveCard.lineName && (
                <div className="text-xs text-accent-teal font-mono mb-2 uppercase tracking-wider">
                  {effectiveCard.lineName}
                </div>
              )}
              <p className="text-text-primary text-sm">
                Find the best move for{' '}
                <span className="font-semibold">
                  {isWhiteToMove ? 'White' : 'Black'}
                </span>
              </p>

              {!showSolution ? (
                <>
                  {/* Wrong-move flash (walk mode only) */}
                  {walkTryAgain ? (
                    <p className="text-accent-red text-xs mt-2 font-medium">
                      Wrong move — try again
                    </p>
                  ) : (
                    <p className="text-text-muted text-xs mt-2">
                      Click or drag a piece to make your move
                    </p>
                  )}
                  <button
                    onClick={handleShowSolutionFromQuestion}
                    className="btn-secondary mt-3 flex items-center gap-1.5 text-xs py-1.5 px-3"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Show Solution
                  </button>
                </>
              ) : (
                <>
                  <p className="text-text-muted text-xs mt-2">
                    Take your time to memorise the move shown on the board.
                  </p>
                  <button
                    onClick={handleSolutionNext}
                    className="btn-primary mt-3 flex items-center gap-1.5 text-xs py-1.5 px-3"
                  >
                    Got it, Next
                    <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── Phase: grading ──────────────────────────────────────── */}
          {phase === 'grading' && effectiveCard && (
            <div className="flex flex-col gap-4">
              <div
                className={`panel p-4 ${
                  isCorrect
                    ? 'border-accent-teal/40 bg-accent-teal/5'
                    : 'border-accent-red/30 bg-accent-red/5'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className={`text-sm font-semibold ${
                      isCorrect ? 'text-accent-teal' : 'text-accent-red'
                    }`}
                  >
                    {isCorrect
                      ? 'Correct!'
                      : userMove === null
                        ? 'Solution Revealed'
                        : 'Incorrect'}
                  </span>
                </div>
                {!isCorrect && userMoveSan && (
                  <p className="text-text-muted text-xs mb-1">
                    Your move:{' '}
                    <span className="text-text-primary font-mono">
                      {userMoveSan}
                    </span>
                  </p>
                )}
                {(isCorrect || showSolution) && (
                  <p className="text-text-muted text-xs">
                    Correct move:{' '}
                    <span className="text-accent-teal font-mono">
                      {correctMoveSan}
                    </span>
                  </p>
                )}
              </div>

              {/* Walk mode wrong move — solution visible, auto-continuing */}
              {!isCorrect && walkSession && userMove !== null && (
                <div className="text-center text-xs text-text-muted animate-pulse-subtle">
                  Continuing…
                </div>
              )}

              {/* Walk mode manually showed solution — user controls pace */}
              {!isCorrect && walkSession && userMove === null && (
                <button
                  onClick={advanceToNext}
                  className="btn-primary flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium"
                >
                  <SkipForward className="w-3.5 h-3.5" />
                  Next
                </button>
              )}

              {/* Card mode incorrect — user controls pace */}
              {!isCorrect && !walkSession && (
                <div className="flex items-center gap-2">
                  {!showSolution && (
                    <button
                      onClick={handleToggleSolution}
                      className="flex-1 btn-secondary flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Show Solution
                    </button>
                  )}
                  <button
                    onClick={advanceToNext}
                    className="flex-1 btn-secondary flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium"
                  >
                    <SkipForward className="w-3.5 h-3.5" />
                    Next
                  </button>
                </div>
              )}

              {isCorrect && (
                <div className="text-center text-xs text-text-muted animate-pulse-subtle">
                  Advancing…
                </div>
              )}
            </div>
          )}

          {/* ── Phase: complete ─────────────────────────────────────── */}
          {phase === 'complete' && (() => {
            const total = stats.correct + stats.incorrect;
            const sessionPct = total > 0 ? Math.round((stats.correct / total) * 100) : 0;
            const lifetimePct = lifetimeStats.totalReviewed > 0
              ? Math.round((lifetimeStats.totalCorrect / lifetimeStats.totalReviewed) * 100)
              : 0;
            return (
              <div className="flex flex-col items-center gap-4 py-8">
                <Trophy className="w-12 h-12 text-accent-amber" />
                <h3 className="text-text-primary text-lg font-semibold">
                  Session Complete!
                </h3>

                <div className="text-4xl font-bold text-accent-teal">
                  {sessionPct}%
                </div>
                <p className="text-text-muted text-xs -mt-2">session accuracy</p>

                <div className="panel p-4 w-full">
                  <div className="grid grid-cols-2 gap-4 text-center">
                    <div>
                      <div className="text-accent-teal text-2xl font-bold">
                        {stats.correct}
                      </div>
                      <div className="text-text-muted text-xs">Correct</div>
                    </div>
                    <div>
                      <div className="text-accent-red text-2xl font-bold">
                        {stats.incorrect}
                      </div>
                      <div className="text-text-muted text-xs">Incorrect</div>
                    </div>
                  </div>
                </div>

                {lifetimeStats.totalReviewed > 0 && (
                  <div className="panel p-3 w-full text-center">
                    <p className="text-text-muted text-xs mb-1">Lifetime Accuracy</p>
                    <p className="text-text-primary text-lg font-semibold">
                      {lifetimePct}%{' '}
                      <span className="text-text-muted text-xs font-normal">
                        ({lifetimeStats.totalCorrect}/{lifetimeStats.totalReviewed} correct)
                      </span>
                    </p>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  {sessionHistory.length > 0 && (
                    <button
                      onClick={handleStartReplay}
                      className="btn-secondary flex items-center gap-1.5 px-4 py-2 text-sm font-medium"
                    >
                      <Play className="w-4 h-4" />
                      Replay Moves
                    </button>
                  )}
                  <button
                    onClick={handleNewSession}
                    className="btn-primary px-4 py-2 text-sm font-medium"
                  >
                    New Session
                  </button>
                </div>
              </div>
            );
          })()}

          {/* ── Phase: replay ───────────────────────────────────────── */}
          {phase === 'replay' && sessionHistory[replayIndex] && (() => {
            const entry = sessionHistory[replayIndex];
            const replaySan = uciToSan(entry.card.front, entry.card.back);
            const replayUserSan = entry.userMove
              ? uciToSan(entry.card.front, entry.userMove)
              : null;
            const replayWhite = entry.card.front.split(' ')[1] === 'w';
            return (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-muted font-mono">
                    Replay: {replayIndex + 1} / {sessionHistory.length}
                  </span>
                  <button
                    onClick={handleExitReplay}
                    className="text-xs text-text-muted hover:text-text-primary transition-colors"
                  >
                    Back to Summary
                  </button>
                </div>

                <div className="w-full h-1.5 bg-bg-panel rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent-teal rounded-full transition-all duration-200"
                    style={{
                      width: `${((replayIndex + 1) / sessionHistory.length) * 100}%`,
                    }}
                  />
                </div>

                <div
                  className={`panel p-4 ${
                    entry.correct
                      ? 'border-accent-teal/30 bg-accent-teal/5'
                      : 'border-accent-red/30 bg-accent-red/5'
                  }`}
                >
                  {entry.card.lineName && (
                    <div className="text-xs text-accent-teal font-mono mb-2 uppercase tracking-wider">
                      {entry.card.lineName}
                    </div>
                  )}
                  <p className="text-text-muted text-xs mb-1">
                    {replayWhite ? 'White' : 'Black'} to move
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    <span
                      className={`text-xs font-semibold ${
                        entry.correct ? 'text-accent-teal' : 'text-accent-red'
                      }`}
                    >
                      {entry.correct ? 'Correct' : 'Incorrect'}
                    </span>
                  </div>
                  {!entry.correct && replayUserSan && (
                    <p className="text-text-muted text-xs mt-1">
                      Your move:{' '}
                      <span className="text-text-primary font-mono">
                        {replayUserSan}
                      </span>
                    </p>
                  )}
                  {!entry.correct && !replayUserSan && (
                    <p className="text-text-muted text-xs mt-1 italic">
                      No attempt — solution revealed
                    </p>
                  )}
                  <p className="text-text-muted text-xs mt-1">
                    Correct move:{' '}
                    <span className="text-accent-teal font-mono">{replaySan}</span>
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleReplayNav('prev')}
                    disabled={replayIndex <= 0}
                    className="flex-1 btn-secondary flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    Prev
                  </button>
                  <button
                    onClick={() => handleReplayNav('next')}
                    disabled={replayIndex >= sessionHistory.length - 1}
                    className="flex-1 btn-secondary flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Next
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })()}

          {/* ─── Repertoire Training ────────────────────────────────── */}
          <div className="mt-auto pt-4 flex flex-col gap-2">
            <button
              onClick={() => setRepertoireListOpen(!repertoireListOpen)}
              className="btn-secondary flex items-center justify-between w-full px-3 py-2 text-xs"
            >
              <span className="flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5" />
                Repertoire Training
              </span>
              {repertoireListOpen ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>

            {repertoireListOpen && (
              <div className="panel overflow-hidden">
                {files.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-text-muted text-center">
                    No saved repertoires yet.
                    <br />
                    Save a repertoire from the main view first.
                  </div>
                ) : (
                  <div className="divide-y divide-border-subtle">
                    {files.map((file) => (
                      <div
                        key={file.id}
                        className="px-3 py-2.5 flex items-center gap-2"
                      >
                        {/* File name */}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-text-primary font-medium truncate">
                            {file.name}
                          </div>
                          <div className="text-[10px] text-text-muted">
                            {file.nodeCount} position{file.nodeCount !== 1 ? 's' : ''}
                          </div>
                        </div>

                        {/* Play (walk mode) buttons */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => handleStartWalk(file.id, 'white')}
                            className="btn-primary flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded"
                            title={`Train as White through "${file.name}" from move 1`}
                          >
                            <Play className="w-2.5 h-2.5" />
                            <span className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-white border border-border-active" />
                          </button>
                          <button
                            onClick={() => handleStartWalk(file.id, 'black')}
                            className="btn-primary flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded"
                            title={`Train as Black through "${file.name}" from move 1`}
                          >
                            <Play className="w-2.5 h-2.5" />
                            <span className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-text-primary border border-border-subtle" />
                          </button>

                          {/* Divider */}
                          <span className="text-border-subtle text-[10px] mx-0.5">|</span>

                          {/* Import (card mode) buttons */}
                          <button
                            onClick={() => handleImportRepertoire(file.id, 'white')}
                            className="btn-secondary flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded"
                            title={`Add White cards from "${file.name}" for review`}
                          >
                            <Download className="w-2.5 h-2.5" />
                            <span className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-white border border-border-active" />
                          </button>
                          <button
                            onClick={() => handleImportRepertoire(file.id, 'black')}
                            className="btn-secondary flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded"
                            title={`Add Black cards from "${file.name}" for review`}
                          >
                            <Download className="w-2.5 h-2.5" />
                            <span className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-text-primary border border-border-subtle" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {/* Legend */}
                <div className="px-3 py-2 border-t border-border-subtle flex items-center gap-4 text-[10px] text-text-muted">
                  <span className="flex items-center gap-1">
                    <Play className="w-2.5 h-2.5 text-accent-teal" /> Play from move 1
                  </span>
                  <span className="flex items-center gap-1">
                    <Download className="w-2.5 h-2.5" /> Add to review deck
                  </span>
                </div>
              </div>
            )}

            {/* Manual card importer */}
            <button
              onClick={() => setImporterOpen(!importerOpen)}
              className="btn-secondary flex items-center justify-between w-full px-3 py-2 text-xs"
            >
              <span>Add Cards Manually</span>
              {importerOpen ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
            </button>
            {importerOpen && (
              <div className="mt-1">
                <SRCardImporter onCardsChanged={handleCardsImported} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
