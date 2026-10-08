/** Small local Utility AI. These are motives, never a feeding or punishment system. */
export type ForestMindAction = "look" | "sniff" | "groom" | "rest" | "bush" | "home-sleep"
  | "butterfly" | "firefly" | "mushroom" | "leaf" | "water-bush" | "harvest-berries" | "idle";
export type ForestMindNeeds = { energy: number; curiosity: number; comfort: number; attention: number };
/** Internal decision signals, not additional care needs or persisted account fields. */
export type ForestMindMotives = { arousal: number; saturation: number; variety: number };
export type ForestMindOutcome = "completed" | "interrupted" | "failed";
export type ForestMindCandidate = {
  key: string; action: ForestMindAction; score: number | null; available: boolean; reasons: string[]; selected: boolean;
};
export type ForestMindState = {
  elapsed: number; needs: ForestMindNeeds; attentionUntil: number;
  /** Short-lived activation. Restoration estimates it from the existing needs and memory. */
  arousal: number;
  intention: { key: string; action: ForestMindAction; reason: string; startedAt: number; source: "clearing" | "director" } | null;
  recent: { key: string; action: ForestMindAction; outcome: ForestMindOutcome; at: number; duration: number }[];
  candidates: ForestMindCandidate[];
  events: { at: number; type: ForestMindOutcome | "selected" | "attention" | "restored"; action: ForestMindAction | null; reason: string }[];
};
const actions: readonly ForestMindAction[] = ["look", "sniff", "groom", "rest", "bush", "home-sleep", "butterfly", "firefly", "mushroom", "leaf", "water-bush", "harvest-berries", "idle"];
const unit = (value: number) => Math.max(0, Math.min(1, value));
const finite = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : fallback;
const actionLabel: Record<ForestMindAction, string> = {
  look: "Осматривает полянку", sniff: "Изучает полянку", groom: "Приводит себя в порядок", rest: "Отдыхает",
  bush: "Исследует куст", "home-sleep": "Отдыхает дома", butterfly: "Играет с бабочкой", firefly: "Наблюдает за светлячком",
  mushroom: "Рассматривает гриб", leaf: "Играет с листиком", idle: "Спокойно осматривается",
  "water-bush": "Поливает ягодный куст", "harvest-berries": "Собирает ягоды в корзинку",
};
type ActionFamily = "observe" | "explore" | "play" | "care" | "rest" | "idle";
const actionFamily: Record<ForestMindAction, ActionFamily> = {
  look: "observe", sniff: "explore", groom: "care", rest: "rest", bush: "explore", "home-sleep": "rest",
  butterfly: "play", firefly: "observe", mushroom: "observe", leaf: "play", idle: "idle",
  "water-bush": "care", "harvest-berries": "care",
};
// Positive values describe lively activities; negative values describe quieter ones.
const stimulation: Record<ForestMindAction, number> = {
  look: -.65, sniff: .2, groom: -.8, rest: -1, bush: .85, "home-sleep": -1,
  butterfly: 1, firefly: -.55, mushroom: -.45, leaf: .9, idle: -.75,
  "water-bush": -.45, "harvest-berries": -.25,
};
function productiveCare(action: ForestMindAction | undefined) {
  return action === "water-bush" || action === "harvest-berries";
}
function interesting(action: ForestMindAction | undefined) {
  const family = action === undefined ? undefined : actionFamily[action];
  return family === "observe" || family === "explore" || family === "play";
}

function completedExperience(mind: ForestMindState) {
  const families: Record<ActionFamily, number> = { observe: 0, explore: 0, play: 0, care: 0, rest: 0, idle: 0 };
  let impressions = 0, total = 0;
  for (const previous of mind.recent) {
    if (previous.outcome !== "completed") continue;
    const family = actionFamily[previous.action], age = Math.max(0, mind.elapsed - previous.at);
    const freshness = Math.max(0, 1 - age / 120);
    // Walking time is included in intention.duration, so it cannot measure experience intensity.
    if (family === "idle" || family === "rest") continue;
    families[family] += freshness; total += freshness;
    if (interesting(previous.action)) impressions += freshness * (family === "play" ? 1 : family === "explore" ? .7 : .45);
  }
  const peak = Math.max(...Object.values(families));
  return { families, total, saturation: unit(impressions / 3), variety: total ? unit((peak - 1) / 3) * peak / total : 0 };
}
function restoredArousal(mind: ForestMindState, saturation: number) {
  return unit(.22 + finite(mind.needs.attention, 0, 1) * .45
    + (1 - finite(mind.needs.comfort, .85, 1)) * .16 + saturation * .3);
}
/** Pure, bounded diagnostic view. Reading it never advances a second simulation clock. */
export function forestMindMotives(mind: ForestMindState): ForestMindMotives {
  const { saturation, variety } = completedExperience(mind);
  return { arousal: finite(mind.arousal, restoredArousal(mind, saturation), 1), saturation, variety };
}
export const forestMindActionLabel = (action: ForestMindAction) => actionLabel[action];
export function createForestMind(): ForestMindState {
  return { elapsed: 0, needs: { energy: .82, curiosity: .58, comfort: .85, attention: 0 }, attentionUntil: 0,
    arousal: .244, intention: null, recent: [], candidates: [], events: [] };
}
function event(mind: ForestMindState, type: ForestMindState["events"][number]["type"], action: ForestMindAction | null, reason: string) {
  mind.events.push({ at: mind.elapsed, type, action, reason });
  mind.events = mind.events.slice(-24);
}

