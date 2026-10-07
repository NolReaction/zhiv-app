import type { FishingAction } from "./fishing-props";

export type PleskPortraitPose = { action: FishingAction; frame: number; phase: number; still: boolean };

/** A presentation-only loop: breathing/blinking, one small greeting, then a rest.
 * It neither advances the resident's world mind nor creates a catch or reward. */
export function pleskPortraitPose(seconds: number, still = false): PleskPortraitPose {
  if (still) return { action: "idle", frame: 0, phase: 0, still: true };
  const time = Math.max(0, Number.isFinite(seconds) ? seconds : 0) % 32;
  const action = time >= 3 && time < 5 ? "greet" : time >= 23 && time < 26 ? "rest" : "idle";
  return { action, frame: Math.floor(time * 8), phase: action === "greet" ? (time - 3) / 2 : 0, still: false };
}

type PortraitWindow = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame" | "matchMedia">;
type PortraitDocument = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

/** The clock counts visible time only. No scheduled frames remain while the tab
 * is hidden, reduced motion is enabled, or the portrait has been unmounted. */
export function startPleskPortraitAnimation(draw: (pose: PleskPortraitPose) => void,
  host: PortraitWindow = window, page: PortraitDocument = document): () => void {
  const reduced = host.matchMedia("(prefers-reduced-motion: reduce)");
  let request: number | undefined, previous: number | undefined, elapsed = 0, painted = -Infinity, stopped = false;
  const cancel = () => { if (request !== undefined) host.cancelAnimationFrame(request); request = undefined; previous = undefined; };
  const tick = (now: number) => {
    request = undefined;
    if (stopped || page.hidden || reduced.matches) return;
    if (previous !== undefined) elapsed += Math.max(0, Math.min(250, now - previous)) / 1000;
    previous = now;
    if (elapsed - painted >= 1 / 8) { draw(pleskPortraitPose(elapsed)); painted = elapsed; }
    request = host.requestAnimationFrame(tick);
  };
  const sync = () => {
    cancel();
    if (stopped) return;
    if (reduced.matches) { draw(pleskPortraitPose(elapsed, true)); painted = -Infinity; }
    else if (!page.hidden) { draw(pleskPortraitPose(elapsed)); painted = elapsed; request = host.requestAnimationFrame(tick); }
  };
  page.addEventListener("visibilitychange", sync);
  reduced.addEventListener("change", sync);
  sync();
  return () => { stopped = true; cancel(); page.removeEventListener("visibilitychange", sync); reduced.removeEventListener("change", sync); };
}
