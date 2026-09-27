import type { FixedWorldScene, WorldPoint } from "./tiled/types";
import { createWorldNavigation, findWorldPath, isWalkable } from "./navigation";
import { isForestGroundClear } from "./forest-ground-weather";
import { forestBushArtworkAvailable } from "./forest-bush-artwork";
import { forestGardenBerryLayout } from "./forest-garden-layout";

export type ForestGardenAction = "water-bush" | "harvest-berries";
export type ForestGardenPhase = "approach-basket" | "take-basket" | "approach-bush" | "water" | "collect"
  | "return-basket" | "deposit" | "settle";
export type ForestBerryBush = {
  id: string; position: WorldPoint; points: WorldPoint[]; workPosition: WorldPoint | null;
  /** Temporary authoring state; crop persistence contains no artwork flags. */
  artworkPending?: boolean;
  growth: number; moisture: number; waterIn: number;
};
export type ForestGardenRoutine = {
  kind: ForestGardenAction; bushId: string; phase: ForestGardenPhase;
  elapsed: number; totalElapsed: number; carryingBasket: boolean;
};
export type ForestGardenState = {
  elapsed: number; bushes: ForestBerryBush[]; unplacedBerries: number;
  basket: { position: WorldPoint; approach: WorldPoint; homePosition: WorldPoint; homeApproach: WorldPoint;
    berries: number; capacity: number } | null;
  routine: ForestGardenRoutine | null; nextActionAt: number;
};
export const FOREST_GARDEN_LIMITS = { harvest: 3, capacity: 12, waterCooldown: 600, maxBushes: 32 } as const;
const unit = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const point = (value: WorldPoint) => ({ x: value.x, y: value.y });
const finitePoint = (value: WorldPoint) => Number.isFinite(value.x) && Number.isFinite(value.y);

/** Props use already authored clear ground and walk areas; no new hidden collision or map edits. */
export function createForestGarden(scene: FixedWorldScene): ForestGardenState {
  const state: ForestGardenState = { elapsed: 0, bushes: [], unplacedBerries: 0, basket: null, routine: null, nextActionAt: 0 };
  const actor = scene.actor, nav = actor ? createWorldNavigation(scene) : null;
  state.bushes = (scene.bushes ?? []).filter(bush => finitePoint(bush.entry) && bush.points.length >= 3
    && bush.points.every(finitePoint)).slice(0, FOREST_GARDEN_LIMITS.maxBushes).map(bush => ({
    id: bush.id, position: point(bush.entry), points: bush.points.map(point), workPosition: null,
    artworkPending: !forestBushArtworkAvailable(scene, bush), growth: .2, moisture: .32, waterIn: 0,
  }));
  if (!actor || !nav) return state;
  for (const bush of state.bushes) {
    const authored = scene.bushes?.find(item => item.id === bush.id);
    if (!authored || !forestBushArtworkAvailable(scene, authored)) continue;
    const cluster = forestGardenBerryLayout(bush, bush.position)[0];
    if (!cluster) continue;
    const middleX = bush.points.reduce((sum, point) => sum + point.x, 0) / bush.points.length;
    const side = bush.position.x < middleX ? -1 : 1;
    // Feet stay on navigable ground; the worked fruit must be below the near ear
    // and beside a short paw, not behind the face or at full arm's extension.
    for (const vertical of [.27, .255, .28]) {
      for (const horizontal of [.4, .36, .44]) {
        const candidate = { x: cluster.x + side * actor.size * horizontal, y: cluster.y + actor.size * vertical };
        const shoulder = { x: candidate.x - side * actor.size * 10 / 48, y: candidate.y - actor.size * 14 / 48 };
        const reach = Math.hypot(cluster.x - shoulder.x, cluster.y - shoulder.y) + cluster.radius;
        if (reach > actor.size * .27 || !findWorldPath(nav, actor.spawn, candidate)) continue;
        bush.workPosition = candidate; break;
      }
      if (bush.workPosition) break;
    }
  }
  if (!state.bushes.length) return state;
  // A small prop stays beside the clearing's existing routes. The separate foot
  // position keeps the body in front of the basket instead of standing inside it.
  for (const [dx, dy] of [[.49, -.08], [-.49, -.08], [.31, .34], [-.31, .34], [.55, .04], [-.55, .04], [.25, .4], [-.25, .4], [.19, .28], [-.19, .28]]) {
    const position = { x: actor.spawn.x + actor.size * dx, y: actor.spawn.y + actor.size * dy };
    const approach = { x: position.x, y: position.y + actor.size * .055 };
    if (!isForestGroundClear(scene, position, actor.size * .085) || !isWalkable(nav, position)
      || !findWorldPath(nav, actor.spawn, approach)) continue;
    if ((scene.mushrooms ?? []).some(mushroom => Math.hypot(mushroom.position.x - position.x, mushroom.position.y - position.y) < actor.size * .16)) continue;
    state.basket = { position, approach, homePosition: point(position), homeApproach: point(approach), berries: 0,
      capacity: FOREST_GARDEN_LIMITS.capacity };
    break;
  }
  return state;
}

