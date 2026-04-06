import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { Chess } from 'chess.js';
import { Loader, StopCircle, Cpu, ChevronUp, ChevronDown, Plus, Settings2 } from 'lucide-react';
import { TopBar } from './TopBar';
import { StatusBar } from './StatusBar';
import ChessBoard from './Board/ChessBoard';
import BoardControls from './Board/BoardControls';
import { OpeningTree } from './Tree/OpeningTree';
import { MoveList } from './Sidebar/MoveList';
import { EnginePanel } from './Sidebar/EnginePanel';
import { NotesPanel } from './Sidebar/NotesPanel';
import { GameImportPanel } from './GameImportPanel';
import { MistakePanel } from './MistakePanel';
import { ErrorBoundary } from './ErrorBoundary';
import { RepertoireFilesPanel } from './RepertoireFilesPanel';
import { ImportModal } from './Modals/ImportModal';
import { ExportModal } from './Modals/ExportModal';
import { SettingsModal } from './Modals/SettingsModal';
import type { SettingsTab } from './Modals/SettingsModal';
import { useRepertoireTree } from '../hooks/useRepertoireTree';
import { useEngine } from '../hooks/useEngine';
import { usePgnParser } from '../hooks/usePgnParser';
import { useGames } from '../context/GameContext';
import { useFiles } from '../context/FileContext';
import { useRepertoireEval } from '../context/RepertoireEvalContext';
import { getOpeningForPath } from '../utils/openingNames';
import { exportTreeToPgn, copyToClipboard, downloadAsFile } from '../utils/pgnExporter';
import { cloneTree, countNodes } from '../utils/treeBuilder';
import { findNodeById } from '../utils/treeBuilder';
import type { TreeNode } from '../types';
import type { ImportedGame } from '../types/game';
import { toFigurine } from '../utils/figurineNotation';
import { ErrorToast } from './ErrorToast';
import { ErrorLogPanel } from './ErrorLogPanel';
import { analyzeRepertoire } from '../engine/repertoireAnalyzer';
import { MISTAKE_THRESHOLDS } from '../types/game';
import type { MistakeTier } from '../types/game';
import type { NodeAnnotation } from '../context/RepertoireEvalContext';
import type { RepertoireEval } from '../types';
import { GameFetcherPage } from './GameFetcher/GameFetcherPage';
import { GeneratorPage } from './Generator/GeneratorPage';
import { SpacedRepetitionTrainer } from './SpacedRepetitionTrainer';
import { PerformanceReportPage } from './PerformanceReportPage';
import { handleOAuthCallback } from '../utils/lichessAuth';
import { getStoredToken } from '../utils/lichessAuth';
import { useIsMobile } from '../hooks/useIsMobile';
import { useGenerator } from '../hooks/useGenerator';
import { useSettings, type PracticalMoveRating } from '../context/SettingsContext';
import { getMostLikelyMove, getMostPlayedMoves, type LichessMove } from '../utils/lichessApi';
import { logger } from '../utils/errorLogger';

type SidebarTab = 'analysis' | 'games';
type MobileTab = 'tree' | 'analysis' | 'games';

interface MostLikelyMoveState {
  fen: string;
  move: LichessMove | null;
  error: string | null;
}

interface GapSuggestion extends LichessMove {
  severity: 'high' | 'medium';
}

interface TrickyMoveSuggestion {
  move: LichessMove;
  score: number;
  soundness: number;
  opponentSpread: number;
  topReply: LichessMove | null;
}

