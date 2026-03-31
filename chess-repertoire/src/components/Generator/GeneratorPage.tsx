/**
 * Main auto-repertoire generator page.
 * Supports interactive move-playing on the board to build a starting tree,
 * which is then expanded/analysed via the generator engine.
 */

import React, { useState, useCallback, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowLeft,
  Download,
  Upload,
  Cpu,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  Trash2,
} from 'lucide-react';
import { Chessboard } from 'react-chessboard';
import type { Square, Piece } from 'react-chessboard/dist/chessboard/types';
import { Chess } from 'chess.js';
import type { TreeNode } from '../../types';
import type { GeneratorNode, GeneratorSettings } from '../../types/generator';
import { DEFAULT_GENERATOR_SETTINGS } from '../../types/generator';
import { useGenerator } from '../../hooks/useGenerator';
import { useEngine } from '../../hooks/useEngine';
import { GeneratorSettingsPanel } from './GeneratorSettings';
import { GeneratorProgressBar } from './GeneratorProgress';
import { GeneratorMoveTree } from './GeneratorMoveTree';
import { convertToTreeNode } from '../../utils/generatorConverter';
import { exportGeneratorPGN } from '../../utils/generatorPgn';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useSettings } from '../../context/SettingsContext';
import { BOARD_THEME_COLORS } from '../Board/theme';

interface GeneratorPageProps {
  onClose: () => void;
  onImportTree: (tree: TreeNode) => void;
  /** True when this page is the active visible view. When false (user navigated
   *  away), generation still runs but a floating portal chip shows progress. */
  isVisible?: boolean;
}

const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// Module-level cache for settings and pgn seeds — survives navigating away and back
let _cachedSettings: GeneratorSettings = DEFAULT_GENERATOR_SETTINGS;
let _cachedPgnSeeds: string[][] = [];

