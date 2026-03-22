import React from 'react';
import { NAG_SYMBOLS } from '../../types';

interface NotesPanelProps {
  comment: string;
  nags: number[];
  onCommentChange: (comment: string) => void;
  onAddNag: (nag: number) => void;
  onRemoveNag: (nag: number) => void;
  nodeId: string;
}

// Common NAGs for quick access
const COMMON_NAGS = [
  { nag: 1, symbol: '!', meaning: 'Good move' },
  { nag: 2, symbol: '?', meaning: 'Mistake' },
  { nag: 3, symbol: '!!', meaning: 'Brilliant move' },
  { nag: 4, symbol: '??', meaning: 'Blunder' },
  { nag: 5, symbol: '!?', meaning: 'Interesting move' },
  { nag: 6, symbol: '?!', meaning: 'Dubious move' },
];

export const NotesPanel: React.FC<NotesPanelProps> = ({
  comment,
  nags,
  onCommentChange,
  onAddNag,
  onRemoveNag,
  nodeId,
}) => {
  const handleNagToggle = (nag: number) => {
    if (nags.includes(nag)) {
      onRemoveNag(nag);
    } else {
      onAddNag(nag);
    }
  };

  const isNagActive = (nag: number): boolean => {
    return nags.includes(nag);
  };

  return (
    <div className="panel flex flex-col">
      <div className="panel-header">NOTES</div>

      <div className="p-3 space-y-3 flex-1 overflow-auto">
        {/* NAG Buttons */}
        <div className="flex flex-wrap gap-1">
          {COMMON_NAGS.map(({ nag, symbol, meaning }) => {
            const isActive = isNagActive(nag);

            return (
              <button
                key={nag}
                onClick={() => handleNagToggle(nag)}
                title={meaning}
                className={`
                  px-2 py-1 rounded text-sm font-semibold border transition-colors
                  ${
                    isActive
                      ? 'bg-accent-teal/20 text-accent-teal border-accent-teal/30'
                      : 'bg-bg-hover text-text-muted border-border-subtle hover:border-accent-teal/50 hover:text-text-primary'
                  }
                `}
              >
                {symbol}
              </button>
            );
          })}
        </div>

        {/* Comment Textarea */}
        <textarea
          key={nodeId}
          value={comment}
          onChange={(e) => onCommentChange(e.target.value)}
          placeholder="Add notes for this position..."
          className="
            bg-bg-primary border border-border-subtle rounded-lg p-3 w-full h-24
            resize-y font-sans text-sm text-text-primary placeholder-text-muted
            focus:border-accent-teal/50 focus:outline-none transition-colors
          "
        />
      </div>
    </div>
  );
};

export default NotesPanel;