export const App: React.FC = () => {
  const {
    tree,
    currentNode,
    currentPath,
    orientation,
    selectedColor,
    currentMoveNumber,
    isWhiteToMove,
    setTree,
    navigateToNode,
    navigateForward,
    navigateBack,
    navigateToStart,
    navigateToEnd,
    flipBoard,
    setComment,
    addNag,
    removeNag,
    addMove,
    addMoveToNode,
    addLineToNode,
    deleteNode,
  } = useRepertoireTree();

  const engine = useEngine();
  const pgnParser = usePgnParser();
  const games = useGames();
  const { files, activeFileId, getActiveFile, updateFileGames, setActive } = useFiles();
  const repertoireEval = useRepertoireEval();
  const generator = useGenerator();
  const { settings, updateSetting } = useSettings();

  // ─── Folder ↔ Games bidirectional sync ────────────────────────────────
  // When the active folder changes, load that folder's games into GameContext.
  // A ref guards against writing the just-loaded games back to the file.
  const loadingGamesFromFileRef = useRef(false);

  useEffect(() => {
    loadingGamesFromFileRef.current = true;
    const activeFile = getActiveFile();
    games.setGames(activeFile?.importedGames ?? []);
    // Reset the guard after effects have had a chance to fire
    const t = setTimeout(() => { loadingGamesFromFileRef.current = false; }, 0);
    return () => clearTimeout(t);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFileId]);

  useEffect(() => {
    if (!activeFileId || loadingGamesFromFileRef.current) return;
    updateFileGames(activeFileId, games.importedGames);
  }, [activeFileId, games.importedGames, updateFileGames]);

  // ──────────────────────────────────────────────────────────────────────

  // Ref so async analysis loop always sees the latest cancellation state
  const evalCancelledRef = useRef(false);
  // Tracks the cycling index per annotation tier for badge navigation
  const annotationNavIndexRef = useRef<Record<string, number>>({});

  const isMobile = useIsMobile();
  const [mobileTab, setMobileTab] = useState<MobileTab>('tree');
  const [boardMinimized, setBoardMinimized] = useState(false);
  const [boardExpanded, setBoardExpanded] = useState(false);

  const [filesOpen, setFilesOpen] = useState(() => !isMobile);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [exportModalOpen, setExportModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('board');
  const [gameFetcherOpen, setGameFetcherOpen] = useState(false);
  const [performanceReportOpen, setPerformanceReportOpen] = useState(false);
  const [generatorOpen, setGeneratorOpen] = useState(false);
  const [trainerOpen, setTrainerOpen] = useState(false);
  const [exportOptions, setExportOptions] = useState({
    includeAnnotations: true,
    filterColor: 'both' as 'white' | 'black' | 'both',
  });
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('analysis');
  const [repertoireDepth, setRepertoireDepth] = useState(18);
  const [thresholds, setThresholds] = useState({
    inaccuracy: MISTAKE_THRESHOLDS.inaccuracy,
    mistake:    MISTAKE_THRESHOLDS.mistake,
    blunder:    MISTAKE_THRESHOLDS.blunder,
  });
  const [moveListExpanded, setMoveListExpanded] = useState(false);
  const [notesExpanded, setNotesExpanded] = useState(false);
  const [mostLikelyMoveState, setMostLikelyMoveState] = useState<MostLikelyMoveState | null>(null);
  const [isFetchingMostLikelyMove, setIsFetchingMostLikelyMove] = useState(false);
  const [showMostLikelyMoveSettings, setShowMostLikelyMoveSettings] = useState(false);
  const [treeExploreMode, setTreeExploreMode] = useState(false);
  const [gapSuggestions, setGapSuggestions] = useState<GapSuggestion[]>([]);
  const [trickyMoveSuggestion, setTrickyMoveSuggestion] = useState<TrickyMoveSuggestion | null>(null);
  const [recommendationError, setRecommendationError] = useState<string | null>(null);
  const [isLoadingRecommendations, setIsLoadingRecommendations] = useState(false);
  const [activeSignal, setActiveSignal] = useState<'tricky' | 'gaps' | null>(null);

  const classifyWithThresholds = useCallback(
    (evalDrop: number): MistakeTier | null => {
      if (evalDrop >= thresholds.blunder)    return 'blunder';
      if (evalDrop >= thresholds.mistake)    return 'mistake';
      if (evalDrop >= thresholds.inaccuracy) return 'inaccuracy';
      return null;
    },
    [thresholds]
  );

  // ─── Game Viewer State ───────────────────────────────────────────────
  const [viewingGame, setViewingGame] = useState<ImportedGame | null>(null);
  const [viewingMoveIndex, setViewingMoveIndex] = useState(0);

  useEffect(() => {
    if (isMobile) setFilesOpen(false);
  }, [isMobile]);

  // ─── Explore overlay FEN ─────────────────────────────────────────────
  // Set when clicking a greyed-out overlay node in explore mode.
  // Cleared automatically whenever currentNode changes (real navigation).
  const [exploreOverlayFen, setExploreOverlayFen] = useState<string | null>(null);
  useEffect(() => { setExploreOverlayFen(null); }, [currentNode]);
  useEffect(() => {
    if (!treeExploreMode) setExploreOverlayFen(null);
  }, [treeExploreMode]);

  /**
   * Compute all FENs for a game's moves so we can step through them.
   * Index 0 = starting position, index N = position after Nth move.
   */
  const gamePositions = useMemo(() => {
    if (!viewingGame) return [];
    const chess = new Chess();
    const fens: string[] = [chess.fen()];
    for (const san of viewingGame.moves) {
      try {
        chess.move(san);
        fens.push(chess.fen());
      } catch {
        break;
      }
    }
    return fens;
  }, [viewingGame]);

  const viewingFen = viewingGame && gamePositions.length > 0
    ? gamePositions[Math.min(viewingMoveIndex, gamePositions.length - 1)]
    : null;

  useEffect(() => {
    setMostLikelyMoveState(null);
    setIsFetchingMostLikelyMove(false);
    setShowMostLikelyMoveSettings(false);
    setGapSuggestions([]);
    setTrickyMoveSuggestion(null);
    setRecommendationError(null);
    setIsLoadingRecommendations(false);
    setActiveSignal(null);
  }, [currentNode.fen]);

  const handleViewGame = useCallback((game: ImportedGame) => {
    if (viewingGame?.id === game.id) {
      // Toggle off if same game
      setViewingGame(null);
      setViewingMoveIndex(0);
    } else {
      setViewingGame(game);
      setViewingMoveIndex(0);
      setSidebarTab('games');
    }
  }, [viewingGame]);

  const handleCloseGameViewer = useCallback(() => {
    setViewingGame(null);
    setViewingMoveIndex(0);
  }, []);

  const gameViewerForward = useCallback(() => {
    if (viewingGame) {
      setViewingMoveIndex((i) => Math.min(i + 1, gamePositions.length - 1));
    }
  }, [viewingGame, gamePositions.length]);

  const gameViewerBack = useCallback(() => {
    if (viewingGame) {
      setViewingMoveIndex((i) => Math.max(i - 1, 0));
    }
  }, [viewingGame]);

  const gameViewerStart = useCallback(() => {
    setViewingMoveIndex(0);
  }, []);

  const gameViewerEnd = useCallback(() => {
    if (viewingGame) {
      setViewingMoveIndex(gamePositions.length - 1);
    }
  }, [viewingGame, gamePositions.length]);

  // The FEN to display on the board - game viewer > explore overlay > current node
  const displayFen = viewingFen || exploreOverlayFen || currentNode.fen;

  // Analyze position when current node or game viewer position changes
  useEffect(() => {
    if (engine.enabled && displayFen) {
      engine.analyze(displayFen);
    }
  }, [displayFen, engine.enabled]);

  // Get opening info for current path
  const openingInfo = getOpeningForPath(currentPath.map((n) => n.fen));

  // Handle piece drop on board
  const handleBoardMove = useCallback(
    (from: string, to: string, piece: string): boolean => {
      try {
        const sourceFen = exploreOverlayFen || currentNode.fen;
        const chess = new Chess(sourceFen);
        const promotion = piece[1] === 'P' && (to[1] === '8' || to[1] === '1') ? 'q' : undefined;
        const move = chess.move({ from, to, promotion });
        if (!move) return false;

        if (treeExploreMode || exploreOverlayFen) {
          setExploreOverlayFen(chess.fen());
          return true;
        }

        // Check if this move exists as a real child of current node
        // (skip any overlay nodes that may have leaked from D3 visualization)
        const existingChild = currentNode.children.find(
          (c) => c.move === move.san && !(c as any)._isOverlay
        );
        if (existingChild) {
          navigateToNode(existingChild);
        } else {
          // Add as new variation
          addMove(move.san, chess.fen());
        }
        return true;
      } catch {
        return false;
      }
    },
    [currentNode, exploreOverlayFen, treeExploreMode, navigateToNode, addMove]
  );

  const addSanMoveFromFen = useCallback((san: string) => {
    try {
      const chess = new Chess(currentNode.fen);
      const move = chess.move(san);
      if (!move) return false;
      addMoveToNode(currentNode.id, move.san, chess.fen());
      return true;
    } catch {
      return false;
    }
  }, [addMoveToNode, currentNode.fen, currentNode.id]);

  const buildLineFromFen = useCallback((startFen: string, sans: string[]) => {
    const chess = new Chess(startFen);
    const moves: { move: string; fen: string }[] = [];

    for (const san of sans) {
      const move = chess.move(san);
      if (!move) return null;
      moves.push({ move: move.san, fen: chess.fen() });
    }

    return moves;
  }, []);

  const addLineFromCurrentFen = useCallback((sans: string[]) => {
    const line = buildLineFromFen(currentNode.fen, sans);
    if (!line || line.length === 0) return false;
    addLineToNode(currentNode.id, line);
    return true;
  }, [addLineToNode, buildLineFromFen, currentNode.fen, currentNode.id]);

  const currentSideToMove = currentNode.fen.split(' ')[1] === 'w' ? 'white' : 'black';
  const ourRepertoireColor = settings.defaultColor;
  const isOurTurnInCurrentPosition = currentSideToMove === ourRepertoireColor;

  const handleLoadGaps = useCallback(async () => {
    setIsLoadingRecommendations(true);
    setActiveSignal('gaps');
    setRecommendationError(null);
    setGapSuggestions([]);

    try {
      const playedMoves = await getMostPlayedMoves(
        currentNode.fen,
        {
          color: currentSideToMove,
          useMasters: false,
          ratingMin: settings.mostLikelyMoveRating,
          ratingMax: settings.mostLikelyMoveRating,
          speeds: ['blitz', 'rapid', 'classical'],
        } as any,
        (level, message) => {
          if (level === 'error') logger.error('general', message);
          else if (level === 'warning') logger.warn('general', message);
          else logger.info('general', message);
        },
        5
      );

      const existingMoves = new Set(
        currentNode.children
          .filter((child) => !(child as any)._isOverlay)
          .map((child) => child.move)
      );
      const gaps = playedMoves
        .filter((move) => !existingMoves.has(move.san))
        .filter((move) => move.playRate >= 8 || move.totalGames >= 2000)
        .slice(0, 3)
        .map((move) => ({
          ...move,
          severity: move.playRate >= 15 || move.totalGames >= 10000 ? 'high' as const : 'medium' as const,
        }));

      setGapSuggestions(gaps);
    } catch (error) {
      setRecommendationError(error instanceof Error ? error.message : 'Failed to load recommendations.');
    } finally {
      setIsLoadingRecommendations(false);
    }
  }, [
    currentNode.children,
    currentNode.fen,
    settings.mostLikelyMoveRating,
    currentSideToMove,
  ]);

  const handleLoadTrickyMove = useCallback(async () => {
    setIsLoadingRecommendations(true);
    setActiveSignal('tricky');
    setRecommendationError(null);
    setTrickyMoveSuggestion(null);

    try {
      const engineCandidates = engine.lines
        .filter((line) => line.pv.length > 0)
        .slice(0, 3);

      if (engineCandidates.length === 0) return;

      const suggestions: Array<TrickyMoveSuggestion | null> = await Promise.all(
        engineCandidates.map(async (line) => {
          const candidateSan = line.pv[0];
          const candidateLine = buildLineFromFen(currentNode.fen, [candidateSan]);
          if (!candidateLine || candidateLine.length === 0) return null;

          const opponentFen = candidateLine[0].fen;
          const opponentColor = opponentFen.split(' ')[1] === 'w' ? 'white' : 'black';
          const replies = await getMostPlayedMoves(
            opponentFen,
            {
              color: opponentColor,
              useMasters: false,
              ratingMin: settings.mostLikelyMoveRating,
              ratingMax: settings.mostLikelyMoveRating,
              speeds: ['blitz', 'rapid', 'classical'],
            } as any,
            (level, message) => {
              if (level === 'error') logger.error('general', message);
              else if (level === 'warning') logger.warn('general', message);
              else logger.info('general', message);
            },
            3
          );

          if (replies.length === 0) return null;

          const topReply = replies[0];
          const opponentSpread = Math.max(0, 100 - topReply.playRate);
          const soundness = Math.max(0, Math.min(100, 50 + line.score / 20));
          const score = opponentSpread * 0.6 + soundness * 0.4;

          const suggestion: TrickyMoveSuggestion = {
            move: {
              san: candidateSan,
              uci: line.pvUci[0],
              totalGames: 0,
              playRate: 0,
              winRate: 0,
              lossRate: 0,
              drawRate: 0,
              averageRating: null,
            },
            score,
            soundness,
            opponentSpread,
            topReply,
          };

          return suggestion;
        })
      );

      const best = suggestions
        .filter((item): item is TrickyMoveSuggestion => item !== null)
        .sort((a, b) => b.score - a.score)[0] ?? null;

      setTrickyMoveSuggestion(best);
    } catch (error) {
      setRecommendationError(error instanceof Error ? error.message : 'Failed to load recommendations.');
    } finally {
      setIsLoadingRecommendations(false);
    }
  }, [
    buildLineFromFen,
    currentNode.fen,
    engine.lines,
    settings.mostLikelyMoveRating,
  ]);

  const engineBestMoveSan = engine.lines[0]?.pv?.[0] ?? null;
  const lichessMostLikelyMove = mostLikelyMoveState?.fen === currentNode.fen
    ? mostLikelyMoveState.move
    : null;
  const engineAndLichessAgree = !!engineBestMoveSan && !!lichessMostLikelyMove && engineBestMoveSan === lichessMostLikelyMove.san;

  const handleFetchMostLikelyMove = useCallback(async () => {
    if (!getStoredToken()) {
      setMostLikelyMoveState({
        fen: currentNode.fen,
        move: null,
        error: 'Connect your Lichess account to use Most Likely Move.',
      });
      return;
    }

    setIsFetchingMostLikelyMove(true);
    setMostLikelyMoveState({
      fen: currentNode.fen,
      move: null,
      error: null,
    });

    try {
      const move = await getMostLikelyMove(
        currentNode.fen,
        {
          color: currentNode.fen.split(' ')[1] === 'w' ? 'white' : 'black',
          useMasters: false,
          ratingMin: settings.mostLikelyMoveRating,
          ratingMax: settings.mostLikelyMoveRating,
          speeds: ['blitz', 'rapid', 'classical'],
        },
        (level, message) => {
          if (level === 'error') logger.error('general', message);
          else if (level === 'warning') logger.warn('general', message);
          else logger.info('general', message);
        }
      );

      setMostLikelyMoveState({
        fen: currentNode.fen,
        move,
        error: move ? null : `No Lichess move data found for ${settings.mostLikelyMoveRating}+ in this position.`,
      });
    } catch (error) {
      setMostLikelyMoveState({
        fen: currentNode.fen,
        move: null,
        error: error instanceof Error ? error.message : 'Failed to fetch Lichess move data.',
      });
    } finally {
      setIsFetchingMostLikelyMove(false);
    }
  }, [currentNode.fen, settings.mostLikelyMoveRating]);

  const openLichessSettings = useCallback(() => {
    setSettingsInitialTab('lichess');
    setSettingsOpen(true);
  }, []);

  const handleAddMostLikelyMove = useCallback(() => {
    if (!lichessMostLikelyMove) return;
    addSanMoveFromFen(lichessMostLikelyMove.san);
  }, [addSanMoveFromFen, lichessMostLikelyMove]);

  const handleAddGapMove = useCallback((move: GapSuggestion) => {
    addSanMoveFromFen(move.san);
  }, [addSanMoveFromFen]);

  const handleAddGapLine = useCallback(async (move: GapSuggestion) => {
    const starter = buildLineFromFen(currentNode.fen, [move.san]);
    if (!starter || starter.length === 0) return;

    try {
      const responseFen = starter[0].fen;
      const nextColor = responseFen.split(' ')[1] === 'w' ? 'white' : 'black';
      const reply = await getMostLikelyMove(
        responseFen,
        {
          color: nextColor,
          useMasters: false,
          ratingMin: settings.mostLikelyMoveRating,
          ratingMax: settings.mostLikelyMoveRating,
          speeds: ['blitz', 'rapid', 'classical'],
        },
        (level, message) => {
          if (level === 'error') logger.error('general', message);
          else if (level === 'warning') logger.warn('general', message);
          else logger.info('general', message);
        }
      );

      const sans = reply ? [move.san, reply.san] : [move.san];
      addLineFromCurrentFen(sans);
    } catch {
      addLineFromCurrentFen([move.san]);
    }
  }, [addLineFromCurrentFen, buildLineFromFen, currentNode.fen, settings.mostLikelyMoveRating]);

  const handleAddTrickyLine = useCallback(() => {
    if (!trickyMoveSuggestion) return;
    const sans = [trickyMoveSuggestion.move.san];
    if (trickyMoveSuggestion.topReply) sans.push(trickyMoveSuggestion.topReply.san);
    addLineFromCurrentFen(sans);
  }, [addLineFromCurrentFen, trickyMoveSuggestion]);

  const mostLikelyMovePanel = mostLikelyMoveState?.fen === currentNode.fen ? (
    <div className="border-t border-border-subtle bg-bg-primary px-3 py-2">
      {mostLikelyMoveState.error ? (
        <div className="mt-2 space-y-2">
          <div className="text-xs text-accent-red">{mostLikelyMoveState.error}</div>
          {mostLikelyMoveState.error.includes('Connect your Lichess account') && (
            <button
              onClick={openLichessSettings}
              className="btn-secondary px-2 py-1 text-[10px]"
            >
              Open Lichess settings
            </button>
          )}
        </div>
      ) : lichessMostLikelyMove ? (
        <>
          <div className="mt-2">
            <div className="rounded border border-accent-teal/30 bg-accent-teal/5 px-2 py-2">
              <div className="text-[10px] font-mono uppercase tracking-wider text-text-muted">Lichess</div>
              <div className="mt-1 flex flex-wrap items-start justify-between gap-2">
                <span className="min-w-0 flex-1 break-words text-sm font-semibold text-accent-teal">
                  {lichessMostLikelyMove.san}
                </span>
                <button
                  onClick={handleAddMostLikelyMove}
                  className="btn-primary flex shrink-0 items-center gap-1 self-start px-2 py-1 text-[10px]"
                  title="Add most likely move to this node"
                >
                  <Plus className="w-3 h-3" />
                  Add
                </button>
              </div>
              <div className="mt-1 text-[11px] text-text-secondary">
                {lichessMostLikelyMove.playRate.toFixed(1)}% of {lichessMostLikelyMove.totalGames.toLocaleString()} games
              </div>
              <div className="mt-0.5 text-[10px] text-text-muted">
                W {lichessMostLikelyMove.winRate.toFixed(0)}% · D {lichessMostLikelyMove.drawRate.toFixed(0)}% · L {lichessMostLikelyMove.lossRate.toFixed(0)}%
              </div>
            </div>
          </div>
        </>
      ) : (
        <div className="mt-2 text-xs text-text-muted">No move data loaded yet.</div>
      )}
    </div>
  ) : null;

  const mostLikelyMoveSection = (
    <div className="flex flex-col border-t border-border-subtle">
      <div className="px-3 py-2">
        <div className="flex items-center gap-2">
          <button
            onClick={handleFetchMostLikelyMove}
            disabled={isFetchingMostLikelyMove}
            className={`min-w-0 flex-1 rounded-md border px-3 py-2 text-xs font-mono transition-colors ${
              isFetchingMostLikelyMove
                ? 'border-accent-teal/40 bg-accent-teal/10 text-accent-teal'
                : 'border-border-subtle text-text-secondary hover:border-accent-teal/40 hover:text-accent-teal'
            }`}
          >
            {isFetchingMostLikelyMove
              ? `Checking Lichess ${settings.mostLikelyMoveRating}+...`
              : `Most Likely Next Move ? (${settings.mostLikelyMoveRating}+)`}
          </button>
          <button
            onClick={() => setShowMostLikelyMoveSettings((prev) => !prev)}
            className={`btn-icon border border-border-subtle ${showMostLikelyMoveSettings ? 'bg-bg-hover text-accent-teal' : ''}`}
            title="Set Most Likely Next Move rating"
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
        </div>
        {showMostLikelyMoveSettings && (
          <div className="mt-2 flex items-center gap-2 rounded-md border border-border-subtle bg-bg-surface px-2 py-2">
            <span className="text-[10px] font-mono uppercase tracking-wider text-text-muted">
              Elo
            </span>
            <select
              value={settings.mostLikelyMoveRating}
              onChange={(e) => updateSetting('mostLikelyMoveRating', Number(e.target.value) as PracticalMoveRating)}
              className="flex-1 rounded-md border border-border-subtle bg-bg-primary px-2 py-1 text-xs text-text-primary focus:outline-none focus:border-accent-teal/50"
            >
              {[1600, 1800, 2000, 2200, 2500].map((rating) => (
                <option key={rating} value={rating}>
                  {rating}+
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      {mostLikelyMovePanel}
    </div>
  );

  const recommendationSection = (
    <div className="flex flex-col border-t border-border-subtle">
      <div className="px-3 py-2">
        <div className="flex flex-col gap-2">
          <button
            onClick={handleLoadTrickyMove}
            disabled={isLoadingRecommendations || !isOurTurnInCurrentPosition}
            className={`w-full rounded-md border px-3 py-2 text-[10px] font-mono uppercase tracking-wider transition-colors ${
              isLoadingRecommendations && activeSignal === 'tricky'
                ? 'border-accent-blue/40 bg-accent-blue/10 text-accent-blue'
                : 'border-border-subtle text-text-secondary hover:border-accent-blue/40 hover:text-accent-blue'
            }`}
          >
            {isLoadingRecommendations && activeSignal === 'tricky' ? 'Checking Next Tricky Move...' : 'Next Tricky Move'}
          </button>
          <button
            onClick={handleLoadGaps}
            disabled={isLoadingRecommendations}
            className={`w-full rounded-md border px-3 py-2 text-[10px] font-mono uppercase tracking-wider transition-colors ${
              isLoadingRecommendations && activeSignal === 'gaps'
                ? 'border-accent-amber/40 bg-accent-amber/10 text-accent-amber'
                : 'border-border-subtle text-text-secondary hover:border-accent-amber/40 hover:text-accent-amber'
            }`}
          >
            {isLoadingRecommendations && activeSignal === 'gaps' ? 'Checking for Gaps...' : 'Check for Gaps'}
          </button>
        </div>
        {isLoadingRecommendations ? (
          <div className="mt-2 flex items-center gap-2 text-xs text-text-muted">
            <Loader className="h-3.5 w-3.5 animate-spin" />
            {activeSignal === 'gaps' ? 'Scanning for missing lines...' : 'Scanning practical moves...'}
          </div>
        ) : !activeSignal ? (
          <div className="mt-2 text-xs text-text-muted">
            Use `Next Tricky Move` for your side or `Check for Gaps` to scan missing practical replies.
          </div>
        ) : recommendationError ? (
          <div className="mt-2 text-xs text-accent-red">{recommendationError}</div>
        ) : activeSignal === 'gaps' ? (
          gapSuggestions.length > 0 ? (
            <div className="mt-2 space-y-2">
              <div className="text-xs text-text-secondary">
                {gapSuggestions.length} opening gap{gapSuggestions.length !== 1 ? 's' : ''} found for the opponent.
              </div>
              {gapSuggestions.map((move) => (
                <div key={move.san} className="rounded border border-accent-amber/25 bg-accent-amber/5 px-2 py-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-accent-amber">{move.san}</div>
                      <div className="mt-0.5 text-[11px] text-text-secondary">
                        {move.playRate.toFixed(1)}% of {move.totalGames.toLocaleString()} games
                      </div>
                    </div>
                    <span className={`rounded px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider ${
                      move.severity === 'high'
                        ? 'bg-accent-red/15 text-accent-red'
                        : 'bg-accent-amber/20 text-accent-amber'
                    }`}>
                      {move.severity}
                    </span>
                  </div>
                  <div className="mt-2 flex gap-2">
                    <button
                      onClick={() => handleAddGapMove(move)}
                      className="btn-primary flex items-center gap-1 px-2 py-1 text-[10px]"
                    >
                      <Plus className="w-3 h-3" />
                      Add move
                    </button>
                    <button
                      onClick={() => void handleAddGapLine(move)}
                      className="btn-secondary px-2 py-1 text-[10px]"
                    >
                      Add line
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-2 text-xs text-text-muted">No significant opponent gaps detected here.</div>
          )
        ) : trickyMoveSuggestion ? (
          <div className="mt-2 rounded border border-accent-blue/25 bg-accent-blue/5 px-2 py-2">
            <div className="text-[10px] font-mono uppercase tracking-wider text-text-muted">Next Tricky Move</div>
            <div className="mt-1 flex items-start justify-between gap-2">
              <div className="text-sm font-semibold text-accent-blue">{trickyMoveSuggestion.move.san}</div>
              <div className="text-[10px] font-mono text-text-muted">
                score {trickyMoveSuggestion.score.toFixed(0)}
              </div>
            </div>
            <div className="mt-1 text-[11px] text-text-secondary">
              Opponent spread {trickyMoveSuggestion.opponentSpread.toFixed(0)}% · Soundness {trickyMoveSuggestion.soundness.toFixed(0)}%
            </div>
            {trickyMoveSuggestion.topReply && (
              <div className="mt-0.5 text-[10px] text-text-muted">
                Likely reply: {trickyMoveSuggestion.topReply.san} ({trickyMoveSuggestion.topReply.playRate.toFixed(1)}%)
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => addSanMoveFromFen(trickyMoveSuggestion.move.san)}
                className="btn-primary flex items-center gap-1 px-2 py-1 text-[10px]"
              >
                <Plus className="w-3 h-3" />
                Add move
              </button>
              <button
                onClick={handleAddTrickyLine}
                className="btn-secondary px-2 py-1 text-[10px]"
              >
                Auto-complete line
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-2 text-xs text-text-muted">
            Enable engine analysis here to surface a tricky continuation.
          </div>
        )}
      </div>
    </div>
  );

  // Handle PGN import
  const handleImportText = useCallback(
    (text: string) => {
      pgnParser.parsePgnText(text);
    },
    [pgnParser]
  );

  const handleImportFiles = useCallback(
    (files: FileList) => {
      pgnParser.parsePgnFiles(files);
    },
    [pgnParser]
  );

  // Kick off engine analysis across every unique position in the repertoire tree
  const startRepertoireAnalysis = useCallback(
    async (treeRoot: TreeNode) => {
      if (repertoireEval.isAnalyzing) return;
      repertoireEval.clearEvals();
      evalCancelledRef.current = false;

      // Count positions upfront so we can show accurate progress
      let count = 0;
      const countNodes = (n: TreeNode) => {
        count++;
        n.children.forEach(countNodes);
      };
      countNodes(treeRoot);

      repertoireEval.startAnalysis(count);

      // Accumulate evals locally so we can compute annotations after the loop
      // without relying on batched React state updates.
      const localEvals = new Map<string, RepertoireEval>();

      await analyzeRepertoire(treeRoot, {
        depth: repertoireDepth,
        onEval: (fen, evalResult) => {
          localEvals.set(fen, evalResult);
          repertoireEval.setEval(fen, evalResult);
          repertoireEval.incrementProgress();
        },
        isCancelled: () => evalCancelledRef.current,
      });

      // ── Compute eval-drop annotations ──────────────────────────────────
      // For each non-root node compare parent FEN eval to child FEN eval.
      // evalDrop > 0 means the side that moved worsened their position.
      const annotations = new Map<string, NodeAnnotation>();

      function computeAnnotations(node: TreeNode, parentFen: string | null): void {
        if (parentFen !== null && node.move) {
          const parentEvalResult = localEvals.get(parentFen);
          const nodeEvalResult   = localEvals.get(node.fen);
          if (parentEvalResult && nodeEvalResult) {
            // Skip positions where either eval is a forced-mate score to avoid
            // arithmetic overflow (score ±10 000 cp) producing misleading drops.
            const parentIsMate = Math.abs(parentEvalResult.score) >= 9000;
            const nodeIsMate   = Math.abs(nodeEvalResult.score)   >= 9000;
            if (!parentIsMate && !nodeIsMate) {
              const isWhiteMove = node.depth % 2 === 1;
              const evalDropCp  = isWhiteMove
                ? parentEvalResult.score - nodeEvalResult.score   // positive = white lost ground
                : nodeEvalResult.score   - parentEvalResult.score; // positive = black lost ground
              const evalDrop = evalDropCp / 100;
              if (evalDrop > 0) {
                const tier = classifyWithThresholds(evalDrop);
                if (tier) {
                  annotations.set(node.id, {
                    tier,
                    evalDrop,
                    side: isWhiteMove ? 'white' : 'black',
                  });
                }
              }
            }
          }
        }
        for (const child of node.children) {
          computeAnnotations(child, node.fen);
        }
      }
      computeAnnotations(treeRoot, null);
      repertoireEval.setNodeAnnotations(annotations);
      // ──────────────────────────────────────────────────────────────────

      repertoireEval.finishAnalysis();
    },
    [repertoireEval, repertoireDepth, classifyWithThresholds]
  );

  // When parsing is complete, set the tree
  useEffect(() => {
    if (pgnParser.parsedTree) {
      const captured = pgnParser.parsedTree;
      setTree(captured);
      setImportModalOpen(false);
      pgnParser.clearParsed();
    }
  }, [pgnParser.parsedTree]);

  // Cancel an in-progress repertoire analysis
  const handleCancelRepertoireAnalysis = useCallback(() => {
    evalCancelledRef.current = true;
    repertoireEval.cancelAnalysis();
    repertoireEval.finishAnalysis();
  }, [repertoireEval]);

  // Manually re-run analysis on the current tree
  const handleReanalyzeRepertoire = useCallback(() => {
    startRepertoireAnalysis(tree);
  }, [startRepertoireAnalysis, tree]);

  // Cycle through annotated nodes of a given tier when a badge is clicked
  const navigateToAnnotation = useCallback(
    (tier: string) => {
      if (!tree) return;
      const annotations = repertoireEval.nodeAnnotations;
      if (annotations.size === 0) return;

      // Collect matching nodes in DFS order
      const matches: TreeNode[] = [];
      function collectByTier(node: TreeNode): void {
        if (annotations.get(node.id)?.tier === tier) matches.push(node);
        for (const child of node.children) collectByTier(child);
      }
      collectByTier(tree);
      if (matches.length === 0) return;

      // Advance cyclic index; start from after the currently selected node
      const prevIdx = annotationNavIndexRef.current[tier] ?? -1;
      // If the previously navigated node is still current, advance; otherwise restart
      const isStillAtPrev = prevIdx >= 0 && matches[prevIdx]?.id === currentNode?.id;
      const nextIdx = isStillAtPrev
        ? (prevIdx + 1) % matches.length
        : 0;
      annotationNavIndexRef.current[tier] = nextIdx;
      navigateToNode(matches[nextIdx]);
    },
    [tree, repertoireEval.nodeAnnotations, currentNode, navigateToNode]
  );

  // Generate export PGN
  const exportPgn = exportTreeToPgn(tree, {
    includeAnnotations: exportOptions.includeAnnotations,
    filterColor: exportOptions.filterColor,
  });

  // Engine arrows for best move
  const engineArrows: string[] = [];
  if (engine.lines.length > 0 && engine.lines[0].pvUci.length > 0) {
    engineArrows.push(engine.lines[0].pvUci[0]);
    if (engine.lines.length > 1 && engine.lines[1].pvUci.length > 0) {
      engineArrows.push(engine.lines[1].pvUci[0]);
    }
  }

  // Last move
  const lastMove =
    currentPath.length >= 2
      ? undefined // We don't have from/to info in the tree; react-chessboard handles highlighting
      : undefined;

  // Navigate to a FEN from the mistake panel
  const handleNavigateToFen = useCallback(
    (fen: string, fileId?: string) => {
      const targetFile = fileId
        ? files.find((file) => file.id === fileId) ?? null
        : null;
      const sourceTree = targetFile?.tree ?? tree;

      // Find the node in the tree that has this FEN
      const findByFen = (node: TreeNode): TreeNode | null => {
        if (node.fen === fen) return node;
        for (const child of node.children) {
          const found = findByFen(child);
          if (found) return found;
        }
        return null;
      };

      const targetNode = findByFen(sourceTree);
      if (targetNode) {
        if (targetFile) {
          setActive(targetFile.id);
          setTree(cloneTree(targetFile.tree));
        }
        navigateToNode(targetNode);
      }
    },
    [files, navigateToNode, setActive, setTree, tree]
  );

  // Keyboard navigation — game viewer mode takes priority
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLInputElement) return;

      if (viewingGame) {
        switch (e.key) {
          case 'ArrowLeft':
            e.preventDefault();
            gameViewerBack();
            break;
          case 'ArrowRight':
            e.preventDefault();
            gameViewerForward();
            break;
          case 'ArrowUp':
            e.preventDefault();
            gameViewerEnd();
            break;
          case 'ArrowDown':
            e.preventDefault();
            gameViewerStart();
            break;
          case 'Home':
            e.preventDefault();
            gameViewerStart();
            break;
          case 'End':
            e.preventDefault();
            gameViewerEnd();
            break;
          case 'Escape':
            e.preventDefault();
            handleCloseGameViewer();
            break;
          case 'f':
            if (!e.ctrlKey && !e.metaKey) flipBoard();
            break;
        }
        return;
      }

      switch (e.key) {
        case 'ArrowLeft':
          e.preventDefault();
          navigateBack();
          break;
        case 'ArrowRight':
          e.preventDefault();
          navigateForward();
          break;
        case 'ArrowUp':
          e.preventDefault();
          navigateToEnd();
          break;
        case 'ArrowDown':
          e.preventDefault();
          navigateToStart();
          break;
        case 'Home':
          e.preventDefault();
          navigateToStart();
          break;
        case 'End':
          e.preventDefault();
          navigateToEnd();
          break;
        case 'f':
          if (!e.ctrlKey && !e.metaKey) {
            flipBoard();
          }
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [viewingGame, navigateBack, navigateForward, navigateToStart, navigateToEnd, flipBoard, gameViewerBack, gameViewerForward, gameViewerStart, gameViewerEnd, handleCloseGameViewer]);

  // Handle Lichess OAuth2 callback (?code=... in URL after redirect)
  useEffect(() => {
    if (window.location.search.includes('code=')) {
      handleOAuthCallback().then((success) => {
        if (success) {
          window.dispatchEvent(new CustomEvent('lichess-auth-updated'));
        }
      }).catch(console.error);
    }
  }, []);

  // Load active file tree on startup — run exactly once on mount.
  // FileProvider.getInitialState() loads from localStorage synchronously, so
  // getActiveFile() already reflects persisted state when this fires.
  // We intentionally do NOT list getActiveFile / setTree as deps: the effect
  // must run only once.  If it re-fired whenever state.files changed (e.g.
  // after a first-ever "Save Current"), it would reset currentNode to the
  // tree root mid-session — the "tree resets to first move" bug.
  useEffect(() => {
    const activeFile = getActiveFile();
    if (activeFile) {
      setTree(cloneTree(activeFile.tree));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nodeCount = countNodes(tree);

  return (
    <div className="h-screen flex flex-col bg-bg-primary overflow-hidden">
      {/* Top Bar */}
      <TopBar
        onImport={() => setImportModalOpen(true)}
        onExport={() => setExportModalOpen(true)}
        onGameFetcher={() => {
          setGeneratorOpen(false);
          setTrainerOpen(false);
          setPerformanceReportOpen(false);
          setGameFetcherOpen(true);
        }}
        onPerformanceReport={() => {
          setGeneratorOpen(false);
          setTrainerOpen(false);
          setGameFetcherOpen(false);
          setPerformanceReportOpen(true);
        }}
        onGenerator={() => {
          setGameFetcherOpen(false);
          setTrainerOpen(false);
          setPerformanceReportOpen(false);
          setGeneratorOpen(true);
        }}
        onTrainer={() => {
          setGameFetcherOpen(false);
          setGeneratorOpen(false);
          setPerformanceReportOpen(false);
          setTrainerOpen(true);
        }}
        onSettings={() => { setSettingsInitialTab('board'); setSettingsOpen(true); }}
        activeFileName={getActiveFile()?.name ?? null}
        generatorProgress={generator.progress}
        isGenerating={generator.isGenerating}
      />
      {settingsOpen && <SettingsModal initialTab={settingsInitialTab} onClose={() => setSettingsOpen(false)} />}

      {/* GeneratorPage: always mounted so in-progress generation keeps running
          when the user navigates back to the main repertoire view. Hidden via
          CSS (not unmounted) so all React state is preserved. */}
      <div className={generatorOpen ? 'flex-1 flex flex-col min-h-0' : 'hidden'}>
        <GeneratorPage
          gen={generator}
          onClose={() => setGeneratorOpen(false)}
          onImportTree={(importedTree) => {
            setTree(importedTree);
            setGeneratorOpen(false);
          }}
        />
      </div>

      {/* Other full-page views and main app */}
      {!generatorOpen && (gameFetcherOpen ? (
        <GameFetcherPage onClose={() => setGameFetcherOpen(false)} />
      ) : performanceReportOpen ? (
        <PerformanceReportPage onClose={() => setPerformanceReportOpen(false)} />
      ) : trainerOpen ? (
        <SpacedRepetitionTrainer
          onClose={() => setTrainerOpen(false)}
          onAnalyzePosition={(fileId, fen) => {
            setTrainerOpen(false);
            handleNavigateToFen(fen, fileId);
          }}
        />
      ) : (
      <>

      {/* Repertoire Analysis Progress Banner */}
      {repertoireEval.isAnalyzing && (
        <div className="bg-bg-surface border-b border-border-subtle px-4 py-1.5 flex items-center gap-3 flex-shrink-0">
          <Loader className="w-3.5 h-3.5 text-accent-teal animate-spin flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="flex justify-between text-[11px] text-text-secondary mb-1">
              <span>
                Engine analysing repertoire (depth {repertoireDepth})&hellip;{' '}
                {repertoireEval.progress}/{repertoireEval.total} positions
              </span>
              <span>
                {Math.round(
                  (repertoireEval.progress / Math.max(1, repertoireEval.total)) * 100
                )}%
              </span>
            </div>
            <div className="w-full h-1 bg-bg-hover rounded-full overflow-hidden">
              <div
                className="h-full bg-accent-teal rounded-full transition-all duration-200"
                style={{
                  width: `${Math.round(
                    (repertoireEval.progress / Math.max(1, repertoireEval.total)) * 100
                  )}%`,
                }}
              />
            </div>
          </div>
          <button
            onClick={handleCancelRepertoireAnalysis}
            className="btn-icon p-1 text-accent-red flex-shrink-0"
            title="Cancel analysis"
          >
            <StopCircle className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* Main Content — Mobile or Desktop layout */}
      {isMobile ? (
        /* ── Mobile layout ── */
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {/* Board */}
          <div className="flex flex-col items-center px-2 pt-2 pb-1 flex-shrink-0 border-b border-border-subtle">
            {viewingGame && (
              <div className="w-full flex items-center justify-between bg-accent-teal/10 border border-accent-teal/30 rounded-md px-3 py-1.5 mb-1">
                <div className="text-xs text-accent-teal truncate">
                  <span className="font-semibold">Viewing:</span>{' '}
                  {viewingGame.white} vs {viewingGame.black}
                  <span className="text-text-muted ml-2">
                    Move {viewingMoveIndex}/{gamePositions.length - 1}
                  </span>
                </div>
                <button
                  onClick={handleCloseGameViewer}
                  className="btn-icon p-0.5 text-accent-teal hover:text-accent-teal/70 flex-shrink-0"
                  title="Close game viewer (Esc)"
                >
                  ✕
                </button>
              </div>
            )}
            <div className={`w-full transition-all ${boardMinimized ? 'max-w-[160px]' : ''}`}>
              <ChessBoard
                fen={displayFen}
                orientation={orientation}
                onMove={viewingGame ? () => false : handleBoardMove}
                engineBestMove={engine.enabled ? engineArrows : undefined}
                score={engine.lines.length > 0 ? engine.lines[0].score : 0}
                mate={engine.lines.length > 0 ? engine.lines[0].mate : null}
                sizeScale={boardMinimized ? 0.5 : 1}
              />
            </div>
            {viewingGame ? (
              <BoardControls
                onStart={gameViewerStart}
                onBack={gameViewerBack}
                onForward={gameViewerForward}
                onEnd={gameViewerEnd}
                onFlip={flipBoard}
                canGoBack={viewingMoveIndex > 0}
                canGoForward={viewingMoveIndex < gamePositions.length - 1}
                onToggleSize={() => setBoardMinimized((prev) => !prev)}
                isBoardAltSize={boardMinimized}
                sizeToggleMode="minimize"
              />
            ) : (
              <BoardControls
                onStart={navigateToStart}
                onBack={navigateBack}
                onForward={navigateForward}
                onEnd={navigateToEnd}
                onFlip={flipBoard}
                canGoBack={currentPath.length > 1}
                canGoForward={currentNode.children.length > 0}
                onToggleSize={() => setBoardMinimized((prev) => !prev)}
                isBoardAltSize={boardMinimized}
                sizeToggleMode="minimize"
              />
            )}
          </div>

          {/* Mobile Tab Bar */}
          <div className="flex border-b border-border-subtle flex-shrink-0">
            {(['tree', 'analysis', 'games'] as MobileTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setMobileTab(tab)}
                className={`flex-1 px-2 py-2 text-xs font-mono uppercase tracking-wider transition-colors relative ${
                  mobileTab === tab
                    ? 'text-accent-teal border-b-2 border-accent-teal bg-bg-surface/50'
                    : 'text-text-muted'
                }`}
              >
                {tab === 'tree' ? 'Tree' : tab === 'analysis' ? 'Analysis' : 'Games'}
                {tab === 'games' && games.totalMistakes > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center px-1 min-w-[16px] h-4 rounded-full bg-accent-amber/20 text-accent-amber text-[9px] font-semibold">
                    {games.totalMistakes}
                  </span>
                )}
              </button>
            ))}
          </div>

          {/* Mobile Tab Content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {/* Tree Tab */}
            {mobileTab === 'tree' && (
              <div className="h-full flex flex-col overflow-hidden">
                <div className="border-b border-border-subtle">
                  <div
                    className="panel-header flex items-center justify-between cursor-pointer select-none"
                    onClick={() => setFilesOpen((o) => !o)}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className={`transition-transform text-[10px] ${filesOpen ? 'rotate-90' : ''}`}>▶</span>
                      REPERTOIRE FILES
                      {files.length > 0 && (
                        <span className="text-[10px] text-text-muted normal-case tracking-normal font-normal">({files.length})</span>
                      )}
                    </span>
                  </div>
                  {filesOpen && (
                    <div className="max-h-[40vh] overflow-y-auto px-3 pb-2">
                      <RepertoireFilesPanel currentTree={tree} onLoadTree={setTree} />
                    </div>
                  )}
                </div>
                <div className="flex-1 min-h-0">
                  <OpeningTree
                    tree={tree}
                    currentNode={currentNode}
                    currentPath={currentPath}
                    onNodeClick={navigateToNode}
                    onDeleteNode={deleteNode}
                    onAddMove={addMoveToNode}
                    onAddLine={addLineToNode}
                    importedGames={games.importedGames}
                    showGameOverlay={games.showGameOverlay}
                    onExploreFen={setExploreOverlayFen}
                    exploreModeEnabled={treeExploreMode}
                    onExploreModeChange={setTreeExploreMode}
                  />
                </div>
              </div>
            )}

            {/* Analysis Tab */}
            {mobileTab === 'analysis' && (
              <div className="h-full overflow-y-auto">
                <div className="min-h-[calc(100vh-20rem)] flex flex-col">
                  <EnginePanel
                    lines={engine.lines}
                    isThinking={engine.isThinking}
                    enabled={engine.enabled}
                    depth={engine.depth}
                    multiPV={engine.multiPV}
                    threads={engine.threads}
                    currentFen={displayFen}
                    onToggle={engine.toggleEngine}
                    onDepthChange={engine.setDepth}
                    onMultiPVChange={engine.setMultiPV}
                    onThreadsChange={engine.setThreads}
                  />
                </div>
                {mostLikelyMoveSection}
                {recommendationSection}
                <div className="min-h-[40vh] flex flex-col border-t border-border-subtle">
                  <MoveList
                    currentPath={currentPath}
                    currentNode={currentNode}
                    onNavigateToNode={navigateToNode}
                    importedGames={games.importedGames}
                    showGameOverlay={games.showGameOverlay}
                    onAddMove={addMoveToNode}
                  />
                </div>
                <div className="min-h-[28vh] flex flex-col border-t border-border-subtle">
                  <NotesPanel
                    comment={currentNode.comment}
                    nags={currentNode.nags}
                    nodeId={currentNode.id}
                    onCommentChange={(comment) => setComment(currentNode.id, comment)}
                    onAddNag={(nag) => addNag(currentNode.id, nag)}
                    onRemoveNag={(nag) => removeNag(currentNode.id, nag)}
                  />
                </div>
              </div>
            )}

            {/* Games Tab */}
            {mobileTab === 'games' && (
              <ErrorBoundary>
                <div className="h-full overflow-auto">
                  <div className="p-3 flex flex-col gap-4">
                    {viewingGame && (
                      <div className="panel flex flex-col">
                        <div className="panel-header flex items-center justify-between">
                          <span>GAME MOVES</span>
                          <span className="text-[10px] text-text-muted font-normal normal-case tracking-normal">
                            {viewingGame.white} vs {viewingGame.black}
                            {viewingGame.result ? ` — ${viewingGame.result}` : ''}
                          </span>
                        </div>
                        <div className="p-3 overflow-auto max-h-[200px]">
                          <div className="text-sm leading-relaxed flex flex-wrap gap-y-0.5">
                            {viewingGame.moves.map((san, idx) => {
                              const moveNum = Math.floor(idx / 2) + 1;
                              const isWhite = idx % 2 === 0;
                              const moveIndex = idx + 1;
                              const isCurrent = moveIndex === viewingMoveIndex;
                              const figurine = toFigurine(san, isWhite);
                              return (
                                <React.Fragment key={idx}>
                                  {isWhite && (
                                    <span className="text-text-secondary mr-0.5">{moveNum}.</span>
                                  )}
                                  <span
                                    onClick={() => setViewingMoveIndex(moveIndex)}
                                    className={`cursor-pointer rounded px-1 transition-colors ${
                                      isCurrent
                                        ? 'bg-accent-teal/20 text-accent-teal font-semibold'
                                        : isWhite
                                          ? 'text-text-primary font-medium hover:bg-bg-hover'
                                          : 'text-blue-700 hover:bg-bg-hover'
                                    }`}
                                  >
                                    {figurine}
                                  </span>
                                  {!isWhite && <span className="mr-1.5" />}
                                </React.Fragment>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}
                    <div>
                      <div className="text-xs text-text-muted uppercase tracking-wider font-mono mb-2">Import Games</div>
                      <GameImportPanel onViewGame={handleViewGame} viewingGameId={viewingGame?.id ?? null} />
                    </div>
                    {games.importedGames.some((g) => g.analyzed) && (
                      <div className="border-t border-border-subtle" />
                    )}
                    {games.importedGames.some((g) => g.analyzed) && (
                      <div>
                        <div className="text-xs text-text-muted uppercase tracking-wider font-mono mb-2">Mistake Review</div>
                        <MistakePanel onNavigateToFen={handleNavigateToFen} />
                      </div>
                    )}
                  </div>
                </div>
              </ErrorBoundary>
            )}
          </div>
        </div>
      ) : (
      /* ── Desktop layout ── */
      <div className="flex-1 flex min-h-0">
        {/* Left Panel: Files + Opening Tree */}
        <div className="flex-1 min-w-[300px] border-r border-border-subtle flex flex-col">
          {/* Repertoire Files */}
          <div className="border-b border-border-subtle">
            <div
              className="panel-header flex items-center justify-between cursor-pointer select-none"
              onClick={() => setFilesOpen((o) => !o)}
            >
              <span className="flex items-center gap-1.5">
                <span className={`transition-transform text-[10px] ${filesOpen ? 'rotate-90' : ''}`}>
                  ▶
                </span>
                REPERTOIRE FILES
                {files.length > 0 && (
                  <span className="text-[10px] text-text-muted normal-case tracking-normal font-normal">
                    ({files.length})
                  </span>
                )}
              </span>
            </div>
            {filesOpen && (
              <div className="px-3 pb-2">
                <RepertoireFilesPanel
                  currentTree={tree}
                  onLoadTree={setTree}
                />
              </div>
            )}
          </div>

          {/* Opening Tree */}
          <div className="panel-header flex items-center justify-end gap-3">
            <div className="flex items-center gap-2">
              {/* Annotation count badges — shown after analysis completes */}
              {!repertoireEval.isAnalyzing && repertoireEval.nodeAnnotations.size > 0 && (() => {
                const counts = {
                  inaccuracy: { total: 0, white: 0, black: 0 },
                  mistake:    { total: 0, white: 0, black: 0 },
                  blunder:    { total: 0, white: 0, black: 0 },
                };
                for (const ann of repertoireEval.nodeAnnotations.values()) {
                  const c = counts[ann.tier];
                  c.total++;
                  if (ann.side === 'white') c.white++; else c.black++;
                }
                const tiers: { tier: 'inaccuracy' | 'mistake' | 'blunder'; symbol: string; color: string }[] = [
                  { tier: 'inaccuracy', symbol: '?!', color: '#f59e0b' },
                  { tier: 'mistake',    symbol: '?',  color: '#f97316' },
                  { tier: 'blunder',    symbol: '??', color: '#ef4444' },
                ];
                return (
                  <div className="flex items-center gap-2">
                    {tiers.map(({ tier, symbol, color }) => {
                      const c = counts[tier];
                      if (c.total === 0) return null;
                      const label = tier === 'inaccuracy' ? 'inaccuracies' : `${tier}s`;
                      return (
                        <div key={tier} className="flex items-center gap-0.5">
                          {/* White badge */}
                          {c.white > 0 && (
                            <button
                              onClick={() => navigateToAnnotation(tier)}
                              className="flex items-center gap-0.5 px-1 py-0.5 rounded transition-opacity hover:opacity-100 opacity-85 cursor-pointer"
                              style={{ backgroundColor: '#ffffffcc', border: `1px solid ${color}66` }}
                              title={`${c.white} white ${label} — click to cycle`}
                            >
                              <span className="font-mono text-[8px] font-bold" style={{ color }}>
                                {symbol}
                              </span>
                              <span className="font-mono text-[8px] font-semibold text-[#1a1a1a]">
                                ♔{c.white}
                              </span>
                            </button>
                          )}
                          {/* Black badge */}
                          {c.black > 0 && (
                            <button
                              onClick={() => navigateToAnnotation(tier)}
                              className="flex items-center gap-0.5 px-1 py-0.5 rounded transition-opacity hover:opacity-100 opacity-85 cursor-pointer"
                              style={{ backgroundColor: '#1a1a2ecc', border: `1px solid ${color}66` }}
                              title={`${c.black} black ${label} — click to cycle`}
                            >
                              <span className="font-mono text-[8px] font-bold" style={{ color }}>
                                {symbol}
                              </span>
                              <span className="font-mono text-[8px] font-semibold" style={{ color: '#e8e8e8' }}>
                                ♚{c.black}
                              </span>
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                );
              })()}
            </div>
            <div className="flex items-center gap-2">
              {/* Repertoire analysis controls (only when not running) */}
              {!repertoireEval.isAnalyzing && (
                <div className="flex items-center gap-1">
                  {/* Depth control */}
                  <div className="flex items-center gap-0.5" title="Analysis depth">
                    <span className="text-[9px] text-text-muted font-mono">d{repertoireDepth}</span>
                    <div className="flex flex-col -space-y-0.5">
                      <button
                        onClick={() => setRepertoireDepth((d) => Math.min(d + 2, 30))}
                        className="btn-icon p-0 text-text-muted hover:text-accent-teal leading-none"
                        title="Increase depth"
                      >
                        <ChevronUp className="w-2.5 h-2.5" />
                      </button>
                      <button
                        onClick={() => setRepertoireDepth((d) => Math.max(d - 2, 8))}
                        className="btn-icon p-0 text-text-muted hover:text-accent-teal leading-none"
                        title="Decrease depth"
                      >
                        <ChevronDown className="w-2.5 h-2.5" />
                      </button>
                    </div>
                  </div>
                  {/* Threshold controls */}
                  <div className="flex items-center gap-0.5 ml-1 border-l border-border-subtle pl-1.5">
                    {(
                      [
                        { key: 'inaccuracy', label: '?!', color: '#faff00' },
                        { key: 'mistake',    label: '?',  color: '#e67e22' },
                        { key: 'blunder',    label: '??', color: '#e74c3c' },
                      ] as const
                    ).map(({ key, label, color }) => (
                      <div key={key} className="flex items-center gap-0.5" title={`${key} threshold (eval drop in pawns)`}>
                        <span className="text-[9px] font-mono font-bold" style={{ color }}>{label}</span>
                        <input
                          type="number"
                          step={0.1}
                          min={0.1}
                          max={10}
                          value={thresholds[key]}
                          onChange={(e) => {
                            const val = parseFloat(e.target.value);
                            if (!isNaN(val) && val > 0) {
                              setThresholds((prev) => ({ ...prev, [key]: val }));
                            }
                          }}
                          className="w-10 h-5 text-center rounded border border-border-subtle bg-bg-primary text-text-primary font-mono text-[9px] outline-none focus:border-accent-teal px-0"
                        />
                      </div>
                    ))}
                  </div>
                  {/* Analyze button */}
                  <button
                    onClick={handleReanalyzeRepertoire}
                    className={`btn-icon p-1 ${
                      repertoireEval.evals.size > 0
                        ? 'text-accent-teal/60 hover:text-accent-teal'
                        : 'text-text-muted hover:text-accent-teal'
                    }`}
                    title={
                      repertoireEval.evals.size > 0
                        ? `Re-analyse at depth ${repertoireDepth} (${repertoireEval.evals.size} positions cached)`
                        : `Analyse all positions at depth ${repertoireDepth}`
                    }
                  >
                    <Cpu className="w-3 h-3" />
                  </button>
                </div>
              )}
              {/* Game overlay toggle */}
              {games.importedGames.length > 0 && (
                <label className="flex items-center gap-1.5 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={games.showGameOverlay}
                    onChange={() => games.toggleGameOverlay()}
                    className="w-3 h-3 rounded border-border-subtle bg-bg-primary accent-accent-teal cursor-pointer"
                  />
                  <span className="text-[10px] text-text-muted normal-case tracking-normal">
                    Show games
                  </span>
                </label>
              )}
            </div>{/* end flex items-center gap-2 */}
          </div>
          <div className="flex-1 min-h-0">
            <OpeningTree
              tree={tree}
              currentNode={currentNode}
              currentPath={currentPath}
              onNodeClick={navigateToNode}
              onDeleteNode={deleteNode}
              onAddMove={addMoveToNode}
              onAddLine={addLineToNode}
              importedGames={games.importedGames}
              showGameOverlay={games.showGameOverlay}
              onExploreFen={setExploreOverlayFen}
              exploreModeEnabled={treeExploreMode}
              onExploreModeChange={setTreeExploreMode}
            />
          </div>
        </div>

        {/* Right Panel: Board + Tabbed Content */}
        <div className={`${boardExpanded ? 'w-[580px] min-w-[540px]' : 'w-[420px] min-w-[380px]'} flex flex-col overflow-hidden transition-[width] duration-200`}>
          {/* Chessboard */}
          <div className="flex flex-col items-center p-3 gap-1">
            {/* Game viewer banner */}
            {viewingGame && (
              <div className="w-full max-w-[400px] flex items-center justify-between bg-accent-teal/10 border border-accent-teal/30 rounded-md px-3 py-1.5 mb-1">
                <div className="text-xs text-accent-teal truncate">
                  <span className="font-semibold">Viewing:</span>{' '}
                  {viewingGame.white} vs {viewingGame.black}
                  <span className="text-text-muted ml-2">
                    Move {viewingMoveIndex}/{gamePositions.length - 1}
                  </span>
                </div>
                <button
                  onClick={handleCloseGameViewer}
                  className="btn-icon p-0.5 text-accent-teal hover:text-accent-teal/70 flex-shrink-0"
                  title="Close game viewer (Esc)"
                >
                  ✕
                </button>
              </div>
            )}
            <div className={`w-full transition-all ${
              boardExpanded
                ? 'max-w-[540px]'
                : 'max-w-[400px]'
            }`}>
              <ChessBoard
                fen={displayFen}
                orientation={orientation}
                onMove={viewingGame ? () => false : handleBoardMove}
                engineBestMove={engine.enabled ? engineArrows : undefined}
                score={engine.lines.length > 0 ? engine.lines[0].score : 0}
                mate={engine.lines.length > 0 ? engine.lines[0].mate : null}
                sizeScale={1}
              />
            </div>
            {viewingGame ? (
              <BoardControls
                onStart={gameViewerStart}
                onBack={gameViewerBack}
                onForward={gameViewerForward}
                onEnd={gameViewerEnd}
                onFlip={flipBoard}
                canGoBack={viewingMoveIndex > 0}
                canGoForward={viewingMoveIndex < gamePositions.length - 1}
                onToggleSize={() => setBoardExpanded((prev) => !prev)}
                isBoardAltSize={boardExpanded}
                sizeToggleMode="expand"
              />
            ) : (
              <BoardControls
                onStart={navigateToStart}
                onBack={navigateBack}
                onForward={navigateForward}
                onEnd={navigateToEnd}
                onFlip={flipBoard}
                canGoBack={currentPath.length > 1}
                canGoForward={currentNode.children.length > 0}
                onToggleSize={() => setBoardExpanded((prev) => !prev)}
                isBoardAltSize={boardExpanded}
                sizeToggleMode="expand"
              />
            )}
            <button
              onClick={() => setTreeExploreMode((prev) => !prev)}
              className={`mt-1.5 w-full max-w-[200px] rounded-md border px-2.5 py-1.5 text-xs font-semibold transition-colors ${
                treeExploreMode
                  ? 'border-[#00d4aa]/60 bg-[#00d4aa]/12 text-[#00d4aa]'
                  : 'border-border-subtle bg-bg-surface text-text-secondary hover:border-[#00d4aa]/40 hover:text-[#00d4aa]'
              }`}
              title={treeExploreMode ? 'Explore mode ON — click to disable' : 'Enable explore mode (navigate without adding moves)'}
            >
              {treeExploreMode ? 'Explore Mode On' : 'Explore Mode'}
            </button>
          </div>

          {/* Tab Bar */}
          <div className="flex border-t border-b border-border-subtle">
            <button
              onClick={() => setSidebarTab('analysis')}
              className={`flex-1 px-3 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors ${
                sidebarTab === 'analysis'
                  ? 'text-accent-teal border-b-2 border-accent-teal bg-bg-surface/50'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              Analysis
            </button>
            <button
              onClick={() => setSidebarTab('games')}
              className={`flex-1 px-3 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors relative ${
                sidebarTab === 'games'
                  ? 'text-accent-teal border-b-2 border-accent-teal bg-bg-surface/50'
                  : 'text-text-muted hover:text-text-secondary'
              }`}
            >
              Games & Mistakes
              {games.totalMistakes > 0 && (
                <span className="ml-1.5 inline-flex items-center justify-center px-1 min-w-[16px] h-4 rounded-full bg-accent-amber/20 text-accent-amber text-[9px] font-semibold">
                  {games.totalMistakes}
                </span>
              )}
            </button>
          </div>

          {/* Tab Content */}
          <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            {sidebarTab === 'analysis' ? (
              <div className="flex-1 min-h-0 overflow-auto">
                {/* Engine Panel */}
                <div className="min-h-[140px] flex flex-col shrink-0">
                  <EnginePanel
                    lines={engine.lines}
                    isThinking={engine.isThinking}
                    enabled={engine.enabled}
                    depth={engine.depth}
                    multiPV={engine.multiPV}
                    threads={engine.threads}
                    currentFen={displayFen}
                    onToggle={engine.toggleEngine}
                    onDepthChange={engine.setDepth}
                    onMultiPVChange={engine.setMultiPV}
                    onThreadsChange={engine.setThreads}
                  />
                </div>
                {mostLikelyMoveSection}
                {recommendationSection}

                {/* Move List */}
                <div className="flex flex-col border-t border-border-subtle shrink-0">
                  <button
                    onClick={() => setMoveListExpanded((prev) => !prev)}
                    className="panel-header flex items-center justify-between cursor-pointer select-none"
                    title={moveListExpanded ? 'Collapse moves' : 'Expand moves'}
                  >
                    <span>MOVES</span>
                    {moveListExpanded ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronUp className="w-3 h-3" />
                    )}
                  </button>
                  {moveListExpanded && (
                    <div className="flex flex-col max-h-[320px]">
                      <MoveList
                        currentPath={currentPath}
                        currentNode={currentNode}
                        onNavigateToNode={navigateToNode}
                        importedGames={games.importedGames}
                        showGameOverlay={games.showGameOverlay}
                        onAddMove={addMoveToNode}
                        hideHeader
                      />
                    </div>
                  )}
                </div>

                {/* Notes Panel */}
                <div className="flex flex-col overflow-hidden border-t border-border-subtle shrink-0">
                  <button
                    onClick={() => setNotesExpanded((prev) => !prev)}
                    className="panel-header flex items-center justify-between cursor-pointer select-none"
                    title={notesExpanded ? 'Collapse notes' : 'Expand notes'}
                  >
                    <span>NOTES</span>
                    {notesExpanded ? (
                      <ChevronDown className="w-3 h-3" />
                    ) : (
                      <ChevronUp className="w-3 h-3" />
                    )}
                  </button>
                  {notesExpanded && (
                    <div className="flex flex-col max-h-[280px] overflow-auto">
                      <NotesPanel
                        comment={currentNode.comment}
                        nags={currentNode.nags}
                        nodeId={currentNode.id}
                        onCommentChange={(comment) => setComment(currentNode.id, comment)}
                        onAddNag={(nag) => addNag(currentNode.id, nag)}
                        onRemoveNag={(nag) => removeNag(currentNode.id, nag)}
                        hideHeader
                      />
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <ErrorBoundary>
                <div className="flex-1 min-h-0 overflow-auto">
                  <div className="p-3 flex flex-col gap-4">
                    {/* Game Viewer Move List — shown when viewing a game */}
                    {viewingGame && (
                      <div className="panel flex flex-col">
                        <div className="panel-header flex items-center justify-between">
                          <span>GAME MOVES</span>
                          <span className="text-[10px] text-text-muted font-normal normal-case tracking-normal">
                            {viewingGame.white} vs {viewingGame.black}
                            {viewingGame.result ? ` — ${viewingGame.result}` : ''}
                          </span>
                        </div>
                        <div className="p-3 overflow-auto max-h-[200px]">
                          <div className="text-sm leading-relaxed flex flex-wrap gap-y-0.5">
                            {viewingGame.moves.map((san, idx) => {
                              const moveNum = Math.floor(idx / 2) + 1;
                              const isWhite = idx % 2 === 0;
                              const moveIndex = idx + 1; // 1-based position after this move
                              const isCurrent = moveIndex === viewingMoveIndex;
                              const figurine = toFigurine(san, isWhite);

                              return (
                                <React.Fragment key={idx}>
                                  {isWhite && (
                                    <span className="text-text-secondary mr-0.5">
                                      {moveNum}.
                                    </span>
                                  )}
                                  <span
                                    onClick={() => setViewingMoveIndex(moveIndex)}
                                    className={`cursor-pointer rounded px-1 transition-colors ${
                                      isCurrent
                                        ? 'bg-accent-teal/20 text-accent-teal font-semibold'
                                        : isWhite
                                          ? 'text-text-primary font-medium hover:bg-bg-hover'
                                          : 'text-blue-700 hover:bg-bg-hover'
                                    }`}
                                  >
                                    {figurine}
                                  </span>
                                  {!isWhite && <span className="mr-1.5" />}
                                </React.Fragment>
                              );
                            })}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Game Import Section */}
                    <div>
                      <div className="text-xs text-text-muted uppercase tracking-wider font-mono mb-2">
                        Import Games
                      </div>
                      <GameImportPanel
                        onViewGame={handleViewGame}
                        viewingGameId={viewingGame?.id ?? null}
                      />
                    </div>

                    {/* Divider */}
                    {games.importedGames.some((g) => g.analyzed) && (
                      <div className="border-t border-border-subtle" />
                    )}

                    {/* Mistake Review Section */}
                    {games.importedGames.some((g) => g.analyzed) && (
                      <div>
                        <div className="text-xs text-text-muted uppercase tracking-wider font-mono mb-2">
                          Mistake Review
                        </div>
                        <MistakePanel onNavigateToFen={handleNavigateToFen} />
                      </div>
                    )}
                  </div>
                </div>
              </ErrorBoundary>
            )}
          </div>
        </div>
      </div>
      )} {/* end isMobile ternary */}

      {/* Status Bar */}
      <StatusBar
        openingName={openingInfo?.name || null}
        eco={openingInfo?.eco || null}
        moveNumber={currentMoveNumber}
        isWhiteToMove={isWhiteToMove}
        nodeCount={nodeCount}
        gameCount={tree.gameCount}
      />

      {/* Modals */}
      <ImportModal
        isOpen={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        onImport={handleImportText}
        onImportFiles={handleImportFiles}
        isLoading={pgnParser.isLoading}
        error={pgnParser.error}
      />

      <ExportModal
        isOpen={exportModalOpen}
        onClose={() => setExportModalOpen(false)}
        pgnText={exportPgn}
        onCopy={() => copyToClipboard(exportPgn)}
        onDownload={() => downloadAsFile(exportPgn, 'repertoire.pgn')}
        onOptionsChange={setExportOptions}
      />

      {/* Error logging UI */}
      <ErrorToast />
      <ErrorLogPanel />
      </>
      ))}
    </div>
  );
};
