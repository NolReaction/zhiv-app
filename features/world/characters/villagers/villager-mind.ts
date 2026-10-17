import type { ForestVillagerFrame, ForestVillagerId } from "@/features/world/characters/forest-villager-types";
import { canTraverse, createWorldNavigation, isWalkable } from "@/features/world/navigation/navigation";
import { canTraverseResidents, residentClearance, residentRouteIntent,
  type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { FOREST_VILLAGER_PROFILES, forestVillagerNorthernArrival, forestVillagerPlaces, forestVillagerRoute,
  villagerDistance, type VillagerPlaces } from "./villager-navigation";

import { FOREST_VILLAGER_IDS as ids, FOREST_VILLAGER_LIMITS, createWoodcutterCycle, villagerShelterWeather, type ForestVillagerMind,
  type ForestVillagersState, type ForestVillagerConfiguration, type ForestVillagerEnvironment } from "./villager-state";
import { selectVillagerRoute as select, setVillagerAction as setAction, stopVillager as stop,
  walkForestVillager as walk, yieldForestVillagerPassage } from "./villager-movement";
import { advanceWoodcutterCycle, beginWoodcutterCycle, woodcutterLoaded, WOODCUTTER_CYCLE_LIMITS } from "./woodcutter-cycle";
import { advanceVillagerDoor, approachVillagerDoor, validVillagerDoor, villagerDoorOpacity } from "./villager-doorway";
import { tryVillagerHome } from "./villager-home-routine";
import { resumeVillagerGoal } from "./villager-goal";
import { advanceVillagerHabit } from "./villager-habits";
export { FOREST_VILLAGER_LIMITS } from "./villager-state";
export { requestForestVillagerHome } from "./villager-home-routine";
export type { ForestVillagerMind, ForestVillagersState, ForestVillagerConfiguration, ForestVillagerEnvironment } from "./villager-state";

function releaseSocialIntent(mind: ForestVillagerMind) {
  mind.socialVisit = null; mind.target = null; mind.intent = "wander"; mind.afterWalk = "inspect";
  mind.goal = null; mind.habit = null; stop(mind, "idle"); mind.wait = 3;
}

/** Shared-session, presentation-only minds. No timers, networking, command
 * callbacks, inventory or offline simulation are owned by these residents. */
export function createForestVillagers(scene: FixedWorldScene): ForestVillagersState {
  const residents = Object.fromEntries(ids.map((id, index): [ForestVillagerId, ForestVillagerMind] => [id, {
    id, available: false, initialized: false, position: { x: 0, y: 0 }, direction: "front", action: "idle", age: 0, elapsed: 0,
    walked: 0, wait: 3 + index * 2, route: null, distance: 0, speed: 0, target: null, intent: "home", afterWalk: "idle",
    fatigue: .08 + index * .07, socialNeed: .2, workNeed: .4, decisions: 0, trafficWaiting: false, retryAt: 0, stalledAt: null,
    doorPhase: "outside", doorProgress: 0, door: null, doorPurpose: "rest", outdoorUntil: id === "leaftail" ? 0 : 145 + index * 30, recentStops: [],
    woodwork: id === "lopukh" ? createWoodcutterCycle() : null,
    job: false, jobKey: "", socialVisit: null, noticePending: false, greetAfter: 0,
    goal: null, failedStops: [], habit: null, habitAfter: 24 + index * 9, habitCycles: 0, checkedDelivery: 0, postWorkWalk: false,
  }])) as Record<ForestVillagerId, ForestVillagerMind>;
  return { scene, confirmed: false, buildings: {}, residents, production: null,
    arrivalPending: false, arrivalPhase: "waiting", arrivalCompleted: false, leaftailReady: null };
}

/** Artwork/camera handoff retains real feet and clocks. A social reservation
 * belongs to its old director, so it cannot survive in a second session owner. */
export function rehydrateForestVillagers(scene: FixedWorldScene, previous?: ForestVillagersState | null, now?: number): ForestVillagersState {
  if (!previous) return createForestVillagers(scene);
  const residents = Object.fromEntries(ids.map(id => {
    const mind = previous.residents[id];
    const clone: ForestVillagerMind = { ...mind, position: { ...mind.position },
      target: mind.target ? { ...mind.target, position: { ...mind.target.position }, lookAt: { ...mind.target.lookAt } } : null,
      socialVisit: null, recentStops: [...mind.recentStops],
      goal: mind.goal ? { ...mind.goal, target: { ...mind.goal.target, position: { ...mind.goal.target.position }, lookAt: { ...mind.goal.target.lookAt } } } : null,
      failedStops: mind.failedStops.map(stop => ({ ...stop })), habit: mind.habit ? { ...mind.habit } : null,
      woodwork: mind.woodwork ? { ...mind.woodwork, ...(mind.woodwork.lastDelivery
        ? { lastDelivery: { ...mind.woodwork.lastDelivery, position: { ...mind.woodwork.lastDelivery.position } } } : {}),
        ...(mind.woodwork.deliveries ? { deliveries: mind.woodwork.deliveries.map(delivery => ({ ...delivery, position: { ...delivery.position } })) } : {}) }
        : id === "lopukh" ? createWoodcutterCycle() : null };
    if (mind.socialVisit) { stop(clone, "idle"); clone.wait = 3; clone.goal = null; clone.habit = null; }
    return [id, clone];
  })) as Record<ForestVillagerId, ForestVillagerMind>;
  const state = { ...previous, residents, buildings: { ...previous.buildings },
    production: previous.production ? { ...previous.production, jobs: previous.production.jobs.map(job => ({ ...job })) } : null };
  configureForestVillagers(state, scene, { confirmed: state.confirmed, buildings: state.buildings,
    arrivalSeen: state.arrivalCompleted, now });
  // Restoring against the same immutable geometry does not enter configure's
  // changedScene branch, but still belongs to a new social director.
  for (const id of ids) {
    const mind = state.residents[id], old = previous.residents[id];
    if ((old.socialVisit || old.intent === "social") && !mind.job && mind.doorPhase === "outside"
      && (!mind.woodwork || mind.woodwork.phase === "idle")) releaseSocialIntent(mind);
  }
  return state;
}

function synchronizeJobs(state: ForestVillagersState, now: number) {
  for (const id of ids) {
    const mind = state.residents[id], profile = FOREST_VILLAGER_PROFILES[id];
    const job = id !== "leaftail" && state.production?.jobs.filter(job => job.stationId === profile.work
      && Number.isInteger(job.stationLevel) && job.stationLevel > 0 && Date.parse(job.startedAt) <= now
      && Date.parse(job.finishesAt) > now).sort((a, b) => a.id.localeCompare(b.id))[0];
    const key = job ? `${state.production?.ownerPublicId}:${job.id}` : "";
    if (key === mind.jobKey) continue;
    if (id === "kamneshmyg") mind.postWorkWalk = Boolean(mind.job && !job && state.production?.jobs.some(previous =>
      `${state.production?.ownerPublicId}:${previous.id}` === mind.jobKey && Date.parse(previous.finishesAt) <= now));
    if (mind.postWorkWalk) mind.habitAfter = mind.elapsed;
    mind.goal = null; mind.habit = null;
    mind.jobKey = key; mind.job = !!job; mind.socialVisit = null; mind.noticePending = false;
    if (!mind.available || id === "kamneshmyg" && state.arrivalPhase !== "complete") continue;
    const places = forestVillagerPlaces(state.scene, id);
    if (!places) continue;
    if (mind.doorPhase !== "outside") {
      if (id === "kamneshmyg" && job) mind.doorPurpose = "work";
      if (mind.doorPhase === "approach" && (id === "lopukh" && job || id === "kamneshmyg" && !job && mind.doorPurpose === "work")) {
        mind.doorPhase = "outside"; mind.door = null; stop(mind, "inspect"); mind.wait = .2;
      }
      // Enter/inside/exit owns its real coordinates; advanceDoor reverses a
      // cancelled crossing and leaves a finished worker outside safely.
      continue;
    }
    if (id === "lopukh" && mind.woodwork && mind.woodwork.phase !== "idle") continue;
    stop(mind, "inspect"); mind.wait = .2;
    if (job && id === "lopukh") beginWoodcutterCycle(mind, places);
    else if (job && id === "kamneshmyg") {
      if (!approachVillagerDoor(mind, places)) mind.wait = 3;
    } else if (job) select(mind, places, places.work, "work", "work");
  }
}

/** Only confirmed levels/jobs are accepted. A disconnected refresh retains the
 * last confirmed cosmetics; a new account owns a new ForestSessionState. */
export function configureForestVillagers(state: ForestVillagersState, scene: FixedWorldScene, config: ForestVillagerConfiguration): void {
  const changedScene = state.scene !== scene; state.scene = scene;
  if (config.confirmed) {
    state.confirmed = true; state.buildings = { ...config.buildings };
    if (config.leaftailReady !== undefined) state.leaftailReady = config.leaftailReady;
    if (config.production !== undefined) state.production = config.production;
  }
  const unlocked = state.confirmed && (state.buildings.quarry ?? 0) >= 1;
  state.arrivalPending = unlocked && state.arrivalPhase !== "complete";
  for (const id of ids) {
    const mind = state.residents[id];
    if (!state.confirmed || id === "kamneshmyg" && !unlocked
      || id === "leaftail" && ((state.buildings.home ?? 0) < 3 || state.leaftailReady === false)) {
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
        if (id === "leaftail" && places.door) {
          mind.position = { ...places.door.approach.position }; mind.target = places.door.approach;
          mind.door = places.door; mind.doorPhase = "approach";
        }
      }
      else if (isWalkable(places.navigation, mind.position) || validVillagerDoor(mind, places.door)) mind.available = true;
    }
    if (changedScene) {
      const previousTarget = mind.target, previousIntent = mind.intent, previousAfter = mind.afterWalk;
      mind.socialVisit = null; mind.route = null; mind.speed = 0;
      if (["enter", "inside", "exit"].includes(mind.doorPhase)) {
        // An unchanged doorway can survive a purely visual handoff. Changed
        // geometry fails closed instead of revealing someone through a wall.
        if (validVillagerDoor(mind, places.door)) { mind.door = places.door; mind.available = true; }
        else mind.available = false;
        continue;
      }
      if (mind.doorPhase === "approach") {
        mind.doorPhase = "outside"; mind.door = null;
        if (approachVillagerDoor(mind, places)) continue;
      }
      if (!isWalkable(places.navigation, mind.position)) { mind.available = false; continue; }
      if (id === "lopukh" && mind.woodwork && mind.woodwork.phase !== "idle") {
        const phase = mind.woodwork?.phase;
        if (phase === "haul" && !select(mind, places, places.woodcutting?.delivery ?? [], "home", "unload")) stop(mind, "carry");
        else if (phase === "chop" && mind.action !== "work") select(mind, places, places.work, "work", "work");
        continue;
      }
      if (mind.job && id === "kamneshmyg" && state.arrivalPhase === "complete") {
        if (!approachVillagerDoor(mind, places)) { stop(mind, "inspect"); mind.wait = 3; }
        continue;
      }
      const arriving = id === "kamneshmyg" && state.arrivalPhase === "running";
      if (previousIntent === "social" && !mind.job && !arriving) {
        // The new director did not accept the old promise. Retaining its
        // exterior stop would recreate a visit after releasing its reservation.
        releaseSocialIntent(mind); continue;
      }
      const target = mind.job || arriving ? places.work
        : previousTarget && isWalkable(places.navigation, previousTarget.position) ? [previousTarget] : [places.home];
      select(mind, places, target, mind.job ? "work" : arriving ? "work" : previousIntent,
        arriving ? "greet" : mind.job ? "work" : previousAfter);
    }
  }
  synchronizeJobs(state, Number.isFinite(config.now) ? config.now! : Date.now());
}

