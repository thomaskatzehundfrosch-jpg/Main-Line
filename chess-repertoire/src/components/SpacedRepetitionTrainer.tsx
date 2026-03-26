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
  ArrowRight,
} from 'lucide-react';
import type { Card } from '../lib/srScheduler';
import { reviewCard, getDueCards } from '../lib/srScheduler';
import {
  loadCards,
  saveCards,
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

const _chess = new Chess();
const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

type Phase = 'idle' | 'question' | 'grading' | 'complete' | 'replay';

interface SessionStats {
  correct: number;
  incorrect: number;
}

interface SessionHistoryEntry {
  card: Card;
  userMove: string | null;
  correct: boolean;
  reviewFen: string;
  expectedMove: string;
}

interface SpacedRepetitionTrainerProps {
  onClose?: () => void;
}

interface ImportFeedback {
  fileName: string;
  added: number;
  updated: number;
  skipped: number;
}

interface PreparedLineStep {
  fenBefore: string;
  fenAfter: string;
  san: string;
  uci: string;
  color: 'w' | 'b';
}

function uciToSan(fen: string, uci: string): string {
  try {
    _chess.load(fen);
    const from = uci.slice(0, 2);
    const to = uci.slice(2, 4);
    const promotion = uci.length > 4 ? uci[4] : undefined;
    const move = _chess.move({ from, to, promotion } as { from: string; to: string; promotion?: string });
    return move ? move.san : uci;
  } catch {
    return uci;
  }
}

function buildPreparedLine(card: Card | null): PreparedLineStep[] | null {
  if (!card?.moveHistorySan || card.moveHistorySan.length === 0) return null;

  try {
    const chess = new Chess();
    const steps: PreparedLineStep[] = [];

    for (const san of card.moveHistorySan) {
      const fenBefore = chess.fen();
      const color = chess.turn();
      const move = chess.move(san);
      if (!move) return null;
      steps.push({
        fenBefore,
        fenAfter: chess.fen(),
        san,
        uci: move.from + move.to + (move.promotion || ''),
        color,
      });
    }

    return steps;
  } catch {
    return null;
  }
}

function getTrainingColor(card: Card | null, steps: PreparedLineStep[] | null): 'w' | 'b' {
  if (steps && steps.length > 0) return steps[steps.length - 1].color;
  return card?.front.split(' ')[1] === 'b' ? 'b' : 'w';
}

function getCardOrientation(card: Card | null, steps: PreparedLineStep[] | null): 'white' | 'black' {
  return getTrainingColor(card, steps) === 'b' ? 'black' : 'white';
}

function findNextUserStepIndex(
  steps: PreparedLineStep[] | null,
  startIndex: number,
  trainingColor: 'w' | 'b',
): number {
  if (!steps || steps.length === 0) return 0;
  for (let i = startIndex; i < steps.length; i += 1) {
    if (steps[i].color === trainingColor) return i;
  }
  return steps.length - 1;
}

export const SpacedRepetitionTrainer: React.FC<SpacedRepetitionTrainerProps> = ({ onClose }) => {
  const { files } = useFiles();
  const engine = useEngine();

  const [cards, setCards] = useState<Card[]>([]);
  const [sessionCards, setSessionCards] = useState<Card[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [userMove, setUserMove] = useState<string | null>(null);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');
  const [stats, setStats] = useState<SessionStats>({ correct: 0, incorrect: 0 });
  const [lifetimeStats, setLifetimeStats] = useState<SRLifetimeStats>(loadStats);

  const [repertoireListOpen, setRepertoireListOpen] = useState(true);
  const [importerOpen, setImporterOpen] = useState(false);
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null);

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(400);
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);
  const [showSolution, setShowSolution] = useState(false);

  const [sessionHistory, setSessionHistory] = useState<SessionHistoryEntry[]>([]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [lineStepIndex, setLineStepIndex] = useState(0);

  const pendingSaveRef = useRef<Card[] | null>(null);

  // ── Session init ─────────────────────────────────────────────────────────
  const initializeSession = useCallback(() => {
    const loaded = loadCards();
    setCards(loaded);
    // Shuffle all cards so every position in the repertoire gets drilled
    const shuffled = [...loaded].sort(() => Math.random() - 0.5);
    setSessionCards(shuffled);
    setCurrentIndex(0);
    setUserMove(null);
    setShowSolution(false);
    setSessionHistory([]);
    setReplayIndex(0);
    setLineStepIndex(0);
    setStats({ correct: 0, incorrect: 0 });
    if (shuffled.length > 0) {
      setPhase('question');
      setBoardOrientation(getCardOrientation(shuffled[0], buildPreparedLine(shuffled[0])));
    } else {
      setPhase('idle');
    }
  }, []);

  useEffect(() => { initializeSession(); }, [initializeSession]);

  // ── Board resize ──────────────────────────────────────────────────────────
  useEffect(() => {
    const updateWidth = () => {
      if (boardContainerRef.current) {
        const w = boardContainerRef.current.offsetWidth;
        setBoardWidth(Math.max(280, Math.min(560, w - 50)));
      }
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    if (boardContainerRef.current) observer.observe(boardContainerRef.current);
    return () => observer.disconnect();
  }, []);

  // ── Deferred save ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (pendingSaveRef.current) {
      const data = pendingSaveRef.current;
      pendingSaveRef.current = null;
      requestAnimationFrame(() => saveCards(data));
    }
  });

  // ── Derived values ────────────────────────────────────────────────────────
  const currentCard: Card | null = sessionCards[currentIndex] ?? null;
  const preparedLine = useMemo(() => buildPreparedLine(currentCard), [currentCard]);
  const trainingColor = useMemo(() => getTrainingColor(currentCard, preparedLine), [currentCard, preparedLine]);
  const currentReviewFen = useMemo(() => {
    if (preparedLine && preparedLine[lineStepIndex]) return preparedLine[lineStepIndex].fenBefore;
    return currentCard?.front ?? INITIAL_FEN;
  }, [currentCard, preparedLine, lineStepIndex]);
  const expectedMoveUci = useMemo(() => {
    if (preparedLine && preparedLine[lineStepIndex]) return preparedLine[lineStepIndex].uci;
    return currentCard?.back ?? '';
  }, [currentCard, preparedLine, lineStepIndex]);
  const replayCard: Card | null =
    phase === 'replay' && sessionHistory[replayIndex] ? sessionHistory[replayIndex].card : null;

  const displayFen = phase === 'replay'
    ? (sessionHistory[replayIndex]?.reviewFen ?? replayCard?.front ?? INITIAL_FEN)
    : currentReviewFen;

  useEffect(() => {
    if (!currentCard) {
      setLineStepIndex(0);
      return;
    }
    setLineStepIndex(findNextUserStepIndex(preparedLine, 0, trainingColor));
  }, [currentCard?.id, preparedLine, trainingColor]);

  // Reset click-to-move state when card changes
  useEffect(() => {
    setSelectedSquare(null);
    setLegalMoves([]);
    setShowSolution(false);
  }, [currentIndex, phase, lineStepIndex]);

  // Engine analysis
  useEffect(() => {
    if (engine.enabled && currentCard) engine.analyze(currentReviewFen);
  }, [currentCard?.id, currentReviewFen, engine.enabled]);

  const isWhiteToMove = useMemo(() =>
    currentReviewFen.split(' ')[1] === 'w',
    [currentReviewFen],
  );

  const correctMoveSan = useMemo(() =>
    expectedMoveUci ? uciToSan(currentReviewFen, expectedMoveUci) : '',
    [currentReviewFen, expectedMoveUci],
  );

  const userMoveSan = useMemo(() =>
    userMove ? uciToSan(currentReviewFen, userMove) : '',
    [currentReviewFen, userMove],
  );

  const isCorrect = userMove !== null && userMove === expectedMoveUci;

  const dueCount = useMemo(() => getDueCards(cards).length, [cards]);

  const progressPercent = sessionCards.length > 0
    ? ((currentIndex + (phase === 'complete' ? 1 : 0)) / sessionCards.length) * 100
    : 0;

  // ── Arrows ────────────────────────────────────────────────────────────────
  const customArrows: Arrow[] = useMemo(() => {
    if (phase === 'replay' && sessionHistory[replayIndex]) {
      const entry = sessionHistory[replayIndex];
      const from = entry.expectedMove.slice(0, 2) as Square;
      const to = entry.expectedMove.slice(2, 4) as Square;
      const arrows: Arrow[] = [[from, to, 'rgba(59, 98, 160, 0.8)']];
      if (!entry.correct && entry.userMove) {
        arrows.push([
          entry.userMove.slice(0, 2) as Square,
          entry.userMove.slice(2, 4) as Square,
          'rgba(220, 38, 38, 0.6)',
        ]);
      }
      return arrows;
    }
    if (!currentCard) return [];
    if ((phase === 'grading' && isCorrect) || showSolution) {
      return [[
        expectedMoveUci.slice(0, 2) as Square,
        expectedMoveUci.slice(2, 4) as Square,
        'rgba(59, 98, 160, 0.8)',
      ]];
    }
    return [];
  }, [currentCard, expectedMoveUci, phase, showSolution, isCorrect, sessionHistory, replayIndex]);

  // ── Click-to-move ─────────────────────────────────────────────────────────
  const getLegalMovesForSquare = useCallback((square: string): string[] => {
    if (!currentCard) return [];
    try {
      _chess.load(currentReviewFen);
      return _chess.moves({ square: square as any, verbose: true }).map(m => m.to);
    } catch { return []; }
  }, [currentCard, currentReviewFen]);

  const isOwnPiece = useCallback((square: string): boolean => {
    if (!currentCard) return false;
    try {
      _chess.load(currentReviewFen);
      const piece = _chess.get(square as any);
      return piece ? piece.color === _chess.turn() : false;
    } catch { return false; }
  }, [currentCard, currentReviewFen]);

  const clickToMoveStyles: Record<string, React.CSSProperties> = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (!selectedSquare) return styles;
    styles[selectedSquare] = { backgroundColor: 'rgba(59,98,160,0.35)' };
    if (currentCard) {
      try {
        _chess.load(currentReviewFen);
        for (const sq of legalMoves) {
          const target = _chess.get(sq as any);
          styles[sq] = target
            ? { background: 'radial-gradient(circle, transparent 55%, rgba(59,98,160,0.4) 55%)' }
            : { background: 'radial-gradient(circle, rgba(59,98,160,0.35) 25%, transparent 25%)' };
        }
      } catch { /* ignore */ }
    }
    return styles;
  }, [selectedSquare, legalMoves, currentCard, currentReviewFen]);

  // ── Handlers ──────────────────────────────────────────────────────────────
  const advanceToNext = useCallback(() => {
    if (!currentCard) return;
    const correct = userMove !== null && userMove === expectedMoveUci;

    setSessionHistory(prev => [...prev, {
      card: currentCard,
      userMove,
      correct,
      reviewFen: currentReviewFen,
      expectedMove: expectedMoveUci,
    }]);

    const updated = reviewCard(currentCard, correct ? 2 : 0);
    const newCards = cards.map(c => c.id === updated.id ? updated : c);
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
      setLifetimeStats(saveSessionStats(newStats.correct, newStats.incorrect));
      setPhase('complete');
    } else {
      setCurrentIndex(nextIndex);
      setLineStepIndex(0);
      setUserMove(null);
      setPhase('question');
      setBoardOrientation(getCardOrientation(sessionCards[nextIndex], buildPreparedLine(sessionCards[nextIndex])));
    }
  }, [userMove, expectedMoveUci, currentReviewFen, cards, currentCard, stats, currentIndex, sessionCards]);

  const submitMove = useCallback((from: string, to: string, piece?: string): boolean => {
    if (phase !== 'question' || !currentCard) return false;
    try {
      _chess.load(currentReviewFen);
      const isPromotion = piece
        ? piece[1] === 'P' && (to[1] === '8' || to[1] === '1')
        : (() => { const p = _chess.get(from as any); return p?.type === 'p' && (to[1] === '8' || to[1] === '1'); })();
      const move = _chess.move({ from, to, promotion: isPromotion ? 'q' : undefined });
      if (!move) return false;
      const uci = from + to + (isPromotion ? 'q' : '');
      // When solution is shown: only accept the correct move (counts as incorrect)
      if (showSolution) {
        if (uci === expectedMoveUci) { advanceToNext(); return true; }
        return false;
      }
      if (preparedLine && preparedLine[lineStepIndex] && uci === expectedMoveUci) {
        const nextUserStepIndex = findNextUserStepIndex(preparedLine, lineStepIndex + 1, trainingColor);
        if (lineStepIndex < preparedLine.length - 1 && nextUserStepIndex > lineStepIndex) {
          setLineStepIndex(nextUserStepIndex);
          setUserMove(null);
          return true;
        }
      }
      setUserMove(uci);
      setPhase('grading');
      return true;
    } catch { return false; }
  }, [
    phase,
    currentCard,
    currentReviewFen,
    showSolution,
    advanceToNext,
    expectedMoveUci,
    preparedLine,
    lineStepIndex,
    trainingColor,
  ]);

  const handlePieceDrop = useCallback((src: Square, tgt: Square, piece: Piece): boolean => {
    setSelectedSquare(null);
    setLegalMoves([]);
    return submitMove(src, tgt, piece);
  }, [submitMove]);

  const handleSquareClick = useCallback((square: Square) => {
    if (phase !== 'question' || !currentCard) {
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
  }, [phase, currentCard, selectedSquare, legalMoves, isOwnPiece, getLegalMovesForSquare, submitMove]);

  const handlePieceClick = useCallback((_piece: Piece, square: Square) => {
    handleSquareClick(square);
  }, [handleSquareClick]);

  // Auto-advance 800 ms after a correct answer
  useEffect(() => {
    if (phase !== 'grading' || !isCorrect) return;
    autoAdvanceRef.current = setTimeout(() => advanceToNext(), 800);
    return () => {
      if (autoAdvanceRef.current) { clearTimeout(autoAdvanceRef.current); autoAdvanceRef.current = null; }
    };
  }, [phase, isCorrect, advanceToNext]);

  const handleStartReplay = useCallback(() => {
    if (sessionHistory.length === 0) return;
    setReplayIndex(0);
    setPhase('replay');
    setBoardOrientation(sessionHistory[0].reviewFen.split(' ')[1] === 'b' ? 'black' : 'white');
  }, [sessionHistory]);

  const handleReplayNav = useCallback((direction: 'prev' | 'next') => {
    const newIdx = direction === 'next' ? replayIndex + 1 : replayIndex - 1;
    if (newIdx < 0 || newIdx >= sessionHistory.length) return;
    setReplayIndex(newIdx);
    setBoardOrientation(sessionHistory[newIdx].reviewFen.split(' ')[1] === 'b' ? 'black' : 'white');
  }, [replayIndex, sessionHistory]);

  const handleImportRepertoire = useCallback((fileId: string, drillColor: 'white' | 'black') => {
    const file = files.find(f => f.id === fileId);
    if (!file) return;
    const existing = loadCards();
    const result = treeToCards(file.tree, drillColor, file.name, existing);
    if (result.newCards.length > 0 || result.updatedCards.length > 0) {
      const updatedById = new Map(result.updatedCards.map(card => [card.id, card]));
      const upgradedExisting = existing.map(card => updatedById.get(card.id) ?? card);
      const merged = result.newCards.length > 0
        ? [...upgradedExisting, ...result.newCards]
        : upgradedExisting;
      saveCards(merged);
      setCards(merged);
      if (phase === 'idle') {
        const shuffled = [...merged].sort(() => Math.random() - 0.5);
        if (shuffled.length > 0) {
          setSessionCards(shuffled);
          setCurrentIndex(0);
          setLineStepIndex(0);
          setUserMove(null);
          setPhase('question');
          setBoardOrientation(getCardOrientation(shuffled[0], buildPreparedLine(shuffled[0])));
        }
      }
    }
    setImportFeedback({
      fileName: file.name,
      added: result.newCards.length,
      updated: result.updatedCards.length,
      skipped: result.duplicatesSkipped,
    });
    setTimeout(() => setImportFeedback(null), 4000);
  }, [files, phase]);

  const handleCardsImported = useCallback(() => {
    const loaded = loadCards();
    setCards(loaded);
    if (phase === 'idle') {
      const shuffled = [...loaded].sort(() => Math.random() - 0.5);
      if (shuffled.length > 0) {
        setSessionCards(shuffled);
        setCurrentIndex(0);
        setLineStepIndex(0);
        setUserMove(null);
        setPhase('question');
        setBoardOrientation(getCardOrientation(shuffled[0], buildPreparedLine(shuffled[0])));
      }
    }
  }, [phase]);

  const handleClearCards = useCallback(() => {
    if (!window.confirm('Remove all spaced-repetition cards? This cannot be undone.')) return;
    clearAllCards();
    setCards([]);
    setSessionCards([]);
    setCurrentIndex(0);
    setLineStepIndex(0);
    setPhase('idle');
  }, []);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="flex-1 flex flex-col bg-bg-primary min-h-0">

      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-bg-surface border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-3">
          {onClose && (
            <button onClick={onClose} className="btn-icon p-1.5" title="Back">
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
              <button onClick={handleClearCards} className="btn-icon p-1" title="Clear all cards">
                <Trash2 className="w-3.5 h-3.5 hover:text-accent-red transition-colors" />
              </button>
            </>
          )}
        </div>
      </div>

      {/* Import feedback toast */}
      {importFeedback && (
        <div className="mx-4 mt-3 px-3 py-2 bg-accent-teal/5 border border-accent-teal/30 rounded-lg text-xs text-accent-teal flex items-center gap-2 flex-shrink-0">
          <Check className="w-3.5 h-3.5 flex-shrink-0" />
          <span>
            <strong>{importFeedback.fileName}</strong>: {importFeedback.added} card{importFeedback.added !== 1 ? 's' : ''} added
            {importFeedback.updated > 0 && (
              <span className="text-text-muted">, {importFeedback.updated} upgraded</span>
            )}
            {importFeedback.skipped > 0 && (
              <span className="text-text-muted"> ({importFeedback.skipped} duplicate{importFeedback.skipped !== 1 ? 's' : ''} skipped)</span>
            )}
          </span>
        </div>
      )}

      {/* Main layout */}
      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-auto">

        {/* Left — Board */}
        <div ref={boardContainerRef} className="flex flex-col items-center p-4 lg:flex-1 lg:min-w-[400px]">
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
                isDraggablePiece={() => phase === 'question'}
                customDarkSquareStyle={{ backgroundColor: '#4b6fa0' }}
                customLightSquareStyle={{ backgroundColor: '#e8dcc0' }}
                customBoardStyle={{ borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.10)' }}
                customDropSquareStyle={{ boxShadow: 'inset 0 0 1px 6px rgba(59,98,160,0.5)' }}
                customSquareStyles={clickToMoveStyles}
                animationDuration={100}
                customArrows={customArrows.length > 0 ? customArrows : undefined}
              />
            </div>
          </div>
          <button
            onClick={() => setBoardOrientation(prev => prev === 'white' ? 'black' : 'white')}
            className="btn-secondary mt-3 flex items-center gap-1.5 text-xs py-1.5 px-3"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Flip Board
          </button>
        </div>

        {/* Right — Controls */}
        <div className="lg:w-[400px] lg:min-w-[340px] flex flex-col p-4 gap-4 lg:border-l lg:border-border-subtle overflow-auto">

          {/* Progress bar */}
          {sessionCards.length > 0 && phase !== 'idle' && phase !== 'complete' && phase !== 'replay' && (
            <div>
              <div className="flex justify-between text-xs text-text-muted mb-1.5">
                <span>Session Progress</span>
                <span>{Math.min(currentIndex + 1, sessionCards.length)} / {sessionCards.length}</span>
              </div>
              <div className="w-full h-2 bg-bg-panel rounded-full overflow-hidden">
                <div
                  className="h-full bg-accent-teal rounded-full transition-all duration-300"
                  style={{ width: `${progressPercent}%` }}
                />
              </div>
            </div>
          )}

          {/* ── Idle ── */}
          {phase === 'idle' && (
            <div className="flex flex-col items-center justify-center gap-4 py-6">
              <Brain className="w-12 h-12 text-text-muted opacity-40" />
              <p className="text-text-muted text-center text-sm">
                {cards.length === 0
                  ? 'No cards yet. Import a repertoire below to get started.'
                  : 'No cards due for review. Import more lines to keep training!'}
              </p>
              {cards.length > 0 && (
                <p className="text-text-muted text-xs">
                  {cards.length} card{cards.length !== 1 ? 's' : ''} in your collection
                </p>
              )}
            </div>
          )}

          {/* ── Question ── */}
          {phase === 'question' && currentCard && (
            <div className="panel p-4">
              {currentCard.lineName && (
                <div className="text-xs text-accent-teal font-mono mb-2 uppercase tracking-wider">
                  {currentCard.lineName}
                </div>
              )}
              <p className="text-text-primary text-sm">
                Find the best move for{' '}
                <span className="font-semibold">{isWhiteToMove ? 'White' : 'Black'}</span>
              </p>
              {preparedLine && preparedLine.length > 1 && (
                <p className="text-text-muted text-xs mt-2">
                  Play the line from move 1. Opponent replies are filled in automatically.
                </p>
              )}
              {!showSolution ? (
                <>
                  <p className="text-text-muted text-xs mt-2">Click or drag a piece to make your move</p>
                  <button
                    onClick={() => setShowSolution(true)}
                    className="btn-secondary mt-3 flex items-center gap-1.5 text-xs py-1.5 px-3"
                  >
                    <Eye className="w-3.5 h-3.5" />
                    Show Solution
                  </button>
                </>
              ) : (
                <>
                  <p className="text-text-muted text-xs mt-2">
                    Correct move:{' '}
                    <span className="text-accent-teal font-mono">{correctMoveSan}</span>
                  </p>
                  <p className="text-text-muted text-xs mt-1">
                    Study the arrow, then click Next when ready.
                  </p>
                  <button
                    onClick={() => advanceToNext()}
                    className="btn-primary mt-3 flex items-center gap-1.5 text-xs py-1.5 px-3"
                  >
                    Got it, Next <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          )}

          {/* ── Grading ── */}
          {phase === 'grading' && currentCard && (
            <div className="flex flex-col gap-4">
              <div className={`panel p-4 ${isCorrect ? 'border-accent-teal/40 bg-accent-teal/5' : 'border-accent-red/30 bg-accent-red/5'}`}>
                <span className={`text-sm font-semibold ${isCorrect ? 'text-accent-teal' : 'text-accent-red'}`}>
                  {isCorrect ? 'Correct!' : 'Incorrect'}
                </span>
                {!isCorrect && userMoveSan && (
                  <p className="text-text-muted text-xs mt-1">
                    Your move: <span className="text-text-primary font-mono">{userMoveSan}</span>
                  </p>
                )}
                {(isCorrect || showSolution) && (
                  <p className="text-text-muted text-xs mt-1">
                    Correct: <span className="text-accent-teal font-mono">{correctMoveSan}</span>
                  </p>
                )}
              </div>

              {isCorrect && (
                <div className="text-center text-xs text-text-muted animate-pulse-subtle">Advancing…</div>
              )}

              {!isCorrect && (
                <div className="flex items-center gap-2">
                  {!showSolution && (
                    <button
                      onClick={() => setShowSolution(true)}
                      className="flex-1 btn-secondary flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium"
                    >
                      <Eye className="w-3.5 h-3.5" /> Show Solution
                    </button>
                  )}
                  <button
                    onClick={advanceToNext}
                    className="flex-1 btn-secondary flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium"
                  >
                    <SkipForward className="w-3.5 h-3.5" /> Next
                  </button>
                </div>
              )}
            </div>
          )}

          {/* ── Complete ── */}
          {phase === 'complete' && (() => {
            const total = stats.correct + stats.incorrect;
            const sessionPct = total > 0 ? Math.round((stats.correct / total) * 100) : 0;
            const lifetimePct = lifetimeStats.totalReviewed > 0
              ? Math.round((lifetimeStats.totalCorrect / lifetimeStats.totalReviewed) * 100) : 0;
            return (
              <div className="flex flex-col items-center gap-4 py-8">
                <Trophy className="w-12 h-12 text-accent-amber" />
                <h3 className="text-text-primary text-lg font-semibold">Session Complete!</h3>
                <div className="text-4xl font-bold text-accent-teal">{sessionPct}%</div>
                <p className="text-text-muted text-xs -mt-2">session accuracy</p>
                <div className="panel p-4 w-full">
                  <div className="grid grid-cols-2 gap-4 text-center">
                    <div>
                      <div className="text-accent-teal text-2xl font-bold">{stats.correct}</div>
                      <div className="text-text-muted text-xs">Correct</div>
                    </div>
                    <div>
                      <div className="text-accent-red text-2xl font-bold">{stats.incorrect}</div>
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
                        ({lifetimeStats.totalCorrect}/{lifetimeStats.totalReviewed})
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
                      <Play className="w-4 h-4" /> Replay
                    </button>
                  )}
                  <button
                    onClick={() => initializeSession()}
                    className="btn-primary px-4 py-2 text-sm font-medium"
                  >
                    New Session
                  </button>
                </div>
              </div>
            );
          })()}

          {/* ── Replay ── */}
          {phase === 'replay' && sessionHistory[replayIndex] && (() => {
            const entry = sessionHistory[replayIndex];
            const replaySan = uciToSan(entry.reviewFen, entry.expectedMove);
            const replayUserSan = entry.userMove ? uciToSan(entry.reviewFen, entry.userMove) : null;
            const replayWhite = entry.reviewFen.split(' ')[1] === 'w';
            return (
              <div className="flex flex-col gap-4">
                <div className="flex items-center justify-between">
                  <span className="text-xs text-text-muted font-mono">
                    Replay: {replayIndex + 1} / {sessionHistory.length}
                  </span>
                  <button
                    onClick={() => setPhase('complete')}
                    className="text-xs text-text-muted hover:text-text-primary transition-colors"
                  >
                    Back to Summary
                  </button>
                </div>
                <div className="w-full h-1.5 bg-bg-panel rounded-full overflow-hidden">
                  <div
                    className="h-full bg-accent-teal rounded-full transition-all duration-200"
                    style={{ width: `${((replayIndex + 1) / sessionHistory.length) * 100}%` }}
                  />
                </div>
                <div className={`panel p-4 ${entry.correct ? 'border-accent-teal/30 bg-accent-teal/5' : 'border-accent-red/30 bg-accent-red/5'}`}>
                  {entry.card.lineName && (
                    <div className="text-xs text-accent-teal font-mono mb-2 uppercase tracking-wider">
                      {entry.card.lineName}
                    </div>
                  )}
                  <p className="text-text-muted text-xs mb-1">{replayWhite ? 'White' : 'Black'} to move</p>
                  <span className={`text-xs font-semibold ${entry.correct ? 'text-accent-teal' : 'text-accent-red'}`}>
                    {entry.correct ? 'Correct' : 'Incorrect'}
                  </span>
                  {!entry.correct && replayUserSan && (
                    <p className="text-text-muted text-xs mt-1">
                      Your move: <span className="text-text-primary font-mono">{replayUserSan}</span>
                    </p>
                  )}
                  {!entry.correct && !replayUserSan && (
                    <p className="text-text-muted text-xs mt-1 italic">No attempt — solution revealed</p>
                  )}
                  <p className="text-text-muted text-xs mt-1">
                    Correct: <span className="text-accent-teal font-mono">{replaySan}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => handleReplayNav('prev')}
                    disabled={replayIndex <= 0}
                    className="flex-1 btn-secondary flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    <ChevronLeft className="w-3.5 h-3.5" /> Prev
                  </button>
                  <button
                    onClick={() => handleReplayNav('next')}
                    disabled={replayIndex >= sessionHistory.length - 1}
                    className="flex-1 btn-secondary flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                  >
                    Next <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })()}

          {/* ── Import Repertoire ── */}
          <div className="mt-auto pt-4 flex flex-col gap-2">
            <button
              onClick={() => setRepertoireListOpen(prev => !prev)}
              className="btn-secondary flex items-center justify-between w-full px-3 py-2 text-xs"
            >
              <span className="flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5" />
                Import Repertoire
              </span>
              {repertoireListOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>

            {repertoireListOpen && (
              <div className="panel overflow-hidden">
                {files.length === 0 ? (
                  <div className="px-3 py-4 text-xs text-text-muted text-center">
                    No saved repertoires yet.<br />Save a repertoire from the main view first.
                  </div>
                ) : (
                  <div className="divide-y divide-border-subtle">
                    {files.map(file => (
                      <div key={file.id} className="px-3 py-2.5 flex items-center gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="text-xs text-text-primary font-medium truncate">{file.name}</div>
                          <div className="text-[10px] text-text-muted">
                            {file.nodeCount} position{file.nodeCount !== 1 ? 's' : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => handleImportRepertoire(file.id, 'white')}
                            className="btn-secondary flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded"
                            title={`Add White cards from "${file.name}"`}
                          >
                            <Download className="w-2.5 h-2.5" />
                            <span className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-white border border-border-active" />
                          </button>
                          <button
                            onClick={() => handleImportRepertoire(file.id, 'black')}
                            className="btn-secondary flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded"
                            title={`Add Black cards from "${file.name}"`}
                          >
                            <Download className="w-2.5 h-2.5" />
                            <span className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-text-primary border border-border-subtle" />
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="px-3 py-2 border-t border-border-subtle text-[10px] text-text-muted">
                  White/Black square = drill as that colour
                </div>
              </div>
            )}

            <button
              onClick={() => setImporterOpen(prev => !prev)}
              className="btn-secondary flex items-center justify-between w-full px-3 py-2 text-xs"
            >
              <span>Add Cards Manually</span>
              {importerOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
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
