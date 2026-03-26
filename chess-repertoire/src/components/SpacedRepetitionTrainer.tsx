import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import type { Arrow, Piece, Square } from 'react-chessboard/dist/chessboard/types';
import {
  ArrowRight,
  Brain,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Download,
  Eye,
  FolderOpen,
  Play,
  RotateCcw,
  SkipForward,
  Trash2,
  Trophy,
} from 'lucide-react';
import type { Card } from '../lib/srScheduler';
import { getDueCards, reviewCard } from '../lib/srScheduler';
import {
  clearAllCards,
  loadCards,
  loadStats,
  saveCards,
  saveSessionStats,
} from '../lib/srStorage';
import type { SRLifetimeStats } from '../lib/srStorage';
import { treeToCards } from '../lib/srTreeImport';
import { useFiles } from '../context/FileContext';
import type { RepertoireFile } from '../types/repertoireFile';
import { useEngine } from '../hooks/useEngine';
import EvalBar from './Board/EvalBar';
import { SRCardImporter } from './SRCardImporter';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const sharedChess = new Chess();

type Phase = 'idle' | 'question' | 'grading' | 'complete' | 'replay';

interface ImportFeedback {
  fileName: string;
  added: number;
  updated: number;
  skipped: number;
}

interface SessionStats {
  correct: number;
  incorrect: number;
}

interface SessionEntry {
  card: Card;
  reviewFen: string;
  expectedMove: string;
  userMove: string | null;
  correct: boolean;
}

interface PreparedLineStep {
  fenBefore: string;
  san: string;
  uci: string;
}

interface ReplayableCard extends Card {
  moveHistorySan: string[];
  lineStartFen: string;
}

function uciToSan(fen: string, uci: string): string {
  try {
    sharedChess.load(fen);
    const move = sharedChess.move({
      from: uci.slice(0, 2),
      to: uci.slice(2, 4),
      promotion: uci.length > 4 ? uci[4] : undefined,
    } as { from: string; to: string; promotion?: string });
    return move ? move.san : uci;
  } catch {
    return uci;
  }
}

function compareCards(a: ReplayableCard, b: ReplayableCard): number {
  if ((a.lineName ?? '') !== (b.lineName ?? '')) return (a.lineName ?? '').localeCompare(b.lineName ?? '');

  const sharedLength = Math.min(a.moveHistorySan.length, b.moveHistorySan.length);
  for (let i = 0; i < sharedLength; i += 1) {
    if (a.moveHistorySan[i] !== b.moveHistorySan[i]) return a.moveHistorySan[i].localeCompare(b.moveHistorySan[i]);
  }

  if (a.moveHistorySan.length !== b.moveHistorySan.length) return a.moveHistorySan.length - b.moveHistorySan.length;
  if (a.front !== b.front) return a.front.localeCompare(b.front);
  return a.back.localeCompare(b.back);
}

function buildHistoryLookup(files: RepertoireFile[]): Map<string, { moveHistorySan: string[]; lineStartFen: string; lineName: string }> {
  const lookup = new Map<string, { moveHistorySan: string[]; lineStartFen: string; lineName: string }>();

  const walk = (node: RepertoireFile['tree'], path: string[], file: RepertoireFile) => {
    for (const child of node.children) {
      const nextPath = [...path, child.move];
      try {
        const chess = new Chess(node.fen);
        const move = chess.move(child.move);
        if (move) {
          const uci = move.from + move.to + (move.promotion || '');
          const key = `${node.fen}|||${uci}`;
          if (!lookup.has(key)) {
            lookup.set(key, {
              moveHistorySan: nextPath,
              lineStartFen: file.tree.fen,
              lineName: file.name,
            });
          }
        }
      } catch {
        // Ignore invalid repertoire nodes while rebuilding histories.
      }
      walk(child, nextPath, file);
    }
  };

  for (const file of files) walk(file.tree, [], file);
  return lookup;
}

