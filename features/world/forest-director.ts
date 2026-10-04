import type { ForestSessionState } from "./forest-session";
import type { GardenHarvestRequest } from "./economy-garden-state";
import type { WorldPoint } from "./tiled/types";
import type { ForestLifeAction } from "./forest-life";
import { advanceForestCampfires, campfireReady, type CampfireVisit } from "./forest-campfire";
import type { ForestBird } from "./forest-wildlife";
import { advanceForestBirdwatch, chooseForestBirdwatchTarget, createForestBirdwatch, type ForestBirdwatch } from "./forest-birdwatching";
import { advanceForestLife, cancelForestLife, interruptForestLife, triggerForestLife } from "./forest-life";
import { advanceClearingActivity, canStartClearingInteraction, canStartClearingLife, canVisitClearingBush, clearingActivityFrame,
  isClearingAtHome, isClearingAtPoint, noticeClearingActivity, releaseClearingPoint,
  requestClearingBush, requestClearingPoint, requestClearingSleep, requestClearingOutside, returnClearingHome,
  setClearingNavigationObstacle, baseClearingNavigation } from "./clearing-activity";
import { advanceForestFauna, cancelFaunaInteraction, canRequestFaunaInteraction, emitFaunaStimulus,
  interruptFaunaInteraction, requestFaunaInteraction } from "./forest-fauna";
import { findWorldPath } from "./navigation";
import { advanceForestGarden, cancelForestGarden, gardenActionAvailable, gardenEligibleBushes,
  gardenRoutineStationary, gardenRoutineTarget, gardenWorkReachable, gardenBasketApproach, gardenBasketFootprint,
  growForestBerries, parkForestGardenBasket, FOREST_GARDEN_LIMITS,
  type ForestGardenAction, type ForestGardenPhase } from "./forest-garden";
import { advanceForestMind, beginForestIntention, finishForestIntention, noticeForestMind, recordForestCandidates,
  scoreForestAction, type ForestMindAction, type ForestMindCandidate } from "./forest-mind";

export type ForestDirective = ForestLifeAction | ForestGardenAction | "grow-berries" | "bush" | "home-sleep" | "wake" | "watch-birds" | "campfire";
export type ForestDirectorOptions = {
  autoLife: boolean; blocked: boolean; dusk: number; rain: number; homeAvailable: boolean; actorAway?: boolean;
  /** Server-confirmed departure owns only the existing clearing walk, not life decisions. */
  explicitTravel?: boolean;
  butterflies?: "auto" | "on" | "off"; fireflies?: "auto" | "on" | "off";
  heroScale?: number; reducedMotion?: boolean; navigationMode?: "auto" | "routes";
  /** Actual birds from the shared scene clock, never fabricated by the actor. */
  birds?: readonly ForestBird[];
};
export type ForestDirectorState = {
  elapsed: number; nextDecisionAt: number; seed: number; reason: string;
  pendingSince: number; waitingForExit: boolean; objectId: string | null; target: WorldPoint | null; explicit: boolean;
  activeKey: string | null; recent: { key: string; at: number }[];
  birdwatch: ForestBirdwatch | null;
  campfireVisit: CampfireVisit | null;
  lastFootstep: WorldPoint | null; lastFootstepAt: number; lastBurst: string | null;
  stimulus: { id: number; kind: "movement" | "rustle"; x: number; y: number; strength: number } | null;
};
export function createForestDirector(seed = 8128): ForestDirectorState {
  return { elapsed: 0, nextDecisionAt: 4, seed, reason: "Осматривает полянку", pendingSince: 0, waitingForExit: false,
    objectId: null, target: null, explicit: false, activeKey: null, recent: [], birdwatch: null, campfireVisit: null,
    lastFootstep: null, lastFootstepAt: 0, lastBurst: null, stimulus: null };
}
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);
function random(state: ForestDirectorState) {
  state.seed = (Math.imul(state.seed, 1664525) + 1013904223) >>> 0;
  return state.seed / 0x100000000;
}
function actor(state: ForestSessionState, options: ForestDirectorOptions) {
  const frame = clearingActivityFrame(state.clearing);
  return { x: frame.x, y: frame.y, size: state.clearing.size * (options.heroScale ?? 1), direction: frame.direction };
}
function clearRequest(state: ForestSessionState) {
  state.pendingLife = null; state.director.waitingForExit = false; state.director.objectId = null; state.director.target = null; state.director.explicit = false;
}
function syncGardenObstacle(state: ForestSessionState) {
  setClearingNavigationObstacle(state.clearing, gardenBasketFootprint(state.life.garden));
}
function cancelGarden(state: ForestSessionState) {
  cancelForestGarden(state.life.garden, state.clearing.position, baseClearingNavigation(state.clearing));
  syncGardenObstacle(state);
}
function finishAction(state: ForestSessionState) {
  const director = state.director;
  if (!director.activeKey || director.birdwatch || director.campfireVisit || state.life.routine || state.life.garden.routine || state.fauna.encounter) return;
  if (!state.pendingLife && !state.pendingAttention && state.clearing.behavior.mind.intention?.source === "director"
    && state.clearing.behavior.mind.intention.action === director.activeKey.split(":")[0])
    finishForestIntention(state.clearing.behavior.mind, "completed", "Встреча закончилась — можно выбрать новое занятие");
  director.recent.push({ key: director.activeKey, at: director.elapsed });
  director.recent = director.recent.filter(item => director.elapsed - item.at < 90).slice(-8);
  director.activeKey = null; director.nextDecisionAt = director.elapsed + 7 + random(director) * 6;
  releaseClearingPoint(state.clearing);
}

