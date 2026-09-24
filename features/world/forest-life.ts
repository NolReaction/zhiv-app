import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";
import { isForestGroundClear } from "./forest-ground-weather";

export type ForestLifeKind = "butterfly" | "firefly" | "mushroom" | "leaf";
export type ForestLifeAction = ForestLifeKind | "grow-mushrooms" | "idle";
export type ForestMushroom = WorldPoint & { id: number; growth: number; regrowIn: number };
export type ForestLifeState = {
  elapsed: number; nextRoutineAt: number; sequence: number; fastGrowthUntil: number;
  routine: { kind: ForestLifeKind; elapsed: number; mushroomId?: number; picked?: boolean;
    interrupting?: { from: number; elapsed: number } } | null;
  mushrooms: ForestMushroom[];
  leaf: (WorldPoint & { angle: number }) | null;
};
export type ForestLifeOptions = { autoLife?: boolean; blocked?: boolean; dusk: number; rain: number;
  butterflies?: "auto" | "on" | "off"; fireflies?: "auto" | "on" | "off" };
export type ForestLifeActor = WorldPoint & { size: number };
export type ForestLifeFrame = {
  pose: PixelPose; frame: number; direction: PixelDirection; stage: string;
  heldMushroom: (WorldPoint & { size: number; bite: number }) | null;
  heldLeaf: (WorldPoint & { size: number; angle: number }) | null;
  insect: (WorldPoint & { kind: "butterfly" | "firefly"; size: number; opacity: number; phase: number }) | null;
};
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const mix = (a: number, b: number, t: number) => a + (b - a) * clamp(t);
const smooth = (t: number) => { t = clamp(t); return t * t * (3 - 2 * t); };
const INTERRUPT_SECONDS = .6;

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
  let leaf: ForestLifeState["leaf"] = null;
  if (actor) for (const [dx, dy] of [[.34, .08], [-.3, .16], [.06, .28], [.34, .2]]) {
    const point = { x: actor.spawn.x + dx * actor.size, y: actor.spawn.y + dy * actor.size };
    if (isForestGroundClear(scene, point, actor.size * .065)
      && mushrooms.every(mushroom => Math.hypot(mushroom.x - point.x, mushroom.y - point.y) > actor.size * .18)) {
      leaf = { ...point, angle: -.35 }; break;
    }
  }
  return { elapsed: 0, nextRoutineAt: 4, sequence: 0, fastGrowthUntil: 0, routine: null, mushrooms, leaf };
}

export function cancelForestLife(state: ForestLifeState) {
  restoreUntouchedMushroom(state);
  state.routine = null;
  state.nextRoutineAt = state.elapsed + 10;
}

function restoreUntouchedMushroom(state: ForestLifeState) {
  const routine = state.routine;
  if (routine?.kind !== "mushroom" || !routine.picked || routine.elapsed >= 4.1) return;
  const mushroom = state.mushrooms.find(item => item.id === routine.mushroomId);
  if (mushroom) { mushroom.growth = 1; mushroom.regrowIn = 0; }
}

/** User attention waits at most 600 ms for a held prop or insect to settle. Repeated taps do not restart it. */
export function interruptForestLife(state: ForestLifeState): boolean {
  const routine = state.routine;
  if (!routine) { state.nextRoutineAt = state.elapsed + 10; return false; }
  if (routine.interrupting) return true;
  if ((routine.kind === "mushroom" || routine.kind === "leaf") && !routine.picked
    || routine.kind === "mushroom" && routine.elapsed >= 6.5) {
    cancelForestLife(state); state.sequence++; return false;
  }
  routine.interrupting = { from: routine.elapsed, elapsed: 0 };
  return true;
}

function finishRoutine(state: ForestLifeState) {
  state.routine = null;
  state.nextRoutineAt = state.elapsed + 9 + state.sequence % 5;
  state.sequence++;
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
  if (state.routine) cancelForestLife(state);
  const mushroom = kind === "mushroom" ? state.mushrooms.find(item => item.growth >= .98) ?? state.mushrooms[0] : undefined;
  if (mushroom) { mushroom.growth = 1; mushroom.regrowIn = 0; }
  if (kind === "mushroom" && !mushroom) { cancelForestLife(state); return; }
  if (kind === "leaf" && !state.leaf) { cancelForestLife(state); return; }
  state.routine = { kind, elapsed: 0, ...(mushroom ? { mushroomId: mushroom.id } : {}) };
}

