export type EarthTileId = { x: number; y: number; z: number };
export type EarthTileRecoveryTarget = { sourceId: string; tiles?: EarthTileId[] };
export type EarthTileRecoveryStatus = "idle" | "waiting" | "retrying" | "failed";
export type EarthTileRecoveryState = {
  enabled: boolean;
  visible: boolean;
  online: boolean;
  moving: boolean;
  ready: boolean;
  pending: number;
  /** Monotonically increasing count of successfully completed resource reads. */
  progress: number;
};

type RecoveryClock = {
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => unknown;
  clearTimeout: (handle: unknown) => void;
};
type RecoveryOptions = {
  readState: () => EarthTileRecoveryState;
  sources: () => string[];
  /** Await repairs, then check signal.aborted before every source mutation. */
  refresh: (targets: EarthTileRecoveryTarget[], signal: AbortSignal) => Promise<void> | void;
  onChange: (status: EarthTileRecoveryStatus) => void;
  clock?: RecoveryClock;
};

const RETRY_DELAY = 1_200;
const WATCHDOG_INTERVAL = 3_000;
const STALL_DELAY = 20_000;
const MAX_ATTEMPTS = 2;
const MAX_FAILED_TILES_PER_SOURCE = 128;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}
function canonicalTile(value: unknown): EarthTileId | null {
  const tile = record(record(record(value)?.tileID)?.canonical) ?? record(value);
  if (!tile || typeof tile.z !== "number" || !Number.isInteger(tile.z) || tile.z < 0 || tile.z > 25) return null;
  const width = 2 ** tile.z;
  if (typeof tile.x !== "number" || typeof tile.y !== "number"
    || !Number.isInteger(tile.x) || !Number.isInteger(tile.y)
    || tile.x < 0 || tile.x >= width || tile.y < 0 || tile.y >= width) return null;
  return { x: tile.x, y: tile.y, z: tile.z };
}