/** A DEV pose is a deliberate interruption, never a second owner of a seated insect. */
export function cancelForestDirector(state: ForestSessionState, reason = "Занятие остановлено в DEV") {
  finishForestIntention(state.clearing.behavior.mind, "interrupted", reason);
  state.director.birdwatch = null; state.director.campfireVisit = null;
  cancelForestLife(state.life); cancelFaunaInteraction(state.fauna);
  cancelGarden(state);
  clearRequest(state); state.pendingAttention = false; state.director.activeKey = null;
  state.director.nextDecisionAt = state.director.elapsed + 10;
  releaseClearingPoint(state.clearing);
}
export function noticeForestDirector(state: ForestSessionState, still = false) {
  noticeForestMind(state.clearing.behavior.mind, { rested: state.clearing.stage === "home-sleep" && state.clearing.stageElapsed >= 5 });
  state.director.birdwatch = null; state.director.campfireVisit = null;
  clearRequest(state); state.director.nextDecisionAt = state.director.elapsed + 12;
  if (still) {
    cancelForestDirector(state); noticeClearingActivity(state.clearing, { still: true, mindNoticed: true }); return;
  }
  if (state.pendingAttention) return;
  cancelGarden(state);
  const prop = interruptForestLife(state.life), insect = interruptFaunaInteraction(state.fauna);
  state.pendingAttention = prop || insect;
  if (!state.pendingAttention) {
    releaseClearingPoint(state.clearing); noticeClearingActivity(state.clearing, { mindNoticed: true });
  }
}

/** Requests use the same physical participants and paths as autonomous actions. */
export function requestForestDirective(state: ForestSessionState, kind: ForestDirective, options: ForestDirectorOptions) {
  if (kind === "wake") { noticeForestDirector(state, options.reducedMotion); return; }
  if (kind === "idle" || kind === "grow-mushrooms" || kind === "grow-berries") {
    cancelForestDirector(state);
    if (kind === "idle" && !state.life.garden.basket?.held) returnClearingHome(state.clearing);
    if (kind === "grow-berries") growForestBerries(state.life.garden);
    else triggerForestLife(state.life, kind); return;
  }
  if (options.reducedMotion) { state.director.reason = "Перелёты и прогулки при уменьшенном движении остановлены"; return; }
  finishForestIntention(state.clearing.behavior.mind, "interrupted", "Выбрано занятие через DEV");
  beginForestIntention(state.clearing.behavior.mind, kind === "watch-birds" ? "look" : kind === "campfire" ? "rest" : kind, kind, "Занятие выбрано через DEV", "director");
  if (state.director.birdwatch || state.director.campfireVisit) {
    state.director.birdwatch = null; state.director.campfireVisit = null; state.director.activeKey = null; releaseClearingPoint(state.clearing);
  }
  interruptForestLife(state.life); interruptFaunaInteraction(state.fauna);
  if (state.life.garden.routine) state.director.activeKey = null;
  cancelGarden(state);
  state.pendingAttention = false; state.pendingLife = kind;
  Object.assign(state.director, { pendingSince: state.director.elapsed, waitingForExit: false, objectId: null, target: null, explicit: true,
    reason: "Завершает текущее действие перед новой встречей" });
}

/** Starts a cosmetic delivery for one already-authorized economic collection.
 * Only the caller can claim the server job after the eventual completion event. */
export function requestForestGardenHarvest(state: ForestSessionState, request: GardenHarvestRequest,
  options: ForestDirectorOptions) {
  const garden = state.life.garden;
  const unavailable = (reason: string) => {
    garden.harvestEvent = { ...request, status: "unavailable", reason };
    garden.harvest = null;
  };
  if (!Number.isSafeInteger(request.requestId) || request.requestId <= 0 || !request.jobId) return;
  if (!garden.production || garden.production.jobId !== request.jobId || !garden.bushes.some(bush => bush.growth >= .98)) {
    unavailable("Этот урожай пока недоступен для сбора"); return;
  }
  if (options.reducedMotion || options.actorAway || !state.clearing.navigationEnabled || options.navigationMode === "routes") {
    unavailable(options.reducedMotion ? "Сбор продолжается без анимации" : "Мохлик сейчас не может подойти к кусту"); return;
  }
  requestForestDirective(state, "harvest-berries", options);
  garden.harvest = { request: { ...request }, phase: "pending" };
  garden.harvestEvent = { ...request, status: "started" };
  state.director.reason = "Идёт собрать выбранный урожай";
}

function failRequest(state: ForestSessionState, reason: string) {
  const garden = state.life.garden;
  if (garden.harvest?.phase === "pending") {
    garden.harvestEvent = { ...garden.harvest.request, status: "unavailable", reason };
    garden.harvest = null;
  }
  finishForestIntention(state.clearing.behavior.mind, "failed", reason);
  clearRequest(state); releaseClearingPoint(state.clearing);
  state.director.reason = reason; state.director.nextDecisionAt = state.director.elapsed + 8;
}

