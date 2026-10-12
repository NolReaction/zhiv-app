import type { AudioRuntime } from "@/features/audio/domain/types";

export const STARTUP_AUDIO_BUDGET_MS = 1_500;
export const STARTUP_LOGO_PREPARE_MS = 600;
export const STARTUP_LOGO_AUDIO_WINDOW_MS = 180;
const STARTUP_UI_CUES = ["ui.click", "ui.open", "ui.daily-reward"] as const;

type StartupAudioRuntime = Pick<AudioRuntime, "prepare" | "play" | "getSettings" | "getDiagnostics">;
type Environment = { visible: () => boolean; now?: () => number };
export type StartupAudioPresentation = { settled: boolean; revealReady: boolean };
export const INITIAL_STARTUP_AUDIO: StartupAudioPresentation = { settled: false, revealReady: false };

/** Coordinate the actual logo entrance with its tiny recording. Preparation
 * may obtain browser autoplay permission; a missed entrance is never replayed. */
export function createStartupAudioEntry(runtime: StartupAudioRuntime, environment: Environment) {
  const now = environment.now ?? Date.now;
  const listeners = new Set<() => void>(), presentationListeners = new Set<() => void>();
  const controller = new AbortController();
  let started = false, settled = false, closed = false, logoPrepared = false, logoPlayed = false;
  let revealReady = false, automaticConsumed = false;
  let attachments = 0;
  let revealedAt: number | null = null;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let revealDeadline: ReturnType<typeof setTimeout> | undefined;
  let presentation = INITIAL_STARTUP_AUDIO;

  function canSound() {
    const settings = runtime.getSettings();
    return !closed && environment.visible() && settings.enabled && settings.master > 0 && settings.buses.ui > 0;
  }
  function publish() {
    const next = { settled, revealReady };
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
    if (logoPlayed || revealedAt === null) return;
    if (!canSound() || now() - revealedAt > STARTUP_LOGO_AUDIO_WINDOW_MS) { automaticConsumed = true; return; }
    if (automaticConsumed || !logoPrepared || runtime.getDiagnostics().state !== "running") return;
    logoPlayed = true;
    runtime.play({ id: "startup:logo", cueId: "ui.startup", occurredAt: revealedAt, maxAgeMs: STARTUP_LOGO_AUDIO_WINDOW_MS });
  }
  function close() {
    closed = true;
    controller.abort();
    releaseReveal();
    settle();
    publish();
  }
  return {
    attach() {
      attachments++;
      let attached = true;
      return () => {
        if (!attached) return;
        attached = false;
        attachments--;
        // StrictMode reattaches synchronously; a real unmount ends the opportunity.
        queueMicrotask(() => { if (attachments === 0) close(); });
      };
    },
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
