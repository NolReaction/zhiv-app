import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { ForestBird } from "@/features/world/environment/wildlife/forest-wildlife";
import type { WorldPoint } from "@/features/world/tiled/types";

export type ForestBirdwatch = {
  birdId: string;
  /** Last visible position of this individual, for observation/debugging. */
  target: WorldPoint;
  /** Initial perch bearing keeps small hops from flipping the actor's body. */
  lookTarget: WorldPoint;
  elapsed: number;
  duration: number;
  missingSeconds: number;
};
type BirdwatchActor = WorldPoint & { size: number; direction?: PixelDirection };
export type ForestBirdwatchFrame = {
  pose: PixelPose; frame: number; direction: PixelDirection;
  stage: "notice" | "watch" | "release" | "settle" | "finished";
};
const OUTRO_SECONDS = .6;
const EPSILON = 1e-9;
const point = ({ x, y }: WorldPoint): WorldPoint => ({ x, y });
const finitePoint = (value: WorldPoint) => Number.isFinite(value.x) && Number.isFinite(value.y);
const seconds = (value: number) => Number.isFinite(value) ? Math.max(0, value) : 0;
const durationOf = (duration: number) => Number.isFinite(duration) ? Math.max(6, Math.min(8, duration)) : 6;
const visiblePerch = (bird: ForestBird) => typeof bird.id === "string" && bird.id.trim().length > 0
  && finitePoint(bird) && Number.isFinite(bird.size) && bird.size > 0
  && Number.isFinite(bird.opacity) && bird.opacity >= .5
  && (bird.state === "perched" || bird.state === "preen" || bird.state === "hop" || bird.state === "peck" || bird.state === "lookout");
const finished = (watch: ForestBirdwatch) => seconds(watch.elapsed) + EPSILON >= durationOf(watch.duration)
  || seconds(watch.missingSeconds) + EPSILON >= OUTRO_SECONDS;

/** Only already visible, nearby perched birds can invite a quiet observation. */
export function chooseForestBirdwatchTarget(birds: readonly ForestBird[], actor: BirdwatchActor): ForestBird | null {
  if (!finitePoint(actor) || !Number.isFinite(actor.size) || actor.size <= 0) return null;
  const radius = actor.size * 3;
  let selected: ForestBird | null = null, nearest = radius;
  for (const bird of birds) {
    if (!visiblePerch(bird)) continue;
    const distance = Math.hypot(bird.x - actor.x, bird.y - actor.y);
    if (distance > radius) continue;
    if (!selected || distance < nearest || distance === nearest && bird.id! < selected.id!) {
      selected = bird; nearest = distance;
    }
  }
  return selected;
}

/** Call with a chosen candidate; neither the bird nor its authored flight is changed. */
export function createForestBirdwatch(bird: ForestBird, duration = 6): ForestBirdwatch {
  if (!visiblePerch(bird)) throw new TypeError("Birdwatch requires an identified, visible perched bird");
  return { birdId: bird.id!, target: point(bird), lookTarget: point(bird), elapsed: 0,
    duration: durationOf(duration), missingSeconds: 0 };
}

/** One active scene clock advances the observation. A different bird never takes its place. */
export function advanceForestBirdwatch(watch: ForestBirdwatch, birds: readonly ForestBird[], delta: number): "watching" | "finished" {
  if (finished(watch)) return "finished";
  if (!Number.isFinite(delta) || delta <= 0) return "watching";
  const dt = Math.min(.1, delta);
  watch.elapsed = Math.min(durationOf(watch.duration), seconds(watch.elapsed) + dt);
  const bird = birds.find(item => item.id === watch.birdId && visiblePerch(item));
  if (bird) {
    watch.target = point(bird);
    watch.missingSeconds = 0;
  } else watch.missingSeconds = Math.min(OUTRO_SECONDS, seconds(watch.missingSeconds) + dt);
  return finished(watch) ? "finished" : "watching";
}

function lookDirection(watch: ForestBirdwatch, actor: BirdwatchActor): PixelDirection {
  const fallback = actor.direction ?? "front";
  if (!finitePoint(actor) || !Number.isFinite(actor.size) || actor.size <= 0 || !finitePoint(watch.lookTarget)) return fallback;
  const dx = watch.lookTarget.x - actor.x, dy = watch.lookTarget.y - (actor.y - actor.size * .45);
  if (dy < 0 && Math.abs(dy) > Math.abs(dx) * 1.35) return "back";
  if (Math.abs(dx) > actor.size * .08) return dx < 0 ? "left" : "right";
  return dy > actor.size * .2 ? "front" : fallback;
}

/** No position, timers or random sampling: circle and world see the same quiet pose. */
export function forestBirdwatchFrame(watch: ForestBirdwatch, actor: BirdwatchActor, still = false): ForestBirdwatchFrame {
  const direction = lookDirection(watch, actor), elapsed = seconds(watch.elapsed);
  if (finished(watch)) return { pose: "idle", frame: 0, direction, stage: "finished" };
  if (still) return { pose: "idle", frame: 0, direction, stage: "watch" };
  if (watch.missingSeconds > 0) return { pose: "idle", frame: 0, direction, stage: "release" };
  if (elapsed < .65) return { pose: "wonder", frame: Math.min(3, Math.floor(elapsed / .18)), direction, stage: "notice" };
  const settling = elapsed >= durationOf(watch.duration) - .5;
  const blinking = !settling && (elapsed >= 3.1 && elapsed < 3.26 || elapsed >= 6.35 && elapsed < 6.51);
  return { pose: blinking ? "blink" : "idle", frame: blinking ? 1 : 0, direction, stage: settling ? "settle" : "watch" };
}
