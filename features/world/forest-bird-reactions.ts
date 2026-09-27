import type { ForestBird } from "./forest-wildlife";
import type { WorldPoint } from "./tiled/types";

export type BirdReactionStimulus = {
  kind: "footstep" | "bush-rustle";
  position: WorldPoint;
  /** Zero is silent; omitted intensity is a normal audible event. */
  intensity?: number;
};

export type BirdReactionBounds = { width: number; height: number };

type BirdAttention = {
  startedAt: number;
  duration: number;
  cooldownUntil: number;
  headTurn: number;
  strength: number;
  leavingAt?: number;
};
type BirdFamiliarity = { footsteps: number; lastStepAt: number; lastSeenAt: number };

export type BirdReactionState = {
  elapsed: number;
  quietUntil: number;
  attention: Map<string, BirdAttention>;
  familiarity: Map<string, BirdFamiliarity>;
};

const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const resting = (bird: ForestBird) => bird.state === "perched" || bird.state === "preen";
const finitePoint = (point: WorldPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

/** Session-owned attention; rendering never consumes or advances it. */
export function createBirdReactions(): BirdReactionState {
  return { elapsed: 0, quietUntil: 0, attention: new Map(), familiarity: new Map() };
}

/**
 * A nearby sound interrupts one resting bird's preening with a look and tail flinch.
 * Its authored route keeps running: no replacement bird, frozen flight, or stale perch.
 * The session calls this once per active step; zero dt also ignores new stimuli.
 */
export function advanceBirdReactions(state: BirdReactionState, baseBirds: readonly ForestBird[],
  dt: number, stimulus?: BirdReactionStimulus, bounds?: BirdReactionBounds): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  state.elapsed += dt;
  const visible = new Map(baseBirds.filter(bird => bird.id).map(bird => [bird.id!, bird]));
  for (const [id, familiarity] of state.familiarity) {
    if (visible.has(id)) familiarity.lastSeenAt = state.elapsed;
    if (state.elapsed - familiarity.lastSeenAt > 12) { state.familiarity.delete(id); continue; }
    familiarity.footsteps *= Math.exp(-dt / 75);
  }
  for (const [id, attention] of state.attention) {
    if (state.elapsed >= attention.cooldownUntil) { state.attention.delete(id); continue; }
    const bird = visible.get(id);
    // A departure is still free to unfold its wings and accelerate on its own clock.
    // Only the small head/tail overlay trails off over the first moments of flight.
    if (bird && !resting(bird) && bird.state !== "hop" && attention.leavingAt === undefined)
      attention.leavingAt = state.elapsed;
  }
  if (!stimulus || !finitePoint(stimulus.position)) return;
  if (bounds && (!Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0 || stimulus.position.x < 0 || stimulus.position.y < 0
    || stimulus.position.x > bounds.width || stimulus.position.y > bounds.height)) return;
  const intensity = stimulus.intensity ?? 1;
  if (!Number.isFinite(intensity) || intensity <= 0) return;
  const strength = clamp(intensity);
  const radius = (stimulus.kind === "bush-rustle" ? 112 : 64) * (.5 + strength * .5);
  // A visit keeps a small memory of harmless passing steps. Learning does not
  // restart an active look, and a new individual never inherits the old one's calm.
  const familiarityBefore = new Map<string, number>();
  for (const bird of baseBirds) {
    if (!bird.id || !bird.perchId || !resting(bird) || !finitePoint(bird) || bird.opacity <= .05) continue;
    const distance = Math.hypot(bird.x - stimulus.position.x, bird.y - stimulus.position.y);
    if (distance >= radius) continue;
    const memory = state.familiarity.get(bird.id)
      ?? { footsteps: 0, lastStepAt: -10, lastSeenAt: state.elapsed };
    familiarityBefore.set(bird.id, memory.footsteps);
    if (stimulus.kind === "footstep" && state.elapsed - memory.lastStepAt >= 1.5) {
      memory.footsteps = clamp(memory.footsteps + .16 * (.5 + strength * .5) * (1 - distance / radius));
      memory.lastStepAt = state.elapsed;
      state.familiarity.set(bird.id, memory);
    }
  }
  // The runtime has at most five birds; retain a small hard bound for malformed input, too.
  while (state.familiarity.size > 16) state.familiarity.delete(state.familiarity.keys().next().value!);
  if (state.elapsed < state.quietUntil) return;
  let selected: ForestBird | undefined, nearest = radius;
  for (const bird of baseBirds) {
    if (!bird.id || !bird.perchId || !resting(bird) || !finitePoint(bird) || bird.opacity <= .05
      || state.attention.has(bird.id)) continue;
    const distance = Math.hypot(bird.x - stimulus.position.x, bird.y - stimulus.position.y);
    if (distance < nearest || distance === nearest && (!selected || bird.id < selected.id!)) {
      selected = bird; nearest = distance;
    }
  }
  if (!selected?.id) return;
  const facing = selected.facing ?? (Math.cos(selected.angle) < 0 ? -1 : 1);
  const behind = (stimulus.position.x - selected.x) * facing < 0;
  const calm = stimulus.kind === "footstep" ? familiarityBefore.get(selected.id) ?? 0 : 0;
  state.attention.set(selected.id, {
    startedAt: state.elapsed,
    duration: stimulus.kind === "bush-rustle" ? 1.6 : 1.25,
    cooldownUntil: state.elapsed + 8,
    headTurn: behind ? -1 : .4,
    strength: (.8 + strength * .2) * (1 - calm * .65),
  });
  // Frequent steps cannot make every nearby bird react together or restart its look.
  state.quietUntil = state.elapsed + (stimulus.kind === "bush-rustle" ? 4.5 : 3.5);
}

/** Pure pose overlay: identity, position, wing phase, feet and flight remain authored. */
export function applyBirdReactions(state: BirdReactionState, baseBirds: readonly ForestBird[]): ForestBird[] {
  return baseBirds.map(bird => {
    const attention = bird.id ? state.attention.get(bird.id) : undefined;
    if (!attention) return bird;
    const age = state.elapsed - attention.startedAt;
    if (age <= 0 || age >= attention.duration) return bird;
    const departure = attention.leavingAt === undefined ? 1 : 1 - smooth((state.elapsed - attention.leavingAt) / .28);
    const envelope = smooth(age / .16) * (1 - smooth((age - attention.duration + .42) / .42)) * departure;
    const weight = envelope * attention.strength;
    if (weight <= 0) return bird;
    const head = bird.headTurn ?? 0;
    const tailFlinch = Math.sin(Math.PI * clamp(age / .32)) * .45;
    return { ...bird,
      headTurn: head + (attention.headTurn - head) * weight,
      preen: (bird.preen ?? 0) * (1 - weight),
      tailFlick: clamp((bird.tailFlick ?? 0) + tailFlinch * weight, -1, 1),
    };
  });
}