function decide(mind: ForestVillagerMind, places: VillagerPlaces, env: ForestVillagerEnvironment, occupants: readonly ResidentOccupant[]) {
  const profile = FOREST_VILLAGER_PROFILES[mind.id], weather = villagerShelterWeather(env);
  const rest = mind.fatigue + (weather ? .7 : 0), work = mind.workNeed * profile.diligence;
  const social = mind.socialNeed * profile.sociability;
  if (tryVillagerHome(mind, places, env, occupants)) return;
  if (rest >= Math.max(mind.id === "kamneshmyg" ? 0 : work, social, .65)) {
    select(mind, places, [places.home], "home", "rest", occupants); return;
  }
  // Only a confirmed mining job owns the cave. An idle miner explores,
  // checks stone outside, rests and meets neighbours, never mimes extraction.
  if (mind.id !== "kamneshmyg" && work >= social) {
    if (mind.id === "lopukh") beginWoodcutterCycle(mind, places, occupants);
    else select(mind, places, places.work, "work", "trade", occupants);
    return;
  }
  const rotated = [...places.wander.slice(mind.decisions % Math.max(1, places.wander.length)),
    ...places.wander.slice(0, mind.decisions % Math.max(1, places.wander.length))]
    .filter(stop => villagerDistance(stop.position, mind.position) > profile.size * .6);
  const fresh = rotated.filter(stop => !mind.recentStops.includes(stop.id));
  const ordered = [...fresh, ...rotated.filter(stop => mind.recentStops.includes(stop.id))];
  if (!select(mind, places, ordered, "wander", mind.id === "lopukh" ? "greet" : "inspect", occupants)) {
    setAction(mind, "inspect"); mind.wait = 4;
  }
}

