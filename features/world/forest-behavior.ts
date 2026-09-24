import { findWorldPath, isWalkable, type WorldNavigation } from "./navigation";
import type { WorldPoint } from "./tiled/types";

export type ForestActivity = "look" | "sniff" | "groom" | "rest";
export type ForestInterest = { id: string; position: WorldPoint; activity: ForestActivity };
export type ForestBehaviorMemory = {
  recent: { id: string; activity: ForestActivity; at: number }[];
  restUntil: number;
  reason: string;
  target: ForestInterest | null;
};
export type ForestBehaviorGoal = ForestInterest & { path: WorldPoint[]; reason: string };

export const createForestBehavior = (): ForestBehaviorMemory => ({
  recent: [], restUntil: 0, reason: "waiting", target: null,
});
const clamp = (n: number) => Math.max(0, Math.min(1, n));
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);

/** Evaluate only when a stationary actor needs a new intention, never every paint. */
export function chooseForestGoal(navigation: WorldNavigation, interests: readonly ForestInterest[],
  memory: ForestBehaviorMemory, context: {
    position: WorldPoint; size: number; elapsed: number; awakeUntil: number;
    dusk: number; rain: number; random: () => number;
  }): ForestBehaviorGoal | null {
  const { position, size, elapsed, random } = context;
  const dusk = clamp(context.dusk), rain = clamp(context.rain);
  const choices: ForestInterest[] = interests.slice(0, 24).map(interest => ({ ...interest, position: { ...interest.position } }));
  // A few fresh grass positions keep the named landmarks from becoming another fixed loop.
  // The bounded sample/path budgets also keep a disconnected region inexpensive.
  for (let attempt = 0, accepted = 0; attempt < 24 && accepted < 4; attempt++) {
    const point = { x: navigation.bounds.x + random() * navigation.bounds.width,
      y: navigation.bounds.y + random() * navigation.bounds.height };
    if (distance(position, point) < size * .35 || !isWalkable(navigation, point)) continue;
    choices.push({ id: `grass-${Math.round(point.x / size)}-${Math.round(point.y / size)}`,
      position: point, activity: rain > .35 ? "groom" : random() < .55 ? "sniff" : "look" });
    accepted++;
  }
  let best: ForestBehaviorGoal | null = null, bestScore = -Infinity;
  for (const interest of choices) {
    if (interest.activity === "rest" && (rain > .35 || elapsed < context.awakeUntil || elapsed < memory.restUntil)) continue;
    if (distance(position, interest.position) < size * .22) continue;
    const path = findWorldPath(navigation, position, interest.position);
    if (!path) continue;
    const length = path.slice(1).reduce((sum, point, index) => sum + distance(path[index], point), 0);
    const repeat = memory.recent.reduce((penalty, recent) => {
      const freshness = Math.max(0, 1 - (elapsed - recent.at) / 75);
      return penalty + freshness * (recent.id === interest.id ? 3.5 : recent.activity === interest.activity ? .55 : 0);
    }, 0);
    const weather = interest.activity === "rest" ? dusk * 1.8
      : interest.activity === "groom" ? rain * 1.7 : interest.activity === "sniff" ? (1 - rain) * .35 : 0;
    const score = 2 + weather - Math.min(3, length / (size * 3)) - repeat + random() * 1.25;
    if (score <= bestScore) continue;
    bestScore = score;
    best = { ...interest, path, reason: interest.activity === "rest" ? "quiet-rest"
      : rain > .35 && interest.activity === "groom" ? "rain-grooming"
      : interest.id.startsWith("grass-") ? "explore-grass" : "nearby-interest" };
  }
  memory.reason = best?.reason ?? "no-reachable-goal";
  memory.target = best ? { id: best.id, activity: best.activity, position: { ...best.position } } : null;
  if (best) {
    memory.recent.push({ id: best.id, activity: best.activity, at: elapsed });
    memory.recent = memory.recent.slice(-8);
    if (best.activity === "rest") memory.restUntil = elapsed + 45;
  }
  return best;
}
