import type { AudioRuntime } from "@/features/audio/domain/types";

const UI_CUES = new Set(["ui.click", "ui.open", "ui.close", "ui.confirm", "ui.error", "ui.reward"]);
let uiEventSequence = 0;

/** A semantic event is emitted once; input, hover and animation frames never trigger it. */
export function playUiCue(runtime: AudioRuntime, cueId: string) {
  if (!UI_CUES.has(cueId)) return;
  runtime.play({ id: `ui:${++uiEventSequence}`, cueId, occurredAt: Date.now() });
}

/** Only an explicit data attribute opts a button into delegated audio. */
export function uiCueFromTarget(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null;
  const button = target.closest<HTMLElement>("button[data-audio-cue], [role='button'][data-audio-cue]");
  if (!button || button.matches(":disabled, [aria-disabled='true']") || button.closest("[inert]")) return null;
  const cue = button.dataset.audioCue;
  return cue && UI_CUES.has(cue) ? cue : null;
}

/** Only gestures can unlock the first time; the runtime may resume an already
 * authorized context when visibility returns. Missed events are never replayed. */
export function attachAudioLifecycle(runtime: AudioRuntime, page: Document, surface: Window) {
  const visible = () => runtime.setVisible(!page.hidden);
  const hide = () => runtime.setVisible(false);
  const resumeFromGesture = (event: Event) => {
    if (!event.isTrusted || page.hidden || !runtime.getSettings().enabled) return;
    if (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key)) return;
    if (runtime.getDiagnostics().state !== "running") void runtime.unlock();
  };
  const click = (event: MouseEvent) => {
    if (!event.isTrusted || page.hidden) return;
    const cue = uiCueFromTarget(event.target);
    if (cue) playUiCue(runtime, cue);
  };
  visible();
  page.addEventListener("visibilitychange", visible);
  surface.addEventListener("pagehide", hide);
  surface.addEventListener("pageshow", visible);
  page.addEventListener("pointerdown", resumeFromGesture, { capture: true, passive: true });
  page.addEventListener("keydown", resumeFromGesture, true);
  page.addEventListener("click", click, true);
  return () => {
    page.removeEventListener("visibilitychange", visible);
    surface.removeEventListener("pagehide", hide);
    surface.removeEventListener("pageshow", visible);
    page.removeEventListener("pointerdown", resumeFromGesture, true);
    page.removeEventListener("keydown", resumeFromGesture, true);
    page.removeEventListener("click", click, true);
    // StrictMode and hot reload may reattach immediately; the shared engine survives.
    runtime.setVisible(false);
  };
}
