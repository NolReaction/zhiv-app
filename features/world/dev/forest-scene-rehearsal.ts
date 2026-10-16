import type { SceneOptions } from "@/features/mochlik/scene";
import type { ForestSessionState } from "@/features/world/state/forest-session";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import { createWorldNavigation, isWalkable } from "@/features/world/navigation/navigation";
import { canTraverseResidents, residentClearance, type ResidentOccupant } from "@/features/world/navigation/resident-traffic";
import { requestClearingPoint, isClearingAtPoint, clearingActivityFrame } from "@/features/world/simulation/clearing-activity";
import { requestForestDirective, type ForestDirectorOptions } from "@/features/world/simulation/forest-director";
import { requestBuilderVisit } from "@/features/world/characters/builder/builder-mind";
import { builderLocalPlaces } from "@/features/world/characters/builder/builder-navigation";
import { noticePleskMind, requestPleskHome, requestPleskWalk } from "@/features/world/characters/plesk/plesk-mind";
import { pleskLocalPlaces } from "@/features/world/characters/plesk/plesk-resident";
import { noticeForestVillager } from "@/features/world/characters/villagers/villager-mind";
import { forestVillagerPlaces } from "@/features/world/characters/villagers/villager-navigation";
import { selectVillagerRoute, stopVillager } from "@/features/world/characters/villagers/villager-movement";
import { beginWoodcutterCycle } from "@/features/world/characters/villagers/woodcutter-cycle";
import { canRequestFaunaInteraction, residentFaunaEncounter } from "@/features/world/environment/wildlife/forest-fauna";
import { chooseForestBirdwatchTarget } from "@/features/world/activities/forest-birdwatching";
import type { ForestBird } from "@/features/world/environment/wildlife/forest-wildlife";
import { requestForestSocialVisit, type ForestSocialEnvironment } from "@/features/world/characters/social/forest-social";
import { WORLD_DEV_SCENES, createForestScenePreview, advanceForestScenePreview, forestScenePreviewFeedback,
  normalizeWorldDevSceneRequest, setForestScenePreviewStatus, type ForestScenePreview, type WorldDevSceneActor,
  type WorldDevSceneFeedback, type WorldDevSceneRequest } from "./forest-scene-preview";

export type ForestSceneRehearsalEnvironment = {
  social: ForestSocialEnvironment; occupants: readonly ResidentOccupant[]; birds: readonly ForestBird[]; now: number;
  director?: ForestDirectorOptions; paused?: boolean; reducedMotion?: boolean;
};
export type ForestSceneRehearsal = {
  preview: ForestScenePreview; accepted: boolean; wakeRequested: boolean;
  stage: "prepare" | "moving" | "activity" | "social" | "animal";
  target?: WorldPoint; socialAt?: number; animalToken?: number; birdId?: string; sawAction: boolean;
  actionAt?: number; initialCycles: number;
};
type Holder = ForestSessionState & { devSceneRehearsal?: ForestSceneRehearsal };
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const terminal = (runtime: ForestSceneRehearsal) => ["complete", "blocked", "stopped"].includes(runtime.preview.phase);
const villager = (actor: WorldDevSceneActor): actor is "lopukh" | "kamneshmyg" | "leaftail" => ["lopukh", "kamneshmyg", "leaftail"].includes(actor);
const optionTimes = new WeakMap<WorldDevSceneRequest, number>();

/** A separate DEV presence owns synthetic presentation DTOs. No callback,
 * inventory, command transport or real player's worker enters this session. */
