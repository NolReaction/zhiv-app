import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldBounds, WorldHabitat, WorldPoint } from "./tiled/types";
import type { ForestFirefly } from "./forest-wildlife";
import { heroHandAnchor, type FaunaActor, type HeroAnchorPose } from "./hero-anchors";

export type { FaunaActor } from "./hero-anchors";
export type FaunaSpecies = "butterfly" | "firefly";
export type FaunaMode = "fly" | "rest-seek" | "rest" | "approach" | "perch" | "depart" | "return" | "refuge";
type Orbit = { x: number; y: number; rx: number; ry: number; sx: number; sy: number; px: number; py: number };
export type ForestFaunaEntity = WorldPoint & {
  id: string; species: FaunaSpecies; habitatId: string; size: number; phase: number;
  vx: number; vy: number; angle: number; mode: FaunaMode; modeElapsed: number;
  target: WorldPoint | null; anchorId: string | null; anchorOffset: WorldPoint; cooldownUntil: number;
  /** Kept after hero release, until this individual has physically returned. */
  interactionToken: number | null;
  stimulusCooldownUntil: number; nextRestAt: number; restUntil: number;
  orbit: Orbit; opacity: number; departure: WorldPoint | null;
};
export type FaunaEncounterPhase = "notice" | "raise" | "approach" | "perch" | "release" | "interrupt";
export type FaunaEncounter = {
  token: number; entityId: string; kind: FaunaSpecies; phase: FaunaEncounterPhase;
  elapsed: number; phaseElapsed: number; direction: PixelDirection; actor: FaunaActor;
};
export type ForestFaunaState = {
  elapsed: number; entities: ForestFaunaEntity[]; habitats: WorldHabitat[];
  encounter: FaunaEncounter | null; nextEncounterAt: number; sequence: number;
  visibility: { butterflies: boolean; fireflies: boolean }; width: number; height: number;
  dusk: number; firefliesForced: boolean; lastReason: string | null;
};
type WildlifeMode = "auto" | "on" | "off";
export type ForestFaunaConditions = {
  dusk: number; rain: number; blocked?: boolean;
  butterflies?: WildlifeMode; fireflies?: WildlifeMode;
};
export type ForestFaunaOptions = ForestFaunaConditions & {
  actor?: FaunaActor; paused?: boolean; reducedMotion?: boolean;
  /** A frozen actor/pose also freezes a held encounter, but other fauna keep living. */
  freezeEncounter?: boolean; wind?: WorldPoint;
};
export type FaunaRenderParticle = ForestFirefly & { id: string; species: FaunaSpecies; mode: FaunaMode; glow?: number };
export type FaunaInteractionFrame = HeroAnchorPose & {
  stage: FaunaEncounterPhase; entityId: string; token: number;
};
export type FaunaStimulus = WorldPoint & { kind: "movement" | "rustle"; radius?: number; strength?: number };

