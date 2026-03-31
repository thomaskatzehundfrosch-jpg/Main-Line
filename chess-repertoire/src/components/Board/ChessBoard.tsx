import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Chessboard } from 'react-chessboard';
import type { Square, Arrow, Piece } from 'react-chessboard/dist/chessboard/types';
import { Chess } from 'chess.js';
import EvalBar from './EvalBar';
import { useSettings } from '../../context/SettingsContext';
import { BOARD_THEME_COLORS } from './theme';

interface ChessBoardProps {
  fen: string;
  orientation: 'white' | 'black';
  onMove: (from: string, to: string, piece: string) => boolean;
  engineBestMove?: string[];
  lastMove?: { from: string; to: string };
  score?: number;
  mate?: number | null;
  sizeScale?: number;
}

const ChessBoard: React.FC<ChessBoardProps> = ({
  fen,
  orientation,
  onMove,
  engineBestMove,
  lastMove,
  score = 0,
  mate = null,
  sizeScale = 1,
}) => {
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(480);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);

  const { settings } = useSettings();
  const themeColors = BOARD_THEME_COLORS[settings.boardTheme];

  // Measure board container width on mount and resize
  useEffect(() => {
    const updateBoardWidth = () => {
      if (boardContainerRef.current) {
        const containerWidth = boardContainerRef.current.offsetWidth;
        const baseWidth = Math.min(700, containerWidth - 50);
        const minWidth = sizeScale < 1 ? 150 : 300;
        const width = Math.max(minWidth, baseWidth * sizeScale);
        setBoardWidth(width);
      }
    };

    updateBoardWidth();
    const resizeObserver = new ResizeObserver(updateBoardWidth);
    if (boardContainerRef.current) {
      resizeObserver.observe(boardContainerRef.current);
    }

    return () => {
      resizeObserver.disconnect();
    };
  }, [sizeScale]);

  // Clear selection when FEN changes (new position)
  useEffect(() => {
    setSelectedSquare(null);
    setLegalMoves([]);
  }, [fen]);

  // Get legal moves for a square
  const getLegalMovesForSquare = useCallback(
    (square: string): string[] => {
      try {
        const chess = new Chess(fen);
        const moves = chess.moves({ square: square as any, verbose: true });
        return moves.map((m) => m.to);
      } catch {
        return [];
      }
    },
    [fen]
  );

  // Determine if a square has a piece of the current turn color
  const isOwnPiece = useCallback(
    (square: string): boolean => {
      try {
        const chess = new Chess(fen);
        const piece = chess.get(square as any);
        if (!piece) return false;
        const turn = chess.turn();
        return piece.color === turn;
      } catch {
        return false;
      }
    },
    [fen]
  );

  // Handle square click for click-to-move
  const handleSquareClick = useCallback(
    (square: Square, _piece?: Piece) => {
      if (selectedSquare && legalMoves.includes(square)) {
        try {
          const chess = new Chess(fen);
          const piece = chess.get(selectedSquare as any);
          const pieceStr = piece
            ? `${piece.color === 'w' ? 'w' : 'b'}${piece.type.toUpperCase()}`
            : '';
          const success = onMove(selectedSquare, square, pieceStr);
          if (success) {
            setSelectedSquare(null);
            setLegalMoves([]);
            return;
          }
        } catch {
          // fall through
        }
        setSelectedSquare(null);
        setLegalMoves([]);
        return;
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
    [selectedSquare, legalMoves, fen, isOwnPiece, getLegalMovesForSquare, onMove]
  );

  const handlePieceClick = useCallback(
    (piece: Piece, square: Square) => {
      handleSquareClick(square);
    },
    [handleSquareClick]
  );

  // Convert engineBestMove UCI format to arrow format
  const customArrows: Arrow[] = engineBestMove
    ? engineBestMove.map((move, index) => {
        const from = move.substring(0, 2) as Square;
        const to = move.substring(2, 4) as Square;
        const color =
          index === 0
            ? 'rgba(59,98,160,0.7)'
            : 'rgba(240,165,0,0.5)';
        return [from, to, color] as Arrow;
      })
    : [];

  // Square highlight styles
  const customSquareStyles: Record<string, React.CSSProperties> = {};

  if (settings.showLastMoveHighlight && lastMove) {
    customSquareStyles[lastMove.from] = {
      backgroundColor: `${themeColors.dark}30`,
    };
    customSquareStyles[lastMove.to] = {
      backgroundColor: `${themeColors.dark}30`,
    };
  }

  if (selectedSquare) {
    customSquareStyles[selectedSquare] = {
      backgroundColor: `${themeColors.dark}55`,
    };
  }

  if (settings.showLegalMoveHints) {
    for (const sq of legalMoves) {
      let isCapture = false;
      try {
        const chess = new Chess(fen);
        const targetPiece = chess.get(sq as any);
        isCapture = !!targetPiece;
      } catch {
        // ignore
      }

      if (isCapture) {
        customSquareStyles[sq] = {
          ...customSquareStyles[sq],
          background: `radial-gradient(circle, transparent 55%, ${themeColors.dark}60 55%)`,
        };
      } else {
        customSquareStyles[sq] = {
          ...customSquareStyles[sq],
          background: `radial-gradient(circle, ${themeColors.dark}55 25%, transparent 25%)`,
        };
      }
    }
  }

  const handlePieceDrop = (
    sourceSquare: Square,
    targetSquare: Square,
    piece: Piece
  ): boolean => {
    setSelectedSquare(null);
    setLegalMoves([]);
    return onMove(sourceSquare, targetSquare, piece);
  };

  return (
    <div
      ref={boardContainerRef}
      className="flex items-start gap-0 rounded-lg p-2 w-full"
    >
      {/* Evaluation Bar */}
      {settings.showEvalBar && (
        <div className="mr-1 flex-shrink-0">
          <EvalBar score={score} mate={mate} height={boardWidth} />
        </div>
      )}

      {/* Chessboard */}
      <div className="flex-1 min-w-0">
        <Chessboard
          position={fen}
          onPieceDrop={handlePieceDrop}
          onSquareClick={handleSquareClick}
          onPieceClick={handlePieceClick}
          boardWidth={boardWidth}
          boardOrientation={orientation}
          isDraggablePiece={() => true}
          customDarkSquareStyle={{ backgroundColor: themeColors.dark }}
          customLightSquareStyle={{ backgroundColor: themeColors.light }}
          customBoardStyle={{ borderRadius: '4px' }}
          customDropSquareStyle={{
            boxShadow: `inset 0 0 1px 6px ${themeColors.dark}80`,
          }}
          customSquareStyles={customSquareStyles}
          animationDuration={settings.animateMoves ? 200 : 0}
          showBoardNotation={settings.showCoordinates}
          customArrows={customArrows.length > 0 ? customArrows : undefined}
        />
      </div>
    </div>
  );
};

export default ChessBoard;