/** Availability for optional fauna gestures; real work and doorways own their
 * own clock and cannot be interrupted by a decorative encounter. */
export function forestVillagerAvailableForLeisure(mind: ForestVillagerMind): boolean {
  return mind.available && !mind.job && mind.doorPhase === "outside" && !mind.socialVisit && !mind.noticePending
    && !woodcutterLoaded(mind) && !(mind.route && mind.intent === "yield");
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
    const weather = villagerShelterWeather(environment);
    if (!arriving) {
      if (mind.job && id === "kamneshmyg" && mind.doorPhase === "outside" && places.door && mind.wait <= 0)
        approachVillagerDoor(mind, places, occupants);
      tryVillagerHome(mind, places, environment, occupants);
      if ((weather || mind.fatigue >= .7) && mind.doorPhase === "outside" && !mind.job && !mind.socialVisit
        && (mind.goal?.intent === "wander" || mind.habit)) {
        mind.goal = null; mind.habit = null; stop(mind, "inspect"); mind.wait = 0;
      }
      if (advanceVillagerDoor(mind, places, step, occupants, weather, environment.socialHolds?.includes(id))) continue;
      const optionalHold = Boolean(environment.socialHolds?.includes(id) || environment.wildlifeHolds?.includes(id) || mind.socialVisit);
      if (yieldForestVillagerPassage(mind, places, occupants, { optionalHold,
        partnerId: environment.socialPartners?.[id] ?? mind.socialVisit?.targetId })) continue;
      if (environment.wildlifeHolds?.includes(id) && forestVillagerAvailableForLeisure(mind)) {
        // Keep the same feet and bearing for a landing bird/butterfly. No
        // economic callback or second resident clock is introduced.
        mind.route = null; mind.distance = 0; mind.speed = 0; mind.trafficWaiting = false;
        setAction(mind, "inspect"); mind.socialNeed = Math.max(0, mind.socialNeed - step * .025);
        mind.outdoorUntil = Math.max(mind.outdoorUntil, mind.elapsed + 8); mind.wait = 3; continue;
      }
    }
    if (!arriving && mind.route && environment.socialHolds?.includes(id) && !mind.job && !mind.socialVisit
      && !woodcutterLoaded(mind) && mind.doorPhase === "outside" && mind.intent !== "yield") {
      setAction(mind, "greet"); mind.socialNeed = 0; continue;
    }
    if (!arriving && advanceWoodcutterCycle(mind, scene, places, step, occupants)) continue;
    if (!arriving && !mind.job && !mind.socialVisit && !mind.noticePending && !environment.socialHolds?.includes(id)) {
      if (resumeVillagerGoal(mind, places, occupants)
        || !weather && mind.fatigue < .7 && advanceVillagerHabit(mind, places, occupants)) continue;
    }
    if (mind.route) {
      setAction(mind, woodcutterLoaded(mind) || mind.afterWalk === "carry" ? "carry" : "walk");
      walk(mind, places, step, occupants, arriving);
      if (arriving && !mind.route) { state.arrivalPhase = "greeting"; setAction(mind, "greet"); }
      continue;
    }
    if (arriving) {
      if (state.arrivalPhase === "greeting" && mind.age >= FOREST_VILLAGER_LIMITS.greeting) {
        state.arrivalPhase = "complete"; state.arrivalPending = false; state.arrivalCompleted = true;
        setAction(mind, "inspect"); mind.wait = mind.job ? 0 : 5;
      }
      continue;
    }
    if (environment.socialHolds?.includes(id) || mind.socialVisit) { setAction(mind, "greet"); mind.socialNeed = 0; continue; }
    if (mind.job) {
      mind.wait -= step;
      if (id === "kamneshmyg") {
        setAction(mind, "inspect");
        if (mind.wait <= 0 && !approachVillagerDoor(mind, places, occupants)) mind.wait = 3;
      } else if (id === "lopukh" && places.woodcutting) beginWoodcutterCycle(mind, places, occupants);
      else if (places.work.some(stop => villagerDistance(mind.position, stop.position) < .1)) setAction(mind, "work");
      else if (mind.wait <= 0) select(mind, places, places.work, "work", "work", occupants);
      continue;
    }
    if (mind.noticePending) { mind.noticePending = false; mind.habit = null; setAction(mind, "greet"); mind.wait = FOREST_VILLAGER_LIMITS.greeting; }
    if (mind.action === "rest") mind.fatigue = Math.max(0, mind.fatigue - step * .045);
    else mind.fatigue = Math.min(1, mind.fatigue + step * profile.fatigue * .003);
    mind.socialNeed = Math.min(1, mind.socialNeed + step * (id === "lopukh" ? .009 : id === "kamneshmyg" ? .0045 : .006));
    if (mind.action === "work" || mind.action === "trade") mind.workNeed = Math.max(0, mind.workNeed - step * .045);
    else mind.workNeed = Math.min(1, mind.workNeed + step * .012);
    mind.wait -= step;
    if (mind.wait > 0) continue;
    decide(mind, places, environment, occupants);
  }
}

