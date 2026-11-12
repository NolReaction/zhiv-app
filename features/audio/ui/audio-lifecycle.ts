import type { AudioBus, AudioRuntime } from "@/features/audio/domain/types";

const UI_CUES = new Set(["ui.click", "ui.open", "ui.close", "ui.tab", "ui.confirm", "ui.error", "ui.reward"]);
let uiEventSequence = 0;

/** A semantic event is emitted once; input, hover and animation frames never trigger it. */
export function playUiCue(runtime: AudioRuntime, cueId: string) {
  if (!UI_CUES.has(cueId)) return;
  runtime.play({ id: `ui:${++uiEventSequence}`, cueId, occurredAt: Date.now() });
}

/** User-driven slider feedback shares the UI mixer and its cooldown, never a
 * separate preview context. Lower levels sound lower; zero remains silent. */
export function playVolumeFeedback(runtime: AudioRuntime, bus: AudioBus | "master", value: number) {
  if (!Number.isFinite(value) || value <= 0) return;
  const level = Math.min(1, value);
  const settings = runtime.getSettings();
  if (!settings.enabled || settings.master <= 0 || settings.buses.ui <= 0
    || (bus !== "master" && settings.buses[bus] <= 0)) return;
  runtime.play({ id: `ui:${++uiEventSequence}`, cueId: "ui.slider", occurredAt: Date.now(),
    feedbackBus: bus, playbackRate: .88 + level * .3,
    // Master and UI already scale this voice in the mixer.
    gain: bus === "master" || bus === "ui" ? .65 : level * .65 });
}

/** Enabled controls opt into a cue. Focusable unavailable controls also receive keyboard clicks. */
export function uiCueFromTarget(target: EventTarget | null): string | null {
  if (!target || !(target instanceof Element)) return null;
  const button = target.closest<HTMLElement>("button, [role='button']");
  if (!button || button.matches(":disabled") || button.closest("[inert]")) return null;
  if (button.getAttribute("aria-disabled") === "true") return "ui.error";
  const cue = button.dataset.audioCue;
  return cue && UI_CUES.has(cue) ? cue : null;
}

/** Only gestures can unlock the first time; the runtime may resume an already
 * authorized context when visibility returns. Missed events are never replayed. */
export function attachAudioLifecycle(runtime: AudioRuntime, page: Document, surface: Window) {
  let frozen = false, parked = false;
  const available = () => !page.hidden && !frozen && !parked;
  let disabledPress: { button: Element; id: number; x: number; y: number } | null = null;
  const clearPress = () => { disabledPress = null; };
  const visible = () => {
    if (!available()) clearPress();
    runtime.setVisible(available());
  };
  const hide = () => { parked = true; visible(); };
  const show = () => { parked = false; visible(); };
  const freeze = () => { frozen = true; visible(); };
  const resume = () => { frozen = false; visible(); };
  const resumeFromGesture = (event: Event) => {
    if (!event.isTrusted || !available() || !runtime.getSettings().enabled) return;
    // Touch and pen acquire browser activation on release. Their pointerdown
    // fires too early for Safari; mouse activation is available on press.
    if (event.type === "pointerdown" && (event as PointerEvent).pointerType !== "mouse") return;
    if (event.type === "pointerup" && (event as PointerEvent).pointerType === "mouse") return;
    if (event instanceof KeyboardEvent && !["Enter", " "].includes(event.key)) return;
    if (runtime.getDiagnostics().state !== "running") void runtime.unlock();
  };
  // Native disabled buttons never dispatch click. A completed primary tap can
  // explain the refusal without enabling the control or consuming the gesture.
  const disabledButtonAt = (target: EventTarget | null) =>
    target && target instanceof Element ? target.closest("button:disabled") : null;
  const press = (event: PointerEvent) => {
    resumeFromGesture(event);
    if (!event.isPrimary || event.button !== 0) return;
    const button = event.isTrusted && available() ? disabledButtonAt(event.target) : null;
    disabledPress = button && !button.closest("[inert]")
      ? { button, id: event.pointerId, x: event.clientX, y: event.clientY } : null;
  };
  const release = (event: PointerEvent) => {
    resumeFromGesture(event);
    const start = disabledPress;
    if (!start || start.id !== event.pointerId) return;
    clearPress();
    if (event.isTrusted && available() && disabledButtonAt(event.target) === start.button
      && !start.button.closest("[inert]") && Math.hypot(event.clientX - start.x, event.clientY - start.y) <= 10) playUiCue(runtime, "ui.error");
  };
  const click = (event: MouseEvent) => {
    if (!event.isTrusted || !available()) return;
    const cue = uiCueFromTarget(event.target);
    if (cue) playUiCue(runtime, cue);
  };
  visible();
  page.addEventListener("visibilitychange", visible);
  surface.addEventListener("focus", visible);
  surface.addEventListener("pagehide", hide);
  surface.addEventListener("pageshow", show);
  page.addEventListener("freeze", freeze);
  page.addEventListener("resume", resume);
  page.addEventListener("pointerdown", press, { capture: true, passive: true });
  page.addEventListener("pointerup", release, { capture: true, passive: true });
  page.addEventListener("pointercancel", clearPress, true);
  page.addEventListener("contextmenu", clearPress, true);
  page.addEventListener("touchend", resumeFromGesture, { capture: true, passive: true });
  page.addEventListener("keydown", resumeFromGesture, true);
  page.addEventListener("click", click, true);
  return () => {
    page.removeEventListener("visibilitychange", visible);
    surface.removeEventListener("focus", visible);
    surface.removeEventListener("pagehide", hide);
    surface.removeEventListener("pageshow", show);
    page.removeEventListener("freeze", freeze);
    page.removeEventListener("resume", resume);
    page.removeEventListener("pointerdown", press, true);
    page.removeEventListener("pointerup", release, true);
    page.removeEventListener("pointercancel", clearPress, true);
    page.removeEventListener("contextmenu", clearPress, true);
    page.removeEventListener("touchend", resumeFromGesture, true);
    page.removeEventListener("keydown", resumeFromGesture, true);
    page.removeEventListener("click", click, true);
    // StrictMode and hot reload may reattach immediately; the shared engine survives.
    runtime.setVisible(false);
  };
}
