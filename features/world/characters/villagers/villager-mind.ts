import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import type { ForestVillagerAction, ForestVillagerFrame, ForestVillagerId } from "@/features/world/characters/forest-villager-types";
import { isWalkable } from "@/features/world/navigation/navigation";
import { desiredSteeringSpeed, prepareSteeringPath, type SteeringPath } from "@/features/world/navigation/steering";
import { canTraverseResidents, residentClearance, residentRequestingPassage, residentRouteIntent, residentWalkingStep,
  residentYieldPoint, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { EconomySceneProduction } from "@/features/world/state/economy/economy-production-state";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { FOREST_VILLAGER_PROFILES, forestVillagerNorthernArrival, forestVillagerPlaces, forestVillagerRoute,
  villagerDistance, type VillagerPlaces, type VillagerStop } from "./villager-navigation";

export const FOREST_VILLAGER_LIMITS = { maxDelta: .5, greeting: 2.8, arrivalSpeed: 3, decisionSeconds: 9,
  trafficRetry: .8, visitSeconds: 18, movementSteps: 64 } as const;
const ids: readonly ForestVillagerId[] = ["lopukh", "kamneshmyg", "leaftail"];
export type ForestVillagerMind = {
  id: ForestVillagerId; available: boolean; initialized: boolean; position: WorldPoint; direction: PixelDirection;
  action: ForestVillagerAction; age: number; elapsed: number; walked: number; wait: number;
  route: SteeringPath | null; distance: number; speed: number; target: VillagerStop | null;
  intent: "work" | "home" | "wander" | "social" | "yield"; afterWalk: ForestVillagerAction;
  fatigue: number; socialNeed: number; workNeed: number; decisions: number; trafficWaiting: boolean; retryAt: number; stalledAt: number | null;
  job: boolean; jobKey: string; socialVisit: { targetId: string; anchor: WorldPoint } | null; noticePending: boolean;
};
export type ForestVillagersState = {
  scene: FixedWorldScene; confirmed: boolean; buildings: Readonly<Record<string, number>>;
  residents: Record<ForestVillagerId, ForestVillagerMind>; production: EconomySceneProduction | null;
  arrivalPending: boolean; arrivalPhase: "waiting" | "running" | "greeting" | "complete"; arrivalCompleted: boolean;
};
export type ForestVillagerConfiguration = {
  buildings: Readonly<Record<string, number>>; confirmed: boolean; arrivalSeen?: boolean; allowArrival?: boolean;
  production?: EconomySceneProduction | null; now?: number;
};
export type ForestVillagerEnvironment = {
  rain?: boolean | number; dusk?: boolean | number; occupants?: readonly ResidentOccupant[];
  socialHolds?: readonly ForestVillagerId[]; production?: EconomySceneProduction | null; now?: number;
  /** The map owns this spotlight; closing it pauses only the miner's entrance. */
  arrivalActive?: boolean;
};
const direction = (a: WorldPoint, b: WorldPoint): PixelDirection => Math.abs(b.x - a.x) > Math.abs(b.y - a.y)
  ? b.x > a.x ? "right" : "left" : b.y > a.y ? "front" : "back";
const setAction = (mind: ForestVillagerMind, action: ForestVillagerAction) => {
  if (mind.action !== action) { mind.action = action; mind.age = 0; }
};

/** Shared-session, presentation-only minds. No timers, networking, command
 * callbacks, inventory or offline simulation are owned by these residents. */
export function createForestVillagers(scene: FixedWorldScene): ForestVillagersState {
  const residents = Object.fromEntries(ids.map((id, index) => [id, {
    id, available: false, initialized: false, position: { x: 0, y: 0 }, direction: "front", action: "idle", age: 0, elapsed: 0,
    walked: 0, wait: 3 + index * 2, route: null, distance: 0, speed: 0, target: null, intent: "home", afterWalk: "idle",
    fatigue: .08 + index * .07, socialNeed: .2, workNeed: .4, decisions: 0, trafficWaiting: false, retryAt: 0, stalledAt: null,
    job: false, jobKey: "", socialVisit: null, noticePending: false,
  }])) as Record<ForestVillagerId, ForestVillagerMind>;
  return { scene, confirmed: false, buildings: {}, residents, production: null,
    arrivalPending: false, arrivalPhase: "waiting", arrivalCompleted: false };
}

/** Artwork/camera handoff retains real feet and clocks. A social reservation
 * belongs to its old director, so it cannot survive in a second session owner. */
export function rehydrateForestVillagers(scene: FixedWorldScene, previous?: ForestVillagersState | null, now?: number): ForestVillagersState {
  if (!previous) return createForestVillagers(scene);
  const residents = Object.fromEntries(ids.map(id => {
    const mind = previous.residents[id];
    const clone: ForestVillagerMind = { ...mind, position: { ...mind.position },
      target: mind.target ? { ...mind.target, position: { ...mind.target.position }, lookAt: { ...mind.target.lookAt } } : null,
      socialVisit: null };
    if (mind.socialVisit) { stop(clone, "idle"); clone.wait = 3; }
    return [id, clone];
  })) as Record<ForestVillagerId, ForestVillagerMind>;
  const state = { ...previous, residents, buildings: { ...previous.buildings },
    production: previous.production ? { ...previous.production, jobs: previous.production.jobs.map(job => ({ ...job })) } : null };
  configureForestVillagers(state, scene, { confirmed: state.confirmed, buildings: state.buildings,
    arrivalSeen: state.arrivalCompleted, now });
  return state;
}

function stop(mind: ForestVillagerMind, action: ForestVillagerAction) {
  mind.route = null; mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false; mind.stalledAt = null;
  if (mind.target) mind.direction = direction(mind.position, mind.target.lookAt);
  setAction(mind, action); mind.wait = FOREST_VILLAGER_LIMITS.decisionSeconds;
}
function select(mind: ForestVillagerMind, places: VillagerPlaces, candidates: readonly VillagerStop[],
  intent: ForestVillagerMind["intent"], afterWalk: ForestVillagerAction, occupants?: readonly ResidentOccupant[]): boolean {
  const profile = FOREST_VILLAGER_PROFILES[mind.id];
  const free = candidates.filter(stop => canTraverseResidents(stop.position, stop.position, profile.size, occupants, mind.id));
  const selected = forestVillagerRoute(places, mind.position, free, profile.size);
  mind.decisions++; mind.wait = FOREST_VILLAGER_LIMITS.decisionSeconds;
  if (!selected) return false;
  mind.target = selected.target; mind.route = selected.route; mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false;
  mind.intent = intent; mind.afterWalk = afterWalk;
  if (mind.route.length < .001) stop(mind, afterWalk);
  else setAction(mind, afterWalk === "carry" ? "carry" : "walk");
  return true;
}

function synchronizeJobs(state: ForestVillagersState, now: number) {
  for (const id of ids) {
    const mind = state.residents[id], profile = FOREST_VILLAGER_PROFILES[id];
    const job = id !== "leaftail" && state.production?.jobs.filter(job => job.stationId === profile.work
      && Number.isInteger(job.stationLevel) && job.stationLevel > 0 && Date.parse(job.startedAt) <= now
      && Date.parse(job.finishesAt) > now).sort((a, b) => a.id.localeCompare(b.id))[0];
    const key = job ? `${state.production?.ownerPublicId}:${job.id}` : "";
    if (key === mind.jobKey) continue;
    mind.jobKey = key; mind.job = !!job; mind.socialVisit = null; mind.noticePending = false;
    if (!mind.available || id === "kamneshmyg" && state.arrivalPhase !== "complete") continue;
    const places = forestVillagerPlaces(state.scene, id);
    if (places && job) { stop(mind, "idle"); select(mind, places, places.work, "work", "work"); }
    else { stop(mind, "inspect"); mind.wait = 3; }
  }
}

/** Only confirmed levels/jobs are accepted. A disconnected refresh retains the
 * last confirmed cosmetics; a new account owns a new ForestSessionState. */
export function configureForestVillagers(state: ForestVillagersState, scene: FixedWorldScene, config: ForestVillagerConfiguration): void {
  const changedScene = state.scene !== scene; state.scene = scene;
  if (config.confirmed) {
    state.confirmed = true; state.buildings = { ...config.buildings };
    if (config.production !== undefined) state.production = config.production;
  }
  const unlocked = state.confirmed && (state.buildings.quarry ?? 0) >= 1;
  state.arrivalPending = unlocked && state.arrivalPhase !== "complete";
  for (const id of ids) {
    const mind = state.residents[id];
    if (!state.confirmed || id === "kamneshmyg" && !unlocked) {
      mind.available = false; mind.route = null; mind.socialVisit = null; continue;
    }
    const places = forestVillagerPlaces(scene, id);
    if (!places) {
      mind.available = false; mind.route = null; mind.socialVisit = null; continue;
    }
    if (id === "kamneshmyg" && state.arrivalPhase === "waiting") {
      if (config.arrivalSeen) {
        mind.position = { ...places.work[0].position }; mind.target = places.work[0]; mind.available = true; mind.initialized = true;
        state.arrivalPhase = "complete"; state.arrivalCompleted = true; state.arrivalPending = false; stop(mind, "inspect");
      } else if (config.allowArrival) {
        const arrival = forestVillagerNorthernArrival(places);
        if (arrival) {
          mind.position = { ...arrival.start }; mind.target = arrival.target; mind.route = arrival.route;
          mind.available = true; mind.initialized = true; mind.distance = 0; mind.speed = 0; mind.afterWalk = "greet"; mind.intent = "work";
          state.arrivalPhase = "running"; setAction(mind, "walk");
        }
      }
      continue;
    }
    if (!mind.available) {
      // Initial appearance is hidden until authority/geometry arrive. An already
      // visible resident invalidated by new artwork never jumps to a new stop.
      if (!mind.initialized) {
        mind.position = { ...places.home.position }; mind.target = places.home; mind.available = true; mind.initialized = true;
      }
      else if (isWalkable(places.navigation, mind.position)) mind.available = true;
    }
    if (changedScene) {
      const previousTarget = mind.target, previousIntent = mind.intent, previousAfter = mind.afterWalk;
      mind.socialVisit = null; mind.route = null; mind.speed = 0;
      if (!isWalkable(places.navigation, mind.position)) { mind.available = false; continue; }
      const arriving = id === "kamneshmyg" && state.arrivalPhase === "running";
      const target = mind.job || arriving ? places.work
        : previousTarget && isWalkable(places.navigation, previousTarget.position) ? [previousTarget] : [places.home];
      select(mind, places, target, mind.job ? "work" : arriving ? "work" : previousIntent,
        arriving ? "greet" : mind.job ? "work" : previousAfter);
    }
  }
  synchronizeJobs(state, Number.isFinite(config.now) ? config.now! : Date.now());
}

function walk(mind: ForestVillagerMind, places: VillagerPlaces, step: number, occupants: readonly ResidentOccupant[], running: boolean) {
  const profile = FOREST_VILLAGER_PROFILES[mind.id], maximum = profile.speed * (running ? FOREST_VILLAGER_LIMITS.arrivalSpeed : 1);
  let remaining = step;
  for (let attempt = 0; mind.route && remaining > 1e-7 && attempt < FOREST_VILLAGER_LIMITS.movementSteps; attempt++) {
    const path = mind.route;
    if (path.length - mind.distance < 1e-7) { stop(mind, mind.afterWalk); break; }
    const slice = Math.min(.05, remaining), acceleration = profile.size * 1.6;
    const desired = desiredSteeringSpeed(path, mind.distance, maximum, acceleration);
    mind.speed = Math.min(desired, mind.speed + acceleration * slice);
    const nextIndex = path.distances.findIndex(distance => distance > mind.distance + 1e-7);
    if (nextIndex < 1) { stop(mind, mind.afterWalk); break; }
    const at = Math.min(path.distances[nextIndex], mind.distance + Math.max(.1, mind.speed) * slice);
    const a = path.points[nextIndex - 1], b = path.points[nextIndex];
    const ratio = (at - path.distances[nextIndex - 1]) / (path.distances[nextIndex] - path.distances[nextIndex - 1] || 1);
    const position = { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
    const traffic = residentWalkingStep({ owner: mind, navigation: places.navigation, from: mind.position,
      target: path.points.at(-1)!, size: profile.size, occupants, selfId: mind.id, time: mind.elapsed }, position);
    if (!traffic.clear) {
      mind.trafficWaiting = true; mind.speed = 0;
      mind.stalledAt ??= mind.elapsed;
      // A leisure walk owns no destination. Release a stubborn crossing so the
      // normal idle passage yield can make space for a worker or an arrival.
      if (!running && !mind.job && !mind.socialVisit && mind.elapsed - mind.stalledAt > 2.4) {
        stop(mind, "idle"); mind.wait = 3; return;
      }
      const detour = traffic.path && prepareSteeringPath(places.navigation, traffic.path, profile.size);
      if (detour) { mind.route = detour; mind.distance = 0; }
      return;
    }
    mind.trafficWaiting = false; mind.stalledAt = null; mind.direction = direction(mind.position, position);
    const travelled = at - mind.distance;
    mind.walked += villagerDistance(mind.position, position); mind.position = position; mind.distance = at;
    // Crossing a sampled steering vertex consumes only its actual travel time.
    // Discarding the remainder would make a rounded bend hundreds of tiny stops.
    remaining -= Math.min(slice, travelled / Math.max(.1, mind.speed));
  }
}

function decide(mind: ForestVillagerMind, places: VillagerPlaces, env: ForestVillagerEnvironment, occupants: readonly ResidentOccupant[]) {
  const profile = FOREST_VILLAGER_PROFILES[mind.id];
  const weather = !!env.rain || !!env.dusk;
  const rest = mind.fatigue + (weather ? .7 : 0), work = mind.workNeed * profile.diligence;
  const social = mind.socialNeed * profile.sociability;
  if (mind.job) { select(mind, places, places.work, "work", "work", occupants); return; }
  if (rest >= Math.max(work, social, .65)) { select(mind, places, [places.home], "home", "rest", occupants); return; }
  if (work >= social) {
    select(mind, places, places.work, "work", mind.id === "leaftail" ? "trade" : "work", occupants); return;
  }
  const ordered = [...places.wander.slice(mind.decisions % Math.max(1, places.wander.length)),
    ...places.wander.slice(0, mind.decisions % Math.max(1, places.wander.length))]
    .filter(stop => villagerDistance(stop.position, mind.position) > profile.size * .6);
  select(mind, places, ordered, "wander", mind.id === "lopukh" ? "greet" : "inspect", occupants);
}

export function advanceForestVillagers(state: ForestVillagersState, scene: FixedWorldScene, dt: number,
  environment: ForestVillagerEnvironment = {}): void {
  if (state.scene !== scene) configureForestVillagers(state, scene, { buildings: state.buildings, confirmed: state.confirmed,
    production: environment.production, now: environment.now });
  if (environment.production !== undefined && state.confirmed) state.production = environment.production;
  synchronizeJobs(state, Number.isFinite(environment.now) ? environment.now! : Date.now());
  if (!Number.isFinite(dt) || dt <= 0) return;
  const step = Math.min(FOREST_VILLAGER_LIMITS.maxDelta, dt);
  for (const id of ids) {
    const mind = state.residents[id];
    if (!mind.available) continue;
    const places = forestVillagerPlaces(scene, id), profile = FOREST_VILLAGER_PROFILES[id];
    if (!places) continue;
    const arriving = id === "kamneshmyg" && state.arrivalPhase !== "complete";
    if (arriving && environment.arrivalActive === false) continue;
    mind.elapsed += step; mind.age += step;
    const own = forestVillagerOccupants(state);
    const occupants = [...(environment.occupants ?? []).filter(other => !ids.includes(other.id as ForestVillagerId)), ...own];
    if (mind.route) {
      walk(mind, places, step, occupants, arriving);
      if (arriving && !mind.route) { state.arrivalPhase = "greeting"; setAction(mind, "greet"); }
      continue;
    }
    if (arriving) {
      if (state.arrivalPhase === "greeting" && mind.age >= FOREST_VILLAGER_LIMITS.greeting) {
        state.arrivalPhase = "complete"; state.arrivalPending = false; state.arrivalCompleted = true;
        setAction(mind, mind.job ? "work" : "inspect"); mind.wait = 5;
      }
      continue;
    }
    // Idle workers yield to a real route before another cosmetic decision.
    const requester = !mind.socialVisit && !environment.socialHolds?.includes(id)
      && residentRequestingPassage(mind.position, profile.size, occupants, id, mind.job ? 2 : 0);
    if (requester && mind.elapsed >= mind.retryAt) {
      mind.retryAt = mind.elapsed + FOREST_VILLAGER_LIMITS.trafficRetry;
      const position = residentYieldPoint(places.navigation, mind.position, profile.size, occupants, id, requester);
      if (position && select(mind, places, [{ id: `${id}:yield`, position, lookAt: requester.position }], "yield", "idle", occupants)) continue;
    }
    if (environment.socialHolds?.includes(id) || mind.socialVisit) { setAction(mind, "greet"); mind.socialNeed = 0; continue; }
    if (mind.job) {
      if (places.work.some(stop => villagerDistance(mind.position, stop.position) < .1)) setAction(mind, "work");
      else {
        mind.wait -= step;
        if (mind.wait <= 0) select(mind, places, places.work, "work", "work", occupants);
      }
      continue;
    }
    if (mind.noticePending) { mind.noticePending = false; setAction(mind, "greet"); mind.wait = FOREST_VILLAGER_LIMITS.greeting; }
    if (mind.action === "rest") mind.fatigue = Math.max(0, mind.fatigue - step * .045);
    else mind.fatigue = Math.min(1, mind.fatigue + step * profile.fatigue * .003);
    mind.socialNeed = Math.min(1, mind.socialNeed + step * .007);
    if (mind.action === "work" || mind.action === "trade") mind.workNeed = Math.max(0, mind.workNeed - step * .045);
    else mind.workNeed = Math.min(1, mind.workNeed + step * .012);
    mind.wait -= step;
    if (mind.wait > 0) continue;
    if (id === "lopukh" && mind.action === "work") {
      select(mind, places, [places.home], "home", "carry", occupants); continue;
    }
    if (mind.action === "carry") { setAction(mind, "inspect"); mind.wait = 3; continue; }
    decide(mind, places, environment, occupants);
  }
}

/** Every consumer receives detached values; portraits cannot advance or move feet. */
export function forestVillagerFrames(state: ForestVillagersState, still = false): ForestVillagerFrame[] {
  return ids.flatMap(id => {
    const mind = state.residents[id]; if (!mind.available) return [];
    const action = mind.trafficWaiting && mind.route ? "idle" : mind.action;
    return [{ id, ...mind.position, size: FOREST_VILLAGER_PROFILES[id].size, direction: mind.direction, action,
      frame: still ? 0 : Math.floor((mind.route ? mind.walked / 7 : mind.age * 5) % 32),
      phase: still ? 0 : mind.age % 3 / 3, arriving: id === "kamneshmyg" && state.arrivalPhase !== "complete" }];
  });
}

export function forestVillagerOccupants(state: ForestVillagersState): ResidentOccupant[] {
  return forestVillagerFrames(state, true).map(frame => {
    const mind = state.residents[frame.id], moving = !!mind.route;
    return { id: frame.id, position: { ...mind.position }, size: frame.size, moving,
      intent: moving ? residentRouteIntent(mind.route!, mind.position, mind.distance, frame.size,
        mind.intent === "yield" ? 0 : mind.job || mind.socialVisit || frame.arriving ? 2 : 1) : undefined };
  });
}

export function noticeForestVillager(state: ForestVillagersState, id: ForestVillagerId): void {
  const mind = state.residents[id];
  if (mind.available && !mind.job && !(id === "kamneshmyg" && state.arrivalPhase !== "complete")) mind.noticePending = true;
}

export function requestForestVillagerVisit(state: ForestVillagersState, scene: FixedWorldScene, id: ForestVillagerId,
  target: { id: string; position: WorldPoint; size: number }, occupants?: readonly ResidentOccupant[]): boolean {
  const mind = state.residents[id], places = forestVillagerPlaces(scene, id), profile = FOREST_VILLAGER_PROFILES[id];
  if (!mind.available || state.scene !== scene || !places || mind.job || mind.socialVisit || id === "kamneshmyg" && state.arrivalPhase !== "complete"
    || !Number.isFinite(target.position.x) || !Number.isFinite(target.position.y) || !Number.isFinite(target.size) || target.size <= 0) return false;
  const gap = residentClearance(profile.size, target.size) + 8;
  const heading = Math.atan2(mind.position.y - target.position.y, mind.position.x - target.position.x);
  const candidates = [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI].map(offset => ({
    id: `${id}:social:${target.id}`, position: { x: target.position.x + Math.cos(heading + offset) * gap,
      y: target.position.y + Math.sin(heading + offset) * gap }, lookAt: { ...target.position },
  })).filter(stop => isWalkable(places.navigation, stop.position)
    && canTraverseResidents(stop.position, stop.position, profile.size, occupants, id));
  const route = forestVillagerRoute(places, mind.position, candidates, profile.size);
  if (!route || route.route.length > profile.speed * FOREST_VILLAGER_LIMITS.visitSeconds) return false;
  mind.socialVisit = { targetId: target.id, anchor: { ...target.position } }; mind.target = route.target;
  mind.intent = "social"; mind.afterWalk = "greet"; mind.route = route.route; mind.distance = 0; mind.speed = 0;
  mind.trafficWaiting = false; mind.noticePending = false; mind.decisions++;
  if (mind.route.length < .001) stop(mind, "greet"); else setAction(mind, "walk");
  return true;
}

export function cancelForestVillagerVisit(state: ForestVillagersState, id: ForestVillagerId): void {
  const mind = state.residents[id]; if (!mind.socialVisit) return;
  mind.socialVisit = null; if (mind.job) return;
  stop(mind, "idle"); mind.wait = 3;
}

/** Explicit reduced-motion shortcut after the UI allowed this introduction.
 * Ordinary simulation never uses this coordinate change. */
export function settleForestVillagerArrival(state: ForestVillagersState, otherOccupants?: readonly ResidentOccupant[]): boolean {
  if (!state.confirmed || (state.buildings.quarry ?? 0) < 1
    || !["running", "greeting"].includes(state.arrivalPhase)) return false;
  const mind = state.residents.kamneshmyg, places = forestVillagerPlaces(state.scene, "kamneshmyg");
  if (!places) return false;
  const size = FOREST_VILLAGER_PROFILES.kamneshmyg.size;
  const occupants = [...(otherOccupants ?? []).filter(other => !ids.includes(other.id as ForestVillagerId)), ...forestVillagerOccupants(state)];
  const target = places.work.find(stop => canTraverseResidents(stop.position, stop.position, size, occupants, mind.id));
  if (!target) return false;
  mind.position = { ...target.position }; mind.target = target; mind.available = true; mind.initialized = true;
  stop(mind, mind.job ? "work" : "inspect");
  state.arrivalPhase = "complete"; state.arrivalPending = false; state.arrivalCompleted = true;
  return true;
}
