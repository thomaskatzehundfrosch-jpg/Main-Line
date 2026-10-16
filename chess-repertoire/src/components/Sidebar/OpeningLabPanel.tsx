import React, { useEffect, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import { LabEngine } from '../../openingLab/engine.js';
import { HumanDatabase } from '../../openingLab/human-data.js';
import { investigate } from '../../openingLab/trickiness.js';
import { deepen, deepTargets } from '../../openingLab/deeper-trickiness.js';
import { suggestionLine, suggestionChoices, orderedCandidates } from '../../openingLab/human-suggestions.js';
import { getStoredToken, startOAuthFlow } from '../../utils/lichessAuth';

export type LabMove = { move: string; fen: string };
export function labLine(fen: string, moves: string[]): LabMove[] {
  const board = new Chess(fen);
  return moves.map(uci => {
    const move = board.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
    return { move: move.san, fen: board.fen() };
  });
}

interface Props {
  fen: string;
  onPreview: (line: LabMove[]) => void;
  onSave: (line: LabMove[]) => void;
  onStart: () => void;
  onHover: (uci: string | null) => void;
}

export function OpeningLabPanel({ fen, onPreview, onSave, onStart, onHover }: Props) {
  const [depth, setDepth] = useState(25);
  const [limits, setLimits] = useState({ tolerance: .7, floor: -.5, baseline: 0, candidateLimit: 6, minGames: 100, minReplyGames: 20, mistakeThreshold: .4, rareThreshold: 5 });
  const [baselineMode, setBaselineMode] = useState('automatic');
  const fields = [
    { key: 'tolerance', label: 'Maximum sacrifice (pawns)', min: 0, max: 5, step: .1 },
    { key: 'floor', label: 'Minimum evaluation (our side)', min: -10, max: 10, step: .1 },
    { key: 'candidateLimit', label: 'Candidate limit', min: 2, max: 12, step: 1 },
    { key: 'minGames', label: 'Minimum games for leaders', min: 1, max: 100000, step: 1 },
    { key: 'minReplyGames', label: 'Minimum games per reply', min: 1, max: 10000, step: 1 },
    { key: 'mistakeThreshold', label: 'Mistake threshold (pawns)', min: .1, max: 5, step: .1 },
    { key: 'rareThreshold', label: 'Rare move threshold (%)', min: .1, max: 100, step: .1 },
  ] as const;
  const validLimits = fields.every(f => Number.isFinite(limits[f.key]) && limits[f.key] >= f.min && limits[f.key] <= f.max && (f.step !== 1 || Number.isInteger(limits[f.key]))) && Number.isFinite(limits.baseline) && limits.baseline >= -10 && limits.baseline <= 10;

  const [bypassCache, setBypassCache] = useState(false);
  const [stats, setStats] = useState({ calls: 0, hits: 0 });
  const [manual, setManual] = useState('');
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState('');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [selectedPreview, setSelectedPreview] = useState<{ line: LabMove[]; basis: string } | null>(null);
  const [mode, setMode] = useState('tricks');
  const run = useRef<{ client: any; db: any; id: number } | null>(null);
  const generation = useRef(0);
  const stop = () => {
    generation.current++;
    run.current?.db.cancel(); run.current?.client.pause(); run.current = null;
    setResult((previous: any) => previous ? { ...previous, status: 'paused' } : previous);
    setBusy(false); setPhase('Stopped — partial findings retained');
  };
  useEffect(() => () => {
    generation.current++; run.current?.db.cancel(); run.current?.client.pause();
  }, []);

  async function start(deep = false) {
    if (busy) return;
    if (!deep && !validLimits) { setError('Enter valid search settings within the displayed ranges.'); return; }
    const id = ++generation.current;
    const current = () => generation.current === id;
    const client = new LabEngine((message: string) => { if (current()) setPhase(message); });
    const db = new HumanDatabase(getStoredToken());
    const deeperDepth = Math.min(40, Math.max(depth, result?.settings.depth || 0, result?.deep?.depth || 0) + 2);
    const settings = deep ? { ...result.settings, depth: deeperDepth, bypassCache } : {
      side: new Chess(fen).turn(), depth, manual, bypassCache, engineVariant: 'single',
      candidateLimit: limits.candidateLimit, minGames: limits.minGames, minReplyGames: limits.minReplyGames,
      floor: Math.round(limits.floor * 100), tolerance: Math.round(limits.tolerance * 100), mistakeThreshold: Math.round(limits.mistakeThreshold * 100), rareThreshold: limits.rareThreshold / 100,
      baselineCp: baselineMode === 'fixed' ? Math.round(limits.baseline * 100) : null,
      callNodes: 0, totalNodes: 0, seconds: 0,
    };
    run.current = { client, db, id };
    setBusy(true); setProgress(0); setStats({ calls: 0, hits: 0 }); setError(''); setSaved(false); onStart();
    if (!deep) { setResult(null); setSelected(null); setSelectedPreview(null); onPreview([]); }
    client.start(settings);
    try {
      setPhase('Starting Stockfish');
      await client.init();
      if (!current()) return;
      const update = (next: any) => {
        if (current()) { setProgress(previous => Math.max(previous, deep ? next.deep?.progress || 0 : next.progress || 0)); setResult(structuredClone(next)); setStats({ ...client.stats }); setPhase(next.deep?.status === 'running' ? next.deep.phase : next.phase); }
      };
      const next = deep
        ? await deepen(structuredClone(result), client, db, mode, update, { targetUci: selected || undefined, maxReplies: 5, coverage: .8 })
        : await investigate({ root: fen, moves: [] }, settings, client, db, update);
      if (current()) { setResult(structuredClone(next)); setError(next.message || next.deep?.message || ''); if (deep) setPhase(`${next.deep.phase} · depth ${deeperDepth}`); }
    } catch (e) {
      if (current()) setError(e instanceof Error ? e.message : String(e));
    } finally {
      client.pause();
      if (current()) { setStats({ ...client.stats }); setBusy(false); run.current = null; }
    }
  }

  const recommendations = suggestionChoices(result, mode);
  const candidates = orderedCandidates(result, mode);
  const candidate = candidates.find((c: any) => c.uci === selected);
  const line = selectedPreview?.line || [];
  const choose = (c: any) => {
    try { const suggestion = suggestionLine(c); const preview = labLine(fen, suggestion.moves); onPreview(preview); setSelectedPreview({ line: preview, basis: suggestion.basis }); setSelected(c.uci); setSaved(false); }
    catch { setError('This continuation is incomplete. Wait for the next update.'); }
  };
  const actionClass = 'px-2 py-1 rounded border border-border-subtle hover:text-accent-teal disabled:opacity-40';
  return <div className="p-3 space-y-3 text-xs overflow-y-auto h-full">
    <div className="font-semibold text-accent-teal">Opening Lab · Stockfish</div>
    <p className="text-text-muted">Investigate the selected tree position using Lichess 2000 rapid games. Click a candidate to preview; save it with Add to line.</p>
    <div className="flex gap-2 items-center flex-wrap">
      <label>Depth <select aria-label="Opening Lab depth" disabled={busy} value={depth} onChange={e => setDepth(Number(e.target.value))} className="bg-bg-surface border border-border-subtle rounded p-1">{[12,16,20,25,30,35,40].map(d => <option key={d}>{d}</option>)}</select></label>
      <button className={actionClass} disabled={busy || new Chess(fen).isGameOver()} onClick={() => void start()}>Investigate</button>
      {busy && <button className={actionClass} onClick={stop}>Stop</button>}
      {!getStoredToken() && <button className={actionClass} onClick={() => void startOAuthFlow().catch(e => setError(String(e)))}>Connect Lichess</button>}
    </div>
    <details className="border border-border-subtle rounded p-2 space-y-2">
      <summary className="cursor-pointer font-semibold">Search settings · evaluation & evidence</summary>
      <div className="grid grid-cols-2 gap-2 pt-2">
        {fields.map(field => <label key={field.key} className="space-y-1">{field.label}<input type="number" aria-label={field.label} min={field.min} max={field.max} step={field.step} disabled={busy} value={limits[field.key]} onChange={e => setLimits(previous => ({ ...previous, [field.key]: Number(e.target.value) }))} className="w-full bg-bg-surface border border-border-subtle rounded p-1" /></label>)}
      </div>
      <label className="block space-y-1">Sacrifice baseline<select aria-label="Sacrifice baseline" className="w-full bg-bg-surface p-1" disabled={busy} value={baselineMode} onChange={e => setBaselineMode(e.target.value)}><option value="automatic">Automatic · strongest searched evaluation</option><option value="fixed">Fixed evaluation</option></select></label>
      {baselineMode === 'fixed' && <label className="block">Baseline evaluation (our side)<input aria-label="Baseline evaluation" type="number" min={-10} max={10} step={.1} disabled={busy} value={limits.baseline} onChange={e => setLimits(previous => ({ ...previous, baseline: Number(e.target.value) }))} className="w-full bg-bg-surface border border-border-subtle rounded p-1" /></label>}
      <p className="text-text-muted">Sacrifice = baseline minus the candidate evaluation, with a minimum of zero. The evaluation floor applies separately. Positive scores favour the side you are preparing for; mate scores stay separate. A fixed baseline changes the reference used to judge sacrifice.</p>
      <p className="text-text-muted">Changes apply when you click Investigate. Deeper searches keep the settings of their original investigation.</p>
    </details>
    <label className="flex items-center gap-2 text-text-muted"><input type="checkbox" checked={bypassCache} disabled={busy} onChange={e => setBypassCache(e.target.checked)} />Recompute engine results (ignore cache)</label>
    <p className="text-text-muted">Same position and depth reuse completed searches. Lichess records are cached for seven days; deeper searches reuse those records.</p>
    <input aria-label="Manual candidate moves" className="w-full bg-bg-surface border border-border-subtle rounded p-2" disabled={busy} value={manual} onChange={e => setManual(e.target.value)} placeholder="Optional candidates in SAN, e.g. Nf3, d4" />
    {(busy || result) && <div className="space-y-1">
      <div className="flex justify-between text-text-muted"><span>Phase progress{!busy && progress < 100 ? ' · incomplete' : ''}</span><span>{Math.round(progress)}%</span></div>
      <div role="progressbar" aria-label="Opening Lab investigation progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress)} aria-valuetext={`${Math.round(progress)}% · ${phase}`} className="h-2 rounded-full bg-bg-surface border border-border-subtle overflow-hidden">
        <div className="h-full bg-accent-teal transition-all duration-300" style={{ width: `${progress}%` }} />
      </div>
      <p className="text-text-muted text-[10px]">Tracks investigation stages; engine search times vary.</p>
    </div>}
    <p role="status" className="text-text-muted">{phase}{busy ? ' · findings provisional' : ''}{result || busy ? ` · ${stats.calls} new engine searches · ${stats.hits} cached searches` : ''}</p>
    {error && <p role="alert" className="text-accent-amber">{error}</p>}
    {result && <>
      <label className="flex gap-2 items-center">Rank by <select className="bg-bg-surface p-1" value={mode} onChange={e => setMode(e.target.value)}><option value="tricks">Human difficulty / rare moves</option><option value="wins">Supported win rate</option></select></label>
      <p className="text-text-muted">Scores are from the side to move’s perspective. Soundness allows up to {(result.settings.tolerance / 100).toFixed(2)} pawn loss and a {(result.settings.floor / 100).toFixed(2)} floor. Baseline: {result.baseline == null ? 'pending' : (result.baseline / 100).toFixed(2)} ({result.settings.baselineCp == null ? 'strongest searched' : 'fixed'}). Human difficulty needs supported data; it is not a win probability.</p>
      {candidates.map((c: any) => <button key={c.uci} onMouseEnter={() => onHover(c.uci)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(c.uci)} onBlur={() => onHover(null)} onClick={() => choose(c)} className={`block w-full text-left rounded border p-2 space-y-1 ${selected === c.uci ? 'border-accent-teal bg-accent-teal/10' : 'border-border-subtle'}`}>
        <span className="flex justify-between"><strong>{c.san}</strong><span>{c.mate != null ? `Mate ${c.mate}` : c.cp != null ? `${(c.cp / 100).toFixed(2)}` : 'Checking…'}</span></span>
        {recommendations.find((choice: any) => choice.candidate.uci === c.uci) && <span className="block text-accent-teal">{recommendations.find((choice: any) => choice.candidate.uci === c.uci)?.basis}{result.status === 'complete' ? '' : ' · provisional'}</span>}
        <span className="block text-text-muted">{c.sound == null ? 'Pending soundness' : c.sound ? 'Within soundness limits' : 'Outside soundness limits'} · depth {c.depth || '—'}{c.sacrifice != null ? ` · ${(c.sacrifice / 100).toFixed(2)} pawn loss vs baseline` : ''}</span>
        <span className="block">{c.outcomes?.games ? `${c.outcomes.games} games · ${(c.outcomes.winRate * 100).toFixed(0)}% wins · ${(c.outcomes.draws / c.outcomes.games * 100).toFixed(0)}% draws` : 'No recorded sample'}</span>
        {c.defenceEvidence && <span className="block text-text-muted">Estimated adequate defences: {c.defenceEvidence.adequateCount ?? '—'} · frequency upper bound {((c.defenceEvidence.adequateUpper || 0) * 100).toFixed(0)}%</span>}
        <span className="block text-text-muted">Reply coverage {((c.coverage || 0) * 100).toFixed(0)}% · {c.outcomes?.games >= result.settings.minGames && c.replyData?.games >= result.settings.minGames ? `mistake opportunity ${((c.weightedLoss || 0) / 100).toFixed(2)} pawns` : 'Limited human evidence'}</span>
      </button>)}
      {candidate && <div className="border border-accent-teal/40 rounded p-2 space-y-2">
        <strong>Preview line</strong>
        <div className="flex gap-1 flex-wrap">{line.map((m, i) => <button key={i} className={actionClass} onClick={() => onPreview(line.slice(0, i + 1))}>{m.move}</button>)}</div>
        <p className="text-text-muted">{selectedPreview?.basis}. Click preview nodes in the tree to step through the line.</p>
        <div className="flex gap-2"><button className={actionClass} disabled={!line.length} onClick={() => choose(candidate)}>Refresh preview</button><button className={actionClass} disabled={!line.length || saved} onClick={() => { onSave(line); setSaved(true); }}>{saved ? 'Added' : 'Add to line'}</button><button className={actionClass} onClick={() => { onPreview([]); setSelected(null); }}>Clear preview</button></div>
        {(candidate.replies || []).map((r: any) => <div key={r.uci} className="text-text-muted">{r.san} · {(r.frequency * 100).toFixed(1)}% · {r.games} games · {r.lossCp == null ? 'mate / unknown loss' : `${(r.lossCp / 100).toFixed(2)} pawn loss`}{r.supported ? '' : ' · sparse sample'}</div>)}
        {candidate.deep?.summary && <p>Deeper evidence: {(candidate.deep.summary.lower * 100).toFixed(0)}–{(candidate.deep.summary.upper * 100).toFixed(0)}% mistake coverage bound. Unchecked replies remain unknown.</p>}
      </div>}
      <button className={actionClass} disabled={busy || (result.deep?.depth >= 40) || !(selected ? candidates.some((c: any) => c.uci === selected && c.sound && c.repliesComplete) : deepTargets(result, mode).length)} onClick={() => void start(true)}>Investigate deeper · {selected ? 'selected move' : 'top 2'} · depth {Math.min(40, Math.max(depth, result.settings.depth, result.deep?.depth || 0) + 2)}</button>
      <p className="text-text-muted">Checks a second opponent decision at higher depth. Up to five supported replies per branch, stopping at 80% recorded frequency. Unchecked mass remains unknown.</p>
    </>}
  </div>;
}