const TAU = Math.PI * 2;
const LIMITS = { butterfly: 6, firefly: 12 };
const clamp = (v: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
const finite = (v: number) => Number.isFinite(v) ? v : 0;
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const point = (e: WorldPoint): WorldPoint => ({ x: e.x, y: e.y });
function hash(id: string) {
  let seed = 2166136261;
  for (let i = 0; i < id.length; i++) seed = Math.imul(seed ^ id.charCodeAt(i), 16777619);
  return seed >>> 0;
}
function noise(seed: number, index: number) {
  let n = (seed + Math.imul(index + 1, 0x9e3779b9)) | 0;
  n = Math.imul(n ^ n >>> 16, 0x21f0aaad); n = Math.imul(n ^ n >>> 15, 0x735a2d97);
  return ((n ^ n >>> 15) >>> 0) / 4294967296;
}
function bounds(points: WorldPoint[]): WorldBounds {
  const xs = points.map(p => p.x), ys = points.map(p => p.y);
  const x = Math.min(...xs), y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
function inPolygon(p: WorldPoint, points: WorldPoint[]) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[i], b = points[j];
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}
function orbitSample(e: ForestFaunaEntity, elapsed: number) {
  const o = e.orbit, x = elapsed * o.sx + o.px, y = elapsed * o.sy + o.py;
  return { x: o.x + Math.sin(x) * o.rx, y: o.y + Math.sin(y) * o.ry,
    vx: Math.cos(x) * o.rx * o.sx, vy: Math.cos(y) * o.ry * o.sy };
}
function legacyHabitat(field: WorldBounds, species: FaunaSpecies, id: string, capacity: number): WorldHabitat {
  return { id, species, capacity, anchors: [], points: [
    { x: field.x, y: field.y }, { x: field.x + field.width, y: field.y },
    { x: field.x + field.width, y: field.y + field.height }, { x: field.x, y: field.y + field.height },
  ] };
}
function entity(habitat: WorldHabitat, seed: number, index: number, scale: number, legacy: boolean): ForestFaunaEntity {
  const field = bounds(habitat.points), butterfly = habitat.species === "butterfly";
  const n = butterfly ? index + 1 : index + 20, stride = butterfly ? 5 : 7;
  const phase = noise(seed, n * stride) * TAU;
  const speed = butterfly ? .28 : .16 + noise(seed, n * 7 + 3) * .06;
  const orbit: Orbit = {
    x: field.x + field.width * (.15 + noise(seed, n * stride + (butterfly ? 1 : 4)) * .7),
    y: field.y + field.height * (.15 + noise(seed, n * stride + (butterfly ? 2 : 5)) * .7),
    rx: butterfly ? Math.min(field.width * .055, legacy ? Infinity : 16 * scale)
      : Math.min(field.width * .065, scale * (11 + noise(seed, n * 7 + 1) * 8)),
    ry: butterfly ? Math.min(field.height * .04, legacy ? Infinity : 10 * scale)
      : Math.min(field.height * .05, scale * (7 + noise(seed, n * 7 + 2) * 5)),
    sx: speed, sy: butterfly ? .21 : speed * .81, px: phase, py: phase * (butterfly ? 2 : 1.7),
  };
  // Authored polygons can be concave. Find a valid centre once, never project motion each frame.
  if (!legacy && !inPolygon(orbit, habitat.points)) {
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = { x: field.x + field.width * noise(seed, 500 + index * 40 + attempt),
        y: field.y + field.height * noise(seed, 1300 + index * 40 + attempt) };
      if (inPolygon(candidate, habitat.points)) { orbit.x = candidate.x; orbit.y = candidate.y; break; }
    }
  }
  if (!legacy) for (let iteration = 0; iteration < 8; iteration++) {
    const fits = Array.from({ length: 16 }, (_, i) => ({ x: orbit.x + Math.sin(i / 16 * TAU) * orbit.rx,
      y: orbit.y + Math.cos(i / 16 * TAU) * orbit.ry })).every(p => inPolygon(p, habitat.points));
    if (fits) break;
    orbit.rx *= .65; orbit.ry *= .65;
  }
  const e: ForestFaunaEntity = { id: `${habitat.id}:${habitat.species}:${index + 1}`, species: habitat.species,
    habitatId: habitat.id, size: scale * (butterfly ? (.8 + noise(seed, n * 5 + 3) * .3) * 1.35
      : 1.35 + noise(seed, n * 7 + 6) * .25), phase,
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, orbit, mode: "fly", modeElapsed: 0,
    target: null, anchorId: null, anchorOffset: { x: 0, y: 0 }, cooldownUntil: 0, interactionToken: null, stimulusCooldownUntil: 0,
    nextRestAt: 13 + noise(seed, n + 90) * 25, restUntil: 0, departure: null, opacity: butterfly ? .85 : .9 };
  const initial = orbitSample(e, 0);
  Object.assign(e, initial); e.angle = Math.atan2(e.vy, e.vx) + Math.PI / 2;
  return e;
}

/** Stable population, local to the shared session. Missing markup retains the old orbit seeds. */
export function createForestFauna(scene: FixedWorldScene, seed = hash(scene.id)): ForestFaunaState {
  const scale = clamp(Math.min(scene.focus.width, scene.focus.height) / 256, .35, 2);
  const world = { x: 0, y: 0, width: scene.width, height: scene.height };
  const legacy = scene.habitats === undefined;
  const habitats: WorldHabitat[] = legacy ? [
    legacyHabitat(scene.focus, "butterfly", "legacy-clearing-butterflies", 3),
    legacyHabitat(world, "butterfly", "legacy-world-butterflies", 3),
    legacyHabitat(scene.focus, "firefly", "legacy-clearing-fireflies", 5),
    legacyHabitat(world, "firefly", "legacy-world-fireflies", 7),
  ] : scene.habitats!;
  const entities: ForestFaunaEntity[] = [], counts = { butterfly: 0, firefly: 0 };
  for (const habitat of habitats) {
    if (habitat.points.length < 3) continue;
    const capacity = Math.min(LIMITS[habitat.species] - counts[habitat.species], Math.max(0, Math.floor(habitat.capacity)));
    for (let i = 0; i < capacity; i++) {
      const index = counts[habitat.species]++;
      entities.push(entity(habitat, legacy ? seed : seed ^ hash(habitat.id), index, scale, legacy));
    }
  }
  return { elapsed: 0, entities, habitats, encounter: null, nextEncounterAt: 0, sequence: 0,
    width: scene.width, height: scene.height, visibility: { butterflies: true, fireflies: true },
    dusk: 0, firefliesForced: false, lastReason: null };
}

