import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldBounds, WorldHabitat, WorldPoint } from "./tiled/types";
import type { ForestFirefly } from "./forest-wildlife";
import { habitatContains, habitatFallbackPoint, habitatFlightTarget, habitatCanTraverse } from "./forest-habitats";
import { heroHandAnchor, type FaunaActor, type HeroAnchorPose } from "./hero-anchors";

export type { FaunaActor } from "./hero-anchors";
export type FaunaSpecies = "butterfly" | "firefly";
export type FaunaMode = "fly" | "rest-seek" | "rest" | "approach" | "perch" | "depart" | "return" | "refuge";
type Orbit = { x: number; y: number; rx: number; ry: number; sx: number; sy: number; px: number; py: number };
export type ForestFaunaEntity = WorldPoint & {
  id: string; species: FaunaSpecies; habitatId: string; size: number; phase: number;
  vx: number; vy: number; angle: number; mode: FaunaMode; modeElapsed: number;
  target: WorldPoint | null; anchorId: string | null; anchorOffset: WorldPoint; cooldownUntil: number;
  /** Kept after hero release, until this individual reaches its orbit or shelter. */
  interactionToken: number | null;
  stimulusCooldownUntil: number; nextRestAt: number; restUntil: number;
  shelterReadyAt: number | null;
  landingRetryAt: number; landingExpiresAt: number;
  /** Short-lived individual memory; it advances only with the shared world clock. */
  alertness: number; familiarity: number; lastMovementAt: number; lastRestAnchorId: string | null;
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
function entity(habitat: WorldHabitat, seed: number, index: number, scale: number, legacy: boolean): ForestFaunaEntity | null {
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
  if (habitat.exclusions?.length) {
    if (!habitatContains(habitat, orbit, 3)) {
      let centre: WorldPoint | null = null;
      for (let attempt = 0; attempt < 128; attempt++) {
        const candidate = { x: field.x + field.width * noise(seed, 2400 + index * 128 + attempt),
          y: field.y + field.height * noise(seed, 8400 + index * 128 + attempt) };
        if (habitatContains(habitat, candidate, 3)) { centre = candidate; break; }
      }
      centre ??= habitatFallbackPoint(habitat);
      if (!centre) return null;
      orbit.x = centre.x; orbit.y = centre.y;
    }
    for (let attempt = 0; attempt < 32 && !habitatContains(habitat, orbit, Math.hypot(orbit.rx, orbit.ry) + 2.1); attempt++) {
      orbit.rx *= .65; orbit.ry *= .65;
    }
    if (!habitatContains(habitat, orbit, Math.hypot(orbit.rx, orbit.ry) + 2.1)) return null;
  }
  const e: ForestFaunaEntity = { id: `${habitat.id}:${habitat.species}:${index + 1}`, species: habitat.species,
    habitatId: habitat.id, size: scale * (butterfly ? (.8 + noise(seed, n * 5 + 3) * .3) * 1.35
      : 1.35 + noise(seed, n * 7 + 6) * .25), phase,
    x: 0, y: 0, vx: 0, vy: 0, angle: 0, orbit, mode: "fly", modeElapsed: 0,
    target: null, anchorId: null, anchorOffset: { x: 0, y: 0 }, cooldownUntil: 0, interactionToken: null, stimulusCooldownUntil: 0,
    nextRestAt: 13 + noise(seed, n + 90) * 25, restUntil: 0, shelterReadyAt: null,
    landingRetryAt: 0, landingExpiresAt: 0,
    alertness: 0, familiarity: 0, lastMovementAt: -10, lastRestAnchorId: null,
    departure: null, opacity: butterfly ? .85 : .9 };
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
      const index = counts[habitat.species];
      const individual = entity(habitat, legacy ? seed : seed ^ hash(habitat.id), index, scale, legacy);
      if (individual) { entities.push(individual); counts[habitat.species]++; }
    }
  }
  return { elapsed: 0, entities, habitats, encounter: null, nextEncounterAt: 0, sequence: 0,
    width: scene.width, height: scene.height, visibility: { butterflies: true, fireflies: true },
    dusk: 0, firefliesForced: false, lastReason: null };
}

