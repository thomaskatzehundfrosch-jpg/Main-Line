/**
 * Main auto-repertoire generator page.
 * Supports interactive move-playing on the board to build a starting tree,
 * which is then expanded/analysed via the generator engine.
 */

import React, { useState, useCallback, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  Download,
  Upload,
  Cpu,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Maximize2,
  Minimize2,
  Trash2,
} from 'lucide-react';
import { Chessboard } from 'react-chessboard';
import type { Square, Piece } from 'react-chessboard/dist/chessboard/types';
import { Chess } from 'chess.js';
import type { TreeNode } from '../../types';
import { END_REASON_LABELS } from '../../types/generator';
import type { GeneratorNode, GeneratorSettings } from '../../types/generator';
import type { UseGeneratorReturn } from '../../hooks/useGenerator';
import { GeneratorSettingsPanel } from './GeneratorSettings';
import { GeneratorProgressBar } from './GeneratorProgress';
import { GeneratorMoveTree } from './GeneratorMoveTree';
import { convertToTreeNode } from '../../utils/generatorConverter';
import { exportGeneratorPGN } from '../../utils/generatorPgn';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSettings } from '../../context/SettingsContext';
import { BOARD_THEME_COLORS } from '../Board/theme';
import { getStoredToken } from '../../utils/lichessAuth';
import {
  getCachedGeneratorSettings,
  setCachedGeneratorSettings,
} from '../../utils/generatorSettingsCache';

interface GeneratorPageProps {
  onClose: () => void;
  onImportTree: (tree: TreeNode) => void;
  gen: UseGeneratorReturn;
  initialSeeds?: string[][] | null;
  isActive?: boolean;
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const GeneratorPage: React.FC<GeneratorPageProps> = ({ onClose, onImportTree, gen, initialSeeds, isActive = true }) => {
  const isMobile = useIsMobile();
  const { settings: appSettings } = useSettings();
  const [connected, setConnected] = useState(() => !!getStoredToken());
  useEffect(() => {
    const sync = () => setConnected(!!getStoredToken());
    window.addEventListener('lichess-auth-updated', sync);
    return () => window.removeEventListener('lichess-auth-updated', sync);
  }, []);
  const busy = gen.isGenerating;

  const [settings, _setSettings] = useState<GeneratorSettings>(() => getCachedGeneratorSettings());

  const setSettings = useCallback((val: GeneratorSettings | ((prev: GeneratorSettings) => GeneratorSettings)) => {
    _setSettings((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      setCachedGeneratorSettings(next);
      return next;
    });
  }, []);

  const lastInitialSeeds = useRef<string[][] | null>(null);
  useEffect(() => {
    if (!busy && initialSeeds?.length && initialSeeds !== lastInitialSeeds.current) {
      gen.loadSeeds(initialSeeds, settings.color);
      lastInitialSeeds.current = initialSeeds;
    }
  }, [initialSeeds, gen.loadSeeds, settings.color, busy]);

  useEffect(() => {
    if (!busy && gen.tree?.repertoireColor && gen.tree.repertoireColor !== settings.color) {
      gen.loadSeeds(gen.getSeeds(), settings.color);
    }
  }, [settings.color, gen.tree, gen.loadSeeds, gen.getSeeds, busy]);

  /* ---------------------------------------------------------------- */
  /*  Interactive board state (click-to-move)                         */
  /* ---------------------------------------------------------------- */
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);
  const [boardExpanded, setBoardExpanded] = useState(true);
  const themeColors = BOARD_THEME_COLORS[appSettings.boardTheme];

  // During generation animate to the latest added node; otherwise show selected.
  const displayNode = gen.isGenerating ? gen.latestNode : gen.selectedNode;
  const displayFen = displayNode?.fen || START_FEN;

  // Clear click-to-move selection whenever position changes
  useEffect(() => {
    setSelectedSquare(null);
    setLegalMoves([]);
  }, [displayFen]);

  /* ---------------------------------------------------------------- */
  /*  Board helpers                                                    */
  /* ---------------------------------------------------------------- */

  const getLegalMovesForSquare = useCallback(
    (square: string): string[] => {
      try {
        const chess = new Chess(displayFen);
        return chess.moves({ square: square as any, verbose: true }).map((m) => m.to);
      } catch {
        return [];
      }
    },
    [displayFen]
  );

  const isOwnPiece = useCallback(
    (square: string): boolean => {
      try {
        const chess = new Chess(displayFen);
        const piece = chess.get(square as any);
        return !!piece && piece.color === chess.turn();
      } catch {
        return false;
      }
    },
    [displayFen]
  );

