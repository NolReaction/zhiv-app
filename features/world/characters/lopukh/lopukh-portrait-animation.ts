import type { ForestVillagerAction } from "../forest-villager-types";

export type LopukhPortraitPose = { action: ForestVillagerAction; frame: number; phase: number; still: boolean };

/** A friendly wave and a brief demonstration, with room to breathe between. */
export function lopukhPortraitPose(seconds: number, still = false): LopukhPortraitPose {
  if (still) return { action: "idle", frame: 0, phase: 0, still: true };
  const time = Math.max(0, Number.isFinite(seconds) ? seconds : 0) % 24;
  const action = time >= 3 && time < 5 ? "greet" : time >= 11 && time < 14 ? "work"
    : time >= 18 && time < 20 ? "inspect" : "idle";
  const phase = action === "greet" ? (time - 3) / 2 : action === "work" ? (time - 11) / 3
    : action === "inspect" ? (time - 18) / 2 : 0;
  return { action, frame: Math.floor(time * 8), phase, still: false };
}

type PortraitWindow = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame" | "matchMedia">;
type PortraitDocument = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

export function startLopukhPortraitAnimation(draw: (pose: LopukhPortraitPose) => void,
  host: PortraitWindow = window, page: PortraitDocument = document): () => void {
  const reduced = host.matchMedia("(prefers-reduced-motion: reduce)");
  let request: number | undefined, previous: number | undefined, elapsed = 0, painted = -Infinity, stopped = false;
  const cancel = () => { if (request !== undefined) host.cancelAnimationFrame(request); request = undefined; previous = undefined; };
  const tick = (now: number) => {
    request = undefined;
    if (stopped || page.hidden || reduced.matches) return;
    if (previous !== undefined) elapsed += Math.max(0, Math.min(250, now - previous)) / 1000;
    previous = now;
    if (elapsed - painted >= 1 / 12) { draw(lopukhPortraitPose(elapsed)); painted = elapsed; }
    request = host.requestAnimationFrame(tick);
  };
  const sync = () => {
    cancel();
    if (stopped) return;
    if (reduced.matches) { draw(lopukhPortraitPose(elapsed, true)); painted = -Infinity; }
    else if (!page.hidden) { draw(lopukhPortraitPose(elapsed)); painted = elapsed; request = host.requestAnimationFrame(tick); }
  };
  page.addEventListener("visibilitychange", sync); reduced.addEventListener("change", sync); sync();
  return () => { stopped = true; cancel(); page.removeEventListener("visibilitychange", sync); reduced.removeEventListener("change", sync); };
}