/** Repairs visible tile sources without replacing the map, camera, or WebGL context. */
export function createEarthTileRecovery(options: RecoveryOptions) {
  const clock: RecoveryClock = options.clock ?? {
    now: Date.now,
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const controller = new AbortController();
  const failures = new Map<string, Map<string, EarthTileId> | null>();
  let allSources = false;
  let incident = false;
  let attempts = 0;
  let status: EarthTileRecoveryStatus = "idle";
  let failureRevision = 0;
  let passRevision = -1;
  let passProgress = 0;
  let settledRevision = 0;
  let passSettled = 0;
  let activeAttempt: AbortController | null = null;
  let retryTimer: unknown = null;
  let watchdogTimer: unknown = null;
  let watchdogActive = false;
  let watchdogEpoch = 0;
  let previousProgress = options.readState().progress;
  let lastProgressAt = clock.now();

  function change(next: EarthTileRecoveryStatus) {
    if (status === next || controller.signal.aborted) return;
    status = next;
    options.onChange(next);
  }
  function cancelRetry() {
    if (retryTimer !== null) clock.clearTimeout(retryTimer);
    retryTimer = null;
  }
  function cancelWatchdog() {
    watchdogEpoch += 1;
    if (watchdogTimer !== null) clock.clearTimeout(watchdogTimer);
    watchdogTimer = null;
    watchdogActive = false;
  }
  function pauseAttempt() {
    if (!activeAttempt) return;
    activeAttempt.abort();
    activeAttempt = null;
    // Background/camera time cannot consume a visible retry budget. A resumed
    // pass owns a new signal; the cancelled callback may still be awaiting I/O.
    attempts = Math.max(0, attempts - 1);
    passRevision = -1;
    change("waiting");
  }
  function scheduleWatchdog() {
    if (watchdogTimer !== null || controller.signal.aborted) return;
    const epoch = ++watchdogEpoch;
    watchdogTimer = clock.setTimeout(() => {
      if (controller.signal.aborted || epoch !== watchdogEpoch) return;
      watchdogTimer = null;
      check();
    }, WATCHDOG_INTERVAL);
  }
  function allowed(state: EarthTileRecoveryState) {
    return state.enabled && state.visible && state.online && !state.moving;
  }
  function clearIncident() {
    cancelRetry();
    incident = false;
    attempts = 0;
    failures.clear();
    allSources = false;
    passRevision = -1;
    change("idle");
  }
  function targets(): EarthTileRecoveryTarget[] {
    const sources = [...new Set(options.sources())];
    if (allSources) return sources.map(sourceId => ({ sourceId }));
    return sources.flatMap(sourceId => {
      if (!failures.has(sourceId)) return [];
      const tiles = failures.get(sourceId);
      return [{ sourceId, ...(tiles ? { tiles: [...tiles.values()] } : {}) }];
    });
  }
  function scheduleRetry() {
    if (retryTimer !== null || activeAttempt || controller.signal.aborted) return;
    if (attempts >= MAX_ATTEMPTS) { change("failed"); return; }
    change("waiting");
    retryTimer = clock.setTimeout(() => {
      retryTimer = null;
      void runAttempt();
    }, RETRY_DELAY);
  }
  async function runAttempt() {
    if (controller.signal.aborted || activeAttempt || !incident) return;
    const state = options.readState();
    if (!allowed(state)) return;
    if (attempts >= MAX_ATTEMPTS) { change("failed"); return; }
    const pass = new AbortController();
    activeAttempt = pass;
    attempts += 1;
    passRevision = failureRevision;
    passProgress = state.progress;
    passSettled = settledRevision;
    lastProgressAt = clock.now();
    change("retrying");
    try {
      if (!controller.signal.aborted && !pass.signal.aborted) await options.refresh(targets(), pass.signal);
    } catch {
      if (!controller.signal.aborted && !pass.signal.aborted) failureRevision += 1;
    } finally {
      // A late cancelled pass cannot finish a newer one or start another retry.
      if (activeAttempt === pass) {
        activeAttempt = null;
        if (!controller.signal.aborted) check();
      }
    }
  }

  /** Pass true only for the renderer's idle event, after all visible work has settled. */
  function check(settled = false) {
    if (controller.signal.aborted) return;
    if (settled) settledRevision += 1;
    const state = options.readState();
    const now = clock.now();
    if (!state.enabled || !state.visible) {
      lastProgressAt = now;
      cancelRetry();
      cancelWatchdog();
      pauseAttempt();
      return;
    }
    if (!watchdogActive) {
      watchdogActive = true;
      // Time spent in another section/background is never a visible tile stall.
      lastProgressAt = now;
    }
    scheduleWatchdog();
    if (state.progress !== previousProgress) {
      previousProgress = state.progress;
      lastProgressAt = now;
    }
    if (!allowed(state)) {
      lastProgressAt = now;
      cancelRetry();
      pauseAttempt();
      return;
    }
    if (activeAttempt) return;
    // Errored tiles count as "loaded" in MapLibre. Require a repair pass and
    // fresh success/idle evidence, with no new errors during that pass.
    if (incident && passRevision === failureRevision && state.ready && state.pending === 0
      && (state.progress > passProgress || settledRevision > passSettled)) {
      clearIncident();
      lastProgressAt = now;
      return;
    }
    if (incident && (passRevision !== failureRevision || attempts === 0)) {
      scheduleRetry();
      return;
    }
    if (!incident && state.ready && state.pending === 0) {
      lastProgressAt = now;
      return;
    }
    if (now - lastProgressAt < STALL_DELAY) return;
    // A missing renderer callback can leave the view permanently incomplete.
    // Only an observed stall broadens recovery to all eligible tile sources.
    incident = true;
    allSources = true;
    scheduleRetry();
  }

  check();

  return {
    check,
    reportFailure(failure: { sourceId?: unknown; tile?: unknown } = {}) {
      if (controller.signal.aborted || !options.readState().enabled) return;
      incident = true;
      failureRevision += 1;
      const tile = canonicalTile(failure.tile);
      if (typeof failure.sourceId !== "string" || !failure.sourceId) allSources = true;
      else if (!tile) failures.set(failure.sourceId, null);
      else if (failures.get(failure.sourceId) !== null) {
        const tiles = failures.get(failure.sourceId) ?? new Map<string, EarthTileId>();
        tiles.set(`${tile.z}/${tile.x}/${tile.y}`, tile);
        // Long panning sessions during a provider outage must not retain an
        // unbounded list of offscreen failures. Source refresh covers visible tiles.
        failures.set(failure.sourceId, tiles.size > MAX_FAILED_TILES_PER_SOURCE ? null : tiles);
      }
      change(attempts >= MAX_ATTEMPTS ? "failed" : "waiting");
      check();
    },
    /** A user action or restored connection starts a fresh bounded retry budget. */
    retry() {
      if (controller.signal.aborted || !options.readState().enabled) return;
      if (!incident && options.readState().ready && options.readState().pending === 0) return;
      if (!incident) allSources = true;
      incident = true;
      attempts = 0;
      failureRevision += 1;
      lastProgressAt = clock.now();
      cancelRetry();
      change("waiting");
      check();
    },
    dispose() {
      controller.abort();
      activeAttempt?.abort();
      activeAttempt = null;
      cancelRetry();
      cancelWatchdog();
      failures.clear();
    },
  };
}