export function rehearsalSceneOptions(original: SceneOptions, request: WorldDevSceneRequest): SceneOptions {
  const normalized = normalizeWorldDevSceneRequest(request);
  if (!normalized) return original;
  let now = optionTimes.get(request);
  if (now === undefined) {
    now = Number.isFinite(original.serverNow) ? original.serverNow! : Date.now(); optionTimes.set(request, now);
  }
  const ownerPublicId = `dev-scene-${request.id}`, revision = request.id;
  const buildings = { ...original.economyBuildings, quarry: 1, workshop: Math.max(1, original.economyBuildings?.workshop ?? 0) };
  const jobs = request.scenario === "work" && (request.actor === "kamneshmyg" || request.actor === "lopukh")
    ? [{ id: `dev-work-${request.id}`, stationId: request.actor === "kamneshmyg" ? "quarry" : "woodlot", stationLevel: 1,
      recipeId: request.actor === "kamneshmyg" ? "quarry_stone" : "woodlot_wood",
      startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 120_000).toISOString() }] : [];
  const production = { ownerPublicId, revision, jobs };
  return { ...original, serverNow: now, presenceKey: `dev:scene:${request.id}`, view: "world", devRehearsal: normalized,
    economyBuildings: buildings, economyProduction: production, economyResidents: { ownerPublicId, revision, buildings, production },
    economyConstruction: { ownerPublicId, revision, jobs: request.scenario === "work" && request.actor === "builder"
      ? [{ id: `dev-build-${request.id}`, stationId: "workshop", targetLevel: 2,
        startedAt: new Date(now).toISOString(), finishesAt: new Date(now + 120_000).toISOString() }] : [] },
    economyJourney: null, cancelledExplorations: [], economyGarden: null, gardenHarvestRequest: null, onGardenHarvestEvent: undefined,
    residentArrival: { seen: true, enabled: false, onComplete() {} } };
}

function directorOptions(environment: ForestSceneRehearsalEnvironment): ForestDirectorOptions {
  return environment.director ?? { autoLife: false, blocked: false, rain: environment.social.rain ?? 0,
    dusk: environment.social.dusk ?? 0, homeAvailable: true, birds: environment.birds, occupants: environment.occupants };
}
function finish(runtime: ForestSceneRehearsal, message: string) { setForestScenePreviewStatus(runtime.preview, "complete", message); }
function block(runtime: ForestSceneRehearsal, message: string) { setForestScenePreviewStatus(runtime.preview, "blocked", message); }
function running(runtime: ForestSceneRehearsal, message: string) { setForestScenePreviewStatus(runtime.preview, "running", message); }

function prepareActor(state: ForestSessionState, runtime: ForestSceneRehearsal): boolean {
  const actor = runtime.preview.request.actor;
  if (villager(actor)) {
    const mind = state.villagers?.residents[actor];
    if (!mind?.available) return false;
    if (mind.doorPhase !== "outside") {
      if (!runtime.wakeRequested) { noticeForestVillager(state.villagers!, actor); runtime.wakeRequested = true; }
      running(runtime, "Житель выходит из дома к началу репетиции."); return false;
    }
    if (mind.job && runtime.preview.request.scenario !== "work") return false;
    if (["butterfly", "watch-birds"].includes(runtime.preview.request.scenario)
      && (mind.route || mind.woodwork && !["idle", "rest"].includes(mind.woodwork.phase))) return false;
    return true;
  }
  if (actor === "plesk") {
    if (!state.pleskMind?.available) return false;
    if (state.pleskMind.home.phase !== "outside") {
      if (!runtime.wakeRequested) { noticePleskMind(state.pleskMind); runtime.wakeRequested = true; }
      running(runtime, "Плёска заканчивает домашние дела и выходит."); return false;
    }
    return true;
  }
  if (actor === "builder") return Boolean(state.builderMind?.available && state.builderMind.sleepPhase === "awake");
  return (clearingActivityFrame(state.clearing).opacity ?? 1) > .95;
}