/** One active clock, advanced by the director only; no wall-time decay or offline penalties. */
export function advanceForestMind(mind: ForestMindState, delta: number, context: {
  moving: boolean; resting: boolean; sleeping: boolean; sheltered: boolean; rain: number; dusk: number;
  engaged: boolean; grooming: boolean;
}) {
  if (!Number.isFinite(delta) || delta <= 0) return;
  const dt = Math.min(delta, .1), needs = mind.needs;
  mind.elapsed += dt;
  needs.energy = unit(needs.energy + dt * (context.sleeping ? .009 : context.resting ? .007 : context.moving ? -.0015 : context.engaged ? -.0008 : -.00018));
  // Grooming also uses engaged poses, but it is not a new impression. Interest recovers
  // on walks and in quiet moments; meaningful activity satisfies it without a zero trap.
  const action = mind.intention?.action;
  const exploring = context.engaged && interesting(action), caring = context.engaged && productiveCare(action);
  const curiosityTarget = exploring ? .22 : context.sleeping ? .72 : context.moving ? .7 : caring ? .55 : .8;
  needs.curiosity = unit(needs.curiosity + (curiosityTarget - needs.curiosity) * (1 - Math.exp(-dt / (exploring ? 45 : 100))));
  const comfortTarget = context.sheltered ? .98 : 1 - unit(context.rain) * .7 - unit(context.dusk) * .06;
  needs.comfort = unit(needs.comfort + (comfortTarget - needs.comfort) * (1 - Math.exp(-dt / 35)) + (context.grooming ? dt * .003 : 0));
  needs.attention = unit(needs.attention - dt / 45);
  const currentArousal = Number.isFinite(mind.arousal) ? unit(mind.arousal)
    : restoredArousal(mind, completedExperience(mind).saturation);
  const activation = context.sleeping ? .08 : context.resting ? .12 : context.grooming ? .2
    : context.moving ? .58 : caring ? .3 : exploring ? .38 + Math.max(0, stimulation[action!]) * .5 : .22;
  const arousalTarget = unit(activation + (context.sheltered ? 0 : unit(context.rain) * .14) + needs.attention * .18);
  mind.arousal = unit(currentArousal + (arousalTarget - currentArousal) * (1 - Math.exp(-dt / 14)));
}

