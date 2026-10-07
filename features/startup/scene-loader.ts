import type { SceneLoadState } from "./scene-load-state";

const RETRY_DELAYS_MS = [1_000, 3_000, 8_000, 15_000] as const;
const ATTEMPT_TIMEOUT_MS = 25_000;

type SceneLoaderOptions<T> = {
  load: (signal: AbortSignal) => Promise<T>;
  release: (value: T) => void;
  onReady: (value: T) => void;
  onState: (state: SceneLoadState, error?: unknown) => void;
  isOnline?: () => boolean;
  isVisible?: () => boolean;
};

/** Read-only scene setup retries; a generation fence rejects late, disposed scenes. */
export function createSceneLoader<T>(options: SceneLoaderOptions<T>) {
  let disposed = false, complete = false, generation = 0, failures = 0;
  let pending: AbortController | null = null;
  let current: T | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const available = () => (options.isOnline?.() ?? navigator.onLine !== false)
    && (options.isVisible?.() ?? !document.hidden);
  function clearTimer() { if (timer !== undefined) clearTimeout(timer); timer = undefined; }
  function clearDeadline() { if (deadline !== undefined) clearTimeout(deadline); deadline = undefined; }
  function fail(ticket: number, controller: AbortController, error: unknown) {
    if (disposed || ticket !== generation) return;
    clearDeadline(); pending = null;
    // Invalidate before abort: import() may ignore cancellation and resolve late.
    const failedGeneration = ++generation;
    controller.abort(error);
    const delay = RETRY_DELAYS_MS[Math.min(failures++, RETRY_DELAYS_MS.length - 1)];
    options.onState("error", error);
    // Consumers can synchronously retry, pause or dispose from a state callback.
    if (disposed || complete || failedGeneration !== generation || pending) return;
    if (available()) timer = setTimeout(() => { timer = undefined; run(); }, delay);
  }
  function run() {
    if (disposed || complete || pending || !available()) return;
    clearTimer();
    const ticket = ++generation, controller = new AbortController();
    pending = controller;
    options.onState("loading");
    if (disposed || ticket !== generation) return;
    deadline = setTimeout(() => fail(ticket, controller,
      new DOMException("Scene loading timed out", "TimeoutError")), ATTEMPT_TIMEOUT_MS);
    void Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return options.load(controller.signal);
    }).then(value => {
      if (disposed || ticket !== generation) { options.release(value); return; }
      clearDeadline();
      try { options.onReady(value); }
      catch (error) { options.release(value); throw error; }
      if (disposed || ticket !== generation) { options.release(value); return; }
      pending = null; current = value; complete = true; failures = 0;
      options.onState("ready");
    }).catch((error: unknown) => fail(ticket, controller, error));
  }
  function pause() {
    clearTimer(); clearDeadline(); generation++;
    pending?.abort(); pending = null;
  }
  function retry() {
    if (disposed || complete || pending) return;
    clearTimer(); run();
  }
  return {
    retry,
    resume: retry,
    pause,
    dispose() {
      if (disposed) return;
      disposed = true; pause();
      if (complete) options.release(current!);
      current = undefined;
    },
  };
}

/** Foreground/reconnection retries immediately; background/offline waits have no timers. */
export function bindSceneLoaderEnvironment(loader: Pick<ReturnType<typeof createSceneLoader>, "pause" | "resume">) {
  const visibility = () => { if (document.hidden) loader.pause(); else loader.resume(); };
  window.addEventListener("online", loader.resume);
  window.addEventListener("offline", loader.pause);
  document.addEventListener("visibilitychange", visibility);
  return () => {
    window.removeEventListener("online", loader.resume);
    window.removeEventListener("offline", loader.pause);
    document.removeEventListener("visibilitychange", visibility);
  };
}