function beginWalk(state: ForestSessionState, scene: FixedWorldScene, runtime: ForestSceneRehearsal,
  environment: ForestSceneRehearsalEnvironment): boolean {
  const actor = runtime.preview.request.actor;
  if (villager(actor)) {
    const mind = state.villagers!.residents[actor], places = forestVillagerPlaces(scene, actor);
    if (!places) return false;
    const stops = places.wander.filter(stop => distance(mind.position, stop.position) > 20)
      .sort((a, b) => distance(a.position, mind.position) - distance(b.position, mind.position));
    if (!selectVillagerRoute(mind, places, stops, "wander", "inspect", environment.occupants)) return false;
    mind.outdoorUntil = mind.elapsed + 90; runtime.target = { ...mind.target!.position };
  } else if (actor === "builder") {
    const mind = state.builderMind!, places = builderLocalPlaces(scene);
    const stop = places?.wander.filter(stop => distance(stop.position, mind.position) > 30)
      .sort((a, b) => distance(a.position, mind.position) - distance(b.position, mind.position))
      .find(stop => requestBuilderVisit(mind, scene, { id: "dev-walk", position: stop.position, size: 1 }, environment.occupants));
    if (!stop || !mind.target) return false;
    runtime.target = { ...mind.target.position };
  } else if (actor === "plesk") {
    const mind = state.pleskMind!, places = pleskLocalPlaces(scene);
    const candidates = [places?.trade, places?.rest, places?.base].filter(stop => stop && distance(stop.position, mind.position) > 15);
    const stop = candidates.find(stop => requestPleskWalk(mind, scene, stop!));
    if (!stop) return false;
    runtime.target = { ...stop.position };
  } else {
    const stops = (scene.navigation?.interests ?? []).filter(stop => distance(stop.position, state.clearing.position) > 20)
      .sort((a, b) => distance(a.position, state.clearing.position) - distance(b.position, state.clearing.position));
    const stop = stops.find(stop => requestClearingPoint(state.clearing, stop.position));
    if (!stop) return false;
    runtime.target = { ...stop.position };
  }
  runtime.accepted = true; runtime.stage = "moving"; running(runtime, "Идёт по настоящему проходимому пути."); return true;
}

function heroApproach(state: ForestSessionState, scene: FixedWorldScene, host: ForestSocialEnvironment["actors"][number],
  occupants: readonly ResidentOccupant[]): WorldPoint | undefined {
  const navigation = state.clearing.navigation ?? createWorldNavigation(scene);
  if (!navigation) return;
  const anchor = host.approach ?? host.position, gap = residentClearance(state.clearing.size, host.size) + 9;
  const heading = Math.atan2(state.clearing.position.y - anchor.y, state.clearing.position.x - anchor.x);
  const candidates = host.approach ? [host.approach] : [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2, -Math.PI / 2, Math.PI]
    .map(angle => ({ x: anchor.x + Math.cos(heading + angle) * gap, y: anchor.y + Math.sin(heading + angle) * gap }));
  return candidates.find(point => isWalkable(navigation, point)
    && canTraverseResidents(point, point, state.clearing.size, occupants, "mochlik") && requestClearingPoint(state.clearing, point));
}

function beginConversation(state: ForestSessionState, scene: FixedWorldScene, runtime: ForestSceneRehearsal,
  environment: ForestSceneRehearsalEnvironment): boolean {
  const request = runtime.preview.request, target = request.target!;
  const host = environment.social.actors.find(actor => actor.id === target);
  if (!host || request.scenario === "trade-visit" && !host.window) return false;
  if (request.actor === "mochlik" && !runtime.target) {
    const approach = heroApproach(state, scene, host, environment.occupants);
    if (!approach) return false;
    runtime.target = { ...approach }; runtime.stage = "moving"; running(runtime, "Мохлик идёт к выбранному собеседнику.");
  }
  if (request.actor === "mochlik" && runtime.target && !isClearingAtPoint(state.clearing, runtime.target)) return false;
  if (!requestForestSocialVisit(state.social, request.actor, target, environment.social)) return false;
  runtime.accepted = true; runtime.stage = "social"; runtime.socialAt = state.social.elapsed;
  running(runtime, request.scenario === "trade-visit" ? "Идёт к окну Листохвоста, затем начнёт разговор." : "Жители подходят друг к другу и разговаривают."); return true;
}