/** Each evaluation combines current motives and recency; noise is bounded by callers. */
export function scoreForestAction(mind: ForestMindState, action: ForestMindAction, key: string,
  context: { rain: number; dusk: number; cost?: number; noise?: number }): ForestMindCandidate {
  const n = mind.needs, tired = 1 - n.energy, curious = n.curiosity, discomfort = 1 - n.comfort;
  const experience = completedExperience(mind), arousal = finite(mind.arousal, restoredArousal(mind, experience.saturation), 1);
  const reasons: string[] = [];
  let score = .7;
  if (action === "rest" || action === "home-sleep") {
    score += tired * tired * 6 + unit(context.dusk) * .45;
    reasons.push(n.energy < .4 ? "Устал и хочет восстановить силы" : "Отдых пока не особенно нужен");
    if (action === "home-sleep") {
      score += unit(context.rain) * discomfort * 3;
      reasons.push(context.rain > .35 ? "В домике сухо и уютно" : "Можно отдохнуть дома");
    } else if (context.rain > .35) score -= 4;
    if (mind.elapsed < mind.attentionUntil) return { key, action, score: null, available: false, reasons: ["Недавно разбудили — остаётся с игроком"], selected: false };
  } else if (action === "groom") {
    score += discomfort * 3 + unit(context.rain) * .55;
    reasons.push(discomfort > .3 ? "Хочется привести мокрую шерсть в порядок" : "Спокойное занятие на полянке");
  } else if (productiveCare(action)) {
    // Availability is owned by the garden: a dry bush or a ripe harvest gives this
    // calm task its purpose. It should never turn into a need to work while tired.
    score += .85 + curious * .7 + n.energy * .85 - tired * 2
      - unit(context.rain) * 1.8 - unit(context.dusk) * .4 - n.attention * .5;
    reasons.push(action === "water-bush" ? "Кусту пригодится вода — можно спокойно позаботиться о нём"
      : "Ягоды созрели — можно отнести их в корзинку");
    if (n.energy < .4) reasons.push("Сначала нужно восстановить силы — забота о кусте подождёт");
  } else if (action === "idle") {
    score += tired * .5 + n.attention * .8;
    reasons.push(n.attention > .3 ? "Прислушивается к игроку" : "Можно немного осмотреться");
  } else {
    score += curious * (action === "look" || action === "sniff" ? 2.3 : 2.8) + n.energy * .5 - tired * 1.2;
    if (action === "bush") score -= unit(context.rain) * 2;
    score -= n.attention * .25;
    reasons.push(curious > .5 ? "Любопытно исследовать что-то новое" : "Рядом есть интересное занятие");
    if (n.energy < .35) reasons.push("Сил немного — активность менее привлекательна");
  }
  const tempo = (.45 - arousal) * stimulation[action] * 1.25;
  const impressions = -experience.saturation * stimulation[action] * .65;
  score += tempo + impressions;
  if (arousal > .58 && Math.abs(tempo) > .12) reasons.push("После оживления тянется к спокойному занятию");
  else if (arousal < .3 && tempo > .12) reasons.push("Отдохнул от суеты — готов немного оживиться");
  if (experience.saturation > .35 && Math.abs(impressions) > .12) reasons.push("Набрался впечатлений — хочется спокойствия");
  const family = actionFamily[action];
  // Variety never makes necessary rest less attractive. Failed attempts already have
  // their own recency penalty and must not count as satisfying experiences.
  if (family !== "rest" && family !== "idle" && experience.total) {
    const share = experience.families[family] / experience.total;
    const variety = experience.variety * (.45 - share * 1.5);
    score += variety;
    if (Math.abs(variety) > .1) reasons.push(variety < 0 ? "Недавно занимался похожим — хочется разнообразия" : "Другое занятие внесёт разнообразие");
  }
  let recoveryStillNeeded = false;
  const repeat = mind.recent.reduce((sum, previous) => {
    const age = Math.max(0, mind.elapsed - previous.at);
    const same = previous.key === key ? 2.8 : previous.action === action ? .7 : 0;
    const freshness = Math.max(0, 1 - age / (previous.outcome === "failed" ? 45 : 100));
    // A short completed rest may leave him exhausted. Avoiding repeated leisure
    // must not prevent necessary recovery; failed and interrupted routes still cool down.
    const repetitionWeight = family === "rest" && actionFamily[previous.action] === "rest" && previous.outcome === "completed"
      ? unit((n.energy - .1) / .3) : 1;
    if (same * freshness > 0 && repetitionWeight < 1) recoveryStillNeeded = true;
    return sum + same * freshness * repetitionWeight;
  }, 0);
  if (recoveryStillNeeded) reasons.push("Недавнего отдыха не хватило — восстановить силы важнее разнообразия");
  if (repeat > .1) reasons.push("Недавно уже пробовал — лучше сменить занятие");
  const cost = Math.max(0, Math.min(3, context.cost ?? 0));
  if (cost > .4) reasons.push("До цели нужно пройти по безопасному пути");
  score += Math.max(0, Math.min(.6, context.noise ?? 0)) - repeat - cost;
  return { key, action, score, available: true, reasons, selected: false };
}
export function recordForestCandidates(mind: ForestMindState, candidates: ForestMindCandidate[], selectedKey: string | null) {
  mind.candidates = candidates.slice(0, 32).map(candidate => ({ ...candidate, reasons: [...candidate.reasons], selected: candidate.key === selectedKey }));
}
export function beginForestIntention(mind: ForestMindState, action: ForestMindAction, key: string, reason: string, source: "clearing" | "director") {
  if (mind.intention?.key === key && mind.intention.action === action) return;
  if (mind.intention) finishForestIntention(mind, "interrupted", "Переключился на другое занятие");
  mind.intention = { key, action, reason, startedAt: mind.elapsed, source };
  event(mind, "selected", action, reason);
}
export function finishForestIntention(mind: ForestMindState, outcome: ForestMindOutcome, reason: string) {
  const intention = mind.intention;
  if (!intention) return;
  mind.recent.push({ key: intention.key, action: intention.action, outcome, at: mind.elapsed, duration: Math.max(0, mind.elapsed - intention.startedAt) });
  mind.recent = mind.recent.filter(item => mind.elapsed - item.at <= 300).slice(-16);
  if (outcome === "completed") {
    if (interesting(intention.action)) {
      const experience = completedExperience(mind), familiar = unit(experience.families[actionFamily[intention.action]] / 3);
      mind.needs.curiosity = unit(mind.needs.curiosity * (1 - .08 * (1 - familiar * .75)));
    }
    if (intention.action === "groom") mind.needs.comfort = unit(mind.needs.comfort + .06);
    if (productiveCare(intention.action)) {
      // Satisfaction is a small calming effect from actually finishing the task.
      // It grants neither energy nor impressions, and interrupted work cannot earn it.
      const arousal = forestMindMotives(mind).arousal;
      mind.arousal = arousal - Math.max(0, arousal - .22) * .25;
    }
  }
  event(mind, outcome, intention.action, reason); mind.intention = null;
}
export function noticeForestMind(mind: ForestMindState, options: { rested?: boolean } = {}) {
  const wasSleeping = mind.intention?.action === "home-sleep" && options.rested;
  finishForestIntention(mind, wasSleeping ? "completed" : "interrupted", wasSleeping ? "Отдохнул и услышал игрока" : "Услышал игрока");
  const log = mind.needs.attention < .9 || mind.elapsed - (mind.events.at(-1)?.at ?? -10) >= 2;
  mind.needs.attention = 1; mind.attentionUntil = mind.elapsed + 30;
  mind.arousal = Math.max(forestMindMotives(mind).arousal, .7);
  if (log) event(mind, "attention", null, "Игрок позвал — отвечает и некоторое время остаётся бодрым");
}
export function forestMindMood(mind: ForestMindState): { label: string; description: string } {
  if (mind.needs.attention > .65) return { label: "Рад тебя видеть", description: "Услышал тебя и готов немного побыть рядом." };
  if (mind.needs.energy < .3) return { label: "Хочет отдохнуть", description: "Нагулялся — выбирает спокойное занятие или отдых." };
  if (mind.needs.comfort < .45) return { label: "Хочется уюта", description: "Сырая погода располагает к отдыху и укрытию." };
  if (mind.needs.curiosity > .6) return { label: "Любопытничает", description: "Хочет исследовать полянку и понаблюдать за её обитателями." };
  return { label: "Всё хорошо", description: "Спокойно живёт на полянке и сам выбирает занятия." };
}
export function forestMindFrame(mind: ForestMindState): ForestMindState {
  return { ...mind, needs: { ...mind.needs }, intention: mind.intention ? { ...mind.intention } : null,
    recent: mind.recent.map(item => ({ ...item })), candidates: mind.candidates.map(item => ({ ...item, reasons: [...item.reasons] })),
    events: mind.events.map(item => ({ ...item })) };
}

