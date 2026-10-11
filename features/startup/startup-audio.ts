import type { AudioRuntime } from "@/features/audio/domain/types";

export const STARTUP_AUDIO_BUDGET_MS = 1_500;
export const STARTUP_LOGO_PREPARE_MS = 600;
export const STARTUP_LOGO_AUDIO_WINDOW_MS = 180;
const STARTUP_UI_CUES = ["ui.click", "ui.open", "ui.daily-reward"] as const;

type StartupAudioRuntime = Pick<AudioRuntime, "prepare" | "play" | "unlock" | "getSettings" | "getDiagnostics">;
type Environment = { visible: () => boolean; now?: () => number };
export type StartupAudioPresentation = { settled: boolean; revealReady: boolean; offerSound: boolean; busy: boolean };
export const INITIAL_STARTUP_AUDIO: StartupAudioPresentation = { settled: false, revealReady: false, offerSound: false, busy: false };

/** Coordinate the actual logo entrance with its tiny recording. Browser
 * permission remains optional; only an explicit splash gesture can retry it. */
export function createStartupAudioEntry(runtime: StartupAudioRuntime, environment: Environment) {
  const now = environment.now ?? Date.now;
  const listeners = new Set<() => void>(), presentationListeners = new Set<() => void>();
  const controller = new AbortController();
  let started = false, settled = false, closed = false, logoPrepared = false, logoPlayed = false;
  let revealReady = false, automaticConsumed = false, offeredSound = false, busy = false;
  let revealedAt: number | null = null, gestureAt: number | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let revealDeadline: ReturnType<typeof setTimeout> | undefined;
  let gestureDeadline: ReturnType<typeof setTimeout> | undefined;
  let presentation = INITIAL_STARTUP_AUDIO;

  function canSound() {
    const settings = runtime.getSettings();
    return !closed && environment.visible() && settings.enabled && settings.master > 0 && settings.buses.ui > 0;
  }
  function publish() {
    const available = revealedAt !== null && !logoPlayed && canSound();
    if (available && runtime.getDiagnostics().state !== "running") offeredSound = true;
    const next = { settled, revealReady, offerSound: available && offeredSound, busy };
    if (Object.keys(next).every(key => next[key as keyof StartupAudioPresentation] === presentation[key as keyof StartupAudioPresentation])) return;
    presentation = next;
    for (const listener of presentationListeners) listener();
  }
  function releaseReveal() {
    revealReady = true;
    clearTimeout(revealDeadline);
    publish();
  }
  function settle() {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    for (const listener of listeners) listener();
    publish();
  }
  function tryLogo() {
    if (logoPlayed || revealedAt === null) { publish(); return; }
    if (!canSound()) { automaticConsumed = true; gestureAt = null; busy = false; publish(); return; }
    const occurredAt = gestureAt ?? revealedAt;
    if (now() - occurredAt > STARTUP_LOGO_AUDIO_WINDOW_MS) {
      if (gestureAt !== null) { gestureAt = null; busy = false; }
      else automaticConsumed = true;
      publish(); return;
    }
    if ((gestureAt === null && automaticConsumed) || !logoPrepared || runtime.getDiagnostics().state !== "running") { publish(); return; }
    logoPlayed = true;
    busy = false;
    clearTimeout(gestureDeadline);
    runtime.play({ id: "startup:logo", cueId: "ui.startup", occurredAt, maxAgeMs: STARTUP_LOGO_AUDIO_WINDOW_MS });
    publish();
  }
  function close() {
    closed = true;
    busy = false;
    clearTimeout(gestureDeadline);
    controller.abort();
    releaseReveal();
    settle();
    publish();
  }
  return {
    start() {
      if (started) return;
      started = true;
      if (closed || !environment.visible()) { queueMicrotask(close); return; }
      if (canSound()) {
        revealDeadline = setTimeout(releaseReveal, STARTUP_LOGO_PREPARE_MS);
        deadline = setTimeout(() => { controller.abort(); releaseReveal(); settle(); }, STARTUP_AUDIO_BUDGET_MS);
      } else {
        // Saved mute never delays the logo or acquires playback permission.
        // The runtime can still retain the small encoded files for later.
        queueMicrotask(() => { releaseReveal(); settle(); });
      }
      const logo = Promise.resolve().then(() => runtime.prepare(["ui.startup"], { signal: controller.signal }))
        .then(() => {
          if (!controller.signal.aborted) { logoPrepared = true; releaseReveal(); tryLogo(); }
        }).finally(releaseReveal);
      const controls = Promise.resolve().then(() => runtime.prepare(STARTUP_UI_CUES, { signal: controller.signal }));
      void Promise.allSettled([logo, controls]).then(settle);
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (settled) queueMicrotask(() => { if (listeners.has(listener)) listener(); });
      return () => { listeners.delete(listener); };
    },
    subscribePresentation(listener: () => void) {
      presentationListeners.add(listener);
      return () => { presentationListeners.delete(listener); };
    },
    getPresentation: () => presentation,
    refresh: tryLogo,
    reveal() {
      if (revealedAt !== null || closed) return;
      revealedAt = now();
      tryLogo();
    },
    requestSound() {
      if (busy || logoPlayed || revealedAt === null || !canSound()) return;
      gestureAt = now(); busy = true; publish();
      gestureDeadline = setTimeout(() => { gestureAt = null; busy = false; publish(); }, STARTUP_LOGO_AUDIO_WINDOW_MS);
      // Called synchronously by the visible splash button, preserving the
      // browser gesture. No setting is changed and no permission is bypassed.
      try {
        void runtime.unlock().then(tryLogo, () => { gestureAt = null; busy = false; publish(); });
      } catch { gestureAt = null; busy = false; publish(); }
    },
    hide: close,
    close,
  };
}

type StartupAudioEntry = ReturnType<typeof createStartupAudioEntry>;
const entries = new WeakMap<AudioRuntime, StartupAudioEntry>();

/** Shared across StrictMode reattachment, independent of account hydration. */
export function getStartupAudioEntry(runtime: AudioRuntime, environment: Environment): StartupAudioEntry {
  let entry = entries.get(runtime);
  if (!entry) { entry = createStartupAudioEntry(runtime, environment); entries.set(runtime, entry); }
  return entry;
}