function permitted(species: FaunaSpecies, options: ForestFaunaConditions) {
  const enabled = species === "butterfly" ? options.butterflies : options.fireflies;
  return !options.blocked && enabled !== "off" && options.rain < .35
    && (enabled === "on" || (species === "butterfly" ? options.dusk < .55 : options.dusk >= .55));
}
function candidate(state: ForestFaunaState, kind: FaunaSpecies, actor: FaunaActor, options: ForestFaunaConditions, forced: boolean) {
  if (state.encounter || state.elapsed < state.nextEncounterAt || !permitted(kind, options)
    || ![actor.x, actor.y, actor.size].every(Number.isFinite) || actor.size <= 0) return null;
  const reach = forced ? Math.min(140, actor.size * 2.4) : Math.min(95, actor.size * 1.55);
  let best: ForestFaunaEntity | null = null, nearest = reach;
  for (const e of state.entities) {
    if (e.species !== kind || e.interactionToken !== null || e.cooldownUntil > state.elapsed
      || !["fly", "rest", "rest-seek", "refuge"].includes(e.mode)) continue;
    const d = distance(e, actor);
    if (d < nearest) { nearest = d; best = e; }
  }
  return best;
}
export function canRequestFaunaInteraction(state: ForestFaunaState, kind: FaunaSpecies, actor: FaunaActor,
  options: ForestFaunaConditions, forced = false): boolean {
  return Boolean(candidate(state, kind, actor, options, forced));
}

/** Both reservations are one token; requesting it again never restarts a flight. */
export function requestFaunaInteraction(state: ForestFaunaState, kind: FaunaSpecies, actor: FaunaActor,
  options: ForestFaunaConditions, forced = false): boolean {
  if (state.encounter) {
    const same = state.encounter.kind === kind && !["interrupt", "release"].includes(state.encounter.phase);
    state.lastReason = same ? null : "Мохлик уже занят другой встречей.";
    return same;
  }
  const e = candidate(state, kind, actor, options, forced);
  if (!e) {
    state.lastReason = options.blocked ? "Мохлик сейчас занят."
      : !permitted(kind, options) ? "Для встречи не подходят время суток, погода или настройки."
        : state.elapsed < state.nextEncounterAt ? "Мохлик отдыхает после недавней встречи."
          : "Рядом нет свободной особи: обитатели продолжают свою жизнь.";
    return false;
  }
  state.lastReason = null;
  const direction: PixelDirection = e.x < actor.x - actor.size * .15 ? "left"
    : e.x > actor.x + actor.size * .15 ? "right" : "front";
  state.encounter = { token: ++state.sequence, entityId: e.id, kind, phase: "notice", elapsed: 0,
    phaseElapsed: 0, direction, actor: { ...actor } };
  e.interactionToken = state.encounter.token;
  setMode(e, "approach"); e.anchorId = null;
  return true;
}
function setMode(e: ForestFaunaEntity, mode: FaunaMode) {
  if (e.mode === mode) return;
  e.mode = mode; e.modeElapsed = 0;
}
function depart(state: ForestFaunaState, e: ForestFaunaEntity) {
  if (e.mode === "depart" || e.mode === "return") return;
  setMode(e, "depart"); e.anchorId = null;
  const side = e.orbit.x >= e.x ? 1 : -1;
  e.departure = { x: clamp(e.x + side * 24, 1, state.width - 1), y: clamp(e.y - 20, 1, state.height - 1) };
  e.cooldownUntil = Math.max(e.cooldownUntil, state.elapsed + 25);
}
function releaseHero(state: ForestFaunaState) {
  state.encounter = null; state.nextEncounterAt = state.elapsed + 10;
}

