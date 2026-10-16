import type { ForestVillagerAction } from "@/features/world/characters/forest-villager-types";

export type LeaftailPortraitPose = { action: ForestVillagerAction; frame: number; phase: number; still: boolean };

/** A friendly greeting, one offer and a quiet check of the tied goods. */
export function leaftailPortraitPose(seconds: number, still = false): LeaftailPortraitPose {
  if (still) return { action: "idle", frame: 0, phase: 0, still: true };
  const time = Math.max(0, Number.isFinite(seconds) ? seconds : 0) % 26;
  const action = time >= 3 && time < 5 ? "greet" : time >= 11 && time < 15 ? "trade"
    : time >= 20 && time < 23 ? "work" : "idle";
  const phase = action === "greet" ? (time - 3) / 2 : action === "trade" ? (time - 11) / 4
    : action === "work" ? (time - 20) / 3 : 0;
  return { action, frame: Math.floor(time * 8), phase, still: false };
}

type PortraitWindow = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame" | "matchMedia">;
type PortraitDocument = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

export function startLeaftailPortraitAnimation(draw: (pose: LeaftailPortraitPose) => void,
  host: PortraitWindow = window, page: PortraitDocument = document): () => void {
  const reduced = host.matchMedia("(prefers-reduced-motion: reduce)");
  let request: number | undefined, previous: number | undefined, elapsed = 0, painted = -Infinity, stopped = false;
  const cancel = () => { if (request !== undefined) host.cancelAnimationFrame(request); request = undefined; previous = undefined; };
  const tick = (now: number) => {
    request = undefined;
    if (stopped || page.hidden || reduced.matches) return;
    if (previous !== undefined) elapsed += Math.max(0, Math.min(250, now - previous)) / 1000;
    previous = now;
    if (elapsed - painted >= 1 / 12) { draw(leaftailPortraitPose(elapsed)); painted = elapsed; }
    request = host.requestAnimationFrame(tick);
  };
  const sync = () => {
    cancel();
    if (stopped) return;
    if (reduced.matches) { draw(leaftailPortraitPose(elapsed, true)); painted = -Infinity; }
    else if (!page.hidden) { draw(leaftailPortraitPose(elapsed)); painted = elapsed; request = host.requestAnimationFrame(tick); }
  };
  page.addEventListener("visibilitychange", sync); reduced.addEventListener("change", sync); sync();
  return () => { stopped = true; cancel(); page.removeEventListener("visibilitychange", sync); reduced.removeEventListener("change", sync); };
}