function interactionFailureReason(state: ForestSessionState, kind: "bush" | "home-sleep") {
  const { clearing } = state, home = kind === "home-sleep";
  if (!clearing.navigationEnabled) return home
    ? "Для этого уровня дома нет подходящего прежнего маршрута — включите свободную полянку"
    : "Для куста нет подходящего прежнего маршрута — включите свободную полянку";
  const available = home ? clearing.interactions.home : clearing.interactions.bushes.length > 0;
  if (!available) {
    const diagnostic = clearing.interactions.diagnostics.find(item => home ? item.id === "home" : item.id !== "home" && !item.valid);
    const details: Record<string, string> = {
      "invalid-doorway": "Проверьте точки entry и doorway: порог слишком длинный или некорректный",
      "outside-focus": "Вход не помещается в круглый вид вместе с Мохликом",
      "blocked-doorway": "Подход к порогу пересекает препятствие",
      "unreachable-door-entry": "Перед входом не хватает доступной земли для опоры Мохлика",
      "invalid-bush": "Проверьте контур куста и точку hide",
      "missing-bush-artwork": "Сначала разместите картинку куста в Tiled поверх его контура",
      "invalid-bush-corridor": "Проверьте расстояние между entry и hide куста",
      "unreachable-bush-entry": "Перед кустом не хватает доступной земли для опоры Мохлика",
      "blocked-bush-corridor": "Прыжок в куст пересекает препятствие",
    };
    return details[diagnostic?.reason ?? ""] ?? (home ? "У этого уровня дома нет доступного входа" : "Нет куста с доступным входом");
  }
  const search = clearing.navigation?.stats.lastSearch;
  if (search?.reason === "invalid-endpoint") return "Текущая позиция или точка подхода не вмещает опору Мохлика";
  if (search?.reason === "search-limit") return "Поиск подхода достиг лимита — проверьте разметку проходов";
  return home ? "Из текущего места нет безопасного пути к дому" : "Из текущего места нет безопасного пути к кусту";
}

function prepareProp(state: ForestSessionState, kind: "mushroom" | "leaf", heroScale = 1) {
  const { director, clearing, life } = state, size = clearing.size * heroScale;
  const objects = kind === "leaf" ? life.leaf ? [{ ...life.leaf, id: "leaf" }] : []
    : life.mushrooms.filter(item => item.growth >= .98).sort((a, b) => distance(a, clearing.position) - distance(b, clearing.position));
  for (const item of objects.slice(0, 12)) {
    if (!clearing.navigationEnabled || !clearing.navigation) {
      if (kind === "mushroom" && !life.mushrooms.find(mushroom => mushroom.id === item.id)?.reachable) continue;
      director.objectId = item.id; director.target = { ...clearing.home };
      const idleSeconds = clearing.idleSeconds, awakeUntil = clearing.awakeUntil;
      returnClearingHome(clearing);
      if (!director.explicit) { clearing.idleSeconds = idleSeconds; clearing.awakeUntil = awakeUntil; }
      return true;
    }
    // Stop beside and slightly below the prop: it stays visible outside the
    // body while the bent paw makes a short reach above the sole.
    for (const [dx, dy] of [[.3, .1], [-.3, .1], [.24, .14], [-.24, .14], [.3, .04], [-.3, .04]]) {
      const target = { x: item.x + size * dx, y: item.y + size * dy };
      if (!findWorldPath(clearing.navigation, clearing.position, target)) continue;
      if (!requestClearingPoint(clearing, target)) continue;
      director.objectId = item.id; director.target = target; return true;
    }
  }
  return false;
}