  /** Attempt to play a move and add it to the generator tree. */
  const tryMove = useCallback(
    (from: string, to: string, promotion?: string): boolean => {
      if (busy) return false;
      try {
        const chess = new Chess(displayFen);
        const result = chess.move({ from, to, promotion: promotion as any });
        if (!result) return false;
        const uci = from + to + (result.promotion || '');
        return gen.addManualMove(result.san, uci, chess.fen(), settings.color);
      } catch {
        return false;
      }
    },
    [displayFen, gen, settings.color, busy]
  );

  /* ---------------------------------------------------------------- */
  /*  Board event handlers                                             */
  /* ---------------------------------------------------------------- */

  const handleSquareClick = useCallback(
    (square: Square) => {
      if (busy) return;

      // If a piece is selected and clicked square is a legal target → try move
      if (selectedSquare && legalMoves.includes(square)) {
        const chess = new Chess(displayFen);
        const piece = chess.get(selectedSquare as any);
        const isPawn = piece?.type === 'p';
        const isPromoRank = square[1] === '8' || square[1] === '1';
        tryMove(selectedSquare, square, isPawn && isPromoRank ? 'q' : undefined);
        setSelectedSquare(null);
        setLegalMoves([]);
        return;
      }

      // If clicking own piece, select it
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

      // Otherwise deselect
      setSelectedSquare(null);
      setLegalMoves([]);
    },
    [selectedSquare, legalMoves, displayFen, isOwnPiece, getLegalMovesForSquare, tryMove, busy]
  );

  const handlePieceClick = useCallback(
    (_piece: Piece, square: Square) => handleSquareClick(square),
    [handleSquareClick]
  );

  const handlePieceDrop = useCallback(
    (source: Square, target: Square, piece: Piece): boolean => {
      setSelectedSquare(null);
      setLegalMoves([]);
      const isPawn = piece[1] === 'P';
      const isPromoRank = target[1] === '8' || target[1] === '1';
      return tryMove(source, target, isPawn && isPromoRank ? 'q' : undefined);
    },
    [tryMove]
  );

  /* ---------------------------------------------------------------- */
  /*  Square styles (selection, legal-move dots, last move)            */
  /* ---------------------------------------------------------------- */

  const customSquareStyles: Record<string, React.CSSProperties> = {};

  // Highlight the last move played — follows displayNode so it animates during generation
  if (displayNode && !displayNode.isRoot && displayNode.uci) {
    const uci = displayNode.uci;
    if (uci.length >= 4) {
      customSquareStyles[uci.substring(0, 2)] = { backgroundColor: `${themeColors.dark}30` };
      customSquareStyles[uci.substring(2, 4)] = { backgroundColor: `${themeColors.dark}30` };
    }
  }

  if (selectedSquare) {
    customSquareStyles[selectedSquare] = { backgroundColor: `${themeColors.dark}55` };
  }

  for (const sq of legalMoves) {
    let isCapture = false;
    try {
      const chess = new Chess(displayFen);
      isCapture = !!chess.get(sq as any);
    } catch { /* ignore */ }

    customSquareStyles[sq] = {
      ...customSquareStyles[sq],
      background: isCapture
        ? `radial-gradient(circle, transparent 55%, ${themeColors.dark}60 55%)`
        : `radial-gradient(circle, ${themeColors.dark}55 25%, transparent 25%)`,
    };
  }

