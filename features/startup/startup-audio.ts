import type { AudioRuntime } from "@/features/audio/domain/types";

export const STARTUP_AUDIO_BUDGET_MS = 1_500;
export const STARTUP_LOGO_AUDIO_WINDOW_MS = 180;
const STARTUP_UI_CUES = ["ui.click", "ui.open", "ui.daily-reward"] as const;

type StartupAudioRuntime = Pick<AudioRuntime, "prepare" | "play" | "getSettings" | "getDiagnostics">;
type Environment = { visible: () => boolean; now?: () => number };

/** One document-entry opportunity. Never wait for playback permission or queue
 * a logo sound for the next gesture. A failed/slow download releases the splash. */
export function createStartupAudioEntry(runtime: StartupAudioRuntime, environment: Environment) {
  const now = environment.now ?? Date.now;
  const listeners = new Set<() => void>();
  const controller = new AbortController();
  let started = false, settled = false, closed = false, logoPrepared = false, logoConsumed = false;
  let revealedAt: number | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;

  function settle() {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    for (const listener of listeners) listener();
  }
  function tryLogo() {
    if (logoConsumed || revealedAt === null) return;
    const settings = runtime.getSettings();
    if (closed || !environment.visible() || !settings.enabled || settings.master <= 0 || settings.buses.ui <= 0
      || now() - revealedAt > STARTUP_LOGO_AUDIO_WINDOW_MS) { logoConsumed = true; return; }
    if (!logoPrepared) return;
    // If the browser needs a gesture, this reveal is silent. A subsequent tap
    // belongs to its own UI action and must not replay the old brand sting.
    logoConsumed = true;
    if (runtime.getDiagnostics().state !== "running") return;
    runtime.play({ id: "startup:logo", cueId: "ui.startup", occurredAt: revealedAt,
      maxAgeMs: STARTUP_LOGO_AUDIO_WINDOW_MS });
  }
  return {
    start() {
      if (started) return;
      started = true;
      const settings = runtime.getSettings();
      if (closed || !environment.visible()) {
        queueMicrotask(settle);
        return;
      }
      const waitForControls = settings.enabled && settings.master > 0 && settings.buses.ui > 0;
      if (waitForControls) deadline = setTimeout(() => { controller.abort(); settle(); }, STARTUP_AUDIO_BUDGET_MS);
      // Muted visitors can still cache the tiny recordings without waiting.
      // The runtime uses encoded-only preparation while sound/master is off.
      else queueMicrotask(settle);
      // Give the tiny logo its own completion; a slower menu effect must not
      // postpone it until the logo has already finished appearing.
      const logo = Promise.resolve().then(() => runtime.prepare(["ui.startup"], { signal: controller.signal }))
        .then(() => { if (!controller.signal.aborted) { logoPrepared = true; tryLogo(); } });
      const controls = Promise.resolve().then(() => runtime.prepare(STARTUP_UI_CUES, { signal: controller.signal }));
      void Promise.allSettled([logo, controls]).then(settle);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (settled) queueMicrotask(() => { if (listeners.has(listener)) listener(); });
      return () => { listeners.delete(listener); };
    },
    reveal() {
      if (revealedAt !== null || closed) return;
      revealedAt = now();
      tryLogo();
    },
    hide() {
      // A reveal interrupted by tab hiding never catches up on foregrounding.
      logoConsumed = true;
      controller.abort();
      settle();
    },
    close() {
      closed = true;
      logoConsumed = true;
      controller.abort();
      settle();
    },
  };
}

type StartupAudioEntry = ReturnType<typeof createStartupAudioEntry>;
const entries = new WeakMap<AudioRuntime, StartupAudioEntry>();

/** The mixer and entry ledger survive React StrictMode's effect reattachment.
 * They contain no identity/profile data, so account hydration cannot replay it. */
export function getStartupAudioEntry(runtime: AudioRuntime, environment: Environment): StartupAudioEntry {
  let entry = entries.get(runtime);
  if (!entry) { entry = createStartupAudioEntry(runtime, environment); entries.set(runtime, entry); }
  return entry;
}