/** One reserved task owns every leg; no actor position is ever assigned by this executor. */
function prepareGarden(state: ForestSessionState, kind: ForestGardenAction, heroScale = 1) {
  const { clearing, director } = state, garden = state.life.garden, nav = clearing.navigation;
  if (!nav) return false;
  if (kind === "harvest-berries" && garden.basket) {
    const size = clearing.size * heroScale;
    const approach = gardenBasketApproach(garden.basket.position, size, nav, clearing.position);
    const homeApproach = gardenBasketApproach(garden.basket.homePosition, size, nav, clearing.position);
    if (!approach || !homeApproach) return false;
    garden.basket.approach = approach; garden.basket.homeApproach = homeApproach;
  }
  const candidates = gardenEligibleBushes(garden, kind).filter(bush => gardenWorkReachable(bush, clearing.size * heroScale))
    .sort((a, b) => distance(a.workPosition!, clearing.position) - distance(b.workPosition!, clearing.position));
  for (const bush of candidates) {
    const alreadyHeld = kind === "harvest-berries" && Boolean(garden.basket?.held);
    const first = kind === "water-bush" || alreadyHeld ? bush.workPosition! : garden.basket!.approach;
    if (!findWorldPath(nav, clearing.position, first)) continue;
    if (kind === "harvest-berries" && (!findWorldPath(nav, first, bush.workPosition!)
      || !findWorldPath(nav, bush.workPosition!, garden.basket!.homeApproach))) continue;
    if (!requestClearingPoint(clearing, first)) continue;
    garden.routine = { kind, bushId: bush.id, phase: kind === "water-bush" || alreadyHeld ? "approach-bush" : "approach-basket",
      elapsed: 0, totalElapsed: 0, carryingBasket: alreadyHeld };
    if (kind === "harvest-berries" && garden.harvest) garden.harvest.phase = "running";
    if (alreadyHeld) garden.basket!.held = false;
    director.activeKey = `${kind}:${bush.id}`;
    director.reason = kind === "water-bush" ? "Идёт полить ягодный куст" : "Берёт корзинку для спелых ягод";
    return true;
  }
  garden.nextActionAt = garden.elapsed + 45;
  return false;
}
function failGarden(state: ForestSessionState, reason: string) {
  if (state.life.garden.routine) state.director.activeKey = null;
  cancelGarden(state);
  if (state.life.garden.harvestEvent?.status === "interrupted") state.life.garden.harvestEvent.reason = reason;
  failRequest(state, reason);
}
function advanceGardenRoutine(state: ForestSessionState, delta: number, options: ForestDirectorOptions) {
  const garden = state.life.garden, routine = garden.routine;
  if (!routine) return;
  const dt = Math.min(delta, .1), bush = garden.bushes.find(item => item.id === routine.bushId);
  const economicHarvest = routine.kind === "harvest-berries" && garden.production !== undefined;
  routine.totalElapsed += dt;
  if (bush && !gardenWorkReachable(bush, actor(state, options).size)) {
    failGarden(state, "Размер Мохлика изменился — до ягод больше не дотянуться с этой точки"); return;
  }
  if (!bush?.workPosition || routine.kind === "harvest-berries" && !garden.basket || !state.clearing.navigationEnabled || options.navigationMode === "routes" || routine.totalElapsed > 120 || options.rain >= .7 && !economicHarvest) {
    failGarden(state, options.rain >= .7 ? "Дождь усилился — аккуратно отложил заботы о ягодах" : "Подход изменился — занятие остановлено без потери урожая"); return;
  }
  const transition = (phase: ForestGardenPhase, reason: string) => {
    routine.phase = phase; routine.elapsed = 0; state.director.reason = reason;
  };
  const target = gardenRoutineTarget(garden);
  if (target) {
    if (!requestClearingPoint(state.clearing, target)) { failGarden(state, "К цели больше нет безопасного пути"); return; }
    if (!isClearingAtPoint(state.clearing, target)) return;
    if (routine.phase === "approach-basket") transition("take-basket", "Поднимает корзинку");
    else if (routine.phase === "approach-bush") transition(routine.kind === "water-bush" ? "water" : "collect",
      routine.kind === "water-bush" ? "Бережно поливает ягодный куст" : "Собирает спелые ягоды");
    else transition("deposit", "Ставит корзинку на место");
    return;
  }
  routine.elapsed += dt;
  if (routine.phase === "take-basket" && routine.elapsed >= 1) {
    routine.carryingBasket = true; syncGardenObstacle(state); transition("approach-bush", "Несёт корзинку к ягодному кусту");
  } else if (routine.phase === "water" && routine.elapsed >= 4) {
    bush.moisture = 1; bush.waterIn = FOREST_GARDEN_LIMITS.waterCooldown;
    transition("settle", "Куст полит — теперь ягоды будут расти");
  } else if (routine.phase === "collect" && routine.elapsed >= 5) {
    transition("return-basket", "Относит собранные ягоды к дому");
  } else if (routine.phase === "deposit" && routine.elapsed >= 1.5) {
    const basket = garden.basket;
    if (!basket || bush.growth < .98 || (economicHarvest
      ? !garden.production || !garden.harvest || garden.harvest.request.jobId !== garden.production.jobId
      : basket.berries + FOREST_GARDEN_LIMITS.harvest > basket.capacity)) {
      failGarden(state, "Урожай больше недоступен — корзинка не изменена"); return;
    }
    // This is the only harvest commit. A tap, handoff or restore before this
    // point keeps both the ripe bush and the previous basket contents intact.
    if (economicHarvest && garden.harvest) {
      garden.harvest.phase = "completed";
      garden.harvestEvent = { ...garden.harvest.request, status: "completed" };
    } else { bush.growth = 0; basket.berries += FOREST_GARDEN_LIMITS.harvest; }
    basket.position = { ...basket.homePosition }; basket.approach = { ...basket.homeApproach };
    routine.carryingBasket = false; syncGardenObstacle(state); transition("settle", "Ягоды собраны в корзинку");
  } else if (routine.phase === "settle" && routine.elapsed >= .7) {
    const reason = routine.kind === "water-bush" ? "Закончил полив — можно заняться чем-то другим"
      : economicHarvest ? "Сбор закончен — урожай готов к отправке в кладовую" : "Урожай на месте — куст будет расти заново";
    garden.routine = null; garden.nextActionAt = garden.elapsed + 45;
    finishForestIntention(state.clearing.behavior.mind, "completed", reason);
    state.director.reason = reason;
  }
}