/** Restore motives and short memory only. Replaying a half-finished jump is unsafe. */
export function restoreForestMind(value: unknown): ForestMindState {
  const mind = createForestMind();
  if (!value || typeof value !== "object" || Array.isArray(value)) return mind;
  const saved = value as Record<string, unknown>;
  mind.elapsed = finite(saved.elapsed, 0, 1e9);
  if (saved.needs && typeof saved.needs === "object") for (const key of ["energy", "curiosity", "comfort", "attention"] as const)
    mind.needs[key] = finite((saved.needs as Record<string, unknown>)[key], mind.needs[key], 1);
  mind.attentionUntil = Math.min(mind.elapsed + 30, finite(saved.attentionUntil, 0));
  if (Array.isArray(saved.recent)) for (const entry of saved.recent.slice(-16)) {
    if (!entry || typeof entry !== "object" || typeof entry.key !== "string" || entry.key.length > 160
      || !actions.includes(entry.action) || !["completed", "interrupted", "failed"].includes(entry.outcome)
      || !Number.isFinite(entry.at) || entry.at < 0 || entry.at > mind.elapsed || mind.elapsed - entry.at > 300) continue;
    mind.recent.push({ key: entry.key, action: entry.action, outcome: entry.outcome, at: entry.at, duration: finite(entry.duration, 0, 3600) });
  }
  // Ignore a saved transient value: the account contract contains only the four needs.
  mind.arousal = restoredArousal(mind, completedExperience(mind).saturation);
  event(mind, "restored", null, "Вспомнил недавние занятия и вернулся в безопасное состояние");
  return mind;
}
