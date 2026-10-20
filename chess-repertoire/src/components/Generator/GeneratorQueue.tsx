import React, { useEffect, useRef, useState } from 'react';
import type { UseGeneratorReturn } from '../../hooks/useGenerator';
import type { GeneratorNode, GeneratorSettings } from '../../types/generator';
import { normalizeGeneratorSettings } from '../../types/generator';
import { parsePGN } from '../../utils/generatorPgn';
import { buildSeedTree } from '../../utils/generatorSeeds';

type Job = { id: string; name: string; seeds: string[][]; settings: GeneratorSettings;
  status: 'queued' | 'running' | 'done' | 'paused' | 'failed'; tree?: GeneratorNode; error?: string };
const KEY = 'main-line-generator-queue-v1';
function readJobs(): Job[] {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    return saved.filter(j => typeof j.id === 'string' && typeof j.name === 'string' && Array.isArray(j.seeds) && j.settings)
      .map(j => ({ ...j, settings: normalizeGeneratorSettings(j.settings), status: j.status === 'running' ? 'paused' : j.status }));
  } catch { return []; }
}

export function GeneratorQueue({ gen, settings, setSettings, connected }: {
  gen: UseGeneratorReturn; settings: GeneratorSettings; setSettings: (settings: GeneratorSettings) => void; connected: boolean;
}) {
  const [jobs, setJobs] = useState<Job[]>(readJobs);
  const [running, setRunning] = useState(false);
  const active = useRef<string | null>(null);
  const observedRunning = useRef(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [moves, setMoves] = useState('');
  const [error, setError] = useState('');
  const [storageError, setStorageError] = useState('');
  const liveTree = useRef(gen.tree);
  liveTree.current = gen.tree;
  const update = (id: string, value: Partial<Job>) => setJobs(prev => prev.map(j => j.id === id ? { ...j, ...value } : j));

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify(jobs)); setStorageError(''); }
    catch { setStorageError('Could not save the queue on this device. Export results before closing.'); }
  }, [jobs]);

  // Save each running job separately, rather than relying on the single-run recovery slot.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (active.current && liveTree.current) update(active.current, { tree: liveTree.current });
    }, 5000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!running || gen.isGenerating || active.current) return;
    const next = jobs.find(j => j.status === 'queued' || j.status === 'paused');
    if (!next) { setRunning(false); return; }
    if (next.settings.analysisMode !== 'stockfish' && !connected) {
      setError('Connect Lichess before running this queue.'); setRunning(false); return;
    }
    active.current = next.id;
    observedRunning.current = false;
    const initialTree = next.tree ?? buildSeedTree(next.seeds, next.settings.color);
    liveTree.current = initialTree;
    gen.setTree(initialTree);
    gen.setSelectedNode(initialTree);
    setSelected(next.id);
    setSettings(next.settings);
    update(next.id, { status: 'running', error: undefined });
    gen.startGeneration(next.settings, next.seeds, null, tree => {
      update(next.id, { status: 'done', tree });
      active.current = null;
    }, cause => {
      update(next.id, { status: 'failed', error: cause.message, tree: liveTree.current ?? undefined });
      active.current = null;
      setRunning(false);
    }, next.tree);
  }, [running, gen.isGenerating, jobs, connected]);

  // Stop can also come from the generator's existing Stop button.
  useEffect(() => {
    if (gen.isGenerating && active.current) observedRunning.current = true;
    if (!gen.isGenerating && active.current && observedRunning.current && gen.progress.outcome === 'stopped') {
      update(active.current, { status: 'paused', tree: gen.tree ?? undefined });
      active.current = null;
      setRunning(false);
    }
  }, [gen.isGenerating, gen.progress.outcome, gen.tree]);

  function add(label: string, pgn?: string) {
    try {
      const seeds = pgn === undefined ? gen.getSeeds() : parsePGN(pgn);
      if (!seeds.length) throw new Error('Enter starting moves or build a starting line on the board.');
      buildSeedTree(seeds, settings.color);
      setJobs(prev => [...prev, { id: crypto.randomUUID(), name: label.trim() || `Variation ${prev.length + 1}`,
        seeds, settings: structuredClone(settings), status: 'queued' }]);
      setName(''); setMoves(''); setError('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
  }
  function open(job: Job) {
    if (gen.isGenerating || running) return;
    setSettings(job.settings);
    if (job.tree) { gen.setTree(job.tree); gen.setSelectedNode(job.tree); }
    else gen.loadSeeds(job.seeds, job.settings.color);
    setSelected(job.id);
  }
  const locked = running || gen.isGenerating;
  return <section className="border-b border-border-subtle bg-bg-surface px-4 py-3 text-xs space-y-2">
    <div className="flex flex-wrap items-center gap-2">
      <strong className="text-text-primary">Overnight queue</strong>
      <span className="text-text-muted">{jobs.filter(j => j.status === 'done').length}/{jobs.length} finished · one run at a time</span>
      <button className="btn-primary" disabled={locked || !jobs.some(j => ['queued', 'paused'].includes(j.status))}
        onClick={() => { setError(''); setRunning(true); }}>Run all</button>
      {running && <button className="btn-secondary" onClick={() => { setRunning(false); gen.stopGeneration(); }}>Stop queue</button>}
    </div>
    <div className="flex flex-wrap gap-2">
      <input aria-label="Variation name" placeholder="Variation name" value={name} disabled={locked} onChange={e => setName(e.target.value)} className="bg-bg-primary border border-border-subtle rounded px-2 py-1" />
      <input aria-label="Starting moves" placeholder="1. e4 c5 2. Nf3… (blank uses board)" value={moves} disabled={locked} onChange={e => setMoves(e.target.value)} className="flex-1 min-w-48 bg-bg-primary border border-border-subtle rounded px-2 py-1" />
      <button className="btn-secondary" disabled={locked} onClick={() => add(name, moves.trim() || undefined)}>Add variation</button>
    </div>
    <p className="text-text-muted">New jobs use the current settings. Click a row to view its starting line or saved result. Keep this tab open and your computer awake.</p>
    {jobs.length > 0 && <ul className="max-h-44 overflow-y-auto space-y-1" aria-label="Variation queue">
      {jobs.map(job => <li key={job.id} className={`flex items-center gap-2 rounded border ${selected === job.id ? 'border-accent-teal' : 'border-border-subtle'}`}>
        <button disabled={locked} onClick={() => open(job)} className="flex-1 min-w-0 text-left px-2 py-2" aria-pressed={selected === job.id}>
          <span className="font-semibold">{job.name}</span> <span className="text-text-muted">· {job.status} · {job.settings.color} · {job.settings.studySize}</span>
          <span className="block text-text-secondary truncate">{job.seeds.map(s => s.join(' ')).join(' / ')}</span>
          {job.error && <span className="block text-red-400">{job.error}</span>}
        </button>
        <button disabled={locked} className="btn-secondary" onClick={() => update(job.id, { settings: structuredClone(settings), tree: undefined, status: 'queued', error: undefined })} title="Replace this job’s settings with the current settings and restart it">Use current settings</button>
        {['done', 'failed'].includes(job.status) && <button disabled={locked} className="btn-secondary" onClick={() => update(job.id, { status: 'queued', tree: job.status === 'failed' ? job.tree : undefined, error: undefined })}>Requeue</button>}
        <button disabled={locked} aria-label={`Remove ${job.name}`} className="btn-secondary mr-2" onClick={() => setJobs(prev => prev.filter(j => j.id !== job.id))}>×</button>
      </li>)}
    </ul>}
    {(error || storageError) && <p role="alert" className="text-red-400">{error || storageError}</p>}
  </section>;
}
