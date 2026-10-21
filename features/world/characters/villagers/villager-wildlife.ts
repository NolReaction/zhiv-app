import type { ForestVillagerFrame, ForestVillagerId } from "../forest-villager-types";
import { lopukhSprite, lopukhSpriteRig } from "@/features/world/characters/lopukh/lopukh-sprite";
import { kamneshmygSprite, kamneshmygSpriteRig } from "@/features/world/characters/kamneshmyg/kamneshmyg-sprite";
import { leaftailSprite, leaftailSpriteRig } from "@/features/world/characters/leaftail/leaftail-sprite";
import { advanceForestBirdwatch, chooseForestBirdwatchTarget, createForestBirdwatch, forestBirdwatchFrame,
  type ForestBirdwatch } from "@/features/world/activities/forest-birdwatching";
import { residentFaunaEncounter, FOREST_FAUNA_VISITOR_LIMITS, type FaunaVisitor, type ForestFaunaState } from "@/features/world/environment/wildlife/forest-fauna";
import type { ForestBird } from "@/features/world/environment/wildlife/forest-wildlife";
import type { WorldPoint } from "@/features/world/tiled/types";

/** The scene supplies authority and occupation; this helper never starts jobs,
 * moves a resident, creates wildlife, or owns a second animation clock. */
export type VillagerWildlifeActor = ForestVillagerFrame & {
  available: boolean; job?: boolean; inside?: boolean; social?: boolean; noticed?: boolean; sleeping?: boolean;
  /** Tests/headless hosts can supply the same rig anchor without a canvas. */
  hand?: WorldPoint;
};
type BirdVisit = { visitorId: ForestVillagerId; actor: WorldPoint; size: number; watch: ForestBirdwatch; token: number };
export type VillagerWildlifeState = { elapsed: number; nextBirdAt: number; sequence: number;
  lastBirdVisitor: ForestVillagerId | null; birdwatch: BirdVisit | null };
export type VillagerWildlifeEnvironment = {
  actors: readonly VillagerWildlifeActor[]; birds: readonly ForestBird[]; fauna: ForestFaunaState;
  paused?: boolean; reducedMotion?: boolean; enabled?: boolean; rain?: number; dusk?: number;
  /** The hero's existing observation retains its own identified bird. */
  reservedBirdIds?: readonly string[];
};
const ids: readonly ForestVillagerId[] = ["lopukh", "kamneshmyg", "leaftail"];
const stationary = new Set(["idle", "rest", "inspect", "greet"]);
const finitePoint = (point: WorldPoint) => Number.isFinite(point.x) && Number.isFinite(point.y);
const activeEncounter = (fauna: ForestFaunaState, id: ForestVillagerId) => {
  const encounter = residentFaunaEncounter(fauna, id);
  return encounter && encounter.phase !== "interrupt" && encounter.phase !== "release" ? encounter : null;
};

export function villagerWildlifeAvailable(actor: VillagerWildlifeActor): boolean {
  return actor.available && finitePoint(actor) && Number.isFinite(actor.size) && actor.size > 0
    && (actor.opacity ?? 1) > .95 && !actor.arriving && !actor.job && !actor.inside && !actor.social
    && !actor.noticed && !actor.sleeping && stationary.has(actor.action);
}

/** The free paw is read from the exact fixed greeting used in presentation.
 * Reserving the resting paw and then raising it would cancel its own visitor. */
export function forestVillagerWildlifeHand(frame: ForestVillagerFrame): WorldPoint | null {
  if (typeof document === "undefined" || !finitePoint(frame) || !Number.isFinite(frame.size) || frame.size <= 0) return null;
  const rig = frame.id === "lopukh" ? lopukhSpriteRig(lopukhSprite("greet", frame.direction, 0, .5))
    : frame.id === "kamneshmyg" ? kamneshmygSpriteRig(kamneshmygSprite("greet", frame.direction, 0, .5))
    : leaftailSpriteRig(leaftailSprite("greet", frame.direction, 0, .5));
  const hand = rig?.arms.find(arm => arm.hand === "left")?.palm;
  if (!rig || !hand) return null;
  return { x: frame.x + (hand.x - 24) * frame.size / 48,
    y: frame.y + (hand.y - rig.contact.bottom) * frame.size / 48 };
}

export function forestVillagerFaunaVisitors(actors: readonly VillagerWildlifeActor[],
  wildlife?: VillagerWildlifeState | null): FaunaVisitor[] {
  return actors.slice(0, 3).flatMap(actor => {
    if (!villagerWildlifeAvailable(actor)) return [];
    const hand = actor.hand ?? forestVillagerWildlifeHand(actor);
    if (!hand || !finitePoint(hand)) return [];
    return [{ ...actor, hand, available: wildlife?.birdwatch?.visitorId !== actor.id,
      reach: FOREST_FAUNA_VISITOR_LIMITS.reach, maxDuration: FOREST_FAUNA_VISITOR_LIMITS.duration }];
  });
}

