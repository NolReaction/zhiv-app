export const EARTH_SCENE_INTERVAL_MS = 125;

type SceneClockOptions = {
  now: () => number;
  schedule: (callback: () => void, delay: number) => number;
  cancel: (handle: number) => void;
  step: (elapsedMs: number) => void;
};

/** One modest clock for all overview decor; paused time never becomes a jump. */
export function createEarthSceneClock({ now, schedule, cancel, step }: SceneClockOptions) {
  let timer: number | null = null;
  let running = false;
  let disposed = false;
  let previous = 0;
  let elapsed = 0;
  let intervalMs = EARTH_SCENE_INTERVAL_MS;

  function tick() {
    timer = null;
    if (!running || disposed) return;
    const current = now();
    elapsed += Math.max(0, current - previous);
    previous = current;
    step(elapsed);
    if (running && !disposed && timer === null) timer = schedule(tick, intervalMs);
  }

  function setRunning(value: boolean) {
    if (disposed || running === value) return;
    running = value;
    if (timer !== null) cancel(timer);
    timer = null;
    if (running) {
      previous = now();
      // The initial frame already exists; motion starts after readiness settles.
      timer = schedule(tick, intervalMs);
    }
  }

  return {
    setRunning,
    setIntervalMs(value: number) {
      if (disposed || !Number.isFinite(value)) return;
      const next = Math.max(EARTH_SCENE_INTERVAL_MS, Math.min(500, value));
      if (next === intervalMs) return;
      intervalMs = next;
      if (timer !== null) cancel(timer);
      timer = running ? schedule(tick, intervalMs) : null;
    },
    dispose() {
      setRunning(false);
      disposed = true;
    },
  };
}
