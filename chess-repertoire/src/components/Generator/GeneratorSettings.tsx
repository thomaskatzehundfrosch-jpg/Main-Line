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
      <p className="text-xs text-text-muted">Your existing moves are preserved. Generate adds continuations at the ends of your lines.</p>
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
      <label className={labelClass}>Study size
        <select className={inputClass} value={settings.studySize} onChange={e => update('studySize', e.target.value as StudySize)}>
          <option value="compact">Compact</option><option value="standard">Standard</option><option value="broad">Broad</option>
        </select>
      </label>
      <p className="text-[11px] text-text-muted">{settings.analysisMode === 'stockfish'
        ? `Up to ${preset.maxReplies} engine replies per position.`
        : `Aim to cover ${Math.round(preset.coverage * 100)}% of recorded replies at each position, including the strongest defense; normally up to ${preset.maxReplies} replies. Moves meeting your frequency threshold are included beyond this limit.`}
        {' '}Budget: {preset.maxNodes} moves. Limited data or budget can leave gaps.</p>
      {settings.analysisMode !== 'stockfish' && <div className="space-y-2">
        <label className={labelClass}>Include opponent moves played at least (%)
          <input className={inputClass} type="number" min="1" max="100" step="1" value={settings.opponentMinPlayRate}
            onChange={e => update('opponentMinPlayRate', e.target.valueAsNumber)} />
        </label>
        <p className="text-[11px] text-text-muted">At each position, include all available replies meeting this frequency and the minimum game count, regardless of evaluation. The strongest defense is always selected. The total move budget and analysis failures can still leave gaps.</p>
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
          <p className="text-[11px] text-text-muted">Search this loss interval relative to the best verified candidate. Reversed bounds are sorted. Replaces the normal allowed-loss setting while enabled. If no candidate offers a supported practical improvement, keep the best move. Uses your opponent profile; small samples count less. Examining replies makes generation slower.</p>
        </>}
      </div>}
      <label className={labelClass}>Target move number
        <input className={inputClass} type="number" min="1" max="40" value={settings.maxMoveNumber} onChange={e => update('maxMoveNumber', e.target.valueAsNumber)} />
      </label>
      <details className="text-xs text-text-secondary">
        <summary className="cursor-pointer py-1">Advanced preferences</summary>
        <div className="space-y-3 pt-3">
          <label className={labelClass}>Analysis quality
            <select className={inputClass} value={settings.sfDepth} onChange={e => update('sfDepth', Number(e.target.value))}>
              <option value="12">Quick</option><option value="16">Standard</option><option value="20">Thorough</option><option value="25">Deep — slower</option>
            </select>
          </label>
          <label className={labelClass}>Allowed loss versus best candidate (pawns)
            <input className={inputClass} type="number" min="0" max="1" step="0.1" value={settings.maxEvalLoss} onChange={e => update('maxEvalLoss', e.target.valueAsNumber)} />
          </label>
          <label className={labelClass}>Extra moves for checks and captures
            <select className={inputClass} value={settings.tacticalExtension} onChange={e => update('tacticalExtension', Number(e.target.value))}>
              {[0, 1, 2, 3, 4].map(n => <option key={n} value={n}>{n === 0 ? 'Off' : n}</option>)}
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
