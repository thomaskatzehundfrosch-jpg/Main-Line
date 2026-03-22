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
    [phase, effectiveCard, walkSession],
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

  // ── Auto-advance after grading ─────────────────────────────────────
  useEffect(() => {
    if (phase !== 'grading') return;

    const correct = userMove !== null && userMove === effectiveCard?.back;

    if (correct) {
      // Always auto-advance after a correct answer
      const delay = walkSession ? walkDelays.correct : 300;
      autoAdvanceRef.current = setTimeout(() => advanceToNext(), delay);
    } else if (walkSession) {
      // Walk mode: reveal the solution arrow immediately, then keep going
      setShowSolution(true);
      autoAdvanceRef.current = setTimeout(() => advanceToNext(), walkDelays.incorrect);
    }
    // Card mode + incorrect: user stays in control (clicks Next manually)

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
        // Move to next path
        setWalkSession((prev) =>
          prev ? { ...prev, pathIdx: nextPathIdx, stepIdx: 1 } : null,
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

    // User's turn — check if the move was already seen in this session
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
        // Already drilled — play it out automatically
        const timer = setTimeout(() => {
          setWalkSession((prev) => (prev ? { ...prev, stepIdx: prev.stepIdx + 1 } : null));
        }, walkDelays.known);
        return () => clearTimeout(timer);
      }

      // New move — hand control to the user
      setPhase('question');
    } catch {
      setWalkSession((prev) => (prev ? { ...prev, stepIdx: prev.stepIdx + 1 } : null));
    }
  }, [phase, walkSession, walkDelays]);

  /** Show Solution during question phase – counts as incorrect, enters grading. */
  const handleShowSolutionFromQuestion = useCallback(() => {
    if (phase !== 'question' || !effectiveCard) return;
    setShowSolution(true);
    setUserMove(null);
    setPhase('grading');
  }, [phase, effectiveCard]);

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
   * The user only has to find moves they haven't already played this session;
   * everything else auto-advances so the game flows naturally.
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
        paths: relevantPaths,
        pathIdx: 0,
        stepIdx: 1,
        drillColor,
        sessionPlayed: new Set(),
        fileName: file.name,
        stats: { correct: 0, incorrect: 0 },
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
    <div className="flex-1 flex flex-col bg-gray-900 min-h-0">
      {/* ─── Header ─────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-800 border-b border-gray-700 flex-shrink-0">
        <div className="flex items-center gap-3">
          {onClose && (
            <button
              onClick={onClose}
              className="flex items-center gap-1 text-gray-400 hover:text-white transition-colors text-sm"
            >
              <ChevronLeft className="w-4 h-4" />
              Back
            </button>
          )}
          <Brain className="w-5 h-5 text-blue-400" />
          <span className="font-mono text-blue-400 text-lg font-semibold">
            Spaced Repetition Trainer
          </span>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-400">
          <span>{dueCount} due</span>
          <span className="text-gray-600">|</span>
          <span>{cards.length} total</span>
          {cards.length > 0 && (
            <>
              <span className="text-gray-600">|</span>
              <button
                onClick={handleClearCards}
                className="text-gray-500 hover:text-red-400 transition-colors"
                title="Clear all cards"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* ─── Active session banner ──────────────────────────────────── */}
      {walkSession && (
        <div className="flex items-center justify-between px-4 py-2 bg-blue-900/40 border-b border-blue-700/40 flex-shrink-0">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-blue-400 font-semibold">
              {walkSession.drillColor === 'white' ? '♔' : '♚'}
            </span>
            <span className="text-blue-300 font-medium truncate">
              {walkSession.fileName}
            </span>
            <span className="text-blue-500 text-xs">
              — playing as {walkSession.drillColor}
            </span>
          </div>
          <div className="flex items-center gap-3 text-xs text-blue-400/70">
            <span>Line {walkSession.pathIdx + 1} / {walkTotalPaths}</span>
            <button
              onClick={handleStopWalk}
              className="flex items-center gap-1 text-blue-500/60 hover:text-red-400 transition-colors ml-1"
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
        <div className="mx-4 mt-3 px-3 py-2 bg-blue-900/40 border border-blue-700/50 rounded-lg text-xs text-blue-300 flex items-center gap-2 flex-shrink-0">
          <Check className="w-3.5 h-3.5 flex-shrink-0" />
          <span>
            <strong>{importFeedback.fileName}</strong>: {importFeedback.added} card
            {importFeedback.added !== 1 ? 's' : ''} added
            {importFeedback.skipped > 0 && (
              <span className="text-blue-400/60">
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
            <div className="flex-1">
              <Chessboard
                position={displayFen}
                onPieceDrop={handlePieceDrop}
                onSquareClick={handleSquareClick}
                onPieceClick={handlePieceClick}
                boardWidth={boardWidth}
                boardOrientation={boardOrientation}
                isDraggablePiece={() => phase === 'question' && !showSolution}
                customDarkSquareStyle={{ backgroundColor: '#4b6fa0' }}
                customLightSquareStyle={{ backgroundColor: '#e8dcc0' }}
                customBoardStyle={{ borderRadius: '4px' }}
                customDropSquareStyle={{
                  boxShadow: 'inset 0 0 1px 6px rgba(59,98,160,0.5)',
                }}
                customSquareStyles={clickToMoveStyles}
                animationDuration={100}
                customArrows={customArrows.length > 0 ? customArrows : undefined}
              />
            </div>
          </div>

          <button
            onClick={flipBoard}
            className="mt-3 flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Flip Board
          </button>
        </div>

        {/* Right column — Controls / info */}
        <div className="lg:w-[400px] lg:min-w-[340px] flex flex-col p-4 gap-4 lg:border-l lg:border-gray-700 overflow-auto">

          {/* Walk-mode progress bar + speed control */}
          {walkSession && phase !== 'complete' && (
            <div className="flex flex-col gap-2">
              <div className="flex justify-between text-xs text-gray-400 mb-1.5">
                <span>Step {walkStepDisplay} / {walkCurrentPathLength}</span>
                <span className="text-gray-600">{walkSession.stats.correct}✓ {walkSession.stats.incorrect}✗</span>
              </div>
              <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-200"
                  style={{
                    width: walkCurrentPathLength > 0
                      ? `${(walkStepDisplay / walkCurrentPathLength) * 100}%`
                      : '0%',
                  }}
                />
              </div>
              {/* Speed control */}
              <div className="flex items-center gap-2 mt-0.5">
                <span className="text-[10px] text-gray-500">Speed:</span>
                {(['slow', 'normal', 'fast'] as const).map((s) => (
                  <button
                    key={s}
                    onClick={() => setWalkSpeed(s)}
                    className={`px-2 py-0.5 text-[10px] rounded capitalize transition-colors ${
                      walkSpeed === s
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-700 text-gray-400 hover:text-white'
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
              <div className="flex justify-between text-xs text-gray-400 mb-1.5">
                <span>Session Progress</span>
                <span>
                  {Math.min(currentIndex + 1, sessionCards.length)} /{' '}
                  {sessionCards.length}
                </span>
              </div>
              <div className="w-full h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-blue-500 rounded-full transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* ── Phase: idle ─────────────────────────────────────────── */}
          {phase === 'idle' && (
            <div className="flex flex-col items-center justify-center gap-4 py-6">
              <Brain className="w-12 h-12 text-gray-600" />
              <p className="text-gray-400 text-center text-sm">
                {cards.length === 0
                  ? 'No cards yet. Start a repertoire below, or import cards for later review.'
                  : 'No cards due for review right now. Start a repertoire below to keep training!'}
              </p>
              {cards.length > 0 && (
                <p className="text-gray-500 text-xs">
                  {cards.length} card{cards.length !== 1 ? 's' : ''} in your
                  collection
                </p>
              )}
            </div>
          )}

          {/* ── Phase: walking (auto-advancing) ─────────────────────── */}
          {phase === 'walking' && walkSession && (
            <div className="bg-gray-800 rounded-lg p-4">
              <p className="text-gray-400 text-sm animate-pulse">
                Playing through moves…
              </p>
              <p className="text-gray-600 text-xs mt-1">
                You'll be asked when a new move appears
              </p>
            </div>
          )}

          {/* ── Phase: question ─────────────────────────────────────── */}
          {phase === 'question' && effectiveCard && (
            <div className="bg-gray-800 rounded-lg p-4">
              {effectiveCard.lineName && (
                <div className="text-xs text-blue-400 font-mono mb-2 uppercase tracking-wider">
                  {effectiveCard.lineName}
                </div>
              )}
              <p className="text-gray-200 text-sm">
                Find the best move for{' '}
                <span
                  className={
                    isWhiteToMove
                      ? 'text-white font-semibold'
                      : 'text-gray-300 font-semibold'
                  }
                >
                  {isWhiteToMove ? 'White' : 'Black'}
                </span>
              </p>
              {/* Wrong-move flash (walk mode only) */}
              {walkTryAgain ? (
                <p className="text-red-400 text-xs mt-2 font-medium">
                  Wrong move — try again
                </p>
              ) : (
                <p className="text-gray-500 text-xs mt-2">
                  Click or drag a piece to make your move
                </p>
              )}
              <button
                onClick={handleShowSolutionFromQuestion}
                className="mt-3 flex items-center gap-1.5 px-3 py-1.5 text-xs text-gray-500 hover:text-yellow-400 bg-gray-700/50 hover:bg-gray-700 rounded transition-colors"
              >
                <Eye className="w-3.5 h-3.5" />
                Show Solution
              </button>
            </div>
          )}

          {/* ── Phase: grading ──────────────────────────────────────── */}
          {phase === 'grading' && effectiveCard && (
            <div className="flex flex-col gap-4">
              <div
                className={`rounded-lg p-4 ${
                  isCorrect
                    ? 'bg-blue-900/30 border border-blue-700/50'
                    : 'bg-red-900/30 border border-red-700/50'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <span
                    className={`text-sm font-semibold ${
                      isCorrect ? 'text-blue-400' : 'text-red-400'
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
                  <p className="text-gray-400 text-xs mb-1">
                    Your move:{' '}
                    <span className="text-gray-200 font-mono">
                      {userMoveSan}
                    </span>
                  </p>
                )}
                {(isCorrect || showSolution) && (
                  <p className="text-gray-400 text-xs">
                    Correct move:{' '}
                    <span className="text-blue-300 font-mono">
                      {correctMoveSan}
                    </span>
                  </p>
                )}
              </div>

              {/* Walk mode incorrect — solution already visible, auto-continuing */}
              {!isCorrect && walkSession && (
                <div className="text-center text-xs text-gray-500 animate-pulse">
                  Continuing…
                </div>
              )}

              {/* Card mode incorrect — user controls pace */}
              {!isCorrect && !walkSession && (
                <div className="flex items-center gap-2">
                  {!showSolution && (
                    <button
                      onClick={handleToggleSolution}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-yellow-400 bg-yellow-900/30 hover:bg-yellow-900/50 border border-yellow-700/50 rounded-lg transition-colors"
                    >
                      <Eye className="w-3.5 h-3.5" />
                      Show Solution
                    </button>
                  )}
                  <button
                    onClick={advanceToNext}
                    className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-gray-700 hover:bg-gray-600 rounded-lg transition-colors"
                  >
                    <SkipForward className="w-3.5 h-3.5" />
                    Next
                  </button>
                </div>
              )}

              {isCorrect && (
                <div className="text-center text-xs text-gray-500">
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
                <Trophy className="w-12 h-12 text-yellow-400" />
                <h3 className="text-white text-lg font-semibold">
                  Session Complete!
                </h3>

                <div className="text-4xl font-bold text-blue-400">
                  {sessionPct}%
                </div>
                <p className="text-gray-400 text-xs -mt-2">session accuracy</p>

                <div className="bg-gray-800 rounded-lg p-4 w-full">
                  <div className="grid grid-cols-2 gap-4 text-center">
                    <div>
                      <div className="text-blue-400 text-2xl font-bold">
                        {stats.correct}
                      </div>
                      <div className="text-gray-400 text-xs">Correct</div>
                    </div>
                    <div>
                      <div className="text-red-400 text-2xl font-bold">
                        {stats.incorrect}
                      </div>
                      <div className="text-gray-400 text-xs">Incorrect</div>
                    </div>
                  </div>
                </div>

                {lifetimeStats.totalReviewed > 0 && (
                  <div className="bg-gray-800/60 rounded-lg p-3 w-full text-center">
                    <p className="text-gray-400 text-xs mb-1">Lifetime Accuracy</p>
                    <p className="text-white text-lg font-semibold">
                      {lifetimePct}%{' '}
                      <span className="text-gray-500 text-xs font-normal">
                        ({lifetimeStats.totalCorrect}/{lifetimeStats.totalReviewed} correct)
                      </span>
                    </p>
                  </div>
                )}

                <div className="flex items-center gap-3">
                  {sessionHistory.length > 0 && (
                    <button
                      onClick={handleStartReplay}
                      className="flex items-center gap-1.5 px-4 py-2 bg-gray-700 hover:bg-gray-600 text-gray-200 rounded-lg text-sm font-medium transition-colors"
                    >
                      <Play className="w-4 h-4" />
                      Replay Moves
                    </button>
                  )}
                  <button
                    onClick={handleNewSession}
                    className="px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-lg text-sm font-medium transition-colors"
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
                  <span className="text-xs text-gray-400 font-mono">
                    Replay: {replayIndex + 1} / {sessionHistory.length}
                  </span>
                  <button
                    onClick={handleExitReplay}
                    className="text-xs text-gray-500 hover:text-white transition-colors"
                  >
                    Back to Summary
                  </button>
                </div>

                <div className="w-full h-1.5 bg-gray-700 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full transition-all duration-200"
                    style={{
                      width: `${((replayIndex + 1) / sessionHistory.length) * 100}%`,
                    }}
                  />
                </div>

                <div
                  className={`rounded-lg p-4 ${
                    entry.correct
                      ? 'bg-blue-900/20 border border-blue-700/40'
                      : 'bg-red-900/20 border border-red-700/40'
                  }`}
                >
                  {entry.card.lineName && (
                    <div className="text-xs text-blue-400 font-mono mb-2 uppercase tracking-wider">
                      {entry.card.lineName}
                    </div>
                  )}
                  <p className="text-gray-300 text-xs mb-1">
                    {replayWhite ? 'White' : 'Black'} to move
                  </p>
                  <div className="flex items-center gap-2 mt-2">
                    <span
                      className={`text-xs font-semibold ${
                        entry.correct ? 'text-blue-400' : 'text-red-400'
                      }`}
                    >
                      {entry.correct ? 'Correct' : 'Incorrect'}
                    </span>
                  </div>
                  {!entry.correct && replayUserSan && (
                    <p className="text-gray-400 text-xs mt-1">
                      Your move:{' '}
                      <span className="text-gray-200 font-mono">
                        {replayUserSan}
                      </span>
                    </p>
                  )}
                  {!entry.correct && !replayUserSan && (
                    <p className="text-gray-500 text-xs mt-1 italic">
                      No attempt — solution revealed
                    </p>
                  )}
                  <p className="text-gray-400 text-xs mt-1">
                    Correct move:{' '}
                    <span className="text-blue-300 font-mono">{replaySan}</span>
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleReplayNav('prev')}
                    disabled={replayIndex <= 0}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium text-gray-300 bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition-colors"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" />
                    Prev
                  </button>
                  <button
                    onClick={() => handleReplayNav('next')}
                    disabled={replayIndex >= sessionHistory.length - 1}
                    className="flex-1 flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium text-gray-300 bg-gray-700 hover:bg-gray-600 disabled:opacity-30 disabled:cursor-not-allowed rounded-lg transition-colors"
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
              className="flex items-center justify-between w-full px-3 py-2 text-xs text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
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
              <div className="bg-gray-800 rounded-lg overflow-hidden">
                {files.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-gray-500 text-center">
                    No saved repertoires yet.
                    <br />
                    Save a repertoire from the main view first.
                  </div>
                ) : (
                  <div className="divide-y divide-gray-700/50">
                    {files.map((file) => (
                      <div
                        key={file.id}
                        className="px-3 py-2.5 flex items-center gap-2"
                      >
                        {/* File name */}
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-gray-200 font-medium truncate">
                            {file.name}
                          </div>
                          <div className="text-[10px] text-gray-500">
                            {file.nodeCount} position{file.nodeCount !== 1 ? 's' : ''}
                          </div>
                        </div>

                        {/* Play (walk mode) buttons */}
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => handleStartWalk(file.id, 'white')}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                            title={`Train as White through "${file.name}" from move 1`}
                          >
                            <Play className="w-2.5 h-2.5" />
                            <span className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-white border border-gray-300" />
                          </button>
                          <button
                            onClick={() => handleStartWalk(file.id, 'black')}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-blue-700 hover:bg-blue-600 text-white transition-colors"
                            title={`Train as Black through "${file.name}" from move 1`}
                          >
                            <Play className="w-2.5 h-2.5" />
                            <span className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-gray-900 border border-gray-500" />
                          </button>

                          {/* Divider */}
                          <span className="text-gray-700 text-[10px] mx-0.5">|</span>

                          {/* Import (card mode) buttons */}
                          <button
                            onClick={() => handleImportRepertoire(file.id, 'white')}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
                            title={`Add White cards from "${file.name}" for review`}
                          >
                            <Download className="w-2.5 h-2.5" />
                            <span className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-white border border-gray-400" />
                          </button>
                          <button
                            onClick={() => handleImportRepertoire(file.id, 'black')}
                            className="flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded bg-gray-700 hover:bg-gray-600 text-gray-300 hover:text-white transition-colors"
                            title={`Add Black cards from "${file.name}" for review`}
                          >
                            <Download className="w-2.5 h-2.5" />
                            <span className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-gray-900 border border-gray-500" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {/* Legend */}
                <div className="px-3 py-2 border-t border-gray-700/50 flex items-center gap-4 text-[10px] text-gray-600">
                  <span className="flex items-center gap-1">
                    <Play className="w-2.5 h-2.5 text-blue-500" /> Play from move 1
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
              className="flex items-center justify-between w-full px-3 py-2 text-xs text-gray-400 hover:text-white bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
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
