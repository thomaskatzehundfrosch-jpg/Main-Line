import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chessboard } from 'react-chessboard';
import { Chess } from 'chess.js';
import type { Arrow, Piece, Square } from 'react-chessboard/dist/chessboard/types';
import {
  ArrowRight,
  Brain,
  ChevronLeft,
  ChevronRight,
  Eye,
  RotateCcw,
  SkipForward,
  Trophy,
} from 'lucide-react';
import { createCard, getDueCards, reviewCard } from '../lib/srScheduler';
import type { Card } from '../lib/srScheduler';
import { loadCards, loadStats, saveCards, saveSessionStats } from '../lib/srStorage';
import type { SRLifetimeStats } from '../lib/srStorage';
import { useFiles } from '../context/FileContext';
import type { RepertoireFile } from '../types/repertoireFile';
import { useEngine } from '../hooks/useEngine';
import EvalBar from './Board/EvalBar';

const INITIAL_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const sharedChess = new Chess();

type Phase = 'idle' | 'question' | 'grading' | 'complete' | 'replay';
type DrillColor = 'white' | 'black';

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

interface PromptStep {
  reviewFen: string;
  expectedMove: string;
}

interface TrainerSelection {
  fileId: string;
  color: DrillColor;
}

function cardKey(card: Pick<Card, 'front' | 'back'>): string {
  return `${card.front}|||${card.back}`;
}

function compareCards(a: Card, b: Card): number {
  if ((a.lineName ?? '') !== (b.lineName ?? '')) return (a.lineName ?? '').localeCompare(b.lineName ?? '');

  const aHistory = a.moveHistorySan ?? [];
  const bHistory = b.moveHistorySan ?? [];
  const sharedLength = Math.min(aHistory.length, bHistory.length);
  for (let i = 0; i < sharedLength; i += 1) {
    if (aHistory[i] !== bHistory[i]) return aHistory[i].localeCompare(bHistory[i]);
  }

  if (aHistory.length !== bHistory.length) return aHistory.length - bHistory.length;
  if (a.front !== b.front) return a.front.localeCompare(b.front);
  return a.back.localeCompare(b.back);
}

function isStrictPrefix(prefix: string[], full: string[]): boolean {
  if (prefix.length >= full.length) return false;
  for (let i = 0; i < prefix.length; i += 1) {
    if (prefix[i] !== full[i]) return false;
  }
  return true;
}

