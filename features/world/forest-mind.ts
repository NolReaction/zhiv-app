/** Small local Utility AI. These are motives, never a feeding or punishment system. */
export type ForestMindAction = "look" | "sniff" | "groom" | "rest" | "bush" | "home-sleep"
  | "butterfly" | "firefly" | "mushroom" | "leaf" | "idle";
export type ForestMindNeeds = { energy: number; curiosity: number; comfort: number; attention: number };
export type ForestMindOutcome = "completed" | "interrupted" | "failed";
export type ForestMindCandidate = {
  key: string; action: ForestMindAction; score: number | null; available: boolean; reasons: string[]; selected: boolean;
};
export type ForestMindState = {
  elapsed: number; needs: ForestMindNeeds; attentionUntil: number;
  intention: { key: string; action: ForestMindAction; reason: string; startedAt: number; source: "clearing" | "director" } | null;
  recent: { key: string; action: ForestMindAction; outcome: ForestMindOutcome; at: number; duration: number }[];
  candidates: ForestMindCandidate[];
  events: { at: number; type: ForestMindOutcome | "selected" | "attention" | "restored"; action: ForestMindAction | null; reason: string }[];
};
const actions: readonly ForestMindAction[] = ["look", "sniff", "groom", "rest", "bush", "home-sleep", "butterfly", "firefly", "mushroom", "leaf", "idle"];
const unit = (value: number) => Math.max(0, Math.min(1, value));
const finite = (value: unknown, fallback: number, max = Number.MAX_SAFE_INTEGER) =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(max, value)) : fallback;
const actionLabel: Record<ForestMindAction, string> = {
  look: "Осматривает полянку", sniff: "Изучает полянку", groom: "Приводит себя в порядок", rest: "Отдыхает",
  bush: "Исследует куст", "home-sleep": "Отдыхает дома", butterfly: "Играет с бабочкой", firefly: "Наблюдает за светлячком",
  mushroom: "Рассматривает гриб", leaf: "Играет с листиком", idle: "Спокойно осматривается",
};
export const forestMindActionLabel = (action: ForestMindAction) => actionLabel[action];
export function createForestMind(): ForestMindState {
  return { elapsed: 0, needs: { energy: .82, curiosity: .58, comfort: .85, attention: 0 }, attentionUntil: 0,
    intention: null, recent: [], candidates: [], events: [] };
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
  needs.curiosity = unit(needs.curiosity + dt * (context.engaged ? -.008 : context.moving ? -.0008 : .002));
  const comfortTarget = context.sheltered ? .98 : 1 - unit(context.rain) * .7 - unit(context.dusk) * .06;
  needs.comfort = unit(needs.comfort + (comfortTarget - needs.comfort) * (1 - Math.exp(-dt / 35)) + (context.grooming ? dt * .003 : 0));
  needs.attention = unit(needs.attention - dt / 45);
}

/** Each evaluation combines current motives and recency; noise is bounded by callers. */
export function scoreForestAction(mind: ForestMindState, action: ForestMindAction, key: string,
  context: { rain: number; dusk: number; cost?: number; noise?: number }): ForestMindCandidate {
  const n = mind.needs, tired = 1 - n.energy, curious = n.curiosity, discomfort = 1 - n.comfort;
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
  const repeat = mind.recent.reduce((sum, previous) => {
    const age = Math.max(0, mind.elapsed - previous.at);
    const same = previous.key === key ? 2.8 : previous.action === action ? .7 : 0;
    return sum + same * Math.max(0, 1 - age / (previous.outcome === "failed" ? 45 : 100));
  }, 0);
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
    if (["look", "sniff", "bush", "butterfly", "firefly", "mushroom", "leaf"].includes(intention.action)) mind.needs.curiosity = unit(mind.needs.curiosity - .08);
    if (intention.action === "groom") mind.needs.comfort = unit(mind.needs.comfort + .06);
  }
  event(mind, outcome, intention.action, reason); mind.intention = null;
}
export function noticeForestMind(mind: ForestMindState, options: { rested?: boolean } = {}) {
  const wasSleeping = mind.intention?.action === "home-sleep" && options.rested;
  finishForestIntention(mind, wasSleeping ? "completed" : "interrupted", wasSleeping ? "Отдохнул и услышал игрока" : "Услышал игрока");
  const log = mind.needs.attention < .9 || mind.elapsed - (mind.events.at(-1)?.at ?? -10) >= 2;
  mind.needs.attention = 1; mind.attentionUntil = mind.elapsed + 30;
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
  event(mind, "restored", null, "Вспомнил недавние занятия и вернулся в безопасное состояние");
  return mind;
}
