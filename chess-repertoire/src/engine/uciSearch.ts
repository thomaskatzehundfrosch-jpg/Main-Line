/** UCI readyok is not a search barrier: only bestmove acknowledges stop. */
export class UnresponsiveEngineError extends Error {}
type Metrics = {
  fen: string; requestedDepth: number; multiPV: number; depth: number;
  engineTimeMs: number; nodes: number; nps: number; wallTimeMs: number;
  outcome: 'complete' | 'failed' | 'cancelled';
};
type SearchState = { searching: boolean; unusable: boolean; dispose?: () => void };
const states = new WeakMap<Worker, SearchState>();
const reporters = new WeakMap<Worker, (metrics: Metrics) => void>();
export function setEngineDiagnostics(worker: Worker, report: (metrics: Metrics) => void) {
  reporters.set(worker, report);
}
function stateFor(worker: Worker) {
  let state = states.get(worker);
  if (!state) { state = { searching: false, unusable: false }; states.set(worker, state); }
  return state;
}

/** Called immediately before go. Keep tracking bestmove even after a timeout. */
export function trackEngineSearch(worker: Worker, fen: string, requestedDepth: number, multiPV: number) {
  const state = stateFor(worker);
  if (state.searching || state.unusable) throw new UnresponsiveEngineError('Stockfish previous search has not finished.');
  state.searching = true;
  const started = Date.now();
  const metrics: Metrics = { fen, requestedDepth, multiPV, depth: 0, engineTimeMs: 0, nodes: 0, nps: 0, wallTimeMs: 0, outcome: 'failed' };
  const listener = (event: MessageEvent<string>) => {
    const line = event.data;
    if (typeof line !== 'string') return;
    if (line.startsWith('bestmove')) {
      state.searching = false;
      state.dispose?.();
    } else if (line.startsWith('info ')) {
      for (const [field, token] of [['depth', 'depth'], ['engineTimeMs', 'time'], ['nodes', 'nodes'], ['nps', 'nps']] as const) {
        const value = line.match(new RegExp(`\\b${token} (\\d+)`));
        if (value) metrics[field] = Number(value[1]);
      }
    }
  };
  state.dispose = () => { worker.removeEventListener('message', listener); state.dispose = undefined; };
  worker.addEventListener('message', listener);
  let reported = false;
  return (outcome: Metrics['outcome']) => {
    if (reported) return;
    reported = true;
    reporters.get(worker)?.({ ...metrics, outcome, wallTimeMs: Date.now() - started });
  };
}

/** Send isready only after the previous go has produced its final bestmove. */
export function synchronizeEngineSearch(worker: Worker, ready: () => void, fail: (error: Error) => void, timeoutMs = 3000): () => void {
  const state = stateFor(worker);
  if (state.unusable) { fail(new UnresponsiveEngineError('Stockfish worker is unresponsive and must be replaced.')); return () => {}; }
  let waitingForStop = state.searching;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', listener); };
  const listener = (event: MessageEvent<string>) => {
    if (waitingForStop) {
      if (typeof event.data !== 'string' || !event.data.startsWith('bestmove')) return;
      waitingForStop = false;
      clearTimeout(timer);
      timer = setTimeout(unresponsive, timeoutMs);
      worker.postMessage('isready');
    } else if (event.data === 'readyok') {
      cleanup(); ready();
    }
  };
  worker.addEventListener('message', listener);
  const unresponsive = () => {
    cleanup(); state.dispose?.(); state.unusable = true;
    worker.terminate();
    fail(new UnresponsiveEngineError(`Stockfish did not acknowledge ${waitingForStop ? 'stop with bestmove' : 'isready with readyok'} within ${timeoutMs}ms; worker must be replaced.`));
  };
  timer = setTimeout(unresponsive, timeoutMs);
  const wasSearching = waitingForStop;
  worker.postMessage('stop');
  if (!wasSearching) worker.postMessage('isready');
  return cleanup;
}
