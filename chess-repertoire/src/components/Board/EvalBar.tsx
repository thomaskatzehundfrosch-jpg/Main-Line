import React from 'react';

interface EvalBarProps {
  score: number;
  mate: number | null;
  height: number;
}

const EvalBar: React.FC<EvalBarProps> = ({ score, mate, height }) => {
  // Calculate white's winning percentage
  let whitePercentage = 50;

  if (mate !== null) {
    // If mate is found, set to 100% for white winning, 0% for black winning
    whitePercentage = mate > 0 ? 100 : 0;
  } else {
    // Formula: percentage = 50 + (score / 10), clamped to 2-98
    whitePercentage = 50 + score / 10;
    whitePercentage = Math.max(2, Math.min(98, whitePercentage));
  }

  const blackPercentage = 100 - whitePercentage;

  // Format the score text
  let scoreText = '';
  if (mate !== null) {
    scoreText = `M${Math.abs(mate)}`;
  } else {
    const pawns = (score / 100).toFixed(1);
    scoreText = score >= 0 ? `+${pawns}` : pawns;
  }

  // Determine text color based on which side is winning
  const isWhiteWinning = whitePercentage > 50;
  const textColor = isWhiteWinning ? 'text-white' : 'text-slate-900';

  return (
    <div
      className="eval-bar-container relative bg-gradient-to-b from-slate-300 to-slate-400 rounded transition-all duration-500"
      style={{ height: `${height}px` }}
    >
      {/* White portion (bottom) */}
      <div
        className="absolute bottom-0 left-0 right-0 bg-white transition-all duration-500"
        style={{ height: `${whitePercentage}%` }}
      />

      {/* Score text overlay */}
      <div
        className={`absolute inset-0 flex items-center justify-center text-[10px] font-mono font-bold ${textColor} pointer-events-none`}
      >
        {scoreText}
      </div>
    </div>
  );
};

export default EvalBar;