/** Every consumer receives detached values; portraits cannot advance or move feet. */
export function forestVillagerFrames(state: ForestVillagersState, still = false): ForestVillagerFrame[] {
  return ids.flatMap(id => {
    const mind = state.residents[id], opacity = villagerDoorOpacity(mind);
    if (!mind.available || opacity <= 0) return [];
    const walking = !!mind.route || mind.doorPhase === "enter" || mind.doorPhase === "exit";
    const action = mind.trafficWaiting && walking && !woodcutterLoaded(mind) ? "idle" : mind.action;
    return [{ id, ...mind.position, size: FOREST_VILLAGER_PROFILES[id].size, direction: mind.direction, action,
      frame: still || action === "unload" ? 0 : Math.floor((walking ? mind.walked / (FOREST_VILLAGER_PROFILES[id].size / 48) : mind.age * 5) % 32),
      phase: still ? 0 : action === "unload" ? Math.min(1, (mind.woodwork?.phase === "unload" ? mind.woodwork.elapsed : 0)
        / WOODCUTTER_CYCLE_LIMITS.unload) : mind.age % 3 / 3, opacity, arriving: id === "kamneshmyg" && state.arrivalPhase !== "complete" }];
  });
}

export function forestVillagerOccupants(state: ForestVillagersState): ResidentOccupant[] {
  return forestVillagerFrames(state, true).map(frame => {
    const mind = state.residents[frame.id], moving = !!mind.route || mind.doorPhase === "enter" || mind.doorPhase === "exit";
    return { id: frame.id, position: { ...mind.position }, size: frame.size, moving,
      intent: mind.route ? residentRouteIntent(mind.route!, mind.position, mind.distance, frame.size,
        mind.intent === "yield" ? 0 : mind.job || mind.socialVisit || frame.arriving ? 2 : 1) : undefined };
  });
}

