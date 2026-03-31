import React from 'react';
import {
  SkipBack,
  ChevronLeft,
  ChevronRight,
  SkipForward,
  RotateCcw,
  Minimize2,
  Maximize2,
} from 'lucide-react';

interface BoardControlsProps {
  onStart: () => void;
  onBack: () => void;
  onForward: () => void;
  onEnd: () => void;
  onFlip: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onToggleSize?: () => void;
  isBoardAltSize?: boolean;
  sizeToggleMode?: 'minimize' | 'expand';
}

const BoardControls: React.FC<BoardControlsProps> = ({
  onStart,
  onBack,
  onForward,
  onEnd,
  onFlip,
  canGoBack,
  canGoForward,
  onToggleSize,
  isBoardAltSize = false,
  sizeToggleMode = 'minimize',
}) => {
  const isExpandMode = sizeToggleMode === 'expand';
  const sizeToggleTitle = isExpandMode
    ? (isBoardAltSize ? 'Shrink board' : 'Expand board')
    : (isBoardAltSize ? 'Expand board' : 'Minimize board');

  return (
    <div className="flex items-center justify-center gap-1 py-2">
      {/* Navigation buttons */}
      <button
        onClick={onStart}
        disabled={!canGoBack}
        className={`btn-icon ${!canGoBack ? 'opacity-30 cursor-not-allowed' : ''}`}
        title="Start of game"
      >
        <SkipBack size={18} />
      </button>

      <button
        onClick={onBack}
        disabled={!canGoBack}
        className={`btn-icon ${!canGoBack ? 'opacity-30 cursor-not-allowed' : ''}`}
        title="Previous move"
      >
        <ChevronLeft size={18} />
      </button>

      <button
        onClick={onForward}
        disabled={!canGoForward}
        className={`btn-icon ${!canGoForward ? 'opacity-30 cursor-not-allowed' : ''}`}
        title="Next move"
      >
        <ChevronRight size={18} />
      </button>

      <button
        onClick={onEnd}
        disabled={!canGoForward}
        className={`btn-icon ${!canGoForward ? 'opacity-30 cursor-not-allowed' : ''}`}
        title="End of game"
      >
        <SkipForward size={18} />
      </button>

      {/* Separator */}
      <div className="border-l border-border-subtle mx-2 h-6" />

      {/* Flip button */}
      <button
        onClick={onFlip}
        className="btn-icon"
        title="Flip board"
      >
        <RotateCcw size={18} />
      </button>

      {onToggleSize && (
        <>
          <div className="border-l border-border-subtle mx-2 h-6" />
          <button
            onClick={onToggleSize}
            className="btn-icon"
            title={sizeToggleTitle}
          >
            {isExpandMode
              ? (isBoardAltSize ? <Minimize2 size={18} /> : <Maximize2 size={18} />)
              : (isBoardAltSize ? <Maximize2 size={18} /> : <Minimize2 size={18} />)}
          </button>
        </>
      )}
    </div>
  );
};

export default BoardControls;