function processRequest(state: ForestSessionState, options: ForestDirectorOptions) {
  const kind = state.pendingLife;
  if (!kind || state.pendingAttention || state.director.birdwatch || state.director.campfireVisit || state.life.routine || state.life.garden.routine || state.fauna.encounter) return;
  if (state.life.garden.basket?.held && kind !== "harvest-berries") {
    state.director.reason = "Ищет место рядом, чтобы сначала поставить корзинку"; return;
  }
  const { clearing, director } = state;
  if (director.elapsed - director.pendingSince > 35) { failRequest(state, "Цель недоступна — выберет другое занятие"); return; }
  if (kind === "watch-birds") {
    if (options.rain > .35 || options.dusk > .6) { failRequest(state, "Птиц лучше наблюдать в сухую светлую погоду"); return; }
    const bird = chooseForestBirdwatchTarget(options.birds ?? [], actor(state, options));
    if (!bird) { failRequest(state, "Рядом пока нет сидящей птицы — дождитесь её посадки"); return; }
    // A manual request can stop an ordinary walk, but never skips a doorway or jump.
    if (!canStartClearingInteraction(clearing)) {
      if (!requestClearingPoint(clearing, clearing.position)) {
        failRequest(state, "Сначала нужно закончить выход или прыжок"); return;
      }
    }
    if (!canStartClearingInteraction(clearing) || clearing.navigationEnabled && !requestClearingPoint(clearing, clearing.position)) {
      failRequest(state, "Сейчас нельзя спокойно остановиться для наблюдения"); return;
    }
    director.birdwatch = createForestBirdwatch(bird, 6 + random(director) * 2);
    director.activeKey = "watch-birds"; director.reason = bird.surface === "ground"
      ? "Остановился и наблюдает за птицей на земле" : "Остановился и наблюдает за птицей на ветке";
    clearRequest(state); return;
  }
  if (kind === "campfire") {
    if (!clearing.navigationEnabled || options.navigationMode === "routes") { failRequest(state, "Для костра включите свободную полянку"); return; }
    const fires = state.life.campfires.filter(fire => campfireReady(fire, options.rain, options.dusk));
    if (!fires.length) {
      if (director.explicit && state.life.campfires.some(fire => fire.wetness < .35) && options.dusk >= .55 && options.rain < .2) {
        if (!clearing.requestedPoint) requestClearingPoint(clearing, clearing.position);
        director.reason = "Ждёт, пока вечерний костёр разгорится"; return;
      }
      failRequest(state, "Костёр ещё не разгорелся или погода не подходит"); return;
    }
    if (!director.target) {
      if (!canStartClearingInteraction(clearing) && !requestClearingPoint(clearing, clearing.position)) {
        if (!director.waitingForExit) { requestClearingOutside(clearing); director.waitingForExit = true; }
        director.reason = "Выходит на полянку к вечернему огню"; return;
      }
      const fire = fires.sort((a, b) => distance(a.seat, clearing.position) - distance(b.seat, clearing.position))
        .find(item => requestClearingPoint(clearing, item.seat));
      if (!fire) { failRequest(state, "К месту у костра нет безопасного подхода — проверьте campfire-seat и WalkAreas"); return; }
      director.objectId = fire.id; director.target = fire.seat;
    }
    const fire = fires.find(item => item.id === director.objectId);
    if (!fire) { failRequest(state, "Огонь погас — отдых у костра подождёт"); return; }
    if (!isClearingAtPoint(clearing, fire.seat)) { director.reason = "Идёт погреться у костра"; return; }
    director.campfireVisit = { id: fire.id, elapsed: 0, duration: 12 + random(director) * 6 };
    director.activeKey = `campfire:${fire.id}`; director.reason = "Устроился рядом с огнём и отдыхает";
    clearRequest(state); return;
  }
  if (kind === "bush" || kind === "home-sleep") {
    if (kind === "home-sleep" && !options.homeAvailable) { failRequest(state, "Домик сейчас недоступен"); return; }
    releaseClearingPoint(clearing);
    const idleSeconds = clearing.idleSeconds, explicit = director.explicit;
    const accepted = kind === "bush" ? requestClearingBush(clearing) : requestClearingSleep(clearing);
    const reason = accepted ? kind === "bush" ? "Идёт к кусту" : "Отправляется домой" : interactionFailureReason(state, kind);
    if (!accepted) finishForestIntention(clearing.behavior.mind, "failed", reason);
    if (accepted && kind === "bush") {
      director.recent.push({ key: "bush", at: director.elapsed });
      director.recent = director.recent.slice(-8);
      if (!explicit) clearing.idleSeconds = idleSeconds;
    }
    clearRequest(state); director.reason = reason;
    return;
  }
  if (kind === "butterfly" || kind === "firefly") {
    if (director.waitingForExit && !(clearing.navigationEnabled ? canStartClearingInteraction(clearing) : isClearingAtHome(clearing))) return;
    if (!canStartClearingInteraction(clearing)) {
      // Stop a free walk at its real feet; leave an authored transition once,
      // without restarting wake-up/greeting on every frame of the exit.
      if (!requestClearingPoint(clearing, clearing.position)) {
        if (!director.waitingForExit) { requestClearingOutside(clearing); director.waitingForExit = true; }
        director.reason = "Сначала безопасно выходит к полянке"; return;
      }
    }
    if (!canStartClearingInteraction(clearing)) return;
    director.waitingForExit = false;
    if (!requestFaunaInteraction(state.fauna, kind, actor(state, options), options, director.explicit)) {
      failRequest(state, state.fauna.lastReason ?? "Рядом нет свободного обитателя подходящего вида"); return;
    }
    director.activeKey = kind; director.reason = kind === "butterfly" ? "Заметил бабочку" : "Наблюдает за светлячком";
    clearRequest(state); return;
  }
  if (kind === "water-bush" || kind === "harvest-berries") {
    if (!clearing.navigationEnabled || options.navigationMode === "routes") {
      failRequest(state, "Для ухода за кустом включите свободную полянку"); return;
    }
    if (options.rain >= .55 && !(kind === "harvest-berries" && state.life.garden.harvest)) { failRequest(state, "Сильный дождь — заботы о ягодах подождут"); return; }
    if (!canStartClearingInteraction(clearing)) {
      if (!requestClearingPoint(clearing, clearing.position)) {
        if (!director.waitingForExit) { requestClearingOutside(clearing); director.waitingForExit = true; }
        director.reason = "Сначала безопасно выходит к полянке"; return;
      }
    }
    if (!prepareGarden(state, kind, options.heroScale)) {
      const garden = state.life.garden;
      const eligible = gardenEligibleBushes(garden, kind);
      const reachBlocked = eligible.length > 0 && !eligible.some(bush => gardenWorkReachable(bush, actor(state, options).size));
      const reason = reachBlocked ? "С текущим размером Мохлик не достаёт до куста с безопасной точки"
        : kind === "water-bush" ? "Куст уже полит или к нему нет безопасного подхода"
        : !garden.basket ? garden.basketUnavailable ? "К точке корзинки в Tiled нет безопасного подхода — переставьте её на свободную землю"
          : "Для корзинки пока нет свободного места у полянки"
          : garden.basket.berries + FOREST_GARDEN_LIMITS.harvest > garden.basket.capacity ? "Корзинка уже наполнена — ягоды останутся на кусте"
            : "Пока нет спелых ягод с доступным подходом";
      failRequest(state, reason); return;
    }
    clearRequest(state); return;
  }
  if (kind !== "mushroom" && kind !== "leaf") { clearRequest(state); return; }
  if (!director.target && clearing.navigationEnabled) {
    if (director.waitingForExit && !(clearing.navigationEnabled ? canStartClearingInteraction(clearing) : isClearingAtHome(clearing))) return;
    if (!requestClearingPoint(clearing, clearing.position)) {
      if (!director.waitingForExit) {
        const idleSeconds = clearing.idleSeconds, awakeUntil = clearing.awakeUntil;
        requestClearingOutside(clearing);
        if (!director.explicit) { clearing.idleSeconds = idleSeconds; clearing.awakeUntil = awakeUntil; }
        director.waitingForExit = true;
      }
      director.reason = "Сначала безопасно выходит к полянке"; return;
    }
    director.waitingForExit = false;
  }
  if (!director.target && !prepareProp(state, kind, options.heroScale)) {
    failRequest(state, kind === "mushroom" ? "Нет выросшего гриба с доступным подходом" : "К листику пока нельзя подойти"); return;
  }
  const arrived = clearing.navigationEnabled ? isClearingAtPoint(clearing, director.target!) : isClearingAtHome(clearing);
  if (!arrived) { director.reason = kind === "mushroom" ? "Подходит к выросшему грибу" : "Идёт рассмотреть листик"; return; }
  const object = kind === "mushroom" ? state.life.mushrooms.find(item => item.id === director.objectId) : state.life.leaf;
  if (!object || distance(object, clearing.position) > actor(state, options).size * .4
    || !clearing.navigationEnabled && kind === "mushroom" && !(object as { reachable?: boolean }).reachable) {
    failRequest(state, "Подход изменился — предмет слишком далеко"); return;
  }
  triggerForestLife(state.life, kind, { mushroomId: kind === "mushroom" ? director.objectId! : undefined, requireGrown: true });
  if (!state.life.routine) { failRequest(state, "Предмет уже недоступен"); return; }
  director.activeKey = `${kind}:${director.objectId}`; director.reason = kind === "mushroom" ? "Рассматривает гриб" : "Рассматривает листик";
  clearRequest(state);
}

