import type { ForestVillagerAction } from "@/features/world/characters/forest-villager-types";

export type KamneshmygPortraitPose = { action: ForestVillagerAction; frame: number; phase: number; still: boolean };

/** A cheerful hello, a quiet empty-paw gesture and a look at a discovered stone. */
export function kamneshmygPortraitPose(seconds: number, still = false): KamneshmygPortraitPose {
  if (still) return { action: "idle", frame: 0, phase: 0, still: true };
  const time = Math.max(0, Number.isFinite(seconds) ? seconds : 0) % 26;
  const action = time >= 3 && time < 5 ? "greet" : time >= 12 && time < 16 ? "work"
    : time >= 20 && time < 22 ? "trade" : "idle";
  const phase = action === "greet" ? (time - 3) / 2 : action === "work" ? (time - 12) / 4
    : action === "trade" ? (time - 20) / 2 : 0;
  return { action, frame: Math.floor(time * 8), phase, still: false };
}

type PortraitWindow = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame" | "matchMedia">;
type PortraitDocument = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

export function startKamneshmygPortraitAnimation(draw: (pose: KamneshmygPortraitPose) => void,
  host: PortraitWindow = window, page: PortraitDocument = document): () => void {
  const reduced = host.matchMedia("(prefers-reduced-motion: reduce)");
  let request: number | undefined, previous: number | undefined, elapsed = 0, painted = -Infinity, stopped = false;
  const cancel = () => { if (request !== undefined) host.cancelAnimationFrame(request); request = undefined; previous = undefined; };
  const tick = (now: number) => {
    request = undefined;
    if (stopped || page.hidden || reduced.matches) return;
    if (previous !== undefined) elapsed += Math.max(0, Math.min(250, now - previous)) / 1000;
    previous = now;
    if (elapsed - painted >= 1 / 12) { draw(kamneshmygPortraitPose(elapsed)); painted = elapsed; }
    request = host.requestAnimationFrame(tick);
  };
  const sync = () => {
    cancel();
    if (stopped) return;
    if (reduced.matches) { draw(kamneshmygPortraitPose(elapsed, true)); painted = -Infinity; }
    else if (!page.hidden) { draw(kamneshmygPortraitPose(elapsed)); painted = elapsed; request = host.requestAnimationFrame(tick); }
  };
  page.addEventListener("visibilitychange", sync); reduced.addEventListener("change", sync); sync();
  return () => { stopped = true; cancel(); page.removeEventListener("visibilitychange", sync); reduced.removeEventListener("change", sync); };
}