function beginAnimal(state: ForestSessionState, runtime: ForestSceneRehearsal, environment: ForestSceneRehearsalEnvironment): boolean {
  const request = runtime.preview.request;
  runtime.stage = "animal";
  if (request.actor === "mochlik") {
    const options = directorOptions(environment), actor = { ...state.clearing.position, size: state.clearing.size };
    const available = request.scenario === "watch-birds" ? chooseForestBirdwatchTarget(environment.birds, actor)
      : canRequestFaunaInteraction(state.fauna, "butterfly", actor, options, true);
    if (!available) { running(runtime, request.scenario === "butterfly" ? "Ждёт доступную бабочку рядом." : "Ждёт, пока птица рядом сядет."); return false; }
    const directive = request.scenario === "butterfly" ? "butterfly" : "watch-birds";
    requestForestDirective(state, directive, options);
    if (state.pendingLife !== directive) return false;
  } else {
    if (villager(request.actor)) {
      const mind = state.villagers!.residents[request.actor];
      stopVillager(mind, "inspect"); mind.wait = 90; mind.outdoorUntil = mind.elapsed + 90;
    } else if (state.pleskMind) {
      if (!["idle", "rest", "greet"].includes(state.pleskMind.stage.action)) return false;
      state.pleskMind.stage.duration = Math.max(state.pleskMind.stage.duration, state.pleskMind.age + 90);
    }
    if (request.scenario === "butterfly") state.fauna.nextVisitorAt = state.fauna.elapsed;
    else if (state.villagerWildlife) state.villagerWildlife.nextBirdAt = state.villagerWildlife.elapsed;
  }
  runtime.accepted = true; runtime.stage = "animal";
  running(runtime, request.scenario === "butterfly" ? "Ждёт доступную бабочку рядом, затем протянет лапу." : "Ищет сидящую рядом птицу для наблюдения."); return true;
}

function tryStart(state: ForestSessionState, scene: FixedWorldScene, runtime: ForestSceneRehearsal, environment: ForestSceneRehearsalEnvironment) {
  const request = runtime.preview.request;
  if (runtime.accepted || terminal(runtime)) return;
  if (request.scenario === "plesk-home" && state.pleskMind?.home.phase === "inside") {
    finish(runtime, "Плёска дома; вход и скрытие жительницы проверены."); return;
  }
  if (request.scenario === "work") {
    const ready = request.actor === "builder" ? Boolean(state.builderMind?.job) : Boolean(state.villagers?.residents[request.actor as "lopukh" | "kamneshmyg"].job);
    if (ready) { runtime.accepted = true; runtime.stage = "activity"; running(runtime, "Идёт к рабочему месту тестового поручения."); }
    return;
  }
  if (!prepareActor(state, runtime)) return;
  if (request.scenario === "walk") {
    if (!beginWalk(state, scene, runtime, environment)) block(runtime, "Не найден свободный путь для прогулки этого жителя.");
  } else if (request.scenario === "carry") {
    const mind = state.villagers!.residents.lopukh, places = forestVillagerPlaces(scene, "lopukh");
    if (!places?.woodcutting || !beginWoodcutterCycle(mind, places, environment.occupants, { chopSeconds: 0 })) {
      block(runtime, "У Лопоуха нет доступного дерева или места для разгрузки перед домом."); return;
    }
    runtime.initialCycles = mind.woodwork?.completedCycles ?? 0; runtime.accepted = true; runtime.stage = "activity";
    running(runtime, "Лопоух идёт за бревном и отнесёт его к дому.");
  } else if (request.scenario === "conversation" || request.scenario === "trade-visit") beginConversation(state, scene, runtime, environment);
  else if (request.scenario === "plesk-home") {
    if (requestPleskHome(state.pleskMind)) { runtime.accepted = true; runtime.stage = "activity"; running(runtime, "Плёска идёт к дому и проходит через настоящий порог."); }
  } else beginAnimal(state, runtime, environment);
}

