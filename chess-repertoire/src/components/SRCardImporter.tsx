import React, { useState, useCallback } from 'react';
import { Chess } from 'chess.js';
import { Plus, Check, AlertCircle } from 'lucide-react';
import { createCard } from '../lib/srScheduler';
import { addCards } from '../lib/srStorage';

interface SRCardImporterProps {
  onCardsChanged?: () => void;
}

export const SRCardImporter: React.FC<SRCardImporterProps> = ({
  onCardsChanged,
}) => {
  const [fen, setFen] = useState('');
  const [moveUci, setMoveUci] = useState('');
  const [lineName, setLineName] = useState('');
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const handleAdd = useCallback(() => {
    const trimmedFen = fen.trim();
    const trimmedMove = moveUci.trim();

    if (!trimmedFen || !trimmedMove) return;

    // Validate FEN
    try {
      new Chess(trimmedFen);
    } catch {
      setFeedback({ type: 'error', message: 'Invalid FEN position' });
      setTimeout(() => setFeedback(null), 3000);
      return;
    }

    // Validate move is legal
    try {
      const chess = new Chess(trimmedFen);
      const from = trimmedMove.slice(0, 2);
      const to = trimmedMove.slice(2, 4);
      const promotion =
        trimmedMove.length > 4 ? trimmedMove[4] : undefined;
      const move = chess.move({
        from,
        to,
        promotion,
      } as { from: string; to: string; promotion?: string });
      if (!move) {
        setFeedback({ type: 'error', message: 'Illegal move for this position' });
        setTimeout(() => setFeedback(null), 3000);
        return;
      }
    } catch {
      setFeedback({ type: 'error', message: 'Invalid UCI move format' });
      setTimeout(() => setFeedback(null), 3000);
      return;
    }

    const card = createCard(
      trimmedFen,
      trimmedMove,
      lineName.trim() || undefined,
      trimmedFen.split(' ')[1] === 'b' ? 'black' : 'white',
    );
    addCards([card]);

    setFen('');
    setMoveUci('');
    setLineName('');
    setFeedback({ type: 'success', message: 'Card added!' });

    onCardsChanged?.();

    setTimeout(() => setFeedback(null), 2000);
  }, [fen, moveUci, lineName, onCardsChanged]);

  return (
    <div className="bg-gray-800 rounded-lg p-3 space-y-2">
      <textarea
        value={fen}
        onChange={(e) => setFen(e.target.value)}
        placeholder="FEN position (e.g. rnbqkbnr/pppppppp/8/8/4P3/8/PPPP1PPP/RNBQKBNR b KQkq - 0 1)"
        className="w-full bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 resize-none font-mono"
        rows={2}
      />
      <div className="flex gap-2">
        <input
          value={moveUci}
          onChange={(e) => setMoveUci(e.target.value)}
          placeholder="UCI move (e.g. e2e4)"
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500 font-mono"
        />
        <input
          value={lineName}
          onChange={(e) => setLineName(e.target.value)}
          placeholder="Line name (optional)"
          className="flex-1 bg-gray-900 border border-gray-700 rounded px-2.5 py-1.5 text-xs text-gray-200 placeholder-gray-500 focus:outline-none focus:border-blue-500"
        />
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={handleAdd}
          disabled={!fen.trim() || !moveUci.trim()}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white text-xs rounded transition-colors"
        >
          <Plus className="w-3 h-3" />
          Add Card
        </button>
        {feedback && (
          <span
            className={`flex items-center gap-1 text-xs ${
              feedback.type === 'success' ? 'text-blue-400' : 'text-red-400'
            }`}
          >
            {feedback.type === 'success' ? (
              <Check className="w-3 h-3" />
            ) : (
              <AlertCircle className="w-3 h-3" />
            )}
            {feedback.message}
          </span>
        )}
      </div>
    </div>
  );
};