/** The hero can respond after 600ms; the same insect remains in flight for as long as needed. */
export function interruptFaunaInteraction(state: ForestFaunaState): boolean {
  const encounter = state.encounter;
  if (!encounter) return false;
  if (encounter.phase === "interrupt" || encounter.phase === "release") return true;
  encounter.phase = "interrupt"; encounter.phaseElapsed = 0;
  const e = state.entities.find(item => item.id === encounter.entityId);
  if (e) depart(state, e);
  return true;
}

/** A fixed DEV pose releases the hero immediately; the insect resumes from this same point later. */
export function cancelFaunaInteraction(state: ForestFaunaState): boolean {
  const encounter = state.encounter;
  if (!encounter) return false;
  const e = state.entities.find(item => item.id === encounter.entityId);
  if (e) depart(state, e);
  releaseHero(state);
  return true;
}

export function faunaInteractionFrame(state: ForestFaunaState): FaunaInteractionFrame | null {
  const encounter = state.encounter;
  if (!encounter) return null;
  const raised = ["raise", "approach", "perch"].includes(encounter.phase);
  return { pose: raised ? "greet" : "wonder", frame: raised ? 0 : Math.floor(encounter.phaseElapsed * 3) % 4,
    direction: encounter.direction, stage: encounter.phase, entityId: encounter.entityId, token: encounter.token };
}

function anchorFor(state: ForestFaunaState, e: ForestFaunaEntity, kind: "rest" | "shelter") {
  const habitat = state.habitats.find(item => item.id === e.habitatId);
  const suitable = habitat?.anchors.filter(a => a.kind === kind) ?? [];
  // Occupancy keeps a visible resting population from collapsing onto one identical point.
  const occupancy = (id: string) => state.entities.filter(other => other !== e && other.anchorId === id).length;
  return suitable.filter(a => kind === "shelter" || occupancy(a.id) === 0)
    .sort((a, b) => occupancy(a.id) - occupancy(b.id) || distance(e, a.position) - distance(e, b.position))[0];
}
function setAnchor(state: ForestFaunaState, e: ForestFaunaEntity, anchor: WorldHabitat["anchors"][number]) {
  e.anchorId = anchor.id; e.anchorOffset = { x: 0, y: 0 };
  if (anchor.kind !== "shelter") return;
  // A shelter marks a patch of real foliage, so several bodies can share it without overlapping.
  const offset = { x: Math.cos(e.phase * 2.7) * (1 + e.size * 1.2), y: Math.sin(e.phase * 2.7) * 2 };
  const habitat = state.habitats.find(h => h.id === e.habitatId);
  if (habitat && inPolygon({ x: anchor.position.x + offset.x, y: anchor.position.y + offset.y }, habitat.points)) e.anchorOffset = offset;
}
function shelterNeeded(e: ForestFaunaEntity, options: ForestFaunaConditions) {
  const forced = (e.species === "butterfly" ? options.butterflies : options.fireflies) === "on";
  return options.rain >= .35 || !forced && (e.species === "butterfly" ? options.dusk >= .55 : options.dusk < .55);
}

/** A bounded impulse is integrated, never a position change. Reserved partners ignore disturbances. */
export function emitFaunaStimulus(state: ForestFaunaState, stimulus: FaunaStimulus): number {
  const radius = clamp(stimulus.radius ?? (stimulus.kind === "rustle" ? 62 : 30), 1, 90);
  const strength = clamp(stimulus.strength ?? 1, 0, 1);
  let affected = 0;
  for (const e of state.entities) {
    if (affected >= 4) break;
    if (e.stimulusCooldownUntil > state.elapsed || ["approach", "perch", "depart", "return"].includes(e.mode)) continue;
    const d = distance(e, stimulus);
    if (d >= radius) continue;
    const amount = (1 - d / radius) * strength;
    const dx = e.x - stimulus.x || Math.cos(e.phase), dy = e.y - stimulus.y || -1;
    const length = Math.hypot(dx, dy);
    e.departure = { x: clamp(e.x + dx / length * (10 + amount * 22), 1, state.width - 1),
      y: clamp(e.y + dy / length * (8 + amount * 15) - 6, 1, state.height - 1) };
    setMode(e, "depart"); e.anchorId = null;
    e.stimulusCooldownUntil = state.elapsed + 7; e.cooldownUntil = Math.max(e.cooldownUntil, state.elapsed + 4);
    affected++;
  }
  return affected;
}

