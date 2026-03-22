/**
 * Progress bar and error log for the generator.
 */

import React from 'react';
import type { GeneratorProgress, GeneratorLogEntry } from '../../types/generator';

interface GeneratorProgressProps {
  progress: GeneratorProgress;
  isGenerating: boolean;
  errorLog: GeneratorLogEntry[];
}

export const GeneratorProgressBar: React.FC<GeneratorProgressProps> = ({
  progress,
  isGenerating,
  errorLog,
}) => {
  const pct = progress.maxNodes > 0
    ? Math.min(100, Math.round((progress.nodes / progress.maxNodes) * 100))
    : 0;

  return (
    <div className="space-y-3">
      {/* Progress Bar */}
      {(isGenerating || progress.nodes > 0) && (
        <div className="panel">
          <div className="p-3">
            <div className="flex justify-between text-[11px] text-text-secondary mb-1.5">
              <span>{progress.status || 'Idle'}</span>
              <span>
                {progress.nodes}/{progress.maxNodes} nodes ({pct}%)
              </span>
            </div>
            <div className="w-full h-1.5 bg-bg-hover rounded-full overflow-hidden">
              <div
                className="h-full bg-accent-teal rounded-full transition-all duration-200"
                style={{ width: `${pct}%` }}
              />
            </div>
            {progress.apiCalls > 0 && (
              <div className="text-[10px] text-text-muted mt-1">
                {progress.apiCalls} Lichess API call{progress.apiCalls !== 1 ? 's' : ''}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Error Log */}
      {errorLog.length > 0 && (
        <div className="panel">
          <div className="px-3 py-2 border-b border-border-subtle">
            <span className="text-[10px] font-mono text-text-muted uppercase tracking-wider">
              Log ({errorLog.length})
            </span>
          </div>
          <div className="max-h-32 overflow-y-auto custom-scrollbar p-2 space-y-0.5">
            {errorLog.slice(-30).map((entry) => {
              let levelClass = 'text-text-muted';
              if (entry.level === 'warning') levelClass = 'text-accent-amber';
              if (entry.level === 'error') levelClass = 'text-accent-red';

              return (
                <div key={entry.id} className="flex gap-2 text-[10px] font-mono leading-relaxed">
                  <span className="text-text-muted flex-shrink-0">{entry.timestamp}</span>
                  <span className={`flex-shrink-0 uppercase ${levelClass}`}>
                    [{entry.level.substring(0, 4)}]
                  </span>
                  <span className="text-text-secondary truncate">{entry.message}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
};