export function createVillagerWildlife(): VillagerWildlifeState {
  return { elapsed: 0, nextBirdAt: 12, sequence: 0, lastBirdVisitor: null, birdwatch: null };
}

/** Economic authority/touch can arrive while animation time is stopped. The
 * bird is untouched; its former observer immediately returns to the real task. */
export function reconcileVillagerWildlife(state: VillagerWildlifeState | null | undefined,
  actors: readonly VillagerWildlifeActor[], fauna: ForestFaunaState): void {
  const visit = state?.birdwatch;
  if (!state || !visit) return;
  const actor = actors.find(item => item.id === visit.visitorId);
  if (actor && villagerWildlifeAvailable(actor) && !activeEncounter(fauna, visit.visitorId)
    && Math.hypot(actor.x - visit.actor.x, actor.y - visit.actor.y) <= .5 && Math.abs(actor.size - visit.size) <= .01) return;
  state.birdwatch = null; state.nextBirdAt = state.elapsed + 45;
}

/** One quiet observer watches a real nearby perch for six seconds. Departing
 * birds remain free; missing identity gets a finite outro, never a replacement. */
export function advanceVillagerWildlife(state: VillagerWildlifeState, delta: number, env: VillagerWildlifeEnvironment): void {
  if (env.paused || env.reducedMotion || !Number.isFinite(delta) || delta <= 0) return;
  const dt = Math.min(.1, delta); state.elapsed += dt;
  const calm = env.enabled !== false && (env.rain ?? 0) < .24 && (env.dusk ?? 0) < .42;
  const visit = state.birdwatch;
  if (visit) {
    const actor = env.actors.find(item => item.id === visit.visitorId);
    const interrupted = !calm || !actor || !villagerWildlifeAvailable(actor) || activeEncounter(env.fauna, visit.visitorId)
      || Math.hypot(actor.x - visit.actor.x, actor.y - visit.actor.y) > .5 || Math.abs(actor.size - visit.size) > .01
      || env.reservedBirdIds?.includes(visit.watch.birdId);
    if (interrupted || advanceForestBirdwatch(visit.watch, env.birds, dt) === "finished") {
      state.birdwatch = null; state.nextBirdAt = state.elapsed + 45;
    }
  }
  if (!calm || state.birdwatch || state.elapsed < state.nextBirdAt) return;
  state.nextBirdAt = state.elapsed + 8;
  const candidates = env.actors.filter(actor => villagerWildlifeAvailable(actor) && !activeEncounter(env.fauna, actor.id))
    .sort((a, b) => Number(a.id === state.lastBirdVisitor) - Number(b.id === state.lastBirdVisitor) || a.id.localeCompare(b.id));
  const birds = env.birds.filter(bird => !bird.id || !env.reservedBirdIds?.includes(bird.id));
  for (const actor of candidates) {
    const bird = chooseForestBirdwatchTarget(birds, actor);
    if (!bird) continue;
    state.birdwatch = { visitorId: actor.id, actor: { x: actor.x, y: actor.y }, size: actor.size,
      watch: createForestBirdwatch(bird), token: ++state.sequence };
    state.lastBirdVisitor = actor.id;
    break;
  }
}

/** Holds are optional and always lose to real work, doors, touch and meetings in
 * the resident mind. Reading poses does not reserve or advance an individual. */
export function villagerWildlifeHolds(state: VillagerWildlifeState | null | undefined,
  fauna: ForestFaunaState): ForestVillagerId[] {
  return ids.filter(id => state?.birdwatch?.visitorId === id || Boolean(activeEncounter(fauna, id)));
}

export function villagerWildlifeFrame(state: VillagerWildlifeState | null | undefined, fauna: ForestFaunaState,
  actor: ForestVillagerFrame): Pick<ForestVillagerFrame, "action" | "frame" | "phase" | "direction"> | null {
  const encounter = activeEncounter(fauna, actor.id);
  if (encounter) return { action: "greet", frame: 0, phase: .5, direction: encounter.direction };
  const visit = state?.birdwatch;
  if (!visit || visit.visitorId !== actor.id) return null;
  const frame = forestBirdwatchFrame(visit.watch, actor);
  return { action: "inspect", frame: 0, phase: 0, direction: frame.direction };
}

export function villagerBirdwatchEvent(state: VillagerWildlifeState | null | undefined) {
  const visit = state?.birdwatch;
  return visit && visit.watch.elapsed >= .65 && visit.watch.missingSeconds === 0
    ? { id: `villager-bird-${visit.token}:${visit.watch.birdId}`, speaker: visit.visitorId, kind: "bird" as const } : null;
}
