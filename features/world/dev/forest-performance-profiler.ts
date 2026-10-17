export const FOREST_PERFORMANCE_STAGES = ["ai", "navigation", "water", "render", "occupancy"] as const;
export type ForestPerformanceStage = typeof FOREST_PERFORMANCE_STAGES[number];
export type ForestPerformanceSource = "world" | "rehearsal";
export const FOREST_PERFORMANCE_LIMITS = { samples: 240, pending: 32, publishMs: 500 } as const;
export type ForestPerformanceSummary = Readonly<{ stage: ForestPerformanceStage; source: ForestPerformanceSource;
  count: number; averageMs: number; p95Ms: number; maxMs: number }>;
export type ForestPerformanceMemory = Readonly<{ usedBytes: number; allocatedBytes?: number; limitBytes?: number }>;
export type ForestPerformanceSnapshot = Readonly<{ enabled: boolean; summaries: readonly ForestPerformanceSummary[];
  memory: ForestPerformanceMemory | null; memoryStatus: "not-measured" | "unavailable" | "measured" }>;
export type ForestPerformanceToken = Readonly<{ id: number; generation: number; stage: ForestPerformanceStage;
  source: ForestPerformanceSource; started: number }>;
type Bucket = { stage: ForestPerformanceStage; source: ForestPerformanceSource; samples: number[]; cursor: number };
type ProfilerOptions = { allowed: boolean; now?: () => number | null; memory?: () => unknown };
const serverSnapshot: ForestPerformanceSnapshot = Object.freeze({ enabled: false, summaries: Object.freeze([]),
  memory: null, memoryStatus: "not-measured" });
const stages = new Set<string>(FOREST_PERFORMANCE_STAGES);

function browserClock(): number | null {
  return typeof globalThis.performance?.now === "function" ? globalThis.performance.now() : null;
}
function browserMemory(): unknown {
  return (globalThis.performance as Performance & { memory?: unknown } | undefined)?.memory;
}
function finiteMemory(value: unknown): ForestPerformanceMemory | null {
  if (!value || typeof value !== "object") return null;
  const input = value as { usedJSHeapSize?: unknown; totalJSHeapSize?: unknown; jsHeapSizeLimit?: unknown };
  if (typeof input.usedJSHeapSize !== "number" || !Number.isFinite(input.usedJSHeapSize) || input.usedJSHeapSize < 0) return null;
  const allocated = input.totalJSHeapSize, limit = input.jsHeapSizeLimit;
  return Object.freeze({ usedBytes: input.usedJSHeapSize,
    ...(typeof allocated === "number" && Number.isFinite(allocated) && allocated >= input.usedJSHeapSize ? { allocatedBytes: allocated } : {}),
    ...(typeof limit === "number" && Number.isFinite(limit) && limit >= input.usedJSHeapSize ? { limitBytes: limit } : {}) });
}

/** Opt-in CPU call durations, never a simulation clock or an FPS estimate.
 * No timer, observer, clock read or memory read exists while disabled. Buckets
 * are fixed stage/source pairs; even malformed caller labels cannot grow them. */
export function createForestPerformanceProfiler(options: ProfilerOptions) {
  const clock = options.now ?? browserClock, readMemory = options.memory ?? browserMemory;
  const buckets = new Map<string, Bucket>(), pending = new Map<number, ForestPerformanceToken>();
  const context: ForestPerformanceToken[] = [], listeners = new Set<() => void>();
  let enabled = false, generation = 0, sequence = 0, lastPublished = -Infinity;
  let memory: ForestPerformanceMemory | null = null, memoryStatus: ForestPerformanceSnapshot["memoryStatus"] = "not-measured";
  let current = serverSnapshot;
  const readClock = () => {
    try { const now = clock(); return typeof now === "number" && Number.isFinite(now) ? now : null; }
    catch { return null; }
  };
  const publish = () => {
    const summaries = [...buckets.values()].map(bucket => {
      const ordered = [...bucket.samples].sort((a, b) => a - b), count = ordered.length;
      return Object.freeze({ stage: bucket.stage, source: bucket.source, count,
        averageMs: ordered.reduce((sum, value) => sum + value, 0) / count,
        p95Ms: ordered[Math.ceil(count * .95) - 1], maxMs: ordered[count - 1] });
    }).sort((a, b) => a.source.localeCompare(b.source)
      || FOREST_PERFORMANCE_STAGES.indexOf(a.stage) - FOREST_PERFORMANCE_STAGES.indexOf(b.stage));
    current = Object.freeze({ enabled, summaries: Object.freeze(summaries), memory, memoryStatus });
    for (const listener of [...listeners]) {
      try { listener(); } catch { /* A closed or failing DEV view cannot interrupt the measured scene. */ }
    }
  };
  return {
    isEnabled: () => enabled,
    getSnapshot: () => current,
    getServerSnapshot: () => serverSnapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setEnabled(value: boolean) {
      const next = options.allowed && value === true;
      if (next === enabled) return;
      enabled = next; generation++; pending.clear(); context.length = 0; lastPublished = -Infinity; publish();
    },
    begin(stage: ForestPerformanceStage, source?: string): ForestPerformanceToken | null {
      if (!enabled || !stages.has(stage) || pending.size >= FOREST_PERFORMANCE_LIMITS.pending) return null;
      const started = readClock(); if (started === null) return null;
      const inherited = source ?? context.at(-1)?.source;
      const token = Object.freeze({ id: ++sequence, generation, stage,
        source: inherited === "rehearsal" ? "rehearsal" as const : "world" as const, started });
      pending.set(token.id, token); context.push(token); return token;
    },
    end(token: ForestPerformanceToken | null | undefined) {
      if (!enabled || !token || token.generation !== generation || pending.get(token.id) !== token) return;
      pending.delete(token.id); const index = context.indexOf(token); if (index >= 0) context.splice(index, 1);
      const ended = readClock(); if (ended === null || ended < token.started) return;
      const duration = ended - token.started; if (!Number.isFinite(duration)) return;
      const key = `${token.source}:${token.stage}`;
      let bucket = buckets.get(key);
      if (!bucket) { bucket = { stage: token.stage, source: token.source, samples: [], cursor: 0 }; buckets.set(key, bucket); }
      if (bucket.samples.length < FOREST_PERFORMANCE_LIMITS.samples) bucket.samples.push(duration);
      else { bucket.samples[bucket.cursor] = duration; bucket.cursor = (bucket.cursor + 1) % FOREST_PERFORMANCE_LIMITS.samples; }
      if (ended - lastPublished >= FOREST_PERFORMANCE_LIMITS.publishMs) { lastPublished = ended; publish(); }
    },
    /** A manual final benchmark read needs no additional clock access. */
    flush() { if (enabled) publish(); },
    refreshMemory() {
      if (!enabled) return;
      try { memory = finiteMemory(readMemory()); } catch { memory = null; }
      memoryStatus = memory ? "measured" : "unavailable"; publish();
    },
    reset() {
      generation++; buckets.clear(); pending.clear(); context.length = 0; lastPublished = -Infinity;
      memory = null; memoryStatus = "not-measured"; publish();
    },
  };
}

// Keep this leaf module independent of the DEV store: navigation imports the
// profiler and must never import scene presentation or resident controllers.
export const forestPerformanceProfiler = createForestPerformanceProfiler({ allowed: process.env.NODE_ENV === "development" });
