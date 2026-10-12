import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { canTraverseWorldObstacle, createWorldNavigation, findWorldPath, isWalkable, withWorldNavigationObstacle, type WorldNavigation } from "@/features/world/navigation/navigation";
import { compileWorldInteractions } from "@/features/world/navigation/interaction-navigation";
import { isForestGroundClear } from "@/features/world/environment/weather/forest-ground-weather";
import { forestBushArtworkAvailable } from "./forest-bush-artwork";
import { forestGardenBerryLayout } from "./forest-garden-layout";
import { economyGardenGrowth, type EconomySceneGarden, type GardenHarvestEvent, type GardenHarvestRequest } from "@/features/world/state/economy/economy-garden-state";

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
    size: number; berries: number; capacity: number; held?: boolean; dropRetryAt?: number } | null;
  basketUnavailable?: boolean;
  basketCorridors: WorldPoint[][];
  routine: ForestGardenRoutine | null; nextActionAt: number;
  /** Undefined retains legacy/DEV growth; null is a managed empty bush. Never persisted. */
  production?: EconomySceneGarden | null;
  harvest?: { request: GardenHarvestRequest; phase: "pending" | "running" | "completed" } | null;
  harvestEvent?: GardenHarvestEvent | null;
};
export const FOREST_GARDEN_LIMITS = { harvest: 3, capacity: 12, basketSize: 14, waterCooldown: 600, maxBushes: 32 } as const;
const unit = (value: number) => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
const point = (value: WorldPoint) => ({ x: value.x, y: value.y });
const finitePoint = (value: WorldPoint) => Number.isFinite(value.x) && Number.isFinite(value.y);

/** The low wicker body occupies ground; its tall handle is not a wall. */
export function gardenBasketFootprint(state: ForestGardenState): WorldPoint[] | null {
  const basket = state.basket;
  if (!basket || basket.held || state.routine?.carryingBasket) return null;
  return basketFootprint(basket.position, basket.size);
}
function basketFootprint(position: WorldPoint, size: number): WorldPoint[] {
  size = Number.isFinite(size) && size > 0 ? size : FOREST_GARDEN_LIMITS.basketSize;
  return Array.from({ length: 8 }, (_, index) => ({
    x: position.x + Math.cos(index * Math.PI / 4) * size * .5,
    y: position.y - size * .1 + Math.sin(index * Math.PI / 4) * size * .21,
  }));
}
function corridorsClear(nav: WorldNavigation, corridors: WorldPoint[][]) {
  return corridors.every(points => points.every((point, index) => !index || canTraverseWorldObstacle(nav, points[index - 1], point)));
}

/** Approach beside the prop, with enough room for its body and the hero's feet. */
export function gardenBasketApproach(position: WorldPoint, size: number, nav: WorldNavigation, from: WorldPoint): WorldPoint | null {
  const preferred = from.x < position.x ? -1 : 1;
  for (const horizontal of [.38, .4, .36]) for (const side of [preferred, -preferred]) {
    for (const vertical of [.035, .065, 0]) {
      const candidate = { x: position.x + side * size * horizontal, y: position.y + size * vertical };
      if (findWorldPath(nav, from, candidate)) return candidate;
    }
  }
  return null;
}

/** An authored basket marker is authoritative; old maps keep the safe automatic fallback. */
export function createForestGarden(scene: FixedWorldScene): ForestGardenState {
  const state: ForestGardenState = { elapsed: 0, bushes: [], unplacedBerries: 0, basket: null, basketCorridors: [], routine: null, nextActionAt: 0 };
  const actor = scene.actor, nav = actor ? createWorldNavigation(scene) : null;
  state.bushes = (scene.bushes ?? []).filter(bush => finitePoint(bush.entry) && bush.points.length >= 3
    && bush.points.every(finitePoint)).slice(0, FOREST_GARDEN_LIMITS.maxBushes).map(bush => ({
    id: bush.id, position: point(bush.entry), points: bush.points.map(point), workPosition: null,
    artworkPending: !forestBushArtworkAvailable(scene, bush), growth: .2, moisture: .32, waterIn: 0,
  }));
  if (!actor || !nav) return state;
  // A placed prop needs its own footprint to fit, not a second hero-sized gap.
  // Walking and the handle approach still use the actor's full clearance below.
  const groundNavigation = createWorldNavigation(scene, 0);
  const interactions = compileWorldInteractions(scene);
  state.basketCorridors = [...(interactions.home ? [interactions.home] : []), ...interactions.bushes]
    .map(interaction => [...interaction.departure.slice().reverse(), interaction.entry,
      interaction.kind === "home" ? interaction.doorway : interaction.hide].map(point));
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
  const positions = scene.basket ? [scene.basket.position]
    : [[.49, -.08], [-.49, -.08], [.31, .34], [-.31, .34], [.55, .04], [-.55, .04], [.25, .4], [-.25, .4], [.19, .28], [-.19, .28]]
      .map(([dx, dy]) => ({ x: actor.spawn.x + actor.size * dx, y: actor.spawn.y + actor.size * dy }));
  for (const position of positions) {
    if (!finitePoint(position)) continue;
    const footprint = basketFootprint(position, FOREST_GARDEN_LIMITS.basketSize);
    if ((!scene.basket && !isForestGroundClear(scene, position, actor.size * .085)) || !isWalkable(nav, position)
      || !groundNavigation || !footprint.every(point => isWalkable(groundNavigation, point))) continue;
    const parkedNavigation = withWorldNavigationObstacle(nav, footprint);
    if (!parkedNavigation || !isWalkable(parkedNavigation, actor.spawn) || !corridorsClear(parkedNavigation, state.basketCorridors)) continue;
    const approach = gardenBasketApproach(position, actor.size, parkedNavigation, actor.spawn);
    if (!approach) continue;
    if ((scene.mushrooms ?? []).some(mushroom => Math.hypot(mushroom.position.x - position.x, mushroom.position.y - position.y) < actor.size * .16)) continue;
    state.basket = { position: point(position), approach, homePosition: point(position), homeApproach: point(approach), size: FOREST_GARDEN_LIMITS.basketSize, berries: 0,
      capacity: FOREST_GARDEN_LIMITS.capacity };
    break;
  }
  state.basketUnavailable = Boolean(scene.basket && !state.basket);
  return state;
}