function enrichReplayableCards(cards: Card[], files: RepertoireFile[]): { cards: ReplayableCard[]; changed: boolean; skipped: number } {
  const lookup = buildHistoryLookup(files);
  let changed = false;
  let skipped = 0;
  const replayable: ReplayableCard[] = [];

  for (const card of cards) {
    let enriched: Card = card;

    if ((!card.moveHistorySan || card.moveHistorySan.length === 0) || !card.lineStartFen) {
      const match = lookup.get(`${card.front}|||${card.back}`);
      if (match) {
        enriched = {
          ...card,
          moveHistorySan: match.moveHistorySan,
          lineStartFen: match.lineStartFen,
          lineName: card.lineName ?? match.lineName,
        };
        changed = true;
      }
    }

    if (enriched.moveHistorySan && enriched.moveHistorySan.length > 0 && enriched.lineStartFen) {
      replayable.push(enriched as ReplayableCard);
    } else {
      skipped += 1;
    }
  }

  replayable.sort(compareCards);
  return { cards: replayable, changed, skipped };
}

function buildPreparedLine(card: ReplayableCard | null): PreparedLineStep[] {
  if (!card) return [];

  try {
    const chess = new Chess(card.lineStartFen);
    const steps: PreparedLineStep[] = [];

    for (const san of card.moveHistorySan) {
      const fenBefore = chess.fen();
      const move = chess.move(san);
      if (!move) return [];
      steps.push({
        fenBefore,
        san,
        uci: move.from + move.to + (move.promotion || ''),
      });
    }

    return steps;
  } catch {
    return [];
  }
}

function getOrientation(card: ReplayableCard | null): 'white' | 'black' {
  if (!card) return 'white';
  try {
    const chess = new Chess(card.lineStartFen);
    return chess.turn() === 'b' ? 'black' : 'white';
  } catch {
    return 'white';
  }
}

function mergeImportedCards(existing: Card[], file: RepertoireFile, drillColor: 'white' | 'black'): { cards: Card[]; feedback: ImportFeedback } {
  const result = treeToCards(file.tree, drillColor, file.name, existing);
  const updatedById = new Map(result.updatedCards.map((card) => [card.id, card]));
  const mergedExisting = existing.map((card) => updatedById.get(card.id) ?? card);
  const merged = [...mergedExisting, ...result.newCards];

  return {
    cards: merged,
    feedback: {
      fileName: file.name,
      added: result.newCards.length,
      updated: result.updatedCards.length,
      skipped: result.duplicatesSkipped,
    },
  };
}

