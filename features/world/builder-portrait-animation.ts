import type { BuilderAction } from "./builder-types";

export type BuilderPortraitPose = { action: BuilderAction; frame: number; phase: number; still: boolean };

/** A greeting, one mallet demonstration and a pouch check, with calm pauses. */
export function builderPortraitPose(seconds: number, still = false): BuilderPortraitPose {
  if (still) return { action: "idle", frame: 0, phase: 0, still: true };
  const time = Math.max(0, Number.isFinite(seconds) ? seconds : 0) % 24;
  const action = time >= 3 && time < 5 ? "greet" : time >= 12 && time < 16 ? "work"
    : time >= 18 && time < 19.6 ? "inspect" : "idle";
  const phase = action === "greet" ? (time - 3) / 2 : action === "work" ? (time - 12) / 4
    : action === "inspect" ? (time - 18) / 1.6 : 0;
  return { action, frame: Math.floor(time * 8), phase, still: false };
}

type PortraitWindow = Pick<Window, "requestAnimationFrame" | "cancelAnimationFrame" | "matchMedia">;
type PortraitDocument = Pick<Document, "hidden" | "addEventListener" | "removeEventListener">;

export function startBuilderPortraitAnimation(draw: (pose: BuilderPortraitPose) => void,
  host: PortraitWindow = window, page: PortraitDocument = document): () => void {
  const reduced = host.matchMedia("(prefers-reduced-motion: reduce)");
  let request: number | undefined, previous: number | undefined, elapsed = 0, painted = -Infinity, stopped = false;
  const cancel = () => { if (request !== undefined) host.cancelAnimationFrame(request); request = undefined; previous = undefined; };
  const tick = (now: number) => {
    request = undefined;
    if (stopped || page.hidden || reduced.matches) return;
    if (previous !== undefined) elapsed += Math.max(0, Math.min(250, now - previous)) / 1000;
    previous = now;
    if (elapsed - painted >= 1 / 8) { draw(builderPortraitPose(elapsed)); painted = elapsed; }
    request = host.requestAnimationFrame(tick);
  };
  const sync = () => {
    cancel();
    if (stopped) return;
    if (reduced.matches) { draw(builderPortraitPose(elapsed, true)); painted = -Infinity; }
    else if (!page.hidden) { draw(builderPortraitPose(elapsed)); painted = elapsed; request = host.requestAnimationFrame(tick); }
  };
  page.addEventListener("visibilitychange", sync); reduced.addEventListener("change", sync); sync();
  return () => { stopped = true; cancel(); page.removeEventListener("visibilitychange", sync); reduced.removeEventListener("change", sync); };
}
