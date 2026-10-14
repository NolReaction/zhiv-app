export const ENGINE_TIMINGS = ["paint", "commit", "undo", "save", "export"] as const;
export type EngineTimingName = typeof ENGINE_TIMINGS[number];
export type EngineTimingSummary = {
  /** Total completed measurements since reset; samples is the bounded retained window. */
  count: number; samples: number;
  latestMs: number | null; medianMs: number | null; p95Ms: number | null;
};
export type EngineProfilerSnapshot = {
  enabled: boolean; capacity: number; timings: Record<EngineTimingName, EngineTimingSummary>;
};
export type EngineProfiler = ReturnType<typeof createEngineProfiler>;
type TimingWindow = { values: number[]; next: number; count: number; latest: number | null };

/** Opt-in operation timings, not FPS. No timer, global clock or sample allocation while disabled. */
export function createEngineProfiler(options: { clock?: () => number; capacity?: number; enabled?: boolean } = {}) {
  const capacity = options.capacity ?? 120;
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 2048) throw new RangeError("Diagnostic sample capacity must be between 1 and 2048.");
  const clock = options.clock ?? (() => globalThis.performance?.now() ?? Date.now());
  let enabled = options.enabled ?? false, generation = 0;
  const windows = new Map<EngineTimingName, TimingWindow>();
  function now(): number | null {
    try { const value = clock(); return Number.isFinite(value) ? value : null; }
    catch { return null; }
  }
  function record(name: EngineTimingName, durationMs: number) {
    if (!enabled || !ENGINE_TIMINGS.includes(name) || !Number.isFinite(durationMs) || durationMs < 0) return;
    let window = windows.get(name);
    if (!window) { window = { values: [], next: 0, count: 0, latest: null }; windows.set(name, window); }
    window.values[window.next] = durationMs; window.next = (window.next + 1) % capacity;
    window.count++; window.latest = durationMs;
  }
  function finish(name: EngineTimingName, start: number | null, startedGeneration: number) {
    if (!enabled || generation !== startedGeneration || start === null) return;
    const end = now(); if (end !== null) record(name, end - start);
  }
  function measure<T>(name: EngineTimingName, operation: () => T): T {
    if (!enabled) return operation();
    const start = now(), startedGeneration = generation;
    try { return operation(); }
    finally { finish(name, start, startedGeneration); }
  }
  function measureAsync<T>(name: EngineTimingName, operation: () => Promise<T>): Promise<T> {
    if (!enabled) return operation();
    const start = now(), startedGeneration = generation;
    try { return Promise.resolve(operation()).finally(() => finish(name, start, startedGeneration)); }
    catch (error) { finish(name, start, startedGeneration); throw error; }
  }
  function snapshot(): EngineProfilerSnapshot {
    const timings = Object.fromEntries(ENGINE_TIMINGS.map(name => {
      const window = windows.get(name), sorted = window?.values.slice().sort((a, b) => a - b) ?? [];
      const size = sorted.length, middle = Math.floor(size / 2);
      return [name, { count: window?.count ?? 0, samples: size, latestMs: window?.latest ?? null,
        medianMs: size ? size % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2 : null,
        p95Ms: size ? sorted[Math.ceil(size * .95) - 1] : null }];
    })) as Record<EngineTimingName, EngineTimingSummary>;
    return { enabled, capacity, timings };
  }
  return {
    get enabled() { return enabled; },
    setEnabled(value: boolean) { if (enabled !== value) { enabled = value; generation++; } },
    measure, measureAsync, record, snapshot,
    reset() { generation++; windows.clear(); },
  };
}