/** Day and night populations never overlap, including forced DEV visibility. */
export function isFaunaActiveAtTime(species: FaunaSpecies, dusk: number): boolean {
  const night = clamp(finite(dusk)) >= .55;
  return species === "firefly" ? night : !night;
}
function permitted(species: FaunaSpecies, options: ForestFaunaConditions) {
  const enabled = species === "butterfly" ? options.butterflies : options.fireflies;
  return !options.blocked && enabled !== "off" && options.rain < .35
    && isFaunaActiveAtTime(species, options.dusk);
}
function candidate(state: ForestFaunaState, kind: FaunaSpecies, actor: FaunaActor, options: ForestFaunaConditions, forced: boolean) {
  if (state.encounter || state.elapsed < state.nextEncounterAt || !permitted(kind, options)
    || ![actor.x, actor.y, actor.size].every(Number.isFinite) || actor.size <= 0) return null;
  const reach = forced ? Math.min(140, actor.size * 2.4) : Math.min(95, actor.size * 1.55);
  let best: ForestFaunaEntity | null = null, nearest = reach;
  for (const e of state.entities) {
    if (e.species !== kind || e.interactionToken !== null || e.cooldownUntil > state.elapsed || e.alertness > .4
      || !["fly", "rest", "rest-seek"].includes(e.mode)) continue;
    const habitat = state.habitats.find(h => h.id === e.habitatId);
    // Forest residents cannot be invited through the excluded home clearing.
    if (habitat?.exclusions?.length && !habitatContains(habitat, heroHandAnchor(actor, { pose: "greet", frame: 0, direction: "front" }), 2.1)) continue;
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
    const same = state.encounter.kind === kind && !["interrupt", "release"].includes(state.encounter.phase)
      && permitted(kind, options);
    state.lastReason = same ? null : !permitted(kind, options)
      ? "Для встречи не подходят время суток, погода или настройки." : "Мохлик уже занят другой встречей.";
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
  if (!["rest-seek", "rest", "refuge"].includes(mode)) e.landingExpiresAt = 0;
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

type Landing = { anchor: WorldHabitat["anchors"][number]; offset: WorldPoint; position: WorldPoint };
const landingModes: readonly FaunaMode[] = ["rest-seek", "rest", "refuge"];
const landingRadius = (e: ForestFaunaEntity) => e.size * (e.species === "butterfly" ? 2.5 : 1.5);
function landingPosition(state: ForestFaunaState, e: ForestFaunaEntity): WorldPoint | null {
  if (!e.anchorId || !landingModes.includes(e.mode)) return null;
  const anchor = state.habitats.find(h => h.id === e.habitatId)?.anchors.find(a => a.id === e.anchorId);
  return anchor ? { x: anchor.position.x + e.anchorOffset.x, y: anchor.position.y + e.anchorOffset.y } : null;
}
function landingAvailable(state: ForestFaunaState, e: ForestFaunaEntity, position: WorldPoint) {
  return state.entities.every(other => {
    if (other === e) return true;
    // Different habitats/species may name the very same leaf differently. Reserve
    // world space from departure to arrival, and let a departing body clear it too.
    const separation = landingRadius(e) + landingRadius(other) + 1.5;
    const reserved = landingPosition(state, other);
    return (!reserved || distance(reserved, position) >= separation)
      && distance(other, position) >= separation;
  });
}
function anchorFor(state: ForestFaunaState, e: ForestFaunaEntity, kind: "rest" | "shelter"): Landing | undefined {
  const habitat = state.habitats.find(item => item.id === e.habitatId);
  if (!habitat) return undefined;
  const suitable: Landing[] = [];
  for (const anchor of habitat.anchors) {
    if (anchor.kind !== kind) continue;
    // A shelter is a small authored foliage patch, with a finite number of seats.
    // Overflow keeps flying; random jitter must never squeeze bodies into a pile.
    const phase = noise(hash(anchor.id), 3) * TAU;
    for (let slot = 0; slot < (kind === "shelter" ? 7 : 1); slot++) {
      const angle = phase + (slot - 1) * TAU / 6;
      const offset = slot ? { x: Math.cos(angle) * 10, y: Math.sin(angle) * 10 } : { x: 0, y: 0 };
      const position = { x: anchor.position.x + offset.x, y: anchor.position.y + offset.y };
      if (habitatContains(habitat, position, habitat.exclusions?.length ? 2.1 : 0)
        && landingAvailable(state, e, position)) suitable.push({ anchor, offset, position });
    }
  }
  // Prefer a different nearby leaf after a landing, without making a long detour.
  const cost = (landing: Landing) => distance(e, landing.position) + Math.hypot(landing.offset.x, landing.offset.y) * 1.05
    + (kind === "rest" && landing.anchor.id === e.lastRestAnchorId ? 24 : 0);
  return suitable.sort((a, b) => cost(a) - cost(b) || a.anchor.id.localeCompare(b.anchor.id))[0];
}
function setAnchor(state: ForestFaunaState, e: ForestFaunaEntity, landing: Landing) {
  e.anchorId = landing.anchor.id; e.anchorOffset = landing.offset;
  const speed = e.species === "butterfly" ? 23 : 16;
  // A disconnected destination must not hold a reservation forever.
  e.landingExpiresAt = state.elapsed + 12 + distance(e, landing.position) / speed * 3;
}
function shelterNeeded(e: ForestFaunaEntity, options: ForestFaunaConditions) {
  // Once sheltered, wait for a genuine clearing rather than turning around at
  // every small fluctuation near the threshold that interrupted the flight.
  return options.rain >= (e.mode === "refuge" ? .23 : .35) || !isFaunaActiveAtTime(e.species, options.dusk);
}
function releaseAnimalReservation(state: ForestFaunaState, e: ForestFaunaEntity) {
  if (e.interactionToken === null) return;
  e.cooldownUntil = Math.max(e.cooldownUntil, state.elapsed + 14);
  e.interactionToken = null;
}

/** A bounded impulse is integrated, never a position change. Reserved partners ignore disturbances. */
export function emitFaunaStimulus(state: ForestFaunaState, stimulus: FaunaStimulus): number {
  if (![stimulus.x, stimulus.y, stimulus.radius ?? 1, stimulus.strength ?? 1].every(Number.isFinite)
    || stimulus.x < 0 || stimulus.y < 0 || stimulus.x > state.width || stimulus.y > state.height) return 0;
  const radius = clamp(stimulus.radius ?? (stimulus.kind === "rustle" ? 62 : 30), 1, 90);
  const strength = clamp(stimulus.strength ?? 1, 0, 1);
  if (strength === 0) return 0;
  let affected = 0;
  // Proximity, rather than array/population order, decides which neighbours notice first.
  const nearby = state.entities.map(e => ({ e, d: distance(e, stimulus) }))
    .filter(({ d }) => d < radius).sort((a, b) => a.d - b.d || a.e.id.localeCompare(b.e.id));
  for (const { e, d } of nearby) {
    if (!isFaunaActiveAtTime(e.species, state.dusk)) continue;
    if (e.interactionToken !== null || ["approach", "perch", "refuge"].includes(e.mode)) continue;
    const amount = (1 - d / radius) * strength;
    const familiarity = e.familiarity;
    // Repeated ordinary footsteps become familiar, sampled at most once per 1.5 s.
    // A sudden bush rustle still matters even to a relaxed, familiar individual.
    if (stimulus.kind === "movement" && state.elapsed - e.lastMovementAt >= 1.5) {
      e.familiarity = clamp(e.familiarity + .18 * (.5 + strength * .5) * (1 - d / radius));
      e.lastMovementAt = state.elapsed;
    }
    if (affected >= 4 || e.stimulusCooldownUntil > state.elapsed || ["depart", "return"].includes(e.mode)) continue;
    const response = amount * (stimulus.kind === "movement" ? 1 - familiarity * .7 : 1);
    const threshold = .1 + noise(hash(e.id), 7) * .08;
    if (response < threshold) continue;
    const dx = e.x - stimulus.x || Math.cos(e.phase), dy = e.y - stimulus.y || -1;
    const length = Math.hypot(dx, dy);
    e.departure = { x: clamp(e.x + dx / length * (10 + response * 22), 1, state.width - 1),
      y: clamp(e.y + dy / length * (8 + response * 15) - 6, 1, state.height - 1) };
    setMode(e, "depart"); e.anchorId = null;
    e.alertness = clamp(e.alertness + response * .75);
    e.stimulusCooldownUntil = state.elapsed + 7; e.cooldownUntil = Math.max(e.cooldownUntil, state.elapsed + 4);
    affected++;
  }
  return affected;
}

/** Continuous acceleration and braking preserve velocity across every mode change. */
function steer(state: ForestFaunaState, e: ForestFaunaEntity, target: WorldPoint, dt: number, velocity: WorldPoint = { x: 0, y: 0 }, wind?: WorldPoint) {
  const habitat = state.habitats.find(h => h.id === e.habitatId);
  const constrained = habitat?.exclusions?.length ? habitat : null;
  const before = point(e);
  if (constrained) {
    const goal = habitatContains(constrained, target, 2.1) ? target : e.orbit;
    const waypoint = habitatFlightTarget(constrained, e, goal, state.elapsed);
    if (!waypoint) { e.vx = 0; e.vy = 0; e.target = point(goal); return; }
    if (waypoint !== target) { velocity = { x: 0, y: 0 }; wind = undefined; }
    target = waypoint;
  }
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
  if (constrained && !habitatCanTraverse(constrained, before, e)) {
    e.x = before.x; e.y = before.y; e.vx = 0; e.vy = 0;
  }
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
  e.alertness *= Math.exp(-dt / 10);
  e.familiarity *= Math.exp(-dt / 100);
  e.modeElapsed += dt;
  if (encounter && ["approach", "perch"].includes(e.mode)) {
    const pose = { pose: "greet", frame: 0, direction: encounter.direction } as const;
    const hand = heroHandAnchor(encounter.actor, pose);
    steer(state, e, hand, dt);
    if (encounter.phase === "approach" && distance(e, hand) < .65 && Math.hypot(e.vx, e.vy) < 1.6) {
      setMode(e, "perch"); encounter.phase = "perch"; encounter.phaseElapsed = 0;
    }
    return;
  }
  if (["approach", "perch"].includes(e.mode)) depart(state, e);
  const refuge = shelterNeeded(e, options);
  // Finishing the small departure first clears the hero's hand. Afterwards a
  // nearby authored shelter takes priority over a detour to the old orbit.
  if (refuge && e.mode !== "refuge" && e.mode !== "depart" && state.elapsed >= e.landingRetryAt) {
    const anchor = anchorFor(state, e, "shelter") ?? anchorFor(state, e, "rest");
    // Legacy scenes without anchors keep their subdued orbit; never invent foliage.
    if (anchor) { setMode(e, "refuge"); setAnchor(state, e, anchor); e.shelterReadyAt = null; }
    else e.landingRetryAt = state.elapsed + 1.2 + noise(hash(e.id), 29) * 1.6;
  }
  if (e.mode === "depart") {
    steer(state, e, e.departure ?? orbitSample(e, state.elapsed), dt, undefined, options.wind);
    if (e.modeElapsed > 1.5) { setMode(e, "return"); e.departure = null; }
    return;
  }
  if (e.mode === "return") {
    const live = orbitSample(e, state.elapsed);
    steer(state, e, live, dt, { x: live.vx, y: live.vy }, options.wind);
    if (distance(e, live) < 2.5 && Math.hypot(e.vx - live.vx, e.vy - live.vy) < 3) {
      setMode(e, "fly");
      releaseAnimalReservation(state, e);
    }
    return;
  }
  if (e.mode === "fly" && !refuge && state.elapsed >= e.nextRestAt) {
    const anchor = anchorFor(state, e, "rest");
    e.nextRestAt = state.elapsed + 25 + e.phase * 3;
    if (anchor) { setMode(e, "rest-seek"); setAnchor(state, e, anchor); e.restUntil = 0; }
  }
  if (["rest-seek", "rest", "refuge"].includes(e.mode)) {
    const anchor = state.habitats.find(h => h.id === e.habitatId)?.anchors.find(a => a.id === e.anchorId);
    if (!anchor) { setMode(e, "return"); e.anchorId = null; e.shelterReadyAt = null; return; }
    const target = { x: anchor.position.x + e.anchorOffset.x, y: anchor.position.y + e.anchorOffset.y };
    steer(state, e, target, dt);
    const settled = distance(e, target) < .65 && Math.hypot(e.vx, e.vy) < 1.6;
    if (settled) e.landingExpiresAt = 0;
    else if (e.landingExpiresAt > 0 && state.elapsed >= e.landingExpiresAt) {
      setMode(e, "return"); e.anchorId = null; e.shelterReadyAt = null;
      e.landingRetryAt = state.elapsed + 3;
      e.nextRestAt = Math.max(e.nextRestAt, e.landingRetryAt);
      return;
    }
    if (e.mode === "refuge") {
      if (settled) releaseAnimalReservation(state, e);
      if (refuge || !settled) e.shelterReadyAt = null;
      else {
        // Small individual pauses spread departures across several seconds.
        // The same resident keeps its rhythm after rain or a night in the foliage.
        e.shelterReadyAt ??= state.elapsed + .8 + noise(hash(e.id), 19) * 4.4;
        if (state.elapsed >= e.shelterReadyAt) {
          setMode(e, "return"); e.anchorId = null; e.shelterReadyAt = null;
          e.nextRestAt = state.elapsed + 25 + e.phase * 3;
        }
      }
    }
    if (e.mode === "rest-seek" && settled) {
      setMode(e, "rest"); e.restUntil = state.elapsed + 12 + e.phase;
      e.lastRestAnchorId = anchor.id;
    }
    if (!refuge && e.mode === "rest" && state.elapsed >= e.restUntil) {
      setMode(e, "return"); e.anchorId = null; e.nextRestAt = state.elapsed + 25 + e.phase * 3;
    }
    return;
  }
  const live = orbitSample(e, state.elapsed);
  steer(state, e, live, dt, { x: live.vx, y: live.vy }, options.wind);
}

/** Exactly one session clock owner calls this; rendering and both cameras only read state. */
export function advanceForestFauna(state: ForestFaunaState, dt: number, options: ForestFaunaOptions) {
  if (!Number.isFinite(dt) || dt <= 0 || options.paused || options.reducedMotion) return;
  const elapsed = Math.min(dt, .25);
  state.visibility.butterflies = options.butterflies !== "off";
  state.visibility.fireflies = options.fireflies !== "off";
  state.dusk = clamp(finite(options.dusk)); state.firefliesForced = options.fireflies === "on";
  // Stable tie-breaking also makes reservation outcomes independent of draw order.
  const individuals = [...state.entities].sort((a, b) => a.id.localeCompare(b.id));
  for (let remaining = elapsed; remaining > 1e-9;) {
    const step = Math.min(1 / 40, remaining); remaining -= step; state.elapsed += step;
    advanceEncounter(state, step, options);
    for (const e of individuals) advanceEntity(state, e, step, options);
  }
}

/** Snapshot arrays include the reserved partner once, at its actual simulated coordinates. */
export function faunaRenderFrame(state: ForestFaunaState,
  options?: Pick<ForestFaunaConditions, "dusk" | "butterflies" | "fireflies">): { elapsed: number; butterflies: FaunaRenderParticle[]; fireflies: FaunaRenderParticle[] } {
  const butterflies: FaunaRenderParticle[] = [], fireflies: FaunaRenderParticle[] = [];
  const dusk = clamp(finite(options?.dusk ?? state.dusk));
  const glow = (options ? options.fireflies === "on" : state.firefliesForced) ? 1 : dusk;
  for (const e of state.entities) {
    if (!isFaunaActiveAtTime(e.species, dusk)) continue;
    const mode = e.species === "butterfly" ? options?.butterflies : options?.fireflies;
    const enabled = mode === undefined ? (e.species === "butterfly" ? state.visibility.butterflies : state.visibility.fireflies)
      : mode !== "off";
    if (!enabled) continue;
    const resting = e.mode === "perch" || e.mode === "rest" || e.mode === "refuge" && Math.hypot(e.vx, e.vy) < 1;
    const particle: FaunaRenderParticle = { id: e.id, species: e.species, mode: e.mode, x: e.x, y: e.y,
      size: e.size, phase: e.phase, opacity: e.opacity, angle: e.angle, resting,
      ...(e.species === "firefly" ? { glow } : {}) };
    (e.species === "butterfly" ? butterflies : fireflies).push(particle);
  }
  return { elapsed: state.elapsed, butterflies, fireflies };
}
