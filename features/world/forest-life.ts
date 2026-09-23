import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";
import { isForestGroundClear } from "./forest-ground-weather";

export type ForestLifeKind = "butterfly" | "firefly" | "mushroom";
export type ForestLifeAction = ForestLifeKind | "grow-mushrooms" | "idle";
export type ForestMushroom = WorldPoint & { id: number; growth: number; regrowIn: number };
export type ForestLifeState = {
  elapsed: number; nextRoutineAt: number; sequence: number; fastGrowthUntil: number;
  routine: { kind: ForestLifeKind; elapsed: number; mushroomId?: number; picked?: boolean } | null;
  mushrooms: ForestMushroom[];
};
export type ForestLifeOptions = { autoLife?: boolean; dusk: number; rain: number;
  butterflies?: "auto" | "on" | "off"; fireflies?: "auto" | "on" | "off" };
export type ForestLifeActor = WorldPoint & { size: number };
export type ForestLifeFrame = {
  pose: PixelPose; frame: number; direction: PixelDirection; stage: string;
  heldMushroom: (WorldPoint & { size: number; bite: number }) | null;
  insect: (WorldPoint & { kind: "butterfly" | "firefly"; size: number; opacity: number; phase: number }) | null;
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const mix = (a: number, b: number, t: number) => a + (b - a) * clamp(t);
const smooth = (t: number) => { t = clamp(t); return t * t * (3 - 2 * t); };

/** Only a few reachable props around the authored feet; no new route or world progression. */
export function createForestLife(scene: FixedWorldScene): ForestLifeState {
  const actor = scene.actor, mushrooms: ForestMushroom[] = [];
  if (actor) for (const [dx, dy] of [[.12, .12], [-.32, .06], [.3, .08], [-.12, .14]]) {
    const point = { x: actor.spawn.x + dx * actor.size, y: actor.spawn.y + dy * actor.size };
    if (isForestGroundClear(scene, point, actor.size * .09)) {
      mushrooms.push({ ...point, id: mushrooms.length, growth: mushrooms.length ? .55 : 1, regrowIn: 0 });
      if (mushrooms.length === 2) break;
    }
  }
  return { elapsed: 0, nextRoutineAt: 4, sequence: 0, fastGrowthUntil: 0, routine: null, mushrooms };
}

export function cancelForestLife(state: ForestLifeState) {
  state.routine = null;
  state.nextRoutineAt = state.elapsed + 10;
}
export function triggerForestLife(state: ForestLifeState, kind: ForestLifeAction) {
  if (kind === "idle") { cancelForestLife(state); return; }
  if (kind === "grow-mushrooms") {
    cancelForestLife(state);
    for (const mushroom of state.mushrooms) { mushroom.growth = .04; mushroom.regrowIn = 0; }
    state.fastGrowthUntil = state.elapsed + 3.5;
    state.nextRoutineAt = state.elapsed + 8;
    return;
  }
  const mushroom = kind === "mushroom" ? state.mushrooms.find(item => item.growth >= .98) ?? state.mushrooms[0] : undefined;
  if (mushroom) { mushroom.growth = 1; mushroom.regrowIn = 0; }
  if (kind === "mushroom" && !mushroom) { cancelForestLife(state); return; }
  state.routine = { kind, elapsed: 0, ...(mushroom ? { mushroomId: mushroom.id } : {}) };
}

/** The scene calls this only from its single visible clock owner. No wall-clock catch-up. */
export function advanceForestLife(state: ForestLifeState, dt: number, options: ForestLifeOptions) {
  if (!Number.isFinite(dt) || dt <= 0) return;
  state.elapsed += dt;
  for (const mushroom of state.mushrooms) {
    const growing = Math.max(0, dt - mushroom.regrowIn);
    mushroom.regrowIn = Math.max(0, mushroom.regrowIn - dt);
    const fast = Math.min(growing, Math.max(0, state.fastGrowthUntil - (state.elapsed - dt)));
    if (growing) mushroom.growth = Math.min(1, mushroom.growth + fast / 3.5 + (growing - fast) / 18);
  }
  const routine = state.routine;
  if (routine) {
    routine.elapsed += dt;
    if (routine.kind === "mushroom" && routine.elapsed >= 2.2 && !routine.picked) {
      const mushroom = state.mushrooms.find(item => item.id === routine.mushroomId);
      if (mushroom) { mushroom.growth = 0; mushroom.regrowIn = 22; }
      routine.picked = true;
    }
    if (routine.elapsed >= (routine.kind === "mushroom" ? 8 : 7.6)) {
      state.routine = null;
      state.nextRoutineAt = state.elapsed + 9 + state.sequence % 5;
      state.sequence++;
    }
  }
  if (!state.routine && options.autoLife !== false && state.elapsed >= state.nextRoutineAt) {
    const nighttime = options.dusk > .45;
    const insect = nighttime ? "firefly" : "butterfly";
    const mode = nighttime ? options.fireflies : options.butterflies;
    const canPlay = mode !== "off" && (mode === "on" || options.rain < .5);
    const canEat = state.mushrooms.some(item => item.growth >= .98);
    if (canEat && (state.sequence % 2 === 1 || !canPlay)) triggerForestLife(state, "mushroom");
    else if (canPlay) triggerForestLife(state, insect);
    else state.nextRoutineAt = state.elapsed + 10;
  }
}

/** Anchors follow the 48px rig and its sole at row 45, including each lifting/chewing frame. */
export function forestLifeFrame(state: ForestLifeState, actor: ForestLifeActor, elapsed: number): ForestLifeFrame {
  const result: ForestLifeFrame = { pose: "idle", frame: Math.floor(elapsed * 3) % 4, direction: "front",
    stage: "idle", heldMushroom: null, insect: null };
  const routine = state.routine;
  if (!routine) return result;
  const t = routine.elapsed, unit = actor.size / 48;
  const at = (sourceX: number, sourceY: number) => ({ x: actor.x + (sourceX - 24) * unit, y: actor.y + (sourceY - 45) * unit });
  if (routine.kind === "mushroom") {
    if (t < 1) { result.stage = "notice"; result.pose = "sniff"; result.frame = Math.min(3, Math.floor(t * 4)); }
    else if (t < 2.2) { result.stage = "reach"; result.pose = "reach"; result.frame = Math.min(3, Math.floor((t - 1) / 1.2 * 4)); }
    else if (t < 3.4) { result.stage = "lift"; result.pose = "hold"; result.frame = Math.min(3, Math.floor((t - 2.2) / 1.2 * 4)); }
    else if (t < 4.1) { result.stage = "hold"; result.pose = "hold"; result.frame = 3; }
    else if (t < 6.5) { result.stage = "chew"; result.pose = "chew"; result.frame = Math.floor((t - 4.1) * 5) % 4; }
    else if (t < 7.4) { result.stage = "swallow"; result.pose = "swallow"; result.frame = Math.min(3, Math.floor((t - 6.5) / .9 * 4)); }
    else { result.stage = "settle"; result.pose = "groom"; }
    if (t >= 2.2 && t < 6.5) {
      const handY = result.pose === "chew" ? 29 + result.frame % 2 : [37, 34, 31, 29][result.frame];
      const hand = at(24, handY), mushroom = state.mushrooms.find(item => item.id === routine.mushroomId);
      // A short pickup bridges the ground cap to the first hold frame without teleporting.
      const pickup = smooth((t - 2.2) / .22);
      result.heldMushroom = { x: mix(mushroom?.x ?? hand.x, hand.x, pickup),
        y: mix(mushroom?.y ?? hand.y, hand.y, pickup), size: actor.size * .19, bite: clamp((t - 4.1) / 2.4) };
    }
  } else {
    if (t < 1.6) { result.stage = "approach"; result.pose = "wonder"; }
    else if (t < 2.4) { result.stage = "notice"; result.pose = "wonder"; }
    else if (t < 3.3) { result.stage = "reach"; result.pose = "greet"; result.frame = 0; }
    else if (t < 5.3) { result.stage = "perch"; result.pose = "greet"; result.frame = 0; }
    else if (t < 6.9) { result.stage = "release"; result.pose = "greet"; }
    else result.stage = "settle";
    const perch = at(36, 24), approach = smooth(t / 3.3), release = smooth((t - 5.3) / 1.6);
    const orbit = (1 - approach) + release;
    result.insect = { kind: routine.kind,
      x: perch.x + actor.size * (-(1 - approach) * .95 + release * 1.05) + Math.sin(t * 4) * actor.size * .05 * orbit,
      y: perch.y - actor.size * ((1 - approach) * .35 + release * .45) + Math.sin(t * 3) * actor.size * .07 * orbit,
      size: actor.size / 32, opacity: clamp((7.6 - t) / .7), phase: .8 };
  }
  return result;
}
