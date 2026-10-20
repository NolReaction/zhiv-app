import type { EarthCacheSnapshot } from "./resource-cache";
import type { EarthTileRecoveryStatus } from "./tile-recovery";
import type { EarthResourceProtocolOutcome } from "./resource-protocol";
import { EARTH_RUNTIME_VERSION } from "./runtime-loader";
import packageInfo from "../../package.json";

const EVENTS = ["initializing", "created", "style-ready", "ready", "foreground", "background",
  "source-error", "source-refresh", "recovery-waiting", "recovery-retrying", "recovery-failed", "recovery-idle",
  "context-lost", "failed", "unsupported", "removed", "manual-retry"] as const;
type DiagnosticEvent = typeof EVENTS[number];
type DiagnosticState = {
  phase: "loading" | "ready" | "failed" | "unsupported";
  stage: "engine" | "resources" | "render";
  recovery: EarthTileRecoveryStatus;
  visible: boolean;
  retained: boolean;
  documentHidden: boolean;
  online: boolean;
  loaded: boolean;
  tilesLoaded: boolean;
  cartographyReady: boolean;
  cache: EarthCacheSnapshot;
};
const count = (value: number) => Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
const choice = <T extends string | null>(value: T, allowed: readonly T[]): T | null => allowed.includes(value) ? value : null;

/** Per-mounted-view RAM only. Never accepts coordinates, URLs, errors or IDs. */
export function createEarthMapDiagnostics(now: () => number = () => performance.now()) {
  const started = now();
  const events: Array<{ elapsedMs: number; event: DiagnosticEvent }> = [];
  const counters: Partial<Record<DiagnosticEvent, number>> = {};
  const resources = { completed: 0, aborted: 0, timeout: 0, error: 0 };
  return {
    record(event: DiagnosticEvent) {
      if (!EVENTS.includes(event)) return;
      counters[event] = (counters[event] ?? 0) + 1;
      events.push({ elapsedMs: count(now() - started), event });
      if (events.length > 40) events.shift();
    },
    resource(outcome: EarthResourceProtocolOutcome) {
      if (Object.hasOwn(resources, outcome)) resources[outcome] += 1;
    },
    report(state: DiagnosticState): string {
      // Explicit projection also protects against accidental extra fields on
      // real cache/map objects. No browser identity or absolute timestamps.
      return JSON.stringify({ version: 1, appVersion: packageInfo.version, maplibreVersion: EARTH_RUNTIME_VERSION,
        elapsedMs: count(now() - started),
        map: { phase: choice(state.phase, ["loading", "ready", "failed", "unsupported"]),
          stage: choice(state.stage, ["engine", "resources", "render"]),
          recovery: choice(state.recovery, ["idle", "waiting", "retrying", "failed"]),
          visible: state.visible === true, retained: state.retained === true, documentHidden: state.documentHidden === true,
          online: state.online === true, loaded: state.loaded === true,
          tilesLoaded: state.tilesLoaded === true, cartographyReady: state.cartographyReady === true },
        cache: { storage: choice(state.cache.storage, ["checking", "device", "session"]),
          persistence: choice(state.cache.persistence, ["unknown", "granted", "best-effort"]),
          storageIssue: choice(state.cache.storageIssue, [null, "unavailable", "quota", "write-failed", "resource-too-large"]),
          pending: count(state.cache.pending), completed: count(state.cache.completed), failed: count(state.cache.failed),
          cacheHits: count(state.cache.cacheHits), networkBytes: count(state.cache.networkBytes),
          storedBytes: count(state.cache.storedBytes), storedEntries: count(state.cache.storedEntries),
          memoryBytes: count(state.cache.memoryBytes), memoryEntries: count(state.cache.memoryEntries) },
        resources: { ...resources }, counters: { ...counters }, events: events.map(event => ({ ...event })),
      }, null, 2);
    },
  };
}
