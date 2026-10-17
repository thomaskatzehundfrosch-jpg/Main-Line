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
  const [rating, setRating] = useState(2000);
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
  const [menu, setMenu] = useState<{ x: number; y: number; candidate: any; line: LabMove[] } | null>(null);
  useEffect(() => {
    const dismiss = () => setMenu(null);
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    document.addEventListener('click', dismiss); document.addEventListener('keydown', key);
    window.addEventListener('resize', dismiss); window.addEventListener('scroll', dismiss, true);
    return () => { document.removeEventListener('click', dismiss); document.removeEventListener('keydown', key); window.removeEventListener('resize', dismiss); window.removeEventListener('scroll', dismiss, true); };
  }, []);
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

  async function start(deep = false, targetUci?: string, moreVariants = false) {
    if (busy) return;
    if (!deep && !validLimits) { setError('Enter valid search settings within the displayed ranges.'); return; }
    const id = ++generation.current;
    const current = () => generation.current === id;
    const client = new LabEngine((message: string) => { if (current()) setPhase(message); });
    const db = new HumanDatabase(getStoredToken(), undefined, deep ? result.settings.rating ?? 2000 : rating);
    const deeperDepth = Math.min(40, Math.max(depth, result?.settings.depth || 0, result?.deep?.depth || 0) + 2);
    const settings = deep ? { ...result.settings, depth: deeperDepth, bypassCache } : {
      side: new Chess(fen).turn(), rating, depth, manual, bypassCache, engineVariant: 'single',
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
        ? await deepen(structuredClone(result), client, db, mode, update, { targetUci: targetUci || selected || undefined, maxReplies: moreVariants ? 8 : 5, firstMaxReplies: moreVariants ? 6 : 3, coverage: moreVariants ? .95 : .8 })
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
    <p className="text-text-muted">Lichess {result?.settings.rating ?? rating} rapid · click lines to preview and inspect · right-click for actions.</p>
    <div className="flex gap-2 items-center flex-wrap">
      <label>Depth <select aria-label="Opening Lab depth" disabled={busy} value={depth} onChange={e => setDepth(Number(e.target.value))} className="bg-bg-surface border border-border-subtle rounded p-1">{[12,16,20,25,30,35,40].map(d => <option key={d}>{d}</option>)}</select></label>
      <button className={actionClass} disabled={busy || new Chess(fen).isGameOver()} onClick={() => void start()}>Investigate</button>
      {busy && <button className={actionClass} onClick={stop}>Stop</button>}
      {!getStoredToken() && <button className={actionClass} onClick={() => void startOAuthFlow().catch(e => setError(String(e)))}>Connect Lichess</button>}
    </div>
    <details className="border border-border-subtle rounded p-2 space-y-2">
      <summary className="cursor-pointer font-semibold">Search settings · evaluation & evidence</summary>
      <label className="block pt-2">Lichess rating group<select aria-label="Lichess rating group" disabled={busy} value={rating} onChange={e => setRating(Number(e.target.value))} className="w-full bg-bg-surface border border-border-subtle rounded p-1">{[400,1000,1200,1400,1600,1800,2000,2200,2500].map(elo => <option key={elo} value={elo}>{elo}</option>)}</select></label>
      <p className="text-text-muted">Uses Lichess explorer rating groups, based on both players’ average rating. Click Investigate to apply; deeper searches keep the original group.</p>
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
    {menu && <div role="menu" aria-label="Opening Lab line actions" className="fixed z-50 w-60 rounded border border-border-subtle bg-bg-surface shadow-xl p-1" style={{ left: menu.x, top: menu.y }} onClick={event => event.stopPropagation()} onContextMenu={event => event.preventDefault()}>
      <button role="menuitem" className="block w-full text-left p-2 hover:text-accent-teal" onClick={() => { onSave(menu.line); setMenu(null); }}>Add to line</button>
      <button role="menuitem" disabled={busy || !menu.candidate.sound || !menu.candidate.repliesComplete} className="block w-full text-left p-2 hover:text-accent-teal disabled:opacity-40" onClick={() => { const target = menu.candidate.uci; setMenu(null); choose(menu.candidate); void start(true, target, true); }}>Investigate deeper · more variants</button>
      <button role="menuitem" className="block w-full text-left p-2 text-text-muted" onClick={() => setMenu(null)}>Close</button>
    </div>}
    {error && <p role="alert" className="text-accent-amber">{error}</p>}
    {result && <>
      <label className="flex gap-2 items-center">Rank by <select className="bg-bg-surface p-1" value={mode} onChange={e => setMode(e.target.value)}><option value="tricks">Human difficulty / rare moves</option><option value="wins">Supported win rate</option></select></label>
      <p className="text-text-muted">Click a line for details. Right-click for line actions.</p>
      {candidates.map((c: any) => {
        let moves: LabMove[] = [];
        try { moves = labLine(fen, suggestionLine(c).moves); } catch { /* Live PV may be incomplete. */ }
        return <button key={c.uci} aria-expanded={selected === c.uci}
          onMouseEnter={() => onHover(c.uci)} onMouseLeave={() => onHover(null)} onFocus={() => onHover(c.uci)} onBlur={() => onHover(null)}
          onClick={() => { if (selected === c.uci) { setSelected(null); onPreview([]); } else choose(c); }}
          onContextMenu={event => { event.preventDefault(); if (moves.length) setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 260)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 150)), candidate: c, line: moves }); }}
          className={`block w-full text-left rounded border px-2 py-2 font-mono leading-relaxed ${selected === c.uci ? 'border-accent-teal bg-accent-teal/10' : 'border-border-subtle'}`}>
          {moves.length ? moves.map(m => m.move).join(' ') : c.san}
        </button>;
      })}
      {candidate && <div className="border border-accent-teal/40 rounded p-2 space-y-2">
        <strong>{candidate.san} · line details</strong>
        <p>{candidate.mate != null ? `Mate ${candidate.mate}` : candidate.cp != null ? `Evaluation ${(candidate.cp / 100).toFixed(2)}` : 'Evaluation pending'} · depth {candidate.depth || '—'} · {candidate.sound == null ? 'Soundness pending' : candidate.sound ? 'Within limits' : 'Outside limits'}</p>
        <p className="text-text-muted">{recommendations.find((choice: any) => choice.candidate.uci === candidate.uci)?.basis || 'Checked alternative'}{result.status !== 'complete' ? ' · provisional' : ''}</p>
        <p className="text-text-muted">Baseline {result.baseline == null ? 'pending' : (result.baseline / 100).toFixed(2)} · sacrifice {candidate.sacrifice == null ? 'unknown' : (candidate.sacrifice / 100).toFixed(2)} / {(result.settings.tolerance / 100).toFixed(2)} allowed · floor {(result.settings.floor / 100).toFixed(2)}. Scores favour the side to move at the investigation root.</p>
        <p>{candidate.outcomes?.games ? `${candidate.outcomes.games} games · ${(candidate.outcomes.winRate * 100).toFixed(0)}% wins · ${(candidate.outcomes.draws / candidate.outcomes.games * 100).toFixed(0)}% draws` : 'No recorded sample'}</p>
        <p className="text-text-muted">Reply coverage {((candidate.coverage || 0) * 100).toFixed(0)}% · {candidate.outcomes?.games >= result.settings.minGames && candidate.replyData?.games >= result.settings.minGames ? `mistake opportunity ${((candidate.weightedLoss || 0) / 100).toFixed(2)} pawns` : 'Limited human evidence'}. This is not a win probability.</p>
        {candidate.defenceEvidence && <p className="text-text-muted">Estimated adequate defences: {candidate.defenceEvidence.adequateCount ?? 'unknown'} · frequency upper bound {(candidate.defenceEvidence.adequateUpper * 100).toFixed(0)}%</p>}
        <div className="flex gap-1 flex-wrap">{line.map((m, i) => <button key={i} className={actionClass} onClick={() => onPreview(line.slice(0, i + 1))}>{m.move}</button>)}</div>
        <p className="text-text-muted">{selectedPreview?.basis}. Click preview nodes in the tree to step through the line.</p>
        <div className="flex gap-2"><button className={actionClass} disabled={!line.length} onClick={() => choose(candidate)}>Refresh preview</button><button className={actionClass} disabled={!line.length || saved} onClick={() => { onSave(line); setSaved(true); }}>{saved ? 'Added' : 'Add to line'}</button><button className={actionClass} onClick={() => { onPreview([]); setSelected(null); }}>Clear preview</button></div>
        {(candidate.replies || []).map((r: any) => <div key={r.uci} className="text-text-muted">{r.san} · {(r.frequency * 100).toFixed(1)}% · {r.games} games · {r.lossCp == null ? 'mate / unknown loss' : `${(r.lossCp / 100).toFixed(2)} pawn loss`}{r.supported ? '' : ' · sparse sample'}</div>)}
        {(candidate.deep?.branches || []).flatMap((branch: any) => (branch.replies || []).map((reply: any) => {
          if (!branch.ownMove || !reply.punishment?.length) return null;
          let variant: LabMove[];
          try { variant = labLine(fen, [candidate.uci, branch.reply, branch.ownMove, reply.uci, ...reply.punishment]); } catch { return null; }
          return <button key={`${branch.reply}-${reply.uci}`} className="block w-full text-left font-mono p-2 rounded border border-border-subtle hover:text-accent-teal" onClick={() => { onPreview(variant); setSelectedPreview({ line: variant, basis: 'Recorded replies with engine continuation' }); setSaved(false); }} onContextMenu={event => { event.preventDefault(); setMenu({ x: Math.max(8, Math.min(event.clientX, window.innerWidth - 260)), y: Math.max(8, Math.min(event.clientY, window.innerHeight - 150)), candidate, line: variant }); }}>{variant.map(m => m.move).join(' ')}</button>;
        }))}
        {candidate.deep?.summary && <p>Deeper evidence: {(candidate.deep.summary.lower * 100).toFixed(0)}–{(candidate.deep.summary.upper * 100).toFixed(0)}% mistake coverage bound. Unchecked replies remain unknown.</p>}
      </div>}
      <button className={actionClass} disabled={busy || (result.deep?.depth >= 40) || !(selected ? candidates.some((c: any) => c.uci === selected && c.sound && c.repliesComplete) : deepTargets(result, mode).length)} onClick={() => void start(true)}>Investigate deeper · {selected ? 'selected move' : 'top 2'} · depth {Math.min(40, Math.max(depth, result.settings.depth, result.deep?.depth || 0) + 2)}</button>
      <p className="text-text-muted">Checks a second opponent decision at higher depth. Up to five supported replies per branch, stopping at 80% recorded frequency. Unchecked mass remains unknown.</p>
    </>}
  </div>;
}
