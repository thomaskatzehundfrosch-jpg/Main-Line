import { useEffect, useState } from 'react';
import { Chess } from 'chess.js';
import { getMostLikelyMoves, type LichessMove } from '../../utils/lichessApi';
import type { GeneratorSettings } from '../../types/generator';
import { getStoredToken } from '../../utils/lichessAuth';

const cache = new Map<string, LichessMove[]>();

interface Props {
  fen: string;
  rating: number;
  onRatingChange: (rating: number) => void;
  onMove: (move: LichessMove) => void;
  onConnect: () => void;
  interactive: boolean;
}

export function MoveExplorer({ fen, rating, onRatingChange, onMove, onConnect, interactive }: Props) {
  const [result, setResult] = useState<{ key: string; moves: LichessMove[]; error?: string }>({ key: '', moves: [] });
  const [retry, setRetry] = useState(0);
  const key = `${fen}|${rating}`;
  const connected = Boolean(getStoredToken());
  useEffect(() => {
    if (!connected) return;
    const controller = new AbortController();
    const cached = cache.get(key);
    if (cached) { setResult({ key, moves: cached }); return; }
    const timer = window.setTimeout(() => {
      getMostLikelyMoves(fen, {
        color: 'white', useMasters: false, ratingMin: rating, ratingMax: 2500,
        speeds: ['blitz', 'rapid', 'classical'],
      } as GeneratorSettings, () => {}, 100, controller.signal).then(moves => {
        if (controller.signal.aborted) return;
        if (cache.size >= 200) cache.delete(cache.keys().next().value!);
        cache.set(key, moves);
        setResult({ key, moves });
      }).catch(error => {
        if (!controller.signal.aborted) setResult({ key, moves: [], error: error.message || 'Could not load move statistics.' });
      });
    }, 250);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [fen, rating, key, connected, retry]);

  const side = new Chess(fen).turn() === 'w' ? 'White' : 'Black';
  return (
    <section className="border-t border-border-subtle" aria-label="Opening explorer">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <div>
          <h3 className="text-xs font-mono uppercase tracking-wider text-text-primary">Opening explorer</h3>
          <p className="mt-0.5 text-[10px] text-text-muted">Lichess · Blitz, rapid & classical · {side} to move</p>
        </div>
        <select aria-label="Explorer minimum rating" value={rating} onChange={e => onRatingChange(Number(e.target.value))}
          className="rounded border border-border-subtle bg-bg-primary px-2 py-1 text-xs text-text-primary">
          {[1600, 1800, 2000, 2200, 2500].map(value => <option key={value} value={value}>{value}+</option>)}
        </select>
      </div>
      {!connected ? <div className="px-3 pb-3 text-xs text-text-muted">Connect Lichess to see move statistics.
        <button className="btn-secondary mt-2 block" onClick={onConnect}>Connect Lichess</button>
      </div> : result.key !== key ? <p className="px-3 pb-3 text-xs text-text-muted" role="status">Loading move statistics…</p>
        : result.error ? <div className="px-3 pb-3 text-xs text-accent-red" role="alert">{result.error}
          <button className="btn-secondary mt-2 block" onClick={() => { setResult({ key: '', moves: [] }); setRetry(value => value + 1); }}>Retry</button>
        </div> : result.moves.length === 0 ? <p className="px-3 pb-3 text-xs text-text-muted">No recorded games for this position and rating range.</p> : <>
          <div className="grid grid-cols-[54px_65px_65px_1fr] gap-2 px-3 py-1.5 text-[10px] text-text-muted border-y border-border-subtle">
            <span>Move</span><span className="text-right">Played</span><span className="text-right">Games</span><span>White / Draw / Black</span>
          </div>
          <div className="max-h-[280px] overflow-y-auto">
            {result.moves.map(move => <button key={move.uci} disabled={!interactive} onClick={() => onMove(move)}
              title={`${move.san}: played ${move.playRate.toFixed(1)}%; White wins ${move.winRate.toFixed(1)}%, draws ${move.drawRate.toFixed(1)}%, Black wins ${move.lossRate.toFixed(1)}%. Click to play.`}
              className="grid w-full grid-cols-[54px_65px_65px_1fr] items-center gap-2 border-b border-border-subtle px-3 py-2 text-xs hover:bg-bg-hover disabled:cursor-default text-left">
              <span className="font-semibold text-text-primary">{move.san}</span>
              <span className="text-right font-mono text-accent-teal">{move.playRate.toFixed(1)}%</span>
              <span className="text-right tabular-nums text-text-secondary">{move.totalGames.toLocaleString()}</span>
              <span className="flex h-6 overflow-hidden rounded border border-border-subtle text-[9px] font-mono" aria-label={`White ${move.winRate.toFixed(1)}%, draw ${move.drawRate.toFixed(1)}%, Black ${move.lossRate.toFixed(1)}%`}>
                {[{ rate: move.winRate, color: 'bg-[#f0f0eb] text-[#262626]' }, { rate: move.drawRate, color: 'bg-[#92958e] text-white' }, { rate: move.lossRate, color: 'bg-[#343731] text-white' }].map((segment, index) =>
                  <span key={index} className={`flex items-center justify-center ${segment.color}`} style={{ width: `${segment.rate}%` }}>{segment.rate >= 15 ? `${Math.round(segment.rate)}%` : ''}</span>)}
              </span>
            </button>)}
          </div>
          <p className="px-3 py-1.5 text-[10px] text-text-muted">Played = frequency in this position. Results show win rates and draws.</p>
        </>}
    </section>
  );
}
