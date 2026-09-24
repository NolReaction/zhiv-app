import { findWorldPath, isWalkable, type WorldNavigation } from "./navigation";
import type { WorldPoint } from "./tiled/types";
import { beginForestIntention, createForestMind, recordForestCandidates, scoreForestAction,
  type ForestMindCandidate, type ForestMindState } from "./forest-mind";

export type ForestActivity = "look" | "sniff" | "groom" | "rest";
export type ForestInterest = { id: string; position: WorldPoint; activity: ForestActivity };
export type ForestBehaviorMemory = {
  recent: { id: string; activity: ForestActivity; at: number }[];
  restUntil: number;
  reason: string;
  target: ForestInterest | null;
  mind: ForestMindState;
};
export type ForestBehaviorGoal = ForestInterest & { path: WorldPoint[]; reason: string };

export const createForestBehavior = (): ForestBehaviorMemory => ({
  recent: [], restUntil: 0, reason: "waiting", target: null, mind: createForestMind(),
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
  const choices: ForestInterest[] = [];
  const choiceIds = new Set<string>();
  // IDs are also memory/diagnostic identities. Keep the first authored landmark,
  // and at most one sampled representative of each quantized grass location.
  for (const interest of interests.slice(0, 24)) {
    if (choiceIds.has(interest.id)) continue;
    choiceIds.add(interest.id);
    choices.push({ ...interest, position: { ...interest.position } });
  }
  // A few fresh grass positions keep the named landmarks from becoming another fixed loop.
  // The bounded sample/path budgets also keep a disconnected region inexpensive.
  for (let attempt = 0, accepted = 0; attempt < 24 && accepted < 4; attempt++) {
    const point = { x: navigation.bounds.x + random() * navigation.bounds.width,
      y: navigation.bounds.y + random() * navigation.bounds.height };
    if (distance(position, point) < size * .35 || !isWalkable(navigation, point)) continue;
    const id = `grass-${Math.round(point.x / size)}-${Math.round(point.y / size)}`;
    if (choiceIds.has(id)) continue;
    choiceIds.add(id);
    choices.push({ id,
      position: point, activity: rain > .35 ? "groom" : random() < .55 ? "sniff" : "look" });
    accepted++;
  }
  let best: ForestBehaviorGoal | null = null, bestScore = -Infinity;
  const candidates: ForestMindCandidate[] = [];
  for (const interest of choices) {
    const candidate = scoreForestAction(memory.mind, interest.activity, interest.id, { rain, dusk, noise: random() * .6 });
    const reject = (reason: string) => candidates.push({ ...candidate, available: false, score: null, reasons: [reason] });
    if (interest.activity === "rest" && (rain > .35 || elapsed < context.awakeUntil || elapsed < memory.restUntil)) {
      reject(rain > .35 ? "На мокрой траве отдыхать неуютно" : "Недавно отдыхал или проснулся"); continue;
    }
    if (!candidate.available) { candidates.push(candidate); continue; }
    if (distance(position, interest.position) < size * .22) continue;
    const path = findWorldPath(navigation, position, interest.position);
    if (!path) { reject("Безопасный путь не найден"); continue; }
    const length = path.slice(1).reduce((sum, point, index) => sum + distance(path[index], point), 0);
    const repeat = memory.recent.reduce((penalty, recent) => {
      const freshness = Math.max(0, 1 - (elapsed - recent.at) / 75);
      return penalty + freshness * (recent.id === interest.id ? 3.5 : recent.activity === interest.activity ? .55 : 0);
    }, 0);
    const score = candidate.score! - Math.min(2, length / (size * 4)) - repeat;
    candidate.score = score;
    if (length > size * 1.6) candidate.reasons.push("До места нужно пройти по безопасному пути");
    if (repeat > .1) candidate.reasons.push("Недавно выбирал это место");
    candidates.push(candidate);
    if (score <= bestScore) continue;
    bestScore = score;
    best = { ...interest, path, reason: interest.activity === "rest" ? "quiet-rest"
      : rain > .35 && interest.activity === "groom" ? "rain-grooming"
      : interest.id.startsWith("grass-") ? "explore-grass" : "nearby-interest" };
  }
  memory.reason = best?.reason ?? "no-reachable-goal";
  memory.target = best ? { id: best.id, activity: best.activity, position: { ...best.position } } : null;
  recordForestCandidates(memory.mind, candidates, best?.id ?? null);
  if (best) {
    const candidate = candidates.find(item => item.key === best.id);
    beginForestIntention(memory.mind, best.activity, best.id, candidate?.reasons[0] ?? "Выбрал занятие на полянке", "clearing");
    memory.recent.push({ id: best.id, activity: best.activity, at: elapsed });
    memory.recent = memory.recent.slice(-8);
    if (best.activity === "rest") memory.restUntil = elapsed + 45;
  }
  return best;
}
