import { useState, useCallback, useMemo, useEffect } from 'react';
import { Chess, Move, Square } from 'chess.js';

interface UseChessGameReturn {
  game: Chess;
  fen: string;
  isCheck: boolean;
  isCheckmate: boolean;
  isStalemate: boolean;
  isDraw: boolean;
  isGameOver: boolean;
  turn: 'w' | 'b';
  moveHistory: Move[];
  makeMove: (from: Square, to: Square, promotion?: string) => Move | null;
  makeMoveFromSan: (san: string) => Move | null;
  loadFen: (fen: string) => void;
  reset: () => void;
  getLegalMoves: (square: Square) => Square[];
  isLegalMove: (from: Square, to: Square) => boolean;
  undoMove: () => Move | null;
}

/**
 * Custom React hook that wraps chess.js for the chess repertoire explorer.
 * Maintains a Chess instance and provides utilities for game manipulation and state tracking.
 *
 * @param fen - Optional FEN string to initialize the game. Defaults to starting position.
 * @returns Object containing the Chess instance, game state, and manipulation methods.
 */
export function useChessGame(fen?: string): UseChessGameReturn {
  const [game, setGame] = useState<Chess>(() => {
    return new Chess(fen || undefined);
  });

  const [, forceUpdate] = useState<number>(0);

  // Re-initialize game when fen prop changes
  useEffect(() => {
    setGame(new Chess(fen || undefined));
  }, [fen]);

  // Get current FEN string
  const currentFen = useMemo(() => {
    return game.fen();
  }, [game, forceUpdate]);

  // Get game state flags
  const isCheck = useMemo(() => game.inCheck(), [game, forceUpdate]);
  const isCheckmate = useMemo(() => game.isCheckmate(), [game, forceUpdate]);
  const isStalemate = useMemo(() => game.isStalemate(), [game, forceUpdate]);
  const isDraw = useMemo(() => game.isDraw(), [game, forceUpdate]);
  const isGameOver = useMemo(() => game.isGameOver(), [game, forceUpdate]);
  const turn = useMemo(() => game.turn() as 'w' | 'b', [game, forceUpdate]);

  // Get move history
  const moveHistory = useMemo(() => {
    return game.history({ verbose: true });
  }, [game, forceUpdate]);

  /**
   * Attempts to make a move on the board.
   * @param from - Source square
   * @param to - Destination square
   * @param promotion - Optional promotion piece ('q', 'r', 'b', 'n')
   * @returns The move object if successful, null if illegal
   */
  const makeMove = useCallback(
    (from: Square, to: Square, promotion?: string): Move | null => {
      try {
        const move = game.move({
          from,
          to,
          promotion: promotion as 'q' | 'r' | 'b' | 'n' | undefined,
        });

        if (move) {
          // Clone the game to trigger re-render
          setGame(new Chess(game.fen()));
          forceUpdate((prev) => prev + 1);
          return move;
        }

        return null;
      } catch {
        return null;
      }
    },
    [game]
  );

  /**
   * Attempts to make a move from Standard Algebraic Notation (SAN).
   * @param san - Move in SAN notation (e.g., 'e4', 'Nf3', 'O-O')
   * @returns The move object if successful, null if illegal
   */
  const makeMoveFromSan = useCallback(
    (san: string): Move | null => {
      try {
        const move = game.move(san);

        if (move) {
          // Clone the game to trigger re-render
          setGame(new Chess(game.fen()));
          forceUpdate((prev) => prev + 1);
          return move;
        }

        return null;
      } catch {
        return null;
      }
    },
    [game]
  );

  /**
   * Loads a new FEN position.
   * @param newFen - FEN string to load
   */
  const loadFen = useCallback((newFen: string) => {
    const newGame = new Chess(newFen);
    setGame(newGame);
    forceUpdate((prev) => prev + 1);
  }, []);

  /**
   * Resets the game to the starting position.
   */
  const reset = useCallback(() => {
    const newGame = new Chess();
    setGame(newGame);
    forceUpdate((prev) => prev + 1);
  }, []);

  /**
   * Returns an array of legal target squares for a piece on a given square.
   * @param square - The square to check
   * @returns Array of legal destination squares
   */
  const getLegalMoves = useCallback(
    (square: Square): Square[] => {
      const moves = game.moves({ square, verbose: true });
      return moves.map((move) => move.to);
    },
    [game, forceUpdate]
  );

  /**
   * Checks if a move from one square to another is legal.
   * @param from - Source square
   * @param to - Destination square
   * @returns True if the move is legal, false otherwise
   */
  const isLegalMove = useCallback(
    (from: Square, to: Square): boolean => {
      const moves = game.moves({ square: from, verbose: true });
      return moves.some((move) => move.to === to);
    },
    [game, forceUpdate]
  );

  /**
   * Undoes the last move on the board.
   * @returns The move that was undone, or null if no moves to undo
   */
  const undoMove = useCallback((): Move | null => {
    const move = game.undo();

    if (move) {
      // Clone the game to trigger re-render
      setGame(new Chess(game.fen()));
      forceUpdate((prev) => prev + 1);
      return move;
    }

    return null;
  }, [game]);

  return {
    game,
    fen: currentFen,
    isCheck,
    isCheckmate,
    isStalemate,
    isDraw,
    isGameOver,
    turn,
    moveHistory,
    makeMove,
    makeMoveFromSan,
    loadFen,
    reset,
    getLegalMoves,
    isLegalMove,
    undoMove,
  };
}
