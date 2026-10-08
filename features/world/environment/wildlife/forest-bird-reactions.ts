import type { ForestBird } from "./forest-wildlife";
import type { WorldPoint } from "@/features/world/tiled/types";

export type BirdReactionStimulus = {
  kind: "footstep" | "bush-rustle";
  position: WorldPoint;
  /** Zero is silent; omitted intensity is a normal audible event. */
  intensity?: number;
};

export type BirdReactionBounds = { width: number; height: number };
export type BirdReactionWeather = { rain: number; dusk: number; forced?: boolean };

type BirdAttention = {
  startedAt: number;
  duration: number;
  cooldownUntil: number;
  headTurn: number;
  strength: number;
  leavingAt?: number;
};
type BirdFamiliarity = { footsteps: number; lastStepAt: number; lastSeenAt: number };
type BirdEscape = { bird: ForestBird; startedAt: number; lastSeenAt: number; end: WorldPoint; duration: number };
export type BirdVisitor = WorldPoint & { size: number; moving: boolean };

export type BirdReactionState = {
  elapsed: number;
  quietUntil: number;
  attention: Map<string, BirdAttention>;
  familiarity: Map<string, BirdFamiliarity>;
  escapes: Map<string, BirdEscape>;
  proximity: Map<string, { calm: number; alarm: number }>;
  recentGround: Map<string, { bird: ForestBird; seenAt: number }>;
  nextEscapeAt: number;
};

const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const smooth = (value: number) => { const t = clamp(value); return t * t * (3 - 2 * t); };
const resting = (bird: ForestBird) => bird.state === "perched" || bird.state === "preen" || bird.state === "peck" || bird.state === "lookout";
const finitePoint = (point: WorldPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);

/** Session-owned attention; rendering never consumes or advances it. */
export function createBirdReactions(): BirdReactionState {
  return { elapsed: 0, quietUntil: 0, attention: new Map(), familiarity: new Map(),
    escapes: new Map(), proximity: new Map(), recentGround: new Map(), nextEscapeAt: 0 };
}

function proximity(state: BirdReactionState, birds: readonly ForestBird[], dt: number,
  bounds?: BirdReactionBounds, visitorInput?: BirdVisitor | readonly BirdVisitor[]) {
  const visible = new Set(birds.map(bird => bird.id));
  for (const [id, escape] of state.escapes) {
    if (visible.has(id)) escape.lastSeenAt = state.elapsed;
    // Suppress the original visit until it is gone; never reappear on the old branch.
    if (state.elapsed - escape.lastSeenAt > 12 && state.elapsed - escape.startedAt >= escape.duration) state.escapes.delete(id);
  }
  for (const id of state.proximity.keys()) if (!visible.has(id)) state.proximity.delete(id);
  if (!bounds || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height) || bounds.width <= 0 || bounds.height <= 0) return;
  const visitors: readonly BirdVisitor[] = (Array.isArray(visitorInput) ? visitorInput : visitorInput ? [visitorInput] : [])
    .filter(visitor => finitePoint(visitor) && Number.isFinite(visitor.size) && visitor.size > 0
      && visitor.x >= 0 && visitor.y >= 0 && visitor.x <= bounds.width && visitor.y <= bounds.height).slice(0, 8);
  if (!visitors.length) return;
  for (const bird of birds.slice(0, 16).sort((a, b) => (a.id ?? "").localeCompare(b.id ?? ""))) {
    const lowLanding = bird.surface === "ground" && bird.state === "landing" && bird.groundY !== undefined;
    if (!bird.id || !bird.perchId || !resting(bird) && !lowLanding || !finitePoint(bird) || bird.opacity < .5 || state.escapes.has(bird.id)) continue;
    const threatDistance = (visitor: BirdVisitor) => Math.hypot(bird.x - visitor.x, bird.y + bird.size * 3.3 - visitor.y) / visitor.size - (visitor.moving ? .5 : 0);
    const visitor = visitors.reduce((nearest, actor) => threatDistance(actor) < threatDistance(nearest) ? actor : nearest);
    const distance = Math.hypot(bird.x - visitor.x, bird.y + bird.size * 3.3 - visitor.y);
    const memory = state.proximity.get(bird.id) ?? { calm: 0, alarm: 0 };
    if (!visitor.moving && distance < visitor.size * 2.2) memory.calm = Math.min(1, memory.calm + dt / 10);
    else memory.calm = Math.max(0, memory.calm - dt / 25);
    const radius = visitor.size * ((bird.surface === "ground" ? 1.35 : 1.05) - memory.calm * .25);
    const threat = distance < visitor.size * .4 || visitor.moving && distance < radius;
    memory.alarm = Math.max(0, memory.alarm + (threat ? dt : -dt * 2));
    state.proximity.set(bird.id, memory);
    if (memory.alarm < .3 + memory.calm * .6 || state.elapsed < state.nextEscapeAt || state.escapes.size >= 16) continue;
    const dx = bird.x - visitor.x, dy = bird.y - visitor.y;
    const length = Math.hypot(dx, dy) || 1;
    const direction = length > 1 ? { x: dx / length, y: dy / length } : { x: 1, y: -.4 };
    const reach = Math.hypot(bounds.width, bounds.height) + 80;
    const end = { x: bird.x + direction.x * reach, y: bird.y + direction.y * reach };
    state.escapes.set(bird.id, { bird: { ...bird }, startedAt: state.elapsed, lastSeenAt: state.elapsed,
      end, duration: Math.max(6, reach / 155) });
    state.attention.delete(bird.id); state.nextEscapeAt = state.elapsed + .9;
  }
}