export const GeneratorPage: React.FC<GeneratorPageProps> = ({ onClose, onImportTree, isVisible = true }) => {
  const engine = useEngine();
  const gen = useGenerator();
  const isMobile = useIsMobile();
  const { settings: appSettings } = useSettings();

  const [settings, _setSettings] = useState<GeneratorSettings>(() => _cachedSettings);
  const [pgnSeeds, _setPgnSeeds] = useState<string[][]>(() => _cachedPgnSeeds);

  const setSettings = useCallback((val: GeneratorSettings | ((prev: GeneratorSettings) => GeneratorSettings)) => {
    _setSettings((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      _cachedSettings = next;
      return next;
    });
  }, []);

  const setPgnSeeds = useCallback((val: string[][] | ((prev: string[][]) => string[][])) => {
    _setPgnSeeds((prev) => {
      const next = typeof val === 'function' ? val(prev) : val;
      _cachedPgnSeeds = next;
      return next;
    });
  }, []);

  /* ---------------------------------------------------------------- */
  /*  Interactive board state (click-to-move)                         */
  /* ---------------------------------------------------------------- */
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);
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
      if (gen.isGenerating) return false;
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
    [displayFen, gen, settings.color]
  );

  /* ---------------------------------------------------------------- */
  /*  Board event handlers                                             */
  /* ---------------------------------------------------------------- */

  const handleSquareClick = useCallback(
    (square: Square) => {
      if (gen.isGenerating) return;

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
    [selectedSquare, legalMoves, displayFen, isOwnPiece, getLegalMovesForSquare, tryMove, gen.isGenerating]
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
      if (gen.isGenerating) return;
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
  }, [gen]);

  /* ---------------------------------------------------------------- */
  /*  Generation / actions                                             */
  /* ---------------------------------------------------------------- */

  const canGenerate = (() => {
    if (gen.isGenerating) return false;
    return engine.enabled && engine.workerReady;
  })();

  const handleGenerate = useCallback(() => {
    const mode = settings.analysisMode || 'stockfish';
    let sfWorker = engine.workerRef.current;

    engine.stopAnalysis();

    // Merge seeds from manually-built tree with any PGN seeds
    const treeSeeds = gen.getSeeds();
    const allSeeds = [...pgnSeeds, ...treeSeeds];

    gen.startGeneration(settings, allSeeds.length > 0 ? allSeeds : null, sfWorker);
  }, [settings, pgnSeeds, engine, gen]);

  const handleStop = useCallback(() => gen.stopGeneration(), [gen]);
  const handleClear = useCallback(() => gen.clearTree(), [gen]);

  const handleNodeSelect = useCallback(
    (node: GeneratorNode) => gen.setSelectedNode(node),
    [gen]
  );

  const handleImport = useCallback(() => {
    if (!gen.tree) return;
    onImportTree(convertToTreeNode(gen.tree));
  }, [gen.tree, onImportTree]);

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

  const node = gen.selectedNode;

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
          Auto Rep Gen
        </h2>
        <span className="hidden text-xs text-text-muted sm:inline">
          Play moves to build a starting tree, then generate analysis
        </span>

        {gen.tree && !gen.isGenerating && (
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
      <div className="flex flex-1 min-h-0 flex-col overflow-hidden md:flex-row">
        {/* Left: Settings */}
        <div
          className="border-b border-border-subtle bg-bg-surface overflow-hidden flex flex-col md:border-b-0 md:border-r"
          style={isMobile ? undefined : { width: '280px', minWidth: '260px' }}
        >
          <GeneratorSettingsPanel
            settings={settings}
            setSettings={setSettings}
            onGenerate={handleGenerate}
            onStop={handleStop}
            isGenerating={gen.isGenerating}
            sfReady={engine.enabled && engine.workerReady}
            canGenerate={canGenerate}
            pgnSeeds={pgnSeeds}
            setPgnSeeds={setPgnSeeds}
          />
        </div>

        {/* Center: Board + Nav + Details + Progress */}
        <div className="flex-1 flex flex-col overflow-auto p-4 gap-4">
          {/* Chessboard — interactive when not generating */}
          <div className="flex justify-center">
            <div style={{ width: isMobile ? 'min(100%, 320px)' : '360px', maxWidth: '100%' }}>
              <Chessboard
                position={displayFen}
                boardOrientation={settings.color === 'black' ? 'black' : 'white'}
                boardWidth={isMobile ? 320 : 360}
                isDraggablePiece={() => !gen.isGenerating}
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
              disabled={!gen.selectedNode || gen.selectedNode.isRoot}
              className="btn-icon p-1.5 disabled:opacity-30"
              title="Go to start"
            >
              <ChevronsLeft className="w-4 h-4" />
            </button>
            <button
              onClick={gen.goToParent}
              disabled={!gen.selectedNode || gen.selectedNode.isRoot}
              className="btn-icon p-1.5 disabled:opacity-30"
              title="Previous move (Left arrow)"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button
              onClick={() => gen.goToChild(0)}
              disabled={!gen.selectedNode || gen.selectedNode.children.length === 0}
              className="btn-icon p-1.5 disabled:opacity-30"
              title="Next move (Right arrow)"
            >
              <ChevronRight className="w-4 h-4" />
            </button>

            <div className="w-px h-5 bg-border-subtle mx-1" />

            <button
              onClick={gen.deleteSelected}
              disabled={!gen.selectedNode || gen.selectedNode.isRoot || gen.isGenerating}
              className="btn-icon p-1.5 disabled:opacity-30 hover:text-accent-red"
              title="Delete this move and its sub-tree"
            >
              <Trash2 className="w-4 h-4" />
            </button>

            {/* Current position hint */}
            {node && !node.isRoot && node.san && (
              <span className="ml-3 font-mono text-xs text-text-muted">
                {node.fullMoveNumber}{node.isOurMove ? '.' : '...'} {node.san}
              </span>
            )}
            {(!node || node.isRoot) && (
              <span className="ml-3 text-xs text-text-muted">Starting position</span>
            )}
          </div>

          {/* Node Detail */}
          {node && !node.isRoot && (
            <div className="panel">
              <div className="p-3">
                <div className="flex items-center gap-3 mb-2">
                  <span className="font-mono text-sm font-semibold text-text-primary">
                    {node.fullMoveNumber}{node.isOurMove ? '.' : '...'} {node.san}
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
            isGenerating={gen.isGenerating}
            errorLog={gen.errorLog}
          />
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
            />
          </div>
        )}
      </div>

      {/* Floating progress chip — shown via portal when generation is running
          but the user has navigated away from this page (isVisible = false). */}
      {gen.isGenerating && !isVisible && createPortal(
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 flex items-center gap-2.5
          bg-bg-surface border border-accent-teal/60 rounded-full px-4 py-2 shadow-xl
          font-mono text-xs text-accent-teal select-none pointer-events-none">
          <span className="w-2 h-2 rounded-full bg-accent-teal animate-pulse flex-shrink-0" />
          <span>
            Generating repertoire&hellip;&nbsp;
            {gen.progress.nodes}/{gen.progress.maxNodes} nodes
            &nbsp;({Math.round((gen.progress.nodes / Math.max(1, gen.progress.maxNodes)) * 100)}%)
          </span>
        </div>,
        document.body
      )}
    </div>
  );
};