/** The director is the sole active clock. A suspended tab never catches up growth. */
export function advanceForestGarden(state: ForestGardenState, delta: number, options: { rain: number }) {
  if (!Number.isFinite(delta) || delta <= 0) return;
  const dt = Math.min(delta, .1), rain = unit(options.rain);
  state.elapsed += dt;
  for (const bush of state.bushes) {
    // Rain waters gradually; otherwise moisture dries over many active minutes.
    bush.moisture = unit(bush.moisture + dt * (rain > .1 ? rain / 90 : -1 / 1500));
    bush.waterIn = Math.max(0, bush.waterIn - dt);
    // A watered bush takes 30 minutes; a dry bush still grows in 60. Nothing dies.
    bush.growth = unit(bush.growth + dt * (1 + bush.moisture) / 3600);
  }
}

/** DEV can resize only the rendered rig. Do not stretch it toward a stale work point. */
export function gardenWorkReachable(bush: ForestBerryBush, size: number): boolean {
  const foot = bush.workPosition, cluster = forestGardenBerryLayout(bush, bush.position)[0];
  if (!foot || !cluster || !Number.isFinite(size) || size <= 0) return false;
  const side = cluster.x < foot.x ? -1 : 1;
  const shoulder = { x: foot.x + side * size * 10 / 48, y: foot.y - size * 14 / 48 };
  return foot.y - cluster.y <= size * .285 && foot.y >= cluster.y
    && Math.abs(cluster.x - foot.x) >= size * .32
    && Math.hypot(cluster.x - shoulder.x, cluster.y - shoulder.y) + cluster.radius <= size * .27;
}

export function gardenActionAvailable(state: ForestGardenState, kind: ForestGardenAction): boolean {
  if (state.routine || state.elapsed < state.nextActionAt) return false;
  return gardenEligibleBushes(state, kind).length > 0;
}
export function gardenEligibleBushes(state: ForestGardenState, kind: ForestGardenAction): ForestBerryBush[] {
  if (kind === "harvest-berries" && (!state.basket || state.basket.berries + FOREST_GARDEN_LIMITS.harvest > state.basket.capacity)) return [];
  return state.bushes.filter(bush => bush.workPosition && (kind === "water-bush"
    ? bush.growth < .98 && bush.moisture < .58 && bush.waterIn <= 0 : bush.growth >= .98));
}
export function gardenRoutineStationary(routine: ForestGardenRoutine | null): boolean {
  return Boolean(routine && !["approach-basket", "approach-bush", "return-basket"].includes(routine.phase));
}
export function gardenRoutineTarget(state: ForestGardenState): WorldPoint | null {
  const routine = state.routine;
  if (!routine) return null;
  if (routine.phase === "approach-basket") return state.basket?.approach ?? null;
  if (routine.phase === "return-basket") return state.basket?.homeApproach ?? null;
  if (routine.phase === "approach-bush") return state.bushes.find(bush => bush.id === routine.bushId)?.workPosition ?? null;
  return null;
}
/** Dropping a carried basket occurs at the real feet; unfinished harvest has no result. */
export function cancelForestGarden(state: ForestGardenState, foot?: WorldPoint) {
  if (state.routine?.carryingBasket && state.basket && foot && finitePoint(foot)) {
    state.basket.position = point(foot); state.basket.approach = point(foot);
  }
  state.routine = null;
  state.nextActionAt = state.elapsed + 30;
}
/** Explicit DEV command; the caller suspends account persistence before requesting it. */
export function growForestBerries(state: ForestGardenState) {
  for (const bush of state.bushes) bush.growth = 1;
  state.nextActionAt = state.elapsed;
}