/** The scene calls this only from its single visible clock owner. No wall-clock catch-up. */
export function advanceForestLife(state: ForestLifeState, dt: number, options: ForestLifeOptions) {
  if (!Number.isFinite(dt) || dt <= 0) return;
  state.elapsed += dt;
  for (const mushroom of state.mushrooms) {
    if (options.blocked && state.routine?.kind === "mushroom" && state.routine.picked
      && state.routine.elapsed < 6.5 && state.routine.mushroomId === mushroom.id) continue;
    const growing = Math.max(0, dt - mushroom.regrowIn);
    mushroom.regrowIn = Math.max(0, mushroom.regrowIn - dt);
    const fast = Math.min(growing, Math.max(0, state.fastGrowthUntil - (state.elapsed - dt)));
    if (growing) mushroom.growth = Math.min(1, mushroom.growth + fast / 3.5 + (growing - fast) / 18);
  }
  // A manual pose pauses the actor's story, not the forest's active-time growth.
  if (options.blocked) return;
  const routine = state.routine;
  if (routine) {
    if (routine.interrupting) {
      routine.interrupting.elapsed += dt;
      if (routine.interrupting.elapsed >= INTERRUPT_SECONDS) {
        // An untouched mushroom is put back; a bitten meal is swallowed instead of duplicating food.
        restoreUntouchedMushroom(state);
        finishRoutine(state);
      }
      return;
    }
    routine.elapsed += dt;
    if (routine.kind === "mushroom" && routine.elapsed >= 2.2 && !routine.picked) {
      const mushroom = state.mushrooms.find(item => item.id === routine.mushroomId);
      if (mushroom) { mushroom.growth = 0; mushroom.regrowIn = 22; }
      routine.picked = true;
    }
    if (routine.kind === "leaf") routine.picked = routine.elapsed >= 1.9 && routine.elapsed < 5.8;
    if (routine.elapsed >= (routine.kind === "mushroom" ? 8 : routine.kind === "leaf" ? 7.2 : 7.6)) finishRoutine(state);
  }
  if (!state.routine && options.autoLife !== false && state.elapsed >= state.nextRoutineAt) {
    const nighttime = options.dusk > .45;
    const insect = nighttime ? "firefly" : "butterfly";
    const mode = nighttime ? options.fireflies : options.butterflies;
    const canPlay = mode !== "off" && (mode === "on" || options.rain < .5);
    const canEat = state.mushrooms.some(item => item.growth >= .98);
    if (state.leaf && (state.sequence % 3 === 2 || !canPlay && !canEat)) triggerForestLife(state, "leaf");
    else if (canEat && (state.sequence % 3 === 1 || !canPlay)) triggerForestLife(state, "mushroom");
    else if (canPlay) triggerForestLife(state, insect);
    else if (state.leaf) triggerForestLife(state, "leaf");
    else state.nextRoutineAt = state.elapsed + 10;
  }
}

/** Anchors follow the 48px rig and its sole at row 45, including each lifting/chewing frame. */
function routineFrame(state: ForestLifeState, actor: ForestLifeActor, elapsed: number, t: number): ForestLifeFrame {
  const result: ForestLifeFrame = { pose: "idle", frame: Math.floor((state.routine ? t : elapsed) * 3) % 4, direction: "front",
    stage: "idle", heldMushroom: null, heldLeaf: null, insect: null };
  const routine = state.routine;
  if (!routine) return result;
  const unit = actor.size / 48;
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
        y: mix(mushroom ? mushroom.y - actor.size * .19 * .38 : hand.y, hand.y, pickup),
        size: actor.size * .19, bite: clamp((t - 4.1) / 2.4) };
    }
  } else if (routine.kind === "leaf") {
    if (t < .9) { result.stage = "notice"; result.pose = "sniff"; }
    else if (t < 1.9) { result.stage = "reach"; result.pose = "reach"; result.frame = Math.min(3, Math.floor((t - .9) * 4)); }
    else if (t < 2.8) { result.stage = "lift"; result.pose = "hold"; result.frame = Math.min(3, Math.floor((t - 1.9) / .9 * 4)); }
    else if (t < 4.9) { result.stage = "examine"; result.pose = "hold"; result.frame = 3; }
    else if (t < 5.8) { result.stage = "put-down"; result.pose = "hold"; result.frame = Math.max(0, 3 - Math.floor((t - 4.9) / .9 * 4)); }
    else if (t < 6.4) { result.stage = "release"; result.pose = "reach"; result.frame = 0; }
    else { result.stage = "settle"; result.pose = "wonder"; }
    if (state.leaf && t >= 1.9 && t < 5.8) {
      const hand = at(24, [37, 34, 31, 29][result.frame]);
      const pickup = smooth((t - 1.9) / .2), putDown = smooth((t - 4.9) / .9);
      result.heldLeaf = { x: mix(mix(state.leaf.x, hand.x, pickup), state.leaf.x, putDown),
        y: mix(mix(state.leaf.y, hand.y, pickup), state.leaf.y, putDown), size: actor.size * .18,
        angle: mix(state.leaf.angle, Math.sin((t - 2.8) * 2.5) * .6, pickup * (1 - putDown)) };
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

export function forestLifeFrame(state: ForestLifeState, actor: ForestLifeActor, elapsed: number): ForestLifeFrame {
  const routine = state.routine, recovery = routine?.interrupting;
  const result = routineFrame(state, actor, elapsed, recovery?.from ?? routine?.elapsed ?? 0);
  if (!recovery) return result;
  const progress = smooth(recovery.elapsed / INTERRUPT_SECONDS);
  result.stage = "interrupt";
  if (result.heldMushroom) {
    const food = result.heldMushroom;
    if (recovery.from >= 4.1) {
      result.pose = progress < .65 ? "chew" : "swallow";
      result.frame = Math.min(3, Math.floor(progress * 4));
      food.bite = mix(food.bite, 1, progress / .65);
      if (progress >= .65) result.heldMushroom = null;
    } else {
      const ground = state.mushrooms.find(mushroom => mushroom.id === routine?.mushroomId);
      result.pose = "hold"; result.frame = Math.round(mix(result.frame, 0, progress));
      if (ground) { food.x = mix(food.x, ground.x, progress); food.y = mix(food.y, ground.y - food.size * .38, progress); }
    }
  } else if (result.heldLeaf && state.leaf) {
    result.pose = "hold"; result.frame = Math.round(mix(result.frame, 0, progress));
    result.heldLeaf.x = mix(result.heldLeaf.x, state.leaf.x, progress);
    result.heldLeaf.y = mix(result.heldLeaf.y, state.leaf.y, progress);
    result.heldLeaf.angle = mix(result.heldLeaf.angle, state.leaf.angle, progress);
  } else if (result.insect) {
    result.pose = "wonder";
    result.insect.x += actor.size * progress * .8;
    result.insect.y -= actor.size * progress * .5;
    result.insect.opacity *= 1 - progress;
  } else {
    result.pose = "swallow"; result.frame = Math.min(3, Math.floor(progress * 4));
  }
  return result;
}