export const SpacedRepetitionTrainer: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { files } = useFiles();
  const engine = useEngine();

  const [cards, setCards] = useState<Card[]>([]);
  const [sessionCards, setSessionCards] = useState<ReplayableCard[]>([]);
  const [currentIndex, setCurrentIndex] = useState(0);
  const [lineStepIndex, setLineStepIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [userMove, setUserMove] = useState<string | null>(null);
  const [showSolution, setShowSolution] = useState(false);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');
  const [stats, setStats] = useState<SessionStats>({ correct: 0, incorrect: 0 });
  const [lifetimeStats, setLifetimeStats] = useState<SRLifetimeStats>(loadStats);
  const [importFeedback, setImportFeedback] = useState<ImportFeedback | null>(null);
  const [repertoireListOpen, setRepertoireListOpen] = useState(true);
  const [importerOpen, setImporterOpen] = useState(false);
  const [sessionHistory, setSessionHistory] = useState<SessionEntry[]>([]);
  const [replayIndex, setReplayIndex] = useState(0);
  const [skippedCards, setSkippedCards] = useState(0);

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(400);
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingSaveRef = useRef<Card[] | null>(null);

  const rebuildSession = useCallback((sourceCards?: Card[]) => {
    const loaded = sourceCards ?? loadCards();
    const dueCards = getDueCards(loaded, loaded.length || 20);
    const { cards: replayable, changed, skipped } = enrichReplayableCards(dueCards, files);
    const allEnriched = changed ? loaded.map((card) => {
      const replayableCard = replayable.find((candidate) => candidate.id === card.id);
      return replayableCard ?? card;
    }) : loaded;

    setCards(allEnriched);
    setSessionCards(replayable);
    setSkippedCards(skipped);
    setCurrentIndex(0);
    setLineStepIndex(0);
    setUserMove(null);
    setShowSolution(false);
    setSelectedSquare(null);
    setLegalMoves([]);
    setSessionHistory([]);
    setReplayIndex(0);
    setStats({ correct: 0, incorrect: 0 });

    if (changed) pendingSaveRef.current = allEnriched;

    if (replayable.length > 0) {
      setBoardOrientation(getOrientation(replayable[0]));
      setPhase('question');
    } else {
      setBoardOrientation('white');
      setPhase('idle');
    }
  }, [files]);

  useEffect(() => {
    rebuildSession();
  }, [rebuildSession]);

  useEffect(() => {
    if (pendingSaveRef.current) {
      const nextCards = pendingSaveRef.current;
      pendingSaveRef.current = null;
      requestAnimationFrame(() => saveCards(nextCards));
    }
  });

  useEffect(() => {
    const updateWidth = () => {
      if (!boardContainerRef.current) return;
      const width = boardContainerRef.current.offsetWidth;
      setBoardWidth(Math.max(280, Math.min(560, width - 50)));
    };

    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    if (boardContainerRef.current) observer.observe(boardContainerRef.current);
    return () => observer.disconnect();
  }, []);

  const currentCard = sessionCards[currentIndex] ?? null;
  const preparedLine = useMemo(() => buildPreparedLine(currentCard), [currentCard]);
  const currentStep = preparedLine[lineStepIndex] ?? null;
  const displayFen = phase === 'replay'
    ? (sessionHistory[replayIndex]?.reviewFen ?? INITIAL_FEN)
    : (currentStep?.fenBefore ?? currentCard?.lineStartFen ?? INITIAL_FEN);
  const expectedMove = currentStep?.uci ?? currentCard?.back ?? '';
  const isWhiteToMove = displayFen.split(' ')[1] === 'w';
  const correctMoveSan = expectedMove ? uciToSan(displayFen, expectedMove) : '';
  const userMoveSan = userMove ? uciToSan(displayFen, userMove) : '';
  const isCorrect = userMove !== null && userMove === expectedMove;

  useEffect(() => {
    setSelectedSquare(null);
    setLegalMoves([]);
    setShowSolution(false);
  }, [currentIndex, lineStepIndex, phase]);

  useEffect(() => {
    if (engine.enabled && phase !== 'replay' && currentStep) engine.analyze(displayFen);
  }, [displayFen, currentStep, engine.enabled, phase]);

  useEffect(() => {
    if (phase !== 'grading' || !isCorrect) return;
    autoAdvanceRef.current = setTimeout(() => {
      advanceAfterAnswer();
    }, 700);

    return () => {
      if (autoAdvanceRef.current) clearTimeout(autoAdvanceRef.current);
    };
  }, [phase, isCorrect]);

  const clickStyles = useMemo(() => {
    const styles: Record<string, React.CSSProperties> = {};
    if (!selectedSquare) return styles;

    styles[selectedSquare] = { backgroundColor: 'rgba(59,98,160,0.35)' };

    try {
      sharedChess.load(displayFen);
      for (const square of legalMoves) {
        const target = sharedChess.get(square as Square);
        styles[square] = target
          ? { background: 'radial-gradient(circle, transparent 55%, rgba(59,98,160,0.4) 55%)' }
          : { background: 'radial-gradient(circle, rgba(59,98,160,0.35) 25%, transparent 25%)' };
      }
    } catch {
      return styles;
    }

    return styles;
  }, [displayFen, legalMoves, selectedSquare]);

  const arrows: Arrow[] = useMemo(() => {
    if (phase === 'replay' && sessionHistory[replayIndex]) {
      const entry = sessionHistory[replayIndex];
      const replayArrows: Arrow[] = [[
        entry.expectedMove.slice(0, 2) as Square,
        entry.expectedMove.slice(2, 4) as Square,
        'rgba(59, 98, 160, 0.8)',
      ]];
      if (!entry.correct && entry.userMove) {
        replayArrows.push([
          entry.userMove.slice(0, 2) as Square,
          entry.userMove.slice(2, 4) as Square,
          'rgba(220, 38, 38, 0.6)',
        ]);
      }
      return replayArrows;
    }

    if (!expectedMove) return [];
    if (phase === 'grading' || showSolution) {
      return [[
        expectedMove.slice(0, 2) as Square,
        expectedMove.slice(2, 4) as Square,
        'rgba(59, 98, 160, 0.8)',
      ]];
    }

    return [];
  }, [expectedMove, phase, replayIndex, sessionHistory, showSolution]);

  const getLegalMoves = useCallback((square: string) => {
    try {
      sharedChess.load(displayFen);
      return sharedChess.moves({ square: square as Square, verbose: true }).map((move) => move.to);
    } catch {
      return [];
    }
  }, [displayFen]);

  const isOwnPiece = useCallback((square: string) => {
    try {
      sharedChess.load(displayFen);
      const piece = sharedChess.get(square as Square);
      return piece?.color === sharedChess.turn();
    } catch {
      return false;
    }
  }, [displayFen]);

  const advanceAfterAnswer = useCallback(() => {
    if (!currentCard || !expectedMove) return;

    const correct = userMove !== null && userMove === expectedMove;

    setSessionHistory((prev) => [...prev, {
      card: currentCard,
      reviewFen: displayFen,
      expectedMove,
      userMove,
      correct,
    }]);

    const updatedCard = reviewCard(currentCard, correct ? 2 : 0);
    const updatedCards = cards.map((card) => (card.id === updatedCard.id ? updatedCard : card));
    setCards(updatedCards);
    pendingSaveRef.current = updatedCards;

    const nextStats = {
      correct: stats.correct + (correct ? 1 : 0),
      incorrect: stats.incorrect + (correct ? 0 : 1),
    };
    setStats(nextStats);

    const nextCardIndex = currentIndex + 1;
    if (nextCardIndex >= sessionCards.length) {
      setLifetimeStats(saveSessionStats(nextStats.correct, nextStats.incorrect));
      setPhase('complete');
      return;
    }

    setCurrentIndex(nextCardIndex);
    setLineStepIndex(0);
    setUserMove(null);
    setBoardOrientation(getOrientation(sessionCards[nextCardIndex]));
    setPhase('question');
  }, [cards, currentCard, currentIndex, displayFen, expectedMove, sessionCards, stats, userMove]);

  const submitMove = useCallback((from: string, to: string, piece?: string) => {
    if (phase !== 'question' || !currentStep) return false;

    try {
      sharedChess.load(displayFen);
      const isPromotion = piece
        ? piece[1] === 'P' && (to[1] === '8' || to[1] === '1')
        : (() => {
            const currentPiece = sharedChess.get(from as Square);
            return currentPiece?.type === 'p' && (to[1] === '8' || to[1] === '1');
          })();

      const move = sharedChess.move({
        from,
        to,
        promotion: isPromotion ? 'q' : undefined,
      } as { from: string; to: string; promotion?: string });

      if (!move) return false;

      const uci = from + to + (isPromotion ? 'q' : '');
      if (showSolution) {
        if (uci === expectedMove) {
          advanceAfterAnswer();
          return true;
        }
        return false;
      }

      if (uci !== expectedMove) {
        setUserMove(uci);
        setPhase('grading');
        return true;
      }

      const nextStepIndex = lineStepIndex + 1;
      if (nextStepIndex < preparedLine.length) {
        setLineStepIndex(nextStepIndex);
        return true;
      }

      setUserMove(uci);
      setPhase('grading');
      return true;
    } catch {
      return false;
    }
  }, [advanceAfterAnswer, currentStep, displayFen, expectedMove, lineStepIndex, phase, preparedLine.length, showSolution]);

  const handlePieceDrop = useCallback((source: Square, target: Square, piece: Piece) => {
    setSelectedSquare(null);
    setLegalMoves([]);
    return submitMove(source, target, piece);
  }, [submitMove]);

  const handleSquareClick = useCallback((square: Square) => {
    if (phase !== 'question' || !currentStep) {
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
        setLegalMoves(getLegalMoves(square));
      }
      return;
    }

    setSelectedSquare(null);
    setLegalMoves([]);
  }, [currentStep, getLegalMoves, isOwnPiece, legalMoves, phase, selectedSquare, submitMove]);

  const handleImportRepertoire = useCallback((fileId: string, drillColor: 'white' | 'black') => {
    const file = files.find((candidate) => candidate.id === fileId);
    if (!file) return;

    const { cards: mergedCards, feedback } = mergeImportedCards(loadCards(), file, drillColor);
    saveCards(mergedCards);
    setImportFeedback(feedback);
    rebuildSession(mergedCards);
    setTimeout(() => setImportFeedback(null), 4000);
  }, [files, rebuildSession]);

  const progressPercent = sessionCards.length > 0
    ? ((currentIndex + (phase === 'complete' ? 1 : 0)) / sessionCards.length) * 100
    : 0;

  return (
    <div className="flex-1 flex flex-col bg-bg-primary min-h-0">
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
          <span>{getDueCards(cards, cards.length || 20).length} due</span>
          {skippedCards > 0 && (
            <>
              <span className="text-border-subtle">|</span>
              <span>{skippedCards} unusable</span>
            </>
          )}
          <span className="text-border-subtle">|</span>
          <span>{cards.length} total</span>
          {cards.length > 0 && (
            <>
              <span className="text-border-subtle">|</span>
              <button
                onClick={() => {
                  if (!window.confirm('Remove all spaced-repetition cards? This cannot be undone.')) return;
                  clearAllCards();
                  rebuildSession([]);
                }}
                className="btn-icon p-1"
                title="Clear all cards"
              >
                <Trash2 className="w-3.5 h-3.5 hover:text-accent-red transition-colors" />
              </button>
            </>
          )}
        </div>
      </div>

      {importFeedback && (
        <div className="mx-4 mt-3 px-3 py-2 bg-accent-teal/5 border border-accent-teal/30 rounded-lg text-xs text-accent-teal flex items-center gap-2 flex-shrink-0">
          <Check className="w-3.5 h-3.5 flex-shrink-0" />
          <span>
            <strong>{importFeedback.fileName}</strong>: {importFeedback.added} added
            {importFeedback.updated > 0 && <span className="text-text-muted">, {importFeedback.updated} upgraded</span>}
            {importFeedback.skipped > 0 && <span className="text-text-muted"> ({importFeedback.skipped} duplicate skipped)</span>}
          </span>
        </div>
      )}

      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-auto">
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
                boardWidth={boardWidth}
                boardOrientation={boardOrientation}
                onPieceDrop={handlePieceDrop}
                onSquareClick={handleSquareClick}
                onPieceClick={(_piece, square) => handleSquareClick(square)}
                isDraggablePiece={() => phase === 'question'}
                customDarkSquareStyle={{ backgroundColor: '#4b6fa0' }}
                customLightSquareStyle={{ backgroundColor: '#e8dcc0' }}
                customBoardStyle={{ borderRadius: '4px', boxShadow: '0 2px 8px rgba(0,0,0,0.10)' }}
                customDropSquareStyle={{ boxShadow: 'inset 0 0 1px 6px rgba(59,98,160,0.5)' }}
                customSquareStyles={clickStyles}
                animationDuration={120}
                customArrows={arrows.length > 0 ? arrows : undefined}
              />
            </div>
          </div>
          <button
            onClick={() => setBoardOrientation((prev) => (prev === 'white' ? 'black' : 'white'))}
            className="btn-secondary mt-3 flex items-center gap-1.5 text-xs py-1.5 px-3"
          >
            <RotateCcw className="w-3.5 h-3.5" />
            Flip Board
          </button>
        </div>

        <div className="lg:w-[400px] lg:min-w-[340px] flex flex-col p-4 gap-4 lg:border-l lg:border-border-subtle overflow-auto">
          {sessionCards.length > 0 && phase !== 'idle' && phase !== 'complete' && phase !== 'replay' && (
            <div>
              <div className="flex justify-between text-xs text-text-muted mb-1.5">
                <span>Session Progress</span>
                <span>{Math.min(currentIndex + 1, sessionCards.length)} / {sessionCards.length}</span>
              </div>
              <div className="w-full h-2 bg-bg-panel rounded-full overflow-hidden">
                <div className="h-full bg-accent-teal rounded-full transition-all duration-300" style={{ width: `${progressPercent}%` }} />
              </div>
            </div>
          )}

          {phase === 'idle' && (
            <div className="flex flex-col items-center justify-center gap-4 py-6">
              <Brain className="w-12 h-12 text-text-muted opacity-40" />
              <p className="text-text-muted text-center text-sm">
                {cards.length === 0
                  ? 'No cards yet. Import a repertoire below to get started.'
                  : 'No replayable due cards found. Import or re-import a repertoire to rebuild line history.'}
              </p>
            </div>
          )}

          {phase === 'question' && currentCard && currentStep && (
            <div className="panel p-4">
              {currentCard.lineName && (
                <div className="text-xs text-accent-teal font-mono mb-2 uppercase tracking-wider">
                  {currentCard.lineName}
                </div>
              )}
              <p className="text-text-primary text-sm">
                Play the line from the start. Next move: <span className="font-semibold">{isWhiteToMove ? 'White' : 'Black'}</span>
              </p>
              <p className="text-text-muted text-xs mt-2">
                Step {lineStepIndex + 1} of {preparedLine.length}. No positions are skipped.
              </p>
              {!showSolution ? (
                <>
                  <p className="text-text-muted text-xs mt-2">Click or drag a piece to make the exact next move.</p>
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
                    Correct move: <span className="text-accent-teal font-mono">{correctMoveSan}</span>
                  </p>
                  <button
                    onClick={advanceAfterAnswer}
                    className="btn-primary mt-3 flex items-center gap-1.5 text-xs py-1.5 px-3"
                  >
                    Got it, Next Card <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          )}

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
                <p className="text-text-muted text-xs mt-1">
                  Correct: <span className="text-accent-teal font-mono">{correctMoveSan}</span>
                </p>
              </div>

              {isCorrect ? (
                <div className="text-center text-xs text-text-muted animate-pulse-subtle">Advancing…</div>
              ) : (
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
                    onClick={advanceAfterAnswer}
                    className="flex-1 btn-secondary flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-medium"
                  >
                    <SkipForward className="w-3.5 h-3.5" /> Next Card
                  </button>
                </div>
              )}
            </div>
          )}

          {phase === 'complete' && (
            <div className="flex flex-col items-center gap-4 py-8">
              <Trophy className="w-12 h-12 text-accent-amber" />
              <h3 className="text-text-primary text-lg font-semibold">Session Complete</h3>
              <div className="text-4xl font-bold text-accent-teal">
                {stats.correct + stats.incorrect > 0
                  ? Math.round((stats.correct / (stats.correct + stats.incorrect)) * 100)
                  : 0}%
              </div>
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
                    {Math.round((lifetimeStats.totalCorrect / lifetimeStats.totalReviewed) * 100)}%
                  </p>
                </div>
              )}
              <div className="flex items-center gap-3">
                {sessionHistory.length > 0 && (
                  <button
                    onClick={() => {
                      setReplayIndex(0);
                      setPhase('replay');
                    }}
                    className="btn-secondary flex items-center gap-1.5 px-4 py-2 text-sm font-medium"
                  >
                    <Play className="w-4 h-4" /> Replay
                  </button>
                )}
                <button onClick={() => rebuildSession(cards)} className="btn-primary px-4 py-2 text-sm font-medium">
                  New Session
                </button>
              </div>
            </div>
          )}

          {phase === 'replay' && sessionHistory[replayIndex] && (
            <div className="flex flex-col gap-4">
              <div className="flex items-center justify-between">
                <span className="text-xs text-text-muted font-mono">
                  Replay: {replayIndex + 1} / {sessionHistory.length}
                </span>
                <button onClick={() => setPhase('complete')} className="text-xs text-text-muted hover:text-text-primary transition-colors">
                  Back to Summary
                </button>
              </div>
              <div className={`panel p-4 ${sessionHistory[replayIndex].correct ? 'border-accent-teal/30 bg-accent-teal/5' : 'border-accent-red/30 bg-accent-red/5'}`}>
                <p className="text-text-muted text-xs mb-1">
                  {sessionHistory[replayIndex].reviewFen.split(' ')[1] === 'w' ? 'White' : 'Black'} to move
                </p>
                <p className="text-text-muted text-xs mt-1">
                  Correct: <span className="text-accent-teal font-mono">{uciToSan(sessionHistory[replayIndex].reviewFen, sessionHistory[replayIndex].expectedMove)}</span>
                </p>
                {sessionHistory[replayIndex].userMove && (
                  <p className="text-text-muted text-xs mt-1">
                    Your move: <span className="text-text-primary font-mono">{uciToSan(sessionHistory[replayIndex].reviewFen, sessionHistory[replayIndex].userMove!)}</span>
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setReplayIndex((prev) => Math.max(prev - 1, 0))}
                  disabled={replayIndex <= 0}
                  className="flex-1 btn-secondary flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <ChevronLeft className="w-3.5 h-3.5" /> Prev
                </button>
                <button
                  onClick={() => setReplayIndex((prev) => Math.min(prev + 1, sessionHistory.length - 1))}
                  disabled={replayIndex >= sessionHistory.length - 1}
                  className="flex-1 btn-secondary flex items-center justify-center gap-1 px-3 py-2 text-xs font-medium disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  Next <ChevronRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          )}

          <div className="mt-auto pt-4 flex flex-col gap-2">
            <button
              onClick={() => setRepertoireListOpen((prev) => !prev)}
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
                    {files.map((file) => (
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
              onClick={() => setImporterOpen((prev) => !prev)}
              className="btn-secondary flex items-center justify-between w-full px-3 py-2 text-xs"
            >
              <span>Add Cards Manually</span>
              {importerOpen ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
            </button>
            {importerOpen && (
              <div className="mt-1">
                <SRCardImporter onCardsChanged={() => rebuildSession()} />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