/** Continuous acceleration and braking preserve velocity across every mode change. */
function steer(e: ForestFaunaEntity, target: WorldPoint, dt: number, velocity: WorldPoint = { x: 0, y: 0 }, wind?: WorldPoint) {
  const maxSpeed = e.species === "butterfly" ? 23 : 16;
  let desiredX = (target.x - e.x) * 2.1 + velocity.x, desiredY = (target.y - e.y) * 2.1 + velocity.y;
  if (wind && ["fly", "return", "depart"].includes(e.mode)) {
    desiredX += clamp(finite(wind.x), -4, 4); desiredY += clamp(finite(wind.y), -3, 3);
  }
  const length = Math.hypot(desiredX, desiredY);
  if (length > maxSpeed) { desiredX *= maxSpeed / length; desiredY *= maxSpeed / length; }
  let ax = (desiredX - e.vx) * 4.8, ay = (desiredY - e.vy) * 4.8;
  const acceleration = Math.hypot(ax, ay), limit = e.species === "butterfly" ? 45 : 32;
  if (acceleration > limit) { ax *= limit / acceleration; ay *= limit / acceleration; }
  e.vx += ax * dt; e.vy += ay * dt;
  e.x += e.vx * dt; e.y += e.vy * dt;
  if (Math.hypot(e.vx, e.vy) > .15) {
    const desiredAngle = Math.atan2(e.vy, e.vx) + Math.PI / 2;
    const turn = Math.atan2(Math.sin(desiredAngle - e.angle), Math.cos(desiredAngle - e.angle));
    e.angle += clamp(turn, -dt * 2.2, dt * 2.2);
  }
  e.target = point(target);
}
function advanceEncounter(state: ForestFaunaState, dt: number, options: ForestFaunaOptions) {
  const encounter = state.encounter;
  if (!encounter || options.freezeEncounter) return;
  const e = state.entities.find(item => item.id === encounter.entityId);
  encounter.elapsed += dt; encounter.phaseElapsed += dt;
  // A moved/hidden/busy actor cannot drag a perched animal or leave its token stranded.
  if (!e || !options.actor || distance(options.actor, encounter.actor) > 1
    || Math.abs(options.actor.size - encounter.actor.size) > .01
    || !permitted(encounter.kind, options) || encounter.elapsed > 12 && encounter.phase !== "perch") {
    interruptFaunaInteraction(state);
  }
  if (encounter.phase === "notice" && encounter.phaseElapsed >= .65) {
    encounter.phase = "raise"; encounter.phaseElapsed = 0;
  } else if (encounter.phase === "raise" && encounter.phaseElapsed >= .4) {
    encounter.phase = "approach"; encounter.phaseElapsed = 0;
  } else if (encounter.phase === "perch" && encounter.phaseElapsed >= 2.5) {
    encounter.phase = "release"; encounter.phaseElapsed = 0; if (e) depart(state, e);
  } else if ((encounter.phase === "release" || encounter.phase === "interrupt") && encounter.phaseElapsed >= .6 - 1e-9) {
    releaseHero(state);
  }
}
function advanceEntity(state: ForestFaunaState, e: ForestFaunaEntity, dt: number, options: ForestFaunaOptions) {
  const encounter = state.encounter?.entityId === e.id ? state.encounter : null;
  if (encounter && options.freezeEncounter) return;
  e.modeElapsed += dt;
  if (encounter && ["approach", "perch"].includes(e.mode)) {
    const pose = { pose: "greet", frame: 0, direction: encounter.direction } as const;
    const hand = heroHandAnchor(encounter.actor, pose);
    steer(e, hand, dt);
    if (encounter.phase === "approach" && distance(e, hand) < .65 && Math.hypot(e.vx, e.vy) < 1.6) {
      setMode(e, "perch"); encounter.phase = "perch"; encounter.phaseElapsed = 0;
    }
    return;
  }
  if (["approach", "perch"].includes(e.mode)) depart(state, e);
  if (e.mode === "depart") {
    steer(e, e.departure ?? orbitSample(e, state.elapsed), dt, undefined, options.wind);
    if (e.modeElapsed > 1.5) { setMode(e, "return"); e.departure = null; }
    return;
  }
  if (e.mode === "return") {
    const live = orbitSample(e, state.elapsed);
    steer(e, live, dt, { x: live.vx, y: live.vy }, options.wind);
    if (distance(e, live) < 2.5 && Math.hypot(e.vx - live.vx, e.vy - live.vy) < 3) {
      setMode(e, "fly");
      if (e.interactionToken !== null) e.cooldownUntil = Math.max(e.cooldownUntil, state.elapsed + 14);
      e.interactionToken = null;
    }
    return;
  }
  const refuge = shelterNeeded(e, options);
  if (refuge && e.mode !== "refuge") {
    const anchor = anchorFor(state, e, "shelter") ?? anchorFor(state, e, "rest");
    // No invented plant: legacy scenes without anchors simply keep their subdued orbit.
    if (anchor) { setMode(e, "refuge"); setAnchor(state, e, anchor); }
  } else if (!refuge && e.mode === "refuge") {
    e.anchorId = null; setMode(e, "return");
  }
  if (e.mode === "fly" && !refuge && state.elapsed >= e.nextRestAt) {
    const anchor = anchorFor(state, e, "rest");
    e.nextRestAt = state.elapsed + 25 + e.phase * 3;
    if (anchor) { setMode(e, "rest-seek"); setAnchor(state, e, anchor); e.restUntil = state.elapsed + 12 + e.phase; }
  }
  if (["rest-seek", "rest", "refuge"].includes(e.mode)) {
    const anchor = state.habitats.find(h => h.id === e.habitatId)?.anchors.find(a => a.id === e.anchorId);
    if (!anchor) { setMode(e, "return"); e.anchorId = null; return; }
    const target = { x: anchor.position.x + e.anchorOffset.x, y: anchor.position.y + e.anchorOffset.y };
    steer(e, target, dt);
    if (e.mode === "rest-seek" && distance(e, target) < .65 && Math.hypot(e.vx, e.vy) < 1.6) setMode(e, "rest");
    if (!refuge && e.mode === "rest" && state.elapsed >= e.restUntil) { setMode(e, "return"); e.anchorId = null; }
    return;
  }
  const live = orbitSample(e, state.elapsed);
  steer(e, live, dt, { x: live.vx, y: live.vy }, options.wind);
}