function escapeFrame(escape: BirdEscape, elapsed: number): ForestBird | null {
  if (elapsed < escape.startedAt) return escape.bird;
  const age = Math.max(0, elapsed - escape.startedAt), t = clamp(age / escape.duration);
  if (t >= 1) return null;
  const bird = escape.bird, move = t * t, lift = Math.sin(t * Math.PI) * 25;
  const dx = escape.end.x - bird.x, dy = escape.end.y - bird.y;
  const unfolding = smooth(age / .5);
  return { ...bird, x: bird.x + dx * move, y: bird.y + dy * move - lift,
    state: age < .65 ? "takeoff" : "flap", angle: Math.atan2(dy, dx), facing: dx < 0 ? -1 : 1,
    wingFold: (bird.wingFold ?? 1) * (1 - unfolding),
    wingLift: (bird.wingLift ?? .35) * (1 - unfolding) + (.35 + Math.sin(age * 15) * .55) * unfolding,
    phase: bird.phase + age * 15, legReach: (bird.legReach ?? 1) * (1 - smooth(age / .8)),
    bank: (bird.bank ?? 0) * (1 - unfolding) - .15 * unfolding,
    groundY: bird.groundY !== undefined && age < .65 ? bird.groundY + dy * move : undefined,
    hopHeight: bird.groundY !== undefined ? (bird.hopHeight ?? 0) + lift : undefined,
    headTurn: (bird.headTurn ?? 0) * (1 - unfolding), preen: (bird.preen ?? 0) * (1 - unfolding),
    ...(bird.peck !== undefined ? { peck: bird.peck * (1 - unfolding) } : {}),
    tailFlick: Math.sin(age * 3) * .1 };
}

function weatherDeparture(state: BirdReactionState, birds: readonly ForestBird[], bounds?: BirdReactionBounds,
  weather?: BirdReactionWeather) {
  if (!bounds || !weather || weather.forced || !Number.isFinite(bounds.width) || !Number.isFinite(bounds.height)
    || bounds.width <= 0 || bounds.height <= 0 || !Number.isFinite(weather.rain) || !Number.isFinite(weather.dusk)
    || weather.rain < .24 && weather.dusk < .42 || state.elapsed < state.nextEscapeAt) return;
  const candidates = new Map(birds.filter(bird => bird.id).map(bird => [bird.id!, bird]));
  // The weather visibility mask may already have removed the visit this tick.
  // Keep its last actual pose just long enough for the pair to leave in sequence.
  for (const [id, recent] of state.recentGround) if (!candidates.has(id)) candidates.set(id, recent.bird);
  const leaving = [...candidates.values()].filter(bird => bird.id && bird.surface === "ground"
    && (resting(bird) || bird.groundY !== undefined) && finitePoint(bird)
    && !state.escapes.has(bird.id));
  const reach = Math.hypot(bounds.width, bounds.height) + 80;
  for (const bird of leaving) {
    if (state.escapes.size >= 16) break;
    const facing = bird.facing ?? 1, startedAt = Math.max(state.elapsed, state.nextEscapeAt);
    state.escapes.set(bird.id!, { bird: { ...bird }, startedAt, lastSeenAt: state.elapsed,
      end: { x: bird.x + facing * reach, y: bird.y - reach * .35 }, duration: Math.max(6, reach / 155) });
    state.attention.delete(bird.id!); state.nextEscapeAt = startedAt + .9;
  }
}

/**
 * A nearby sound interrupts one resting bird's preening with a look and tail flinch.
 * Its authored route keeps running: no replacement bird, frozen flight, or stale perch.
 * The session calls this once per active step; zero dt also ignores new stimuli.
 */
export function advanceBirdReactions(state: BirdReactionState, baseBirds: readonly ForestBird[],
  dt: number, stimulus?: BirdReactionStimulus, bounds?: BirdReactionBounds, visitor?: BirdVisitor | readonly BirdVisitor[],
  weather?: BirdReactionWeather): void {
  if (!Number.isFinite(dt) || dt <= 0) return;
  state.elapsed += dt;
  for (const bird of baseBirds.slice(0, 16)) if (bird.id && bird.surface === "ground" && bird.opacity > .05)
    state.recentGround.set(bird.id, { bird: { ...bird }, seenAt: state.elapsed });
  for (const [id, recent] of state.recentGround) if (state.elapsed - recent.seenAt > 2) state.recentGround.delete(id);
  while (state.recentGround.size > 16) state.recentGround.delete(state.recentGround.keys().next().value!);
  proximity(state, baseBirds, Math.min(dt, .1), bounds, visitor);
  weatherDeparture(state, baseBirds, bounds, weather);
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

/** Pure presentation: gentle looks retain the authored pose; escapes replace that same individual. */
export function applyBirdReactions(state: BirdReactionState, baseBirds: readonly ForestBird[], enabled = true): ForestBird[] {
  if (!enabled) return [];
  const present = new Set(baseBirds.map(bird => bird.id));
  const frame = baseBirds.flatMap(bird => {
    const escape = bird.id ? state.escapes.get(bird.id) : undefined;
    if (escape) return escapeFrame(escape, state.elapsed) ?? [];
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
      ...(bird.peck !== undefined ? { peck: bird.peck * (1 - weight) } : {}),
      tailFlick: clamp((bird.tailFlick ?? 0) + tailFlinch * weight, -1, 1),
    };
  });
  for (const [id, escape] of state.escapes) if (!present.has(id)) {
    const bird = escapeFrame(escape, state.elapsed);
    if (bird) frame.push(bird);
  }
  return frame;
}