/** A tap keeps the current purpose and work intact; an explicit home call may
 * still wake the resident through the usual checked doorway. */
export function noticeForestVillager(state: ForestVillagersState, id: ForestVillagerId,
  options: { preserveActivity?: boolean } = {}): void {
  const mind = state.residents[id];
  if (options.preserveActivity && (mind.route || mind.goal || mind.habit || mind.socialVisit || mind.doorPhase !== "outside"
    || mind.woodwork && mind.woodwork.phase !== "idle" || !["idle", "rest", "inspect"].includes(mind.action)
    || mind.elapsed < mind.greetAfter)) return;
  if (mind.available && !mind.job && !(id === "kamneshmyg" && state.arrivalPhase !== "complete")) {
    mind.noticePending = true;
    if (options.preserveActivity) mind.greetAfter = mind.elapsed + 15;
  }
}

export function requestForestVillagerVisit(state: ForestVillagersState, scene: FixedWorldScene, id: ForestVillagerId,
  target: { id: string; position: WorldPoint; size: number; approach?: WorldPoint }, occupants?: readonly ResidentOccupant[]): boolean {
  const mind = state.residents[id], places = forestVillagerPlaces(scene, id), profile = FOREST_VILLAGER_PROFILES[id];
  if (!mind.available || state.scene !== scene || !places || mind.job || woodcutterLoaded(mind) || mind.socialVisit || mind.doorPhase !== "outside" || id === "kamneshmyg" && state.arrivalPhase !== "complete"
    || !Number.isFinite(target.position.x) || !Number.isFinite(target.position.y) || !Number.isFinite(target.size) || target.size <= 0) return false;
  const gap = residentClearance(profile.size, target.size) + 8;
  const conversationNavigation = createWorldNavigation(scene, Math.min(profile.size, target.size) * .1);
  if (!conversationNavigation) return false;
  const heading = Math.atan2(mind.position.y - target.position.y, mind.position.x - target.position.x);
  const candidates = (target.approach ? [{ id: `${id}:social:${target.id}`, position: { ...target.approach }, lookAt: { ...target.position } }]
    : [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI].map(offset => ({
    id: `${id}:social:${target.id}`, position: { x: target.position.x + Math.cos(heading + offset) * gap,
      y: target.position.y + Math.sin(heading + offset) * gap }, lookAt: { ...target.position },
  }))).filter(stop => isWalkable(places.navigation, stop.position)
    && canTraverse(conversationNavigation, stop.position, target.approach ?? target.position)
    && canTraverseResidents(stop.position, stop.position, profile.size, occupants, id));
  const route = forestVillagerRoute(places, mind.position, candidates, profile.size);
  if (!route || route.route.length > profile.speed * FOREST_VILLAGER_LIMITS.visitSeconds) return false;
  if (mind.woodwork) mind.woodwork.phase = "idle";
  mind.goal = null; mind.habit = null;
  mind.socialVisit = { targetId: target.id, anchor: { ...target.position } }; mind.target = route.target;
  mind.outdoorUntil = Math.max(mind.outdoorUntil, mind.elapsed + FOREST_VILLAGER_LIMITS.visitSeconds);
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
  stop(mind, "inspect"); mind.wait = mind.job ? 0 : 5;
  state.arrivalPhase = "complete"; state.arrivalPending = false; state.arrivalCompleted = true;
  return true;
}