export function syncForestSceneRehearsal(state: ForestSessionState, scene: FixedWorldScene, request: WorldDevSceneRequest,
  environment: ForestSceneRehearsalEnvironment): WorldDevSceneFeedback | null {
  const holder = state as Holder;
  if (holder.devSceneRehearsal?.preview.request.id !== request.id) {
    const preview = createForestScenePreview(request);
    if (!preview) return null;
    holder.devSceneRehearsal = { preview, accepted: false, wakeRequested: false, stage: "prepare", sawAction: false, initialCycles: 0 };
    state.director.nextDecisionAt = state.director.elapsed + 3600; state.clearing.waitSeconds = 3600;
    state.social.nextEncounterAt = state.social.elapsed + 3600; state.social.nextPassingAt = state.social.elapsed + 3600;
    // The selected actor waits for the explicit request, instead of starting
    // an unrelated autonomous job while a window or neighbour becomes ready.
    if (request.scenario !== "work") {
      if (villager(request.actor)) {
        const mind = state.villagers?.residents[request.actor];
        if (mind && !mind.job) { mind.wait = 90; mind.outdoorUntil = mind.elapsed + 90; }
      } else if (request.actor === "builder" && state.builderMind && !state.builderMind.job) state.builderMind.wait = 90;
      else if (request.actor === "plesk" && state.pleskMind && ["idle", "rest", "greet"].includes(state.pleskMind.stage.action))
        state.pleskMind.stage.duration = Math.max(state.pleskMind.stage.duration, state.pleskMind.age + 90);
    }
    if (state.villagerWildlife && request.scenario !== "watch-birds") state.villagerWildlife.nextBirdAt = state.villagerWildlife.elapsed + 3600;
  }
  const runtime = holder.devSceneRehearsal!;
  if (!environment.paused && !environment.reducedMotion) tryStart(state, scene, runtime, environment);
  return forestScenePreviewFeedback(runtime.preview);
}