  /* ---------------------------------------------------------------- */
  /*  Keyboard navigation (arrow keys)                                */
  /* ---------------------------------------------------------------- */

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (busy || !isActive || (e.target instanceof HTMLElement && (e.target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(e.target.tagName)))) return;
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        gen.goToParent();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        gen.goToChild(0);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [gen, busy, isActive]);

  /* ---------------------------------------------------------------- */
  /*  Generation / actions                                             */
  /* ---------------------------------------------------------------- */

  const canGenerate = !busy && (settings.analysisMode === 'stockfish' || connected);

  const handleGenerate = useCallback(() => {
    if (gen.isGenerating || (settings.analysisMode !== 'stockfish' && !getStoredToken())) return;
    gen.startGeneration(settings, gen.getSeeds(), null);
  }, [settings, gen]);
  const handleStop = gen.stopGeneration;
  const handleClear = useCallback(() => { if (!busy) gen.clearTree(); }, [busy, gen.clearTree]);

  const handleNodeSelect = useCallback(
    (node: GeneratorNode) => gen.setSelectedNode(node),
    [gen]
  );

  const handleImport = useCallback(() => {
    if (!gen.tree) return;
    onImportTree(convertToTreeNode(gen.tree, null, true, settings.color));
  }, [gen.tree, onImportTree, settings.color]);

  const handleExportPGN = useCallback(() => {
    if (!gen.tree) return;
    const pgn = exportGeneratorPGN(gen.tree, settings);
    const blob = new Blob([pgn], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `repertoire_${settings.color}_${Date.now()}.pgn`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [gen.tree, settings]);

  const node = displayNode;
  const generatorBoardWidth = isMobile ? 320 : (boardExpanded ? 480 : 360);

  /* ---------------------------------------------------------------- */
  /*  Render                                                           */
  /* ---------------------------------------------------------------- */

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-bg-primary">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border-subtle bg-bg-surface">
        <button onClick={onClose} className="btn-icon p-1.5" title="Back to repertoire">
          <ArrowLeft className="w-4 h-4" />
        </button>
        <Cpu className="w-4 h-4 text-accent-teal" />
        <h2 className="font-mono text-sm uppercase tracking-wider text-text-secondary">
          Repertoire generator
        </h2>
        <span className="hidden text-xs text-text-muted sm:inline">
          Choose your starting moves, then generate continuations
        </span>

        {gen.tree && !busy && (
          <div className="ml-auto flex items-center gap-2">
            <button
              onClick={handleImport}
              className="btn-primary flex items-center gap-2"
              title="Import generated tree into your repertoire"
            >
              <Upload className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Import to Repertoire</span>
              <span className="sm:hidden">Import</span>
            </button>
            <button
              onClick={handleExportPGN}
              className="btn-secondary flex items-center gap-2"
              title="Export generated tree as PGN"
            >
              <Download className="w-3.5 h-3.5" />
              <span>Export</span>
            </button>
          </div>
        )}
      </div>

      {/* 3-column layout */}
      <div className="flex flex-1 min-h-0 flex-col overflow-y-auto md:overflow-hidden md:flex-row">
        {/* Left: Settings */}
        <div
          className="shrink-0 border-b border-border-subtle bg-bg-surface overflow-hidden flex flex-col md:border-b-0 md:border-r"
          style={isMobile ? undefined : { width: '280px', minWidth: '260px' }}
        >
          <GeneratorSettingsPanel
            settings={settings}
            setSettings={setSettings}
            onGenerate={handleGenerate}
            onStop={handleStop}
            isGenerating={busy}
            canGenerate={canGenerate}
            onLoadSeeds={(seeds) => gen.loadSeeds(seeds, settings.color)}
          />
        </div>

        {/* Center: Board + Nav + Details + Progress */}
        <div className="flex-none flex flex-col overflow-visible p-4 gap-4 md:flex-1 md:overflow-auto">
          {/* Chessboard — interactive when not generating */}
          <div className="flex justify-center">
            <div style={{ width: isMobile ? 'min(100%, 320px)' : `${generatorBoardWidth}px`, maxWidth: '100%' }}>
              <Chessboard
                position={displayFen}
                boardOrientation={settings.color === 'black' ? 'black' : 'white'}
                boardWidth={generatorBoardWidth}
                isDraggablePiece={() => !busy}
                onPieceDrop={handlePieceDrop}
                onSquareClick={handleSquareClick}
                onPieceClick={handlePieceClick}
                customSquareStyles={customSquareStyles}
                customDarkSquareStyle={{ backgroundColor: themeColors.dark }}
                customLightSquareStyle={{ backgroundColor: themeColors.light }}
                customBoardStyle={{
                  borderRadius: '4px',
                  boxShadow: '0 2px 8px rgba(0,0,0,0.15)',
                }}
                customDropSquareStyle={{
                  boxShadow: `inset 0 0 1px 6px ${themeColors.dark}80`,
                }}
                animationDuration={200}
              />
            </div>
          </div>

          {/* Navigation controls */}
          <div className="flex items-center justify-center gap-1">
            <button
              onClick={gen.goToRoot}
              disabled={busy || !gen.selectedNode || gen.selectedNode.isRoot}
              className="btn-icon p-1.5 disabled:opacity-30"
              title="Go to start"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
            <button
              onClick={gen.goToParent}
              disabled={busy || !gen.selectedNode || gen.selectedNode.isRoot}
              className="btn-icon p-1.5 disabled:opacity-30"
              title="Previous move (Left arrow)"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => gen.goToChild(0)}
              disabled={busy || !gen.selectedNode || gen.selectedNode.children.length === 0}
              className="btn-icon p-1.5 disabled:opacity-30"
              title="Next move (Right arrow)"
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            <div className="w-px h-5 bg-border-subtle mx-1" />

            <button
              onClick={gen.deleteSelected}
              disabled={busy || !gen.selectedNode || gen.selectedNode.isRoot}
              className="btn-icon p-1.5 disabled:opacity-30 hover:text-accent-red"
              title="Delete this move and its sub-tree"
            >
              <Trash2 className="w-4 h-4" />
            </button>

            {!isMobile && (
              <>
                <div className="w-px h-5 bg-border-subtle mx-1" />
                <button
                  onClick={() => setBoardExpanded((prev) => !prev)}
                  className="btn-icon p-1.5"
                  title={boardExpanded ? 'Shrink board' : 'Expand board'}
                >
                  {boardExpanded ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
                </button>
              </>
            )}

            {/* Current position hint */}
            {node && !node.isRoot && node.san && (
              <span className="ml-3 font-mono text-xs text-text-muted">
                {node.isRoot ? 'Starting position' : `${node.fullMoveNumber}${node.fen.split(' ')[1] === 'b' ? '.' : '...'} ${node.san}`}
              </span>
            )}
            {(!node || node.isRoot) && (
              <span className="ml-3 text-xs text-text-muted">Starting position</span>
            )}
          </div>

          {/* Node Detail */}
          {node && (
            <div className="panel">
              <div className="p-3">
                <div className="flex items-center gap-3 mb-2">
                  <span className="font-mono text-sm font-semibold text-text-primary">
                    {node.isRoot ? 'Starting position' : `${node.fullMoveNumber}${node.fen.split(' ')[1] === 'b' ? '.' : '...'} ${node.san}`}
                  </span>
                  {node.isMainLine && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-accent-teal/10 text-accent-teal">
                      MAIN
                    </span>
                  )}
                  {node.isDangerous && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-accent-red/10 text-accent-red">
                      DANGER
                    </span>
                  )}
                  {node.isSeed && (
                    <span className="text-[9px] font-mono px-1.5 py-0.5 rounded bg-accent-amber/10 text-accent-amber">
                      SEED
                    </span>
                  )}
                </div>
                {node.reason && <p className="text-xs text-text-secondary mb-2">{node.reason}</p>}
                {node.warning && <p className="text-xs text-accent-amber mb-2">{node.warning}</p>}
                {node.endReason && <p className="text-xs text-text-muted mb-2">{END_REASON_LABELS[node.endReason]}</p>}
                {node.responseCoverage !== undefined && <p className="text-xs text-text-muted mb-2">Replies shown cover {(node.responseCoverage * 100).toFixed(0)}% of database games at this position.</p>}
                <div className="flex gap-4 text-[11px] text-text-muted">
                  {node.stockfish && node.stockfish.eval !== null && (
                    <span>
                      Eval: {node.stockfish.eval >= 0 ? '+' : ''}{node.stockfish.eval.toFixed(2)} (d{node.stockfish.depth})
                    </span>
                  )}
                  {node.lichess && (
                    <span>
                      Lichess: {node.lichess.totalGames} games |
                      W{Math.round(node.lichess.winRate)}%
                      D{Math.round(node.lichess.drawRate)}%
                      L{Math.round(node.lichess.lossRate)}%
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Progress + Log */}
          <GeneratorProgressBar
            progress={gen.progress}
            isGenerating={busy}
            errorLog={gen.errorLog}
          />
          {isMobile && <div className="panel min-h-48"><GeneratorMoveTree tree={gen.tree} selectedNode={gen.selectedNode} onSelect={handleNodeSelect} color={settings.color} onClear={handleClear} disabled={busy} /></div>}

        </div>

        {/* Right: Move Tree */}
        {!isMobile && (
          <div
            className="border-l border-border-subtle bg-bg-surface overflow-hidden flex flex-col"
            style={{ width: '340px', minWidth: '280px' }}
          >
            <GeneratorMoveTree
              tree={gen.tree}
              selectedNode={gen.selectedNode}
              onSelect={handleNodeSelect}
              color={settings.color}
              onClear={handleClear}
              disabled={busy}
            />
          </div>
        )}
      </div>
    </div>
  );
};
