import React, { useRef, useState, useEffect, useCallback } from 'react';
import { Chessboard } from 'react-chessboard';
import type { Square, Arrow, Piece } from 'react-chessboard/dist/chessboard/types';
import { Chess } from 'chess.js';
import EvalBar from './EvalBar';

interface ChessBoardProps {
  fen: string;
  orientation: 'white' | 'black';
  onMove: (from: string, to: string, piece: string) => boolean;
  engineBestMove?: string[];
  lastMove?: { from: string; to: string };
  score?: number;
  mate?: number | null;
}

const ChessBoard: React.FC<ChessBoardProps> = ({
  fen,
  orientation,
  onMove,
  engineBestMove,
  lastMove,
  score = 0,
  mate = null,
}) => {
  const boardContainerRef = useRef<HTMLDivElement>(null);
  const [boardWidth, setBoardWidth] = useState(480);
  const [selectedSquare, setSelectedSquare] = useState<string | null>(null);
  const [legalMoves, setLegalMoves] = useState<string[]>([]);

  // Measure board container width on mount and resize
  useEffect(() => {
    const updateBoardWidth = () => {
      if (boardContainerRef.current) {
        const containerWidth = boardContainerRef.current.offsetWidth;
        const width = Math.max(300, Math.min(600, containerWidth - 50));
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
  }, []);

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
        const turn = chess.turn(); // 'w' or 'b'
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
      // If we have a selected piece and clicked a legal target
      if (selectedSquare && legalMoves.includes(square)) {
        // Try to determine the piece for promotion
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

      // If clicking on own piece, select it (or re-select a different piece)
      if (isOwnPiece(square)) {
        if (selectedSquare === square) {
          // Deselect
          setSelectedSquare(null);
          setLegalMoves([]);
        } else {
          // Select new piece
          setSelectedSquare(square);
          setLegalMoves(getLegalMovesForSquare(square));
        }
        return;
      }

      // Clicking on empty square or opponent piece with no selection
      setSelectedSquare(null);
      setLegalMoves([]);
    },
    [selectedSquare, legalMoves, fen, isOwnPiece, getLegalMovesForSquare, onMove]
  );

  // Handle piece click (fired by react-chessboard when clicking on a piece)
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
            ? 'rgba(59,98,160,0.7)'  // Blue for best move
            : 'rgba(240,165,0,0.5)'; // Orange for alternatives
        return [from, to, color] as Arrow;
      })
    : [];

  // Style for last move highlighting + selection + legal move dots
  const customSquareStyles: Record<string, React.CSSProperties> = {};
  if (lastMove) {
    customSquareStyles[lastMove.from] = {
      backgroundColor: 'rgba(59,98,160,0.15)',
    };
    customSquareStyles[lastMove.to] = {
      backgroundColor: 'rgba(59,98,160,0.15)',
    };
  }

  // Highlight selected square
  if (selectedSquare) {
    customSquareStyles[selectedSquare] = {
      backgroundColor: 'rgba(59,98,160,0.35)',
    };
  }

  // Show legal move indicators
  for (const sq of legalMoves) {
    // Check if the target square has a piece (capture)
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
        background: 'radial-gradient(circle, transparent 55%, rgba(59,98,160,0.4) 55%)',
      };
    } else {
      customSquareStyles[sq] = {
        ...customSquareStyles[sq],
        background: 'radial-gradient(circle, rgba(59,98,160,0.35) 25%, transparent 25%)',
      };
    }
  }

  const handlePieceDrop = (
    sourceSquare: Square,
    targetSquare: Square,
    piece: Piece
  ): boolean => {
    // Clear click-to-move selection on drag
    setSelectedSquare(null);
    setLegalMoves([]);
    return onMove(sourceSquare, targetSquare, piece);
  };

  return (
    <div
      ref={boardContainerRef}
      className="flex items-start gap-0 rounded-lg p-2"
    >
      {/* Evaluation Bar */}
      <div className="mr-1">
        <EvalBar score={score} mate={mate} height={boardWidth} />
      </div>

      {/* Chessboard */}
      <div className="flex-1">
        <Chessboard
          position={fen}
          onPieceDrop={handlePieceDrop}
          onSquareClick={handleSquareClick}
          onPieceClick={handlePieceClick}
          boardWidth={boardWidth}
          boardOrientation={orientation}
          isDraggablePiece={() => true}
          customDarkSquareStyle={{ backgroundColor: '#4b6fa0' }}
          customLightSquareStyle={{ backgroundColor: '#e8dcc0' }}
          customBoardStyle={{ borderRadius: '4px' }}
          customDropSquareStyle={{
            boxShadow: 'inset 0 0 1px 6px rgba(59,98,160,0.5)',
          }}
          customSquareStyles={customSquareStyles}
          animationDuration={200}
          customArrows={customArrows.length > 0 ? customArrows : undefined}
        />
      </div>
    </div>
  );
};

export default ChessBoard;
