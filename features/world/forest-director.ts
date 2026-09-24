import type { ForestSessionState } from "./forest-session";
import type { WorldPoint } from "./tiled/types";
import type { ForestLifeAction } from "./forest-life";
import { advanceForestLife, cancelForestLife, interruptForestLife, triggerForestLife } from "./forest-life";
import { advanceClearingActivity, canStartClearingInteraction, canStartClearingLife, canVisitClearingBush, clearingActivityFrame,
  isClearingAtHome, isClearingAtPoint, noticeClearingActivity, releaseClearingPoint,
  requestClearingBush, requestClearingPoint, requestClearingSleep, requestClearingOutside, returnClearingHome } from "./clearing-activity";
import { advanceForestFauna, cancelFaunaInteraction, canRequestFaunaInteraction, emitFaunaStimulus,
  interruptFaunaInteraction, requestFaunaInteraction } from "./forest-fauna";
import { findWorldPath } from "./navigation";

export type ForestDirective = ForestLifeAction | "bush" | "home-sleep" | "wake";
export type ForestDirectorOptions = {
  autoLife: boolean; blocked: boolean; dusk: number; rain: number; homeAvailable: boolean;
  butterflies?: "auto" | "on" | "off"; fireflies?: "auto" | "on" | "off";
  heroScale?: number; reducedMotion?: boolean; navigationMode?: "auto" | "routes";
};
export type ForestDirectorState = {
  elapsed: number; nextDecisionAt: number; seed: number; reason: string;
  pendingSince: number; waitingForExit: boolean; objectId: string | null; target: WorldPoint | null; explicit: boolean;
  activeKey: string | null; recent: { key: string; at: number }[];
  lastFootstep: WorldPoint | null; lastFootstepAt: number; lastBurst: string | null;
  stimulus: { id: number; kind: "movement" | "rustle"; x: number; y: number; strength: number } | null;
};
export function createForestDirector(seed = 8128): ForestDirectorState {
  return { elapsed: 0, nextDecisionAt: 4, seed, reason: "Осматривает полянку", pendingSince: 0, waitingForExit: false,
    objectId: null, target: null, explicit: false, activeKey: null, recent: [],
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
function finishAction(state: ForestSessionState) {
  const director = state.director;
  if (!director.activeKey || state.life.routine || state.fauna.encounter) return;
  director.recent.push({ key: director.activeKey, at: director.elapsed });
  director.recent = director.recent.filter(item => director.elapsed - item.at < 90).slice(-8);
  director.activeKey = null; director.nextDecisionAt = director.elapsed + 7 + random(director) * 6;
  releaseClearingPoint(state.clearing);
}

/** A DEV pose is a deliberate interruption, never a second owner of a seated insect. */
export function cancelForestDirector(state: ForestSessionState) {
  cancelForestLife(state.life); cancelFaunaInteraction(state.fauna);
  clearRequest(state); state.pendingAttention = false; state.director.activeKey = null;
  state.director.nextDecisionAt = state.director.elapsed + 10;
  releaseClearingPoint(state.clearing);
}
export function noticeForestDirector(state: ForestSessionState, still = false) {
  clearRequest(state); state.director.nextDecisionAt = state.director.elapsed + 12;
  if (still) {
    cancelForestDirector(state); noticeClearingActivity(state.clearing, { still: true }); return;
  }
  if (state.pendingAttention) return;
  const prop = interruptForestLife(state.life), insect = interruptFaunaInteraction(state.fauna);
  state.pendingAttention = prop || insect;
  if (!state.pendingAttention) {
    releaseClearingPoint(state.clearing); noticeClearingActivity(state.clearing);
  }
}

/** Requests use the same physical participants and paths as autonomous actions. */
export function requestForestDirective(state: ForestSessionState, kind: ForestDirective, options: ForestDirectorOptions) {
  if (kind === "wake") { noticeForestDirector(state, options.reducedMotion); return; }
  if (kind === "idle" || kind === "grow-mushrooms") {
    cancelForestDirector(state);
    if (kind === "idle") returnClearingHome(state.clearing);
    triggerForestLife(state.life, kind); return;
  }
  if (options.reducedMotion) { state.director.reason = "Перелёты и прогулки при уменьшенном движении остановлены"; return; }
  interruptForestLife(state.life); interruptFaunaInteraction(state.fauna);
  state.pendingAttention = false; state.pendingLife = kind;
  Object.assign(state.director, { pendingSince: state.director.elapsed, waitingForExit: false, objectId: null, target: null, explicit: true,
    reason: "Завершает текущее действие перед новой встречей" });
}

function failRequest(state: ForestSessionState, reason: string) {
  clearRequest(state); releaseClearingPoint(state.clearing);
  state.director.reason = reason; state.director.nextDecisionAt = state.director.elapsed + 8;
}

function prepareProp(state: ForestSessionState, kind: "mushroom" | "leaf") {
  const { director, clearing, life } = state, size = clearing.size;
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
    // The facing-front pickup rig reaches slightly ahead of its feet. Only a
    // safe approach point makes a distant decorative prop an interactive one.
    for (const [dx, dy] of [[.12, -.14], [-.12, -.14], [0, -.1]]) {
      const target = { x: item.x + size * dx, y: item.y + size * dy };
      if (!findWorldPath(clearing.navigation, clearing.position, target)) continue;
      if (!requestClearingPoint(clearing, target)) continue;
      director.objectId = item.id; director.target = target; return true;
    }
  }
  return false;
}

function processRequest(state: ForestSessionState, options: ForestDirectorOptions) {
  const kind = state.pendingLife;
  if (!kind || state.pendingAttention || state.life.routine || state.fauna.encounter) return;
  const { clearing, director } = state;
  if (director.elapsed - director.pendingSince > 35) { failRequest(state, "Цель недоступна — выберет другое занятие"); return; }
  if (kind === "bush" || kind === "home-sleep") {
    releaseClearingPoint(clearing);
    const idleSeconds = clearing.idleSeconds, explicit = director.explicit;
    const accepted = kind === "bush" ? requestClearingBush(clearing) : requestClearingSleep(clearing);
    if (accepted && kind === "bush") {
      director.recent.push({ key: "bush", at: director.elapsed });
      director.recent = director.recent.slice(-8);
      if (!explicit) clearing.idleSeconds = idleSeconds;
    }
    clearRequest(state); director.reason = accepted ? kind === "bush" ? "Идёт к кусту" : "Отправляется домой" : "Безопасный подход не найден";
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
  if (!director.target && !prepareProp(state, kind)) {
    failRequest(state, kind === "mushroom" ? "Нет выросшего гриба с доступным подходом" : "К листику пока нельзя подойти"); return;
  }
  const arrived = clearing.navigationEnabled ? isClearingAtPoint(clearing, director.target!) : isClearingAtHome(clearing);
  if (!arrived) { director.reason = kind === "mushroom" ? "Подходит к выросшему грибу" : "Идёт рассмотреть листик"; return; }
  const object = kind === "mushroom" ? state.life.mushrooms.find(item => item.id === director.objectId) : state.life.leaf;
  if (!object || distance(object, clearing.position) > clearing.size * .4
    || !clearing.navigationEnabled && kind === "mushroom" && !(object as { reachable?: boolean }).reachable) {
    failRequest(state, "Подход изменился — предмет слишком далеко"); return;
  }
  triggerForestLife(state.life, kind, { mushroomId: kind === "mushroom" ? director.objectId! : undefined, requireGrown: true });
  if (!state.life.routine) { failRequest(state, "Предмет уже недоступен"); return; }
  director.activeKey = `${kind}:${director.objectId}`; director.reason = kind === "mushroom" ? "Рассматривает гриб" : "Рассматривает листик";
  clearRequest(state);
}

function chooseAction(state: ForestSessionState, options: ForestDirectorOptions) {
  const { director, clearing } = state;
  if (!options.autoLife || state.pendingLife || state.pendingAttention || state.life.routine || state.fauna.encounter
    || !canStartClearingLife(clearing) || director.elapsed < director.nextDecisionAt) return;
  director.nextDecisionAt = director.elapsed + .6;
  const visitor = options.dusk > .5 ? "firefly" : "butterfly";
  const nearby = state.life.mushrooms.filter(item => item.growth >= .98
    && distance(item, clearing.position) < clearing.size * 1.35 && (clearing.navigationEnabled || item.reachable));
  const choices: { kind: ForestDirective | null; score: number }[] = [{ kind: null, score: .55 + random(director) * .55 }];
  if (canStartClearingInteraction(clearing) && canRequestFaunaInteraction(state.fauna, visitor, actor(state, options), options))
    choices.push({ kind: visitor, score: 1.2 + random(director) * .6 });
  if (nearby.length) choices.push({ kind: "mushroom", score: 1.1 + random(director) * .55 });
  if (state.life.leaf && distance(state.life.leaf, clearing.position) < clearing.size * 1.2)
    choices.push({ kind: "leaf", score: .8 + random(director) * .65 });
  if (clearing.navigationEnabled && options.rain < .35 && options.dusk < .75
    && canVisitClearingBush(clearing)
    && !director.recent.some(item => item.key === "bush" && director.elapsed - item.at < 90))
    choices.push({ kind: "bush", score: .65 + random(director) * .6 });
  for (const choice of choices) if (choice.kind) {
    const last = director.recent.filter(item => item.key.startsWith(choice.kind!)).at(-1);
    if (last) choice.score -= Math.max(0, 1 - (director.elapsed - last.at) / 65) * 1.4;
  }
  choices.sort((a, b) => b.score - a.score);
  const kind = choices[0].kind;
  if (!kind) { director.reason = "Спокойно осматривается"; director.nextDecisionAt = director.elapsed + 6 + random(director) * 7; return; }
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
  const director = state.director; director.elapsed += Math.min(dt, .1);
  advanceForestFauna(state.fauna, dt, { ...options, actor: actor(state, options) });
  advanceForestLife(state.life, dt, { autoLife: false, blocked: options.blocked || Boolean(state.fauna.encounter),
    dusk: options.dusk, rain: options.rain, butterflies: options.butterflies, fireflies: options.fireflies });
  finishAction(state);
  if (!options.blocked) {
    if (state.pendingAttention && !state.life.routine && !state.fauna.encounter) {
      state.pendingAttention = false; releaseClearingPoint(state.clearing); noticeClearingActivity(state.clearing);
    }
    chooseAction(state, options); processRequest(state, options);
  }
  const frame = clearingActivityFrame(state.clearing);
  advanceClearingActivity(state.clearing, dt, {
    enabled: options.autoLife || state.clearing.retiring || Boolean(state.pendingLife || state.clearing.bushEffect?.bursts.length)
      || state.clearing.freePurpose === "interaction-exit"
      || frame.attention || !options.homeAvailable && frame.residing,
    blocked: options.blocked || Boolean(state.life.routine || state.fauna.encounter),
    idleEligible: !options.blocked && !state.pendingLife && !state.pendingAttention,
    homeAvailable: options.homeAvailable, dusk: options.dusk, rain: options.rain, navigationMode: options.navigationMode,
  });
  stimuli(state);
}