function collapseToDeepestLines(cards: Card[]): Card[] {
  return cards.filter((card, index) => {
    const cardHistory = card.moveHistorySan ?? [];
    const cardStartFen = card.lineStartFen ?? '';
    return !cards.some((other, otherIndex) => {
      if (index === otherIndex) return false;
      if ((other.lineStartFen ?? '') !== cardStartFen) return false;
      if ((other.lineName ?? '') !== (card.lineName ?? '')) return false;
      return isStrictPrefix(cardHistory, other.moveHistorySan ?? []);
    });
  });
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

function buildCardsForSelection(file: RepertoireFile, drillColor: DrillColor, existingCards: Card[]): Card[] {
  const existingByKey = new Map(existingCards.map((card) => [cardKey(card), card] as const));
  const result: Card[] = [];

  const walk = (node: RepertoireFile['tree'], parentFen: string | null, path: string[]) => {
    if (node.move !== '' && parentFen !== null) {
      const currentPath = [...path, node.move];
      const activeColor = parentFen.split(' ')[1];
      const isPlayerMove =
        (drillColor === 'white' && activeColor === 'w') ||
        (drillColor === 'black' && activeColor === 'b');

      if (isPlayerMove) {
        try {
          const chess = new Chess(parentFen);
          const move = chess.move(node.move);
          if (move) {
            const uci = move.from + move.to + (move.promotion || '');
            const key = `${parentFen}|||${uci}`;
            const existing = existingByKey.get(key);
            result.push(existing
              ? {
                  ...existing,
                  drillColor,
                  lineName: file.name,
                  moveHistorySan: existing.moveHistorySan ?? currentPath,
                  lineStartFen: existing.lineStartFen ?? file.tree.fen,
                }
              : createCard(parentFen, uci, file.name, drillColor, currentPath, file.tree.fen));
          }
        } catch {
          // Ignore invalid repertoire nodes while building a training deck.
        }
      }

      for (const child of node.children) walk(child, node.fen, currentPath);
      return;
    }

    for (const child of node.children) walk(child, node.fen, path);
  };

  walk(file.tree, null, []);
  result.sort(compareCards);
  return result;
}

function buildPromptSteps(card: Card, drillColor: DrillColor): PromptStep[] {
  if (!card.lineStartFen || !card.moveHistorySan || card.moveHistorySan.length === 0) {
    return [{ reviewFen: card.front, expectedMove: card.back }];
  }

  try {
    const chess = new Chess(card.lineStartFen);
    const prompts: PromptStep[] = [];

    for (const san of card.moveHistorySan) {
      const reviewFen = chess.fen();
      const mover = chess.turn();
      const move = chess.move(san);
      if (!move) return [{ reviewFen: card.front, expectedMove: card.back }];

      if ((drillColor === 'white' && mover === 'w') || (drillColor === 'black' && mover === 'b')) {
        prompts.push({
          reviewFen,
          expectedMove: move.from + move.to + (move.promotion || ''),
        });
      }
    }

    return prompts.length > 0 ? prompts : [{ reviewFen: card.front, expectedMove: card.back }];
  } catch {
    return [{ reviewFen: card.front, expectedMove: card.back }];
  }
}

function mergeCards(existingCards: Card[], cardsToMerge: Card[]): Card[] {
  const merged = new Map(existingCards.map((card) => [cardKey(card), card] as const));
  for (const card of cardsToMerge) merged.set(cardKey(card), card);
  return Array.from(merged.values());
}

export const SpacedRepetitionTrainer: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { files } = useFiles();
  const engine = useEngine();

  const [selection, setSelection] = useState<TrainerSelection | null>(null);
  const [selectedFileId, setSelectedFileId] = useState<string>('');
  const [selectedColor, setSelectedColor] = useState<DrillColor>('white');
  const [cards, setCards] = useState<Card[]>([]);
  const [sessionLines, setSessionLines] = useState<Card[]>([]);
  const [currentLineIndex, setCurrentLineIndex] = useState(0);
  const [currentPromptIndex, setCurrentPromptIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('idle');
  const [userMove, setUserMove] = useState<string | null>(null);
  const [cardHadMistake, setCardHadMistake] = useState(false);
  const [lineHadMistake, setLineHadMistake] = useState(false);
  const [showSolution, setShowSolution] = useState(false);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);
  const [boardOrientation, setBoardOrientation] = useState<'white' | 'black'>('white');
  const [stats, setStats] = useState<SessionStats>({ correct: 0, incorrect: 0 });
  const [lifetimeStats, setLifetimeStats] = useState<SRLifetimeStats>(loadStats);
  const [sessionHistory, setSessionHistory] = useState<SessionEntry[]>([]);
  const [replayIndex, setReplayIndex] = useState(0);

  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(400);
  const autoAdvanceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!selectedFileId && files.length > 0) setSelectedFileId(files[0].id);
  }, [files, selectedFileId]);

  useEffect(() => {
    const updateWidth = () => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const sidePanelWidth = viewportWidth >= 1024 ? 340 : 0;
      const containerWidth = boardContainerRef.current?.clientWidth ?? viewportWidth;
      const horizontalPadding = viewportWidth >= 1024 ? 96 : 16;
      const evalBarFootprint = 28;
      const verticalAllowance = viewportWidth >= 1024 ? 220 : 280;
      const availableWidth = viewportWidth >= 1024
        ? viewportWidth - sidePanelWidth - horizontalPadding
        : containerWidth - horizontalPadding - evalBarFootprint;
      const availableHeight = viewportHeight - verticalAllowance;
      const minBoardWidth = viewportWidth < 640 ? 280 : 360;
      setBoardWidth(Math.max(minBoardWidth, Math.min(availableWidth, availableHeight, 960)));
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, [selection]);

  const currentFile = useMemo(
    () => files.find((file) => file.id === selectedFileId) ?? null,
    [files, selectedFileId],
  );
  const currentCard = sessionLines[currentLineIndex] ?? null;
  const promptSteps = useMemo(
    () => (currentCard && selection ? buildPromptSteps(currentCard, selection.color) : []),
    [currentCard, selection],
  );
  const currentPrompt = promptSteps[currentPromptIndex] ?? null;
  const displayFen = phase === 'replay'
    ? (sessionHistory[replayIndex]?.reviewFen ?? INITIAL_FEN)
    : (currentPrompt?.reviewFen ?? currentCard?.front ?? INITIAL_FEN);
  const expectedMove = currentPrompt?.expectedMove ?? currentCard?.back ?? '';
  const isWhiteToMove = displayFen.split(' ')[1] === 'w';
  const correctMoveSan = expectedMove ? uciToSan(displayFen, expectedMove) : '';
  const userMoveSan = userMove ? uciToSan(displayFen, userMove) : '';
  const isCorrect = !cardHadMistake && userMove !== null && userMove === expectedMove;

  const startTraining = useCallback((nextSelection: TrainerSelection) => {
    const file = files.find((candidate) => candidate.id === nextSelection.fileId);
    if (!file) return;

    const storedCards = loadCards();
    const cardsForSelection = buildCardsForSelection(file, nextSelection.color, storedCards);
    const linesForSession = collapseToDeepestLines(cardsForSelection);
    const mergedCards = mergeCards(storedCards, cardsForSelection);
    saveCards(mergedCards);

    setSelection(nextSelection);
    setCards(cardsForSelection);
    setSessionLines(linesForSession);
    setCurrentLineIndex(0);
    setCurrentPromptIndex(0);
    setUserMove(null);
    setCardHadMistake(false);
    setLineHadMistake(false);
    setShowSolution(false);
    setSelectedSquare(null);
    setLegalMoves([]);
    setSessionHistory([]);
    setReplayIndex(0);
    setStats({ correct: 0, incorrect: 0 });
    setBoardOrientation(nextSelection.color);
    setPhase(linesForSession.length > 0 ? 'question' : 'idle');
  }, [files]);

  const leaveSession = useCallback(() => {
    setSelection(null);
    setCards([]);
    setSessionLines([]);
    setCurrentLineIndex(0);
    setCurrentPromptIndex(0);
    setUserMove(null);
    setCardHadMistake(false);
    setLineHadMistake(false);
    setShowSolution(false);
    setSelectedSquare(null);
    setLegalMoves([]);
    setSessionHistory([]);
    setReplayIndex(0);
    setStats({ correct: 0, incorrect: 0 });
    setPhase('idle');
    setBoardOrientation('white');
  }, []);

  useEffect(() => {
    setSelectedSquare(null);
    setLegalMoves([]);
    setShowSolution(false);
  }, [currentLineIndex, currentPromptIndex, phase]);

  useEffect(() => {
    if (engine.enabled && phase !== 'replay' && currentCard) engine.analyze(displayFen);
  }, [currentCard, displayFen, engine.enabled, phase]);

  useEffect(() => {
    if (phase !== 'grading' || !isCorrect) return;
    autoAdvanceRef.current = setTimeout(() => {
      advanceAfterAnswer();
    }, 180);

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

    const promptCorrect = !cardHadMistake && userMove !== null && userMove === expectedMove;

    setSessionHistory((prev) => [...prev, {
      card: currentCard,
      reviewFen: displayFen,
      expectedMove,
      userMove,
      correct: promptCorrect,
    }]);

    const nextPromptIndex = currentPromptIndex + 1;
    if (nextPromptIndex < promptSteps.length) {
      setCurrentPromptIndex(nextPromptIndex);
      setUserMove(null);
      setCardHadMistake(false);
      setBoardOrientation(selection?.color ?? 'white');
      setPhase('question');
      return;
    }

    const lineCorrect = !lineHadMistake && promptCorrect;
    const updatedCard = reviewCard(currentCard, lineCorrect ? 2 : 0);
    const updatedCards = cards.map((card) => (cardKey(card) === cardKey(updatedCard) ? updatedCard : card));
    setCards(updatedCards);
    saveCards(mergeCards(loadCards(), [updatedCard]));

    const nextStats = {
      correct: stats.correct + (lineCorrect ? 1 : 0),
      incorrect: stats.incorrect + (lineCorrect ? 0 : 1),
    };
    setStats(nextStats);

    const nextLineIndex = currentLineIndex + 1;
    if (nextLineIndex >= sessionLines.length) {
      setLifetimeStats(saveSessionStats(nextStats.correct, nextStats.incorrect));
      setPhase('complete');
      return;
    }

    setCurrentLineIndex(nextLineIndex);
    setCurrentPromptIndex(0);
    setUserMove(null);
    setCardHadMistake(false);
    setLineHadMistake(false);
    setBoardOrientation(selection?.color ?? 'white');
    setPhase('question');
  }, [cardHadMistake, cards, currentCard, currentLineIndex, currentPromptIndex, displayFen, expectedMove, lineHadMistake, promptSteps.length, selection?.color, sessionLines.length, stats, userMove]);

  const submitMove = useCallback((from: string, to: string, piece?: string) => {
    if ((phase !== 'question' && phase !== 'grading') || !currentCard) return false;

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
        setUserMove((prev) => prev ?? uci);
        setCardHadMistake(true);
        setLineHadMistake(true);
        setPhase('grading');
        return true;
      }

      if (cardHadMistake) {
        advanceAfterAnswer();
        return true;
      }

      setUserMove(uci);
      setPhase('grading');
      return true;
    } catch {
      return false;
    }
  }, [advanceAfterAnswer, cardHadMistake, currentCard, displayFen, expectedMove, phase, showSolution]);

  const handlePieceDrop = useCallback((source: Square, target: Square, piece: Piece) => {
    setSelectedSquare(null);
    setLegalMoves([]);
    return submitMove(source, target, piece);
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
        setLegalMoves(getLegalMoves(square));
      }
      return;
    }

    setSelectedSquare(null);
    setLegalMoves([]);
  }, [currentCard, getLegalMoves, isOwnPiece, legalMoves, phase, selectedSquare, submitMove]);

  const progressPercent = sessionLines.length > 0
    ? ((currentLineIndex + (phase === 'complete' ? 1 : 0)) / sessionLines.length) * 100
    : 0;

  if (!selection) {
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
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-4 sm:p-6">
          <div className="mx-auto w-full max-w-2xl panel p-4 sm:p-6">
            <h3 className="text-text-primary text-lg font-semibold">Start New Training Session</h3>
            <p className="text-text-muted text-sm mt-2">
              Pick one repertoire and one side. This session will only train that selection until you go back.
            </p>

            <div className="mt-5 grid gap-5 sm:mt-6 sm:gap-6">
              <div>
                <div className="text-xs uppercase tracking-wide text-text-muted mb-2">Repertoire</div>
                {files.length === 0 ? (
                  <div className="panel p-4 text-sm text-text-muted">
                    No saved repertoires yet. Save a repertoire from the main view first.
                  </div>
                ) : (
                  <div className="grid gap-2 max-h-[40vh] overflow-y-auto pr-1 sm:max-h-none sm:overflow-visible sm:pr-0">
                    {files.map((file) => (
                      <button
                        key={file.id}
                        onClick={() => setSelectedFileId(file.id)}
                        className={`w-full text-left rounded-lg border px-4 py-3 transition-colors ${
                          selectedFileId === file.id
                            ? 'border-accent-teal bg-accent-teal/5'
                            : 'border-border-subtle bg-bg-panel hover:border-border-active'
                        }`}
                      >
                        <div className="text-sm font-medium text-text-primary">{file.name}</div>
                        <div className="text-xs text-text-muted mt-1">
                          {file.nodeCount} position{file.nodeCount !== 1 ? 's' : ''}
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <div className="text-xs uppercase tracking-wide text-text-muted mb-2">Color</div>
                <div className="flex gap-2">
                  {(['white', 'black'] as DrillColor[]).map((color) => (
                    <button
                      key={color}
                      onClick={() => setSelectedColor(color)}
                      className={`flex-1 rounded-lg border px-4 py-3 text-sm font-medium transition-colors ${
                        selectedColor === color
                          ? 'border-accent-teal bg-accent-teal/5 text-text-primary'
                          : 'border-border-subtle bg-bg-panel text-text-muted hover:text-text-primary'
                      }`}
                    >
                      {color === 'white' ? 'White' : 'Black'}
                    </button>
                  ))}
                </div>
              </div>

              <div className="sticky bottom-0 -mx-4 mt-1 border-t border-border-subtle bg-bg-primary/95 px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] backdrop-blur sm:static sm:mx-0 sm:mt-0 sm:border-t-0 sm:bg-transparent sm:px-0 sm:pt-0 sm:pb-0 sm:backdrop-blur-none">
                <button
                  onClick={() => currentFile && startTraining({ fileId: currentFile.id, color: selectedColor })}
                  disabled={!currentFile}
                  className="btn-primary flex w-full items-center justify-center gap-2 px-4 py-3 sm:w-auto sm:justify-start sm:py-2 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  Start Training <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col bg-bg-primary min-h-0">
      <div className="flex items-center justify-between px-4 py-3 bg-bg-surface border-b border-border-subtle flex-shrink-0">
        <div className="flex items-center gap-3">
          <button onClick={leaveSession} className="btn-icon p-1.5" title="Choose another repertoire">
            <ChevronLeft className="w-4 h-4" />
          </button>
          {onClose && (
            <button onClick={onClose} className="text-xs text-text-muted hover:text-text-primary transition-colors">
              Close
            </button>
          )}
          <Brain className="w-4 h-4 text-accent-teal" />
          <h2 className="font-mono text-sm uppercase tracking-wider text-text-secondary">
            {currentFile?.name ?? 'Spaced Repetition Trainer'}
          </h2>
        </div>
        <div className="flex items-center gap-3 text-xs text-text-muted">
          <span>{selection.color === 'white' ? 'White' : 'Black'} repertoire</span>
          <span className="text-border-subtle">|</span>
          <span>{cards.length} cards</span>
          <span className="text-border-subtle">|</span>
          <span>{getDueCards(cards, cards.length || 20).length} due</span>
        </div>
      </div>

      <div className="flex-1 flex flex-col lg:flex-row min-h-0 overflow-auto">
        <div
          ref={boardContainerRef}
          className="w-full flex flex-col items-center px-2 py-2 sm:px-3 lg:flex-[2.8] lg:basis-0 lg:min-w-[820px] xl:min-w-[980px] 2xl:min-w-[1120px]"
        >
          <div className="mx-auto flex w-fit max-w-full items-start justify-center">
            <div className="mr-1">
              <EvalBar
                score={engine.lines.length > 0 ? engine.lines[0].score : 0}
                mate={engine.lines.length > 0 ? engine.lines[0].mate : null}
                height={boardWidth}
              />
            </div>
            <div className="shrink-0">
              <Chessboard
                position={displayFen}
                boardWidth={boardWidth}
                boardOrientation={boardOrientation}
                onPieceDrop={handlePieceDrop}
                onSquareClick={handleSquareClick}
                onPieceClick={(_piece, square) => handleSquareClick(square)}
                isDraggablePiece={() => phase === 'question' || (phase === 'grading' && (!isCorrect || showSolution))}
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

        <div className="lg:w-[280px] lg:min-w-[260px] xl:w-[300px] flex flex-col p-4 gap-4 lg:border-l lg:border-border-subtle overflow-auto">
          {sessionLines.length > 0 && phase !== 'idle' && phase !== 'complete' && phase !== 'replay' && (
            <div>
              <div className="flex justify-between text-xs text-text-muted mb-1.5">
                <span>Line Progress</span>
                <span>{Math.min(currentLineIndex + 1, sessionLines.length)} / {sessionLines.length}</span>
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
                This repertoire has no trainable cards yet.
              </p>
              <button onClick={leaveSession} className="btn-secondary px-4 py-2 text-sm">
                Choose Another Repertoire
              </button>
            </div>
          )}

          {phase === 'question' && currentCard && (
            <div className="panel p-4">
              <div className="text-xs text-accent-teal font-mono mb-2 uppercase tracking-wider">
                {currentFile?.name}
              </div>
              <p className="text-text-primary text-sm">
                Find the repertoire move for <span className="font-semibold">{isWhiteToMove ? 'White' : 'Black'}</span>.
              </p>
              <p className="text-text-muted text-xs mt-2">
                Play the exact stored move from this position.
              </p>
              {promptSteps.length > 1 && (
                <p className="text-text-muted text-xs mt-2">
                  Move {currentPromptIndex + 1} of {promptSteps.length} in this line.
                </p>
              )}
              {!showSolution ? (
                <>
                  <p className="text-text-muted text-xs mt-2">Click or drag a piece to make the move.</p>
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
                <div className="flex flex-col gap-2">
                  <p className="text-text-muted text-xs">
                    Play the correct move on the board to continue. This card will still count as incorrect.
                  </p>
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
                    Replay
                  </button>
                )}
                <button
                  onClick={() => startTraining(selection)}
                  className="btn-primary px-4 py-2 text-sm font-medium"
                >
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
                    Your move: <span className="text-text-primary font-mono">{uciToSan(sessionHistory[replayIndex].reviewFen, sessionHistory[replayIndex].userMove)}</span>
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
        </div>
      </div>
    </div>
  );
};
