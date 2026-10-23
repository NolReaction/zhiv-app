import type { Map as LibreMap } from "maplibre-gl";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import { paintEarthPositionMarkerPose } from "./position-marker";
import styles from "./position-marker.module.css";

type MarkerCamera = { longitude: number; latitude: number; bearing: number; pitch: number };
type MarkerMotion = { lean: number; x: number; y: number };
type MarkerMap = Pick<LibreMap, "getCenter" | "getBearing" | "getPitch" | "getZoom" | "on" | "off">;
type MarkerEnvironment = {
  document: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  reducedMotion: Pick<MediaQueryList, "matches" | "addEventListener" | "removeEventListener"> | null;
  now: () => number;
  setTimeout: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (id: ReturnType<typeof setTimeout>) => void;
};

const clamp = (value: number, limit: number) => Math.max(-limit, Math.min(limit, value));
const angularDelta = (from: number, to: number) => ((to - from + 540) % 360 + 360) % 360 - 180;

/** Camera angles wrap at the date line; a two-degree turn must stay a small sway. */
export function earthMarkerMotion(previous: MarkerCamera, next: MarkerCamera, elapsed: number): MarkerMotion {
  if (![...Object.values(previous), ...Object.values(next), elapsed].every(Number.isFinite)) return { lean: 0, x: 0, y: 0 };
  const duration = Math.max(8, Math.min(64, elapsed));
  const longitudeScale = Math.cos((previous.latitude + next.latitude) / 2 * Math.PI / 180);
  const horizontal = (angularDelta(previous.longitude, next.longitude) * longitudeScale
    + angularDelta(previous.bearing, next.bearing) * .55) * 16 / duration;
  const vertical = (next.latitude - previous.latitude + (next.pitch - previous.pitch) * .45) * 16 / duration;
  return { lean: clamp(-horizontal * 2.4, 10), x: clamp(-horizontal * .45, 2.5), y: clamp(vertical * .3, 2) };
}

/** No persistent frame loop: map events drive sway, CSS settles it, taps briefly wave. */
export function bindEarthPositionMarkerMotion(map: MarkerMap, marker: HTMLElement,
  environment: MarkerEnvironment = {
    document,
    reducedMotion: typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null,
    now: () => performance.now(),
    setTimeout: (callback, delay) => setTimeout(callback, delay),
    clearTimeout: id => clearTimeout(id),
  }): () => void {
  const portrait = marker.querySelector<HTMLElement>(`.${styles.portrait}`);
  if (!portrait) return () => {};
  let disposed = false;
  let greetingTimer: ReturnType<typeof setTimeout> | null = null;
  let greeting = false;
  let lastTime = environment.now();
  const readCamera = (): MarkerCamera => {
    const center = map.getCenter();
    return { longitude: center.lng, latitude: center.lat, bearing: map.getBearing(), pitch: map.getPitch() };
  };
  let previous = readCamera();
  const visible = () => environment.document.visibilityState !== "hidden";
  const covered = () => marker.classList.contains("maplibregl-marker-covered");
  const motionAllowed = () => visible() && !environment.reducedMotion?.matches;
  const setMotion = (motion: MarkerMotion, state: "moving" | "settling" | "still") => {
    portrait.dataset.motion = state;
    portrait.style.setProperty("--marker-lean", `${motion.lean}deg`);
    portrait.style.setProperty("--marker-shift-x", `${motion.x}px`);
    portrait.style.setProperty("--marker-shift-y", `${motion.y}px`);
  };
  const rest = (settle = false) => setMotion({ lean: 0, x: 0, y: 0 }, settle ? "settling" : "still");
  const stopGreeting = () => {
    if (greetingTimer !== null) environment.clearTimeout(greetingTimer);
    greetingTimer = null;
    if (greeting) paintEarthPositionMarkerPose(marker, "idle");
    greeting = false;
  };
  const syncAvailability = () => {
    const distant = map.getZoom() <= -0.2;
    marker.setAttribute("data-detail", String(map.getZoom() >= 12));
    marker.style.visibility = distant ? "hidden" : "";
    const unavailable = distant || !visible() || covered();
    marker.toggleAttribute("disabled", unavailable);
    if (unavailable) { stopGreeting(); rest(); }
    return !unavailable;
  };
  const onMove = () => {
    if (disposed) return;
    const next = readCamera();
    const now = environment.now();
    const motion = earthMarkerMotion(previous, next, now - lastTime);
    previous = next;
    lastTime = now;
    if (!syncAvailability() || !motionAllowed()) { rest(); return; }
    setMotion(motion, "moving");
  };
  const onEnd = () => {
    if (disposed) return;
    previous = readCamera();
    lastTime = environment.now();
    syncAvailability();
    rest(motionAllowed());
  };
  const onVisibility = () => {
    stopGreeting();
    previous = readCamera();
    lastTime = environment.now();
    rest();
    syncAvailability();
  };
  const greet = (event: Event) => {
    event.stopPropagation();
    if (disposed || !syncAvailability()) return;
    playUiCue(getAudioRuntime(), "ui.click");
    stopGreeting();
    greeting = true;
    paintEarthPositionMarkerPose(marker, "greet", 0);
    if (!motionAllowed()) {
      greetingTimer = environment.setTimeout(stopGreeting, 700);
      return;
    }
    let frame = 0;
    const nextFrame = () => {
      greetingTimer = null;
      if (disposed || !motionAllowed() || covered()) { stopGreeting(); return; }
      frame += 1;
      if (frame === 5) { stopGreeting(); return; }
      paintEarthPositionMarkerPose(marker, "greet", frame % 2);
      greetingTimer = environment.setTimeout(nextFrame, 130);
    };
    greetingTimer = environment.setTimeout(nextFrame, 130);
  };
  const stopPointer = (event: Event) => event.stopPropagation();
  const stopKeyboard = (event: KeyboardEvent) => {
    // Native buttons generate click for Enter/Space; leave that default intact.
    if (event.key === "Enter" || event.key === " ") event.stopPropagation();
  };
  map.on("move", onMove);
  map.on("moveend", onEnd);
  map.on("idle", onEnd);
  marker.addEventListener("click", greet);
  marker.addEventListener("pointerdown", stopPointer);
  marker.addEventListener("mousedown", stopPointer);
  marker.addEventListener("touchstart", stopPointer, { passive: true });
  marker.addEventListener("keydown", stopKeyboard);
  environment.document.addEventListener("visibilitychange", onVisibility);
  environment.reducedMotion?.addEventListener("change", onVisibility);
  syncAvailability();
  return () => {
    if (disposed) return;
    disposed = true;
    stopGreeting();
    rest();
    map.off("move", onMove);
    map.off("moveend", onEnd);
    map.off("idle", onEnd);
    marker.removeEventListener("click", greet);
    marker.removeEventListener("pointerdown", stopPointer);
    marker.removeEventListener("mousedown", stopPointer);
    marker.removeEventListener("touchstart", stopPointer);
    marker.removeEventListener("keydown", stopKeyboard);
    environment.document.removeEventListener("visibilitychange", onVisibility);
    environment.reducedMotion?.removeEventListener("change", onVisibility);
    marker.setAttribute("disabled", "");
  };
}