/** Exactly one session clock owner calls this; rendering and both cameras only read state. */
export function advanceForestFauna(state: ForestFaunaState, dt: number, options: ForestFaunaOptions) {
  if (!Number.isFinite(dt) || dt <= 0 || options.paused || options.reducedMotion) return;
  const elapsed = Math.min(dt, .25);
  state.visibility.butterflies = options.butterflies !== "off";
  state.visibility.fireflies = options.fireflies !== "off";
  state.dusk = clamp(finite(options.dusk)); state.firefliesForced = options.fireflies === "on";
  for (let remaining = elapsed; remaining > 1e-9;) {
    const step = Math.min(1 / 40, remaining); remaining -= step; state.elapsed += step;
    advanceEncounter(state, step, options);
    for (const e of state.entities) advanceEntity(state, e, step, options);
  }
}

/** Snapshot arrays include the reserved partner once, at its actual simulated coordinates. */
export function faunaRenderFrame(state: ForestFaunaState,
  options?: Pick<ForestFaunaConditions, "dusk" | "fireflies">): { elapsed: number; butterflies: FaunaRenderParticle[]; fireflies: FaunaRenderParticle[] } {
  const butterflies: FaunaRenderParticle[] = [], fireflies: FaunaRenderParticle[] = [];
  const glow = (options ? options.fireflies === "on" : state.firefliesForced) ? 1 : clamp(options?.dusk ?? state.dusk);
  for (const e of state.entities) {
    if (!(e.species === "butterfly" ? state.visibility.butterflies : state.visibility.fireflies)) continue;
    const resting = e.mode === "perch" || e.mode === "rest" || e.mode === "refuge" && Math.hypot(e.vx, e.vy) < 1;
    const particle: FaunaRenderParticle = { id: e.id, species: e.species, mode: e.mode, x: e.x, y: e.y,
      size: e.size, phase: e.phase, opacity: e.opacity, angle: e.angle, resting,
      ...(e.species === "firefly" ? { glow } : {}) };
    (e.species === "butterfly" ? butterflies : fireflies).push(particle);
  }
  return { elapsed: state.elapsed, butterflies, fireflies };
}
