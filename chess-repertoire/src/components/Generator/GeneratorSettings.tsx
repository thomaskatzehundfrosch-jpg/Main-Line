import React, { useEffect, useRef, useState } from 'react';
import type { GeneratorSettings, StudySize } from '../../types/generator';
import { normalizeGeneratorSettings, STUDY_SIZES } from '../../types/generator';
import { parsePGN } from '../../utils/generatorPgn';
import { clearStoredToken, getStoredToken, getStoredUsername, startOAuthFlow } from '../../utils/lichessAuth';

interface Props {
  settings: GeneratorSettings;
  setSettings: React.Dispatch<React.SetStateAction<GeneratorSettings>>;
  onGenerate: () => void;
  onStop: () => void;
  isGenerating: boolean;
  canGenerate: boolean;
  onLoadSeeds: (seeds: string[][]) => void;
}
const inputClass = 'w-full rounded border border-border-subtle bg-bg-primary px-2 py-1.5 text-xs text-text-primary';
const labelClass = 'block text-xs text-text-secondary space-y-1';

export const GeneratorSettingsPanel: React.FC<Props> = ({ settings, setSettings, onGenerate, onStop, isGenerating, canGenerate, onLoadSeeds }) => {
  const [pgn, setPgn] = useState('');
  const [pgnError, setPgnError] = useState('');
  const [loaded, setLoaded] = useState('');
  const [connected, setConnected] = useState(() => !!getStoredToken());
  const [username, setUsername] = useState(getStoredUsername);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const updateAuth = () => { setConnected(!!getStoredToken()); setUsername(getStoredUsername()); };
    window.addEventListener('lichess-auth-updated', updateAuth);
    return () => window.removeEventListener('lichess-auth-updated', updateAuth);
  }, []);
  const update = <K extends keyof GeneratorSettings>(key: K, value: GeneratorSettings[K]) =>
    setSettings(prev => normalizeGeneratorSettings({ ...prev, [key]: value }));
  const loadPgn = () => {
    try {
      const lines = parsePGN(pgn);
      if (!lines.length) throw new Error('No moves found. Paste or choose a PGN containing opening moves.');
      onLoadSeeds(lines);
      setLoaded(`${lines.length} starting lines loaded into the board and move tree.`);
      setPgnError('');
      setPgn('');
    } catch (error) { setPgnError(error instanceof Error ? error.message : String(error)); setLoaded(''); }
  };
  const preset = STUDY_SIZES[settings.studySize];
  return <div className="flex flex-col h-full overflow-y-auto custom-scrollbar">
    <fieldset disabled={isGenerating} className="p-4 space-y-4 disabled:opacity-60">
      <p className="text-xs text-text-muted">Your existing moves are preserved. Choose where the generator should add continuations and missing branches.</p>
      <label className={labelClass}>Maximum move number per line
        <input className={inputClass} type="number" min="1" max="40" step="1" value={settings.maxMoveNumber} onChange={e => update('maxMoveNumber', e.target.valueAsNumber)} />
      </label>
      <p className="text-[11px] text-text-muted">Full move numbers: 15 targets move 15 for both sides. Tactical extensions can go beyond this target.</p>
      <label className={labelClass}>Continue existing repertoire
        <select className={inputClass} value={settings.fillBranchesFromMove == null ? 'leaves' : 'fill'}
          onChange={e => update('fillBranchesFromMove', e.target.value === 'fill' ? 1 : undefined)}>
          <option value="leaves">Extend line endings only</option>
          <option value="fill">Fill missing branches from move…</option>
        </select>
      </label>
      {settings.fillBranchesFromMove != null && <label className={labelClass}>Start adding missing replies at move
        <input className={inputClass} type="number" min="1" max="40" step="1"
          value={settings.fillBranchesFromMove}
          onChange={e => update('fillBranchesFromMove', e.target.valueAsNumber)} />
      </label>}
      <p className="text-[11px] text-text-muted">{settings.fillBranchesFromMove == null
        ? 'Starts at the end of each loaded line.'
        : `Checks existing opponent positions from move ${settings.fillBranchesFromMove} onward. Earlier branches are preserved; line endings are also extended. Reply selection follows the opponent profile and branching settings below.`}</p>
      <label className={labelClass}>Generator
        <select aria-label="Generator version" className={inputClass} value={settings.generatorMode} onChange={e => update('generatorMode', e.target.value as GeneratorSettings['generatorMode'])}>
          <option value="opening-lab">Opening Lab Gen</option>
          <option value="legacy">Original Generator</option>
        </select>
      </label>
      <p className="text-[11px] text-text-muted">{settings.generatorMode === 'legacy' ? 'Original move selection and trickiness search.' : 'Opening Lab Gen compares candidates at depth up to 18, then verifies the winner at your selected depth. Uses saved Lichess cloud evaluations when depth and move count are sufficient, with local Stockfish fallback. Supported win rates rank first with at least 100 games; practical evidence breaks ties.'}</p>
      <label className="flex items-center gap-2 text-xs text-text-secondary">
        <input type="checkbox" checked={settings.trustSuppliedMoves} onChange={e => update('trustSuppliedMoves', e.target.checked)} />
        Trust supplied PGN moves — skip verification
      </label>
      <p className="text-[11px] text-text-muted">Supplied moves stay in place. When trusted, generation starts at the leaves; missing-branch completion still inspects opponent positions from your branching-start move. All new moves are verified.</p>
      <label className={labelClass}>Your side
        <select className={inputClass} value={settings.color} onChange={e => update('color', e.target.value as 'white' | 'black')}>
          <option value="white">White</option><option value="black">Black</option>
        </select>
      </label>
      <label className={labelClass}>Opponent profile
        <select className={inputClass} value={settings.analysisMode === 'stockfish' ? 'engine' : settings.useMasters ? 'masters' : 'online'}
          onChange={e => setSettings(prev => ({ ...prev, analysisMode: e.target.value === 'engine' ? 'stockfish' : 'lichess+stockfish', useMasters: e.target.value === 'masters' }))}>
          <option value="masters">Masters games</option><option value="online">Online players</option><option value="engine">Engine defenses only</option>
        </select>
      </label>
      {settings.analysisMode !== 'stockfish' && <div className="space-y-2">
        {!settings.useMasters && <>
          <div className="flex gap-2">
            <label className={labelClass}>Rating from<select className={inputClass} value={settings.ratingMin} onChange={e => update('ratingMin', Number(e.target.value))}>
              {[1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500].map(n => <option key={n}>{n}</option>)}
            </select></label>
            <label className={labelClass}>To<select className={inputClass} value={settings.ratingMax} onChange={e => update('ratingMax', Number(e.target.value))}>
              {[1000, 1200, 1400, 1600, 1800, 2000, 2200, 2500].map(n => <option key={n}>{n}</option>)}
            </select></label>
          </div>
          <div className="flex flex-wrap gap-2 text-xs text-text-secondary">
            {['bullet', 'blitz', 'rapid', 'classical'].map(speed => <label key={speed} className="flex gap-1 items-center">
              <input type="checkbox" checked={settings.speeds.includes(speed)}
                disabled={isGenerating || settings.speeds.length === 1 && settings.speeds.includes(speed)}
                onChange={e => update('speeds', e.target.checked ? [...settings.speeds, speed] : settings.speeds.filter(s => s !== speed))} />{speed}
            </label>)}
          </div>
        </>}
        {connected ? <div className="text-xs text-text-muted flex justify-between gap-2"><span>Connected: {username ?? 'Lichess'}</span>
          <button type="button" onClick={() => { clearStoredToken(); setConnected(false); }}>Disconnect</button></div>
          : <button type="button" className="btn-secondary w-full" onClick={() => startOAuthFlow()}>Connect Lichess</button>}
      </div>}
      <label className={labelClass}>Total move budget
        <select className={inputClass} value={settings.studySize} onChange={e => update('studySize', e.target.value as StudySize)}>
          <option value="compact">150</option><option value="standard">500</option><option value="broad">1200</option>
        </select>
      </label>
      <p className="text-[11px] text-text-muted">{settings.analysisMode === 'stockfish'
        ? `Up to ${preset.maxReplies} engine replies per position.`
        : `Aim to cover ${Math.round(preset.coverage * 100)}% of recorded replies at each position, including the strongest defense; normally up to ${preset.maxReplies} replies. Moves meeting your frequency threshold are included beyond this limit unless branch decay or its budget reservation narrows the position.`}
        {' '}Budget: {preset.maxNodes} moves. Limited data or budget can leave gaps.</p>
      {settings.analysisMode !== 'stockfish' && <div className="space-y-2">
        <label className={labelClass}>Include opponent moves played at least (%)
          <input className={inputClass} type="number" min="1" max="100" step="1" value={settings.opponentMinPlayRate}
            onChange={e => update('opponentMinPlayRate', e.target.valueAsNumber)} />
        </label>
        <p className="text-[11px] text-text-muted">At each position, include all available replies meeting this frequency and the minimum game count, regardless of evaluation. The strongest defense is selected except on single-reply decay branches, which prefer the most likely reply unless the defense is at least 0.5 pawns worse for you. The total move budget and analysis failures can still leave gaps.</p>
        <label className="flex gap-2 text-xs text-text-secondary"><input type="checkbox" checked={settings.adaptiveOpponentDepth}
          onChange={e => update('adaptiveOpponentDepth', e.target.checked)} />Shorten rare opponent branches</label>
        <p className="text-[11px] text-text-muted">Additional replies below this frequency end up to two moves earlier, including your next answer when the current depth limit allows. Common replies and the strongest defense keep the current branch depth. Missing human data does not shorten lines.</p>
      </div>}
      {settings.analysisMode !== 'stockfish' && <div className="space-y-2">
        <label className={labelClass}>Trickiness for your moves
          <select className={inputClass} value={settings.trickiness} onChange={e => update('trickiness', e.target.value as GeneratorSettings['trickiness'])}>
            <option value="off">Off</option><option value="balanced">Balanced</option><option value="high">High</option>
          </select>
        </label>
        {settings.trickiness !== 'off' && <>
          <div className="grid grid-cols-2 gap-2">
            <label className={labelClass}>Minimum sacrifice (pawns)
              <input className={inputClass} type="number" min="0" max="5" step="0.1" value={settings.trickinessMinLoss} onChange={e => update('trickinessMinLoss', e.target.valueAsNumber)} />
            </label>
            <label className={labelClass}>Maximum sacrifice (pawns)
              <input className={inputClass} type="number" min="0" max="5" step="0.1" value={settings.trickinessMaxLoss} onChange={e => update('trickinessMaxLoss', e.target.valueAsNumber)} />
            </label>
          </div>
          <p className="text-[11px] text-text-muted">Search this loss interval relative to the best verified continuation, from your side’s perspective. Final verification uses local Stockfish for a consistent comparison. Below +1, the maximum loss is capped at 1 minus your evaluation; a minimum above that cap is relaxed to zero. At +1 or better, protect the advantage: choose the strongest full-depth verified candidate, ignoring minimum sacrifice and practical bonuses. Reversed bounds are sorted. Replaces the normal allowed-loss setting while enabled. If no candidate offers a supported practical improvement, keep the best move within the maximum loss. If none meets that limit, leave the continuation unfinished. Uses your opponent profile; small samples count less. Examining replies makes generation slower. Opening Lab Gen checks up to six contenders and three replies each; unchecked replies remain unknown.</p>
        </>}
      </div>}
      <div className="space-y-2">
        <label className="flex gap-2 text-xs text-text-secondary"><input type="checkbox" checked={settings.evaluationFloorEnabled}
          onChange={e => update('evaluationFloorEnabled', e.target.checked)} />Use an overall evaluation floor</label>
        {settings.evaluationFloorEnabled && <label className={labelClass}>Minimum acceptable evaluation (your side)
          <input className={inputClass} type="number" min="-10" max="10" step="0.1" value={settings.evaluationFloor}
            onChange={e => update('evaluationFloor', e.target.valueAsNumber)} />
        </label>}
        <p className="text-[11px] text-text-muted">Prevents repeated sacrifices from crossing this evaluation. Applies with or without trickiness. If already below it, choose the strongest verified continuation without a practical bonus. The per-move loss limit still applies; if no candidate qualifies, the branch remains unfinished.</p>
      </div>
      <label className={labelClass}>Branch decay
        <select className={inputClass} value={settings.branchDecay} onChange={e => update('branchDecay', e.target.value as GeneratorSettings['branchDecay'])}>
          <option value="off">Off</option><option value="gentle">Gentle</option><option value="balanced">Balanced</option>
        </select>
      </label>
      <p className="text-[11px] text-text-muted">Keeps the first two generated opponent turns wide, then narrows unlikely paths. Reserves budget to continue existing lines. Overrides frequency and coverage targets when necessary. With decay enabled, rare lines keep the full target depth instead of ending two moves earlier. Missing frequencies do not make a path rare.</p>
      <details className="text-xs text-text-secondary">
        <summary className="cursor-pointer py-1">Advanced preferences</summary>
        <div className="space-y-3 pt-3">
          <label className={labelClass}>{settings.generatorMode === 'opening-lab' ? 'Final verification depth' : 'Analysis quality'}
            <select className={inputClass} value={settings.sfDepth} onChange={e => update('sfDepth', Number(e.target.value))}>
              <option value="12">12</option><option value="16">16</option><option value="20">20</option><option value="25">25</option>
            </select>
          </label>
          <label className={labelClass}>Allowed loss from current evaluation (pawns)
            <input className={inputClass} type="number" min="0" max="1" step="0.1" value={settings.maxEvalLoss} onChange={e => update('maxEvalLoss', e.target.valueAsNumber)} />
          </label>
          <label className={labelClass}>Extra moves for checks and captures
            <select className={inputClass} value={settings.tacticalExtension} onChange={e => update('tacticalExtension', Number(e.target.value))}>
              {[0, 1, 2, 3, 4].map(n => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="flex gap-2"><input type="checkbox" checked={settings.avoidQueenTrades} onChange={e => update('avoidQueenTrades', e.target.checked)} />Prefer to avoid immediate queen exchanges</label>
          <p className="text-[11px] text-text-muted">Only among moves within your allowed evaluation loss. Later exchanges may still happen.</p>
          {settings.analysisMode !== 'stockfish' && <label className={labelClass}>Minimum games supporting a move
            <input className={inputClass} type="number" min="1" max="10000" value={settings.minGames} onChange={e => update('minGames', e.target.valueAsNumber)} />
          </label>}
        </div>
      </details>
      <details className="text-xs text-text-secondary">
        <summary className="cursor-pointer py-1">Load starting moves from PGN</summary>
        <p className="text-[11px] text-text-muted my-2">Replaces the current generator tree. Review and edit the loaded moves on the board before generating.</p>
        <textarea aria-label="Starting PGN" className={inputClass} rows={4} value={pgn} onChange={e => { setPgn(e.target.value); setPgnError(''); setLoaded(''); }} />
        <div className="flex gap-2 mt-2">
          <button type="button" className="btn-secondary" onClick={() => fileInput.current?.click()}>Choose file</button>
          <button type="button" className="btn-primary" disabled={!pgn.trim()} onClick={loadPgn}>Load moves</button>
        </div>
        <input ref={fileInput} type="file" accept=".pgn" className="hidden" onChange={async e => {
          const file = e.target.files?.[0];
          if (file) try { setPgn(await file.text()); setPgnError(''); setLoaded(''); } catch { setPgnError('Could not read this file.'); }
          if (fileInput.current) fileInput.current.value = '';
        }} />
        {pgnError && <p role="alert" className="text-accent-red mt-2">{pgnError}</p>}
        {loaded && <p role="status" className="text-accent-teal mt-2">{loaded}</p>}
      </details>
    </fieldset>
    <div className="sticky bottom-0 p-4 border-t border-border-subtle bg-bg-surface mt-auto">
      {settings.analysisMode !== 'stockfish' && !connected && <p className="text-xs text-accent-amber mb-2">Connect Lichess or choose engine defenses to generate.</p>}
      <button className="btn-primary w-full disabled:opacity-40" disabled={!isGenerating && !canGenerate} onClick={isGenerating ? onStop : onGenerate}>
        {isGenerating ? 'Stop generation' : 'Generate continuations'}
      </button>
    </div>
  </div>;
};