function inspectProgress(state: ForestSessionState, runtime: ForestSceneRehearsal) {
  const request = runtime.preview.request;
  if (!runtime.accepted) return;
  if (request.scenario === "walk" && runtime.target) {
    const position = request.actor === "mochlik" ? state.clearing.position : request.actor === "builder" ? state.builderMind?.position
      : request.actor === "plesk" ? state.pleskMind?.position : state.villagers?.residents[request.actor].position;
    if (position && distance(position, runtime.target) <= 1) finish(runtime, "Прогулка завершена: житель дошёл до выбранного места.");
  } else if (request.scenario === "carry") {
    const cycle = state.villagers?.residents.lopukh.woodwork;
    if (cycle && cycle.completedCycles > runtime.initialCycles) finish(runtime, "Лопоух принёс бревно, разгрузил его перед домом и отдохнул.");
  } else if (request.scenario === "plesk-home") {
    if (state.pleskMind?.home.phase === "inside") finish(runtime, "Плёска дома; путь, порог и скрытие жительницы проверены.");
  } else if (request.scenario === "conversation" || request.scenario === "trade-visit") {
    const result = state.social.lastMeetingResult;
    if (result && result.guest === request.actor && result.host === request.target && result.at >= runtime.socialAt!) {
      if (result.status === "completed") finish(runtime, "Разговор завершён: все реплики прозвучали, жители свободны.");
      else block(runtime, "Встреча прервана: изменились занятие, путь или доступность собеседника.");
    }
  } else if (request.scenario === "work") {
    const working = request.actor === "builder" ? state.builderMind?.action === "work"
      : request.actor === "kamneshmyg" ? state.villagers?.residents.kamneshmyg.doorPhase === "inside"
        : state.villagers?.residents.lopukh.action === "work";
    if (working) {
      runtime.actionAt ??= runtime.preview.elapsed;
      if (runtime.preview.elapsed - runtime.actionAt >= 2) finish(runtime, request.actor === "kamneshmyg"
        ? "Камнешмыг дошёл до пещеры и работает внутри. Ресурсы не выдаются." : "Рабочий дошёл до места и показал занятие. Ресурсы не выдаются.");
    }
  } else if (request.scenario === "butterfly") {
    const encounter = request.actor === "mochlik" ? state.fauna.encounter : residentFaunaEncounter(state.fauna, request.actor);
    if (encounter?.kind === "butterfly") {
      runtime.animalToken ??= encounter.token;
      if (encounter.token === runtime.animalToken && encounter.phase === "perch") runtime.sawAction = true;
      if (encounter.phase === "interrupt") block(runtime, "Бабочка улетела до завершения встречи.");
    } else if (runtime.animalToken !== undefined) {
      if (runtime.sawAction) finish(runtime, "Настоящая бабочка села на лапу и вернулась в лес.");
      else block(runtime, "Бабочка не смогла закончить подход к жителю.");
    } else if (request.actor === "mochlik" && state.pendingLife !== "butterfly") runtime.accepted = false;
  } else if (request.scenario === "watch-birds") {
    const watch = request.actor === "mochlik" ? state.director.birdwatch : state.villagerWildlife?.birdwatch?.visitorId === request.actor
      ? state.villagerWildlife.birdwatch.watch : null;
    if (watch) { runtime.birdId ??= watch.birdId; runtime.sawAction ||= watch.elapsed >= .65; }
    else if (runtime.birdId) {
      if (runtime.sawAction) finish(runtime, "Житель закончил наблюдение за настоящей птицей.");
      else block(runtime, "Птица улетела до начала спокойного наблюдения.");
    } else if (request.actor === "mochlik" && state.pendingLife !== "watch-birds") runtime.accepted = false;
  }
}

/** Called after the normal AI/traffic/fauna tick. It issues finite requests and
 * observes their real completion; it never advances an actor itself. */
export function advanceForestSceneRehearsal(state: ForestSessionState, scene: FixedWorldScene, delta: number,
  environment: ForestSceneRehearsalEnvironment): WorldDevSceneFeedback | null {
  const runtime = (state as Holder).devSceneRehearsal;
  if (!runtime) return null;
  if (terminal(runtime) || environment.paused || environment.reducedMotion || !Number.isFinite(delta) || delta <= 0)
    return forestScenePreviewFeedback(runtime.preview);
  inspectProgress(state, runtime);
  if (!terminal(runtime)) {
    const limit = WORLD_DEV_SCENES.find(scene => scene.id === runtime.preview.request.scenario)!.seconds;
    if (runtime.preview.elapsed + Math.min(.5, delta) >= limit) block(runtime, "Репетиция не закончилась вовремя. Проверьте путь, занятие и доступность жителя.");
    else advanceForestScenePreview(runtime.preview, delta);
    if (!runtime.accepted && !(runtime.stage === "moving" && runtime.target) && runtime.preview.elapsed >= 12)
      block(runtime, "Житель или нужное место сейчас недоступны для этой репетиции.");
    else if (runtime.stage === "animal" && !runtime.animalToken && !runtime.birdId && runtime.preview.elapsed >= 10)
      block(runtime, runtime.preview.request.scenario === "butterfly" ? "Рядом нет доступной бабочки. Выберите другого жителя или дождитесь её подлёта."
        : "Рядом нет сидящей птицы. Дождитесь посадки или выберите другого жителя.");
  }
  if (!terminal(runtime)) tryStart(state, scene, runtime, environment);
  return forestScenePreviewFeedback(runtime.preview);
}
