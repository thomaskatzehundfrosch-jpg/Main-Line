/** Rotate only between awaited searches; never interrupt an active evaluation. */
export function createRecyclingWorkerSession(
  initial: Worker,
  create: () => Promise<Worker>,
  onWorker: (worker: Worker | null) => void,
  signal: AbortSignal,
  limits = { searches: 40, milliseconds: 120000 },
  now = Date.now,
) {
  let worker: Worker | null = initial;
  let searches = 0;
  let started = now();
  const check = () => { if (signal.aborted) throw new DOMException('Generation stopped', 'AbortError'); };
  return async function search<T>(task: (worker: Worker) => Promise<T>): Promise<T> {
    check();
    if (worker && (searches >= limits.searches || now() - started >= limits.milliseconds)) {
      worker.terminate();
      worker = null;
      onWorker(null);
    }
    if (!worker) {
      const replacement = await create();
      if (signal.aborted) { replacement.terminate(); check(); }
      worker = replacement;
      onWorker(worker);
      searches = 0;
      started = now();
    }
    searches++;
    try { return await task(worker); }
    catch (error) {
      // A failed search may leave the WASM engine unhealthy; replace it before reuse.
      worker.terminate();
      worker = null;
      onWorker(null);
      throw error;
    }
  };
}