function chooseAction(state: ForestSessionState, options: ForestDirectorOptions) {
  const { director, clearing } = state, mind = clearing.behavior.mind;
  // A chosen journey/action owns its intention until completion or an explicit interruption.
  if (!options.autoLife || state.pendingLife || state.pendingAttention || director.birdwatch || director.campfireVisit || state.life.routine || state.life.garden.routine || state.life.garden.basket?.held || state.fauna.encounter
    || mind.intention || !canStartClearingLife(clearing) || director.elapsed < director.nextDecisionAt) return;
  director.nextDecisionAt = director.elapsed + .6;
  const visitor = options.dusk > .5 ? "firefly" : "butterfly";
  const nearby = state.life.mushrooms.filter(item => item.growth >= .98
    && distance(item, clearing.position) < clearing.size * 1.35 && (clearing.navigationEnabled || item.reachable));
  const candidates: ForestMindCandidate[] = [];
  const candidate = (action: ForestMindAction, available: boolean, unavailableReason: string) => {
    const item = scoreForestAction(mind, action, action, { rain: options.rain, dusk: options.dusk, noise: random(director) * .6 });
    if (!available) { item.available = false; item.score = null; item.reasons = [unavailableReason]; }
    candidates.push(item);
  };
  candidate("idle", true, "");
  const bird = options.rain <= .35 && options.dusk <= .6
    ? chooseForestBirdwatchTarget(options.birds ?? [], actor(state, options)) : null;
  const watching = scoreForestAction(mind, "look", "watch-birds", { rain: options.rain, dusk: options.dusk, noise: bird ? random(director) * .6 : 0 });
  if (bird) {
    // This short-lived visitor is more novel than another generic look at the grass.
    // Keep the existing fatigue and repeated-watch penalties: it is an opportunity,
    // not an instruction to abandon rest or an activity already under way.
    if (watching.score !== null) watching.score += 1.2;
    watching.reasons.unshift("На ветке рядом устроилась птица — можно тихо понаблюдать");
  }
  else Object.assign(watching, { available: false, score: null, reasons: ["Рядом нет сидящей птицы в подходящую погоду"] });
  candidates.push(watching);
  const fire = clearing.navigationEnabled && options.navigationMode !== "routes"
    && mind.needs.energy > .25 && state.life.campfires.some(item => campfireReady(item, options.rain, options.dusk));
  const warming = scoreForestAction(mind, "rest", "campfire", { rain: options.rain, dusk: options.dusk, noise: 0 });
  if (fire) {
    if (warming.score !== null) warming.score += .65;
    warming.reasons.unshift("На полянке горит вечерний костёр — можно спокойно погреться");
  } else Object.assign(warming, { available: false, score: null, reasons: ["Нужны горящий костёр, сухой вечер и доступная точка подхода"] });
  candidates.push(warming);
  candidate(visitor, canStartClearingInteraction(clearing) && canRequestFaunaInteraction(state.fauna, visitor, actor(state, options), options),
    options.rain > .35 ? "Обитатели укрываются от дождя" : "Рядом нет свободного обитателя подходящего вида");
  candidate("mushroom", nearby.length > 0, "Рядом нет выросшего гриба");
  candidate("leaf", Boolean(state.life.leaf && distance(state.life.leaf, clearing.position) < clearing.size * 1.2), "Рядом нет подходящего листика");
  candidate("bush", clearing.navigationEnabled && options.rain < .35 && options.dusk < .75 && canVisitClearingBush(clearing)
    && !director.recent.some(item => item.key === "bush" && director.elapsed - item.at < 90),
    options.rain >= .35 ? "Куст мокрый — лучше другое занятие" : options.dusk >= .75 ? "Ночью куст оставит в покое" : "Куст недоступен или недавно уже исследован");
  const canGarden = clearing.navigationEnabled && options.navigationMode !== "routes" && options.rain < .35 && options.dusk < .65 && mind.needs.energy > .4;
  const gardenWithinReach = (kind: ForestGardenAction) => gardenEligibleBushes(state.life.garden, kind)
    .some(bush => gardenWorkReachable(bush, actor(state, options).size));
  candidate("water-bush", canGarden && gardenActionAvailable(state.life.garden, "water-bush") && gardenWithinReach("water-bush"),
    "Кусту пока не нужен полив, погода не подходит или Мохлик устал");
  candidate("harvest-berries", canGarden && gardenActionAvailable(state.life.garden, "harvest-berries") && gardenWithinReach("harvest-berries"),
    "Ягоды ещё растут, корзинка полна или сейчас лучше отдохнуть");
  candidate("home-sleep", options.homeAvailable && Boolean(clearing.navigationEnabled ? clearing.interactions.home : clearing.homeRoute)
    && clearing.elapsed >= clearing.awakeUntil && (mind.needs.energy < .32 || options.rain > .55 && mind.needs.comfort < .45),
    clearing.elapsed < clearing.awakeUntil ? "Недавно проснулся — остаётся с игроком" : "Пока достаточно сил для жизни на полянке");
  const selected = candidates.filter(item => item.available).sort((a, b) => b.score! - a.score!)[0];
  recordForestCandidates(mind, candidates, selected?.key ?? null);
  if (!selected || selected.action === "idle") {
    director.reason = "Спокойно осматривается"; director.nextDecisionAt = director.elapsed + 6 + random(director) * 7; return;
  }
  const kind = selected.key === "watch-birds" ? "watch-birds" : selected.key === "campfire" ? "campfire" : selected.action as ForestDirective;
  beginForestIntention(mind, selected.action, selected.key, selected.reasons[0], "director");
  state.pendingLife = kind; director.pendingSince = director.elapsed; director.explicit = false;
}