/** Only the cosmetic garden uses the active clock. Economic crops use server dates. */
export function advanceForestGarden(state: ForestGardenState, delta: number, options: { rain: number }) {
  if (!Number.isFinite(delta) || delta <= 0) return;
  const dt = Math.min(delta, .1), rain = unit(options.rain);
  state.elapsed += dt;
  for (const bush of state.bushes) {
    // Rain waters gradually; otherwise moisture dries over many active minutes.
    bush.moisture = unit(bush.moisture + dt * (rain > .1 ? rain / 90 : -1 / 1500));
    bush.waterIn = Math.max(0, bush.waterIn - dt);
    // A watered bush takes 30 minutes; a dry bush still grows in 60. Nothing dies.
    if (state.production === undefined) bush.growth = unit(bush.growth + dt * (1 + bush.moisture) / 3600);
  }
}

/** Server dates are transient and progress is independent of simulation speed. */
export function syncForestGardenProduction(state: ForestGardenState, crop: EconomySceneGarden | null, now: number) {
  state.production = crop;
  const growth = economyGardenGrowth(crop, now);
  for (const bush of state.bushes) bush.growth = growth;
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
  if (kind === "water-bush" && state.basket?.held) return [];
  if (kind === "harvest-berries") {
    if (!state.basket) return [];
    if (state.production !== undefined) {
      if (!state.production || state.harvest?.request.jobId !== state.production.jobId || state.harvest.phase === "completed") return [];
    } else if (state.basket.berries + FOREST_GARDEN_LIMITS.harvest > state.basket.capacity) return [];
  }
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
/** Put an interrupted basket beside the real feet; unfinished harvest has no result. */
export function parkForestGardenBasket(state: ForestGardenState, foot: WorldPoint, nav?: WorldNavigation | null): boolean {
  if (state.basket && finitePoint(foot)) {
    const basket = state.basket, size = (Number.isFinite(basket.size) && basket.size > 0 ? basket.size : FOREST_GARDEN_LIMITS.basketSize) / .28;
    const positions = [-1, 1].flatMap(side => [.035, -.035, .1].map(vertical => ({
      x: foot.x + side * size * .38, y: foot.y - size * vertical,
    }))).concat(Array.from({ length: 12 }, (_, index) => ({
      x: foot.x + Math.cos(index * Math.PI / 6) * size * .4,
      y: foot.y + Math.sin(index * Math.PI / 6) * size * .4,
    })));
    // Keep a recoverable point even beside a narrow path: every candidate has
    // a visible side gap and the same foot position can reach its handle.
    let approach = point(foot);
    const position = positions.find(candidate => {
      if (!nav) return true;
      const footprint = basketFootprint(candidate, basket.size);
      if (!footprint.every(point => isWalkable(nav, point))) return false;
      const parked = withWorldNavigationObstacle(nav, footprint);
      if (!parked || !isWalkable(parked, foot) || !corridorsClear(parked, state.basketCorridors ?? [])) return false;
      const reachable = gardenBasketApproach(candidate, size, parked, foot);
      if (!reachable) return false;
      approach = reachable; return true;
    });
    if (position) {
      basket.position = position; basket.approach = approach; basket.held = false; return true;
    }
    // A narrow corridor is not permission to teleport the basket home or put
    // its collider under the hero. Keep holding it until there is room nearby.
    basket.held = true; basket.dropRetryAt = state.elapsed + 1;
  }
  return false;
}
export function cancelForestGarden(state: ForestGardenState, foot?: WorldPoint, nav?: WorldNavigation | null) {
  if ((state.routine?.carryingBasket || state.basket?.held) && state.basket && foot && finitePoint(foot))
    parkForestGardenBasket(state, foot, nav);
  state.routine = null;
  if (state.harvest && state.harvest.phase !== "completed") state.harvestEvent = {
    ...state.harvest.request, status: "interrupted", reason: "Сбор остановлен — готовый урожай сохранён",
  };
  state.harvest = null;
  state.nextActionAt = state.elapsed + 30;
}
/** Explicit DEV command; the caller suspends account persistence before requesting it. */
export function growForestBerries(state: ForestGardenState) {
  for (const bush of state.bushes) bush.growth = 1;
  state.nextActionAt = state.elapsed;
}