function stimuli(state: ForestSessionState) {
  const { director, clearing } = state, frame = clearingActivityFrame(clearing);
  let stimulus: Omit<NonNullable<ForestDirectorState["stimulus"]>, "id"> | null = null;
  if (!director.lastFootstep) director.lastFootstep = { ...clearing.position };
  if (frame.pose === "walk" && director.elapsed - director.lastFootstepAt > .55
    && distance(clearing.position, director.lastFootstep) > clearing.size * .13) {
    director.lastFootstep = { ...clearing.position }; director.lastFootstepAt = director.elapsed;
    stimulus = { kind: "movement", ...clearing.position, strength: .3 };
  }
  const burst = frame.bush?.bursts.at(-1), key = burst ? `${frame.bush!.id}:${burst.seed}:${burst.at}` : null;
  if (key && key !== director.lastBurst) {
    director.lastBurst = key; stimulus = { kind: "rustle", ...clearing.position, strength: burst!.strength };
  }
  if (stimulus) {
    director.stimulus = { ...stimulus, id: (director.stimulus?.id ?? 0) + 1 };
    emitFaunaStimulus(state.fauna, { ...stimulus, radius: clearing.size * 1.5 });
  }
}

/** One session clock and one actor position: perception → interaction → walk. */
export function advanceForestDirector(state: ForestSessionState, dt: number, options: ForestDirectorOptions) {
  if (!Number.isFinite(dt) || dt <= 0 || options.reducedMotion) return;
  syncGardenObstacle(state);
  const director = state.director; director.elapsed += Math.min(dt, .1);
  if (options.autoLife && !options.blocked) {
    const frame = clearingActivityFrame(state.clearing), pose = frame.pose;
    advanceForestMind(state.clearing.behavior.mind, dt, {
      moving: frame.pose === "walk", resting: Boolean(director.campfireVisit) || pose === "sleep" || pose === "drowsy",
      sleeping: frame.homeSleeping, sheltered: frame.residing || Boolean(director.campfireVisit),
      rain: options.rain, dusk: options.dusk,
      engaged: Boolean(director.birdwatch || director.campfireVisit || state.life.routine || state.life.garden.routine || state.fauna.encounter) || state.clearing.stage === "bush-hidden"
        || state.clearing.stage === "activity" && !["sleep", "drowsy", "yawn"].includes(pose),
      grooming: ["groom", "shake", "scratch"].includes(pose),
    });
  }
  const previousEncounter = state.fauna.encounter;
  advanceForestFauna(state.fauna, dt, { ...options, actor: options.actorAway ? undefined : actor(state, options) });
  const encounter = state.fauna.encounter ?? previousEncounter;
  if (encounter?.phase === "interrupt" && state.clearing.behavior.mind.intention?.action === encounter.kind)
    finishForestIntention(state.clearing.behavior.mind, "interrupted", "Встреча закончилась раньше — обитатель возвращается в лес");
  advanceForestLife(state.life, dt, { autoLife: false, blocked: options.blocked || Boolean(state.fauna.encounter),
    dusk: options.dusk, rain: options.rain, butterflies: options.butterflies, fireflies: options.fireflies });
  advanceForestGarden(state.life.garden, dt, { rain: options.rain });
  const garden = state.life.garden;
  if (!options.blocked && garden.basket?.held && garden.elapsed >= (garden.basket.dropRetryAt ?? 0)) {
    if (parkForestGardenBasket(garden, state.clearing.position, baseClearingNavigation(state.clearing))) {
      syncGardenObstacle(state); releaseClearingPoint(state.clearing);
    } else {
      requestClearingPoint(state.clearing, garden.basket.homeApproach);
      director.reason = "Несёт корзинку к свободному месту, чтобы аккуратно поставить её";
    }
  }
  advanceForestCampfires(state.life.campfires, dt, options.dusk, options.rain);
  if (!options.blocked && director.campfireVisit) {
    const visit = director.campfireVisit, fire = state.life.campfires.find(item => item.id === visit.id);
    visit.elapsed += Math.min(dt, .1);
    const interrupted = !fire || !campfireReady(fire, options.rain, options.dusk);
    if (interrupted || visit.elapsed >= visit.duration) {
      director.campfireVisit = null;
      director.reason = interrupted ? "Огонь или погода изменились — заканчивает отдых" : "Погрелся у костра и возвращается к своим делам";
      finishForestIntention(state.clearing.behavior.mind, interrupted ? "interrupted" : "completed", director.reason);
    }
  }
  if (!options.blocked) advanceGardenRoutine(state, dt, options);
  if (!options.blocked && director.birdwatch) {
    const weatherChanged = options.rain > .35 || options.dusk > .6;
    if (weatherChanged || advanceForestBirdwatch(director.birdwatch, options.birds ?? [], dt) === "finished") {
      director.birdwatch = null;
      director.reason = weatherChanged ? "Погода изменилась — заканчивает наблюдение" : "Проводил птицу взглядом и возвращается к своим делам";
      finishForestIntention(state.clearing.behavior.mind, weatherChanged ? "interrupted" : "completed", director.reason);
    }
  }
  finishAction(state);
  if (!options.blocked) {
    if (state.pendingAttention && !state.life.routine && !state.life.garden.routine && !state.fauna.encounter) {
      state.pendingAttention = false; releaseClearingPoint(state.clearing); noticeClearingActivity(state.clearing, { mindNoticed: true });
    }
    chooseAction(state, options); processRequest(state, options);
  }
  const frame = clearingActivityFrame(state.clearing);
  const previousIntention = state.clearing.behavior.mind.intention;
  advanceClearingActivity(state.clearing, dt, {
    enabled: options.explicitTravel || options.autoLife || state.clearing.retiring || Boolean(state.pendingLife || state.life.garden.routine || state.life.garden.basket?.held || state.clearing.bushEffect?.bursts.length)
      || state.clearing.freePurpose === "interaction-exit"
      || frame.attention || !options.homeAvailable && frame.residing,
    blocked: options.blocked && !options.explicitTravel || Boolean(director.birdwatch || director.campfireVisit || state.life.routine || state.fauna.encounter) || gardenRoutineStationary(state.life.garden.routine),
    idleEligible: !options.blocked && !director.birdwatch && !director.campfireVisit && !state.pendingLife && !state.pendingAttention && !state.life.garden.routine && !state.life.garden.basket?.held,
    homeAvailable: options.homeAvailable && !state.life.garden.basket?.held, dusk: options.dusk, rain: options.rain,
    navigationMode: state.life.garden.basket?.held ? "auto" : options.navigationMode,
  });
  const intention = state.clearing.behavior.mind.intention;
  // A new successful walk owns the current explanation. Earlier failed requests
  // remain in the mind's event log, not over the actor's unrelated next activity.
  if (!state.pendingLife && intention?.source === "clearing" && intention !== previousIntention) director.reason = intention.reason;
  stimuli(state);
}
