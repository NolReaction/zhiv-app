import { clearingActivityFrame } from "./clearing-activity";
import { forestMindActionLabel, forestMindMood } from "./forest-mind";
import type { ForestSessionState } from "./forest-session";

export type ForestObservation = Readonly<{
  activity: string; detail: string; mood: string;
  needs: Readonly<{ energy: number; curiosity: number; comfort: number; attention: number }>;
  sleeping: boolean; paused: boolean;
  memory: Readonly<{ status: "session" | "saved" | "restored" | "unavailable"; savedAt: number | null }>;
  diagnostics: Readonly<{
    reason: string;
    candidates: ReadonlyArray<Readonly<{ id: string; label: string; score: number; available: boolean; reason: string }>>;
    events: ReadonlyArray<Readonly<{ id: number; at: number; type: string; label: string; reason: string }>>;
  }>;
}>;
type Options = { paused?: boolean; manual?: boolean; now?: number; force?: boolean };
type ObservationEntry = { snapshot: ForestObservation; signature: string; phase: string; nextAt: number };
const entries = new Map<string, ObservationEntry>();
const subscribers = new Map<string, Set<() => void>>();
const pending = new Set<string>();

function notify(key: string) {
  if (pending.has(key)) return;
  pending.add(key);
  // Canvas updates may occur during view mounting. React observes them after it commits.
  queueMicrotask(() => {
    pending.delete(key);
    for (const listener of [...subscribers.get(key) ?? []]) listener();
  });
}
export function subscribeForestObservation(key: string | undefined, listener: () => void) {
  if (!key) return () => {};
  let listeners = subscribers.get(key);
  if (!listeners) { listeners = new Set(); subscribers.set(key, listeners); }
  listeners.add(listener);
  return () => { listeners!.delete(listener); if (!listeners!.size) subscribers.delete(key); };
}
export const getForestObservation = (key: string | undefined): ForestObservation | null => key ? entries.get(key)?.snapshot ?? null : null;
export const getServerForestObservation = (): ForestObservation | null => null;
export function forgetForestObservation(key: string | undefined) {
  if (key && entries.delete(key)) notify(key);
}

function currentActivity(state: ForestSessionState, options: Options) {
  const { clearing, life, fauna } = state;
  const frame = clearingActivityFrame(clearing);
  if (options.manual) return { label: "Показывает анимацию", detail: "Сейчас включён просмотр позы Мохлика." };
  if (clearing.stage === "home-sleep") return { label: "Спит в домике", detail: "Уютно устроился дома. Нажми на круг или Мохлика, чтобы позвать его." };
  if (clearing.stage === "exiting" || clearing.stage === "home-return" || clearing.freePurpose === "interaction-exit")
    return { label: "Возвращается на полянку", detail: "Заканчивает выход и снова будет готов к своим занятиям." };
  if (clearing.stage === "attention" || state.reaction > 0)
    return { label: "Рад тебя видеть", detail: "Услышал тебя и отвлёкся от своих дел." };
  if (state.pendingAttention) return { label: "Отвлекается на тебя", detail: "Аккуратно заканчивает встречу, чтобы ответить тебе." };
  if (clearing.stage === "homebound" || clearing.stage === "entering")
    return { label: "Отправляется домой", detail: "Собирается отдохнуть в домике." };
  if (clearing.stage.startsWith("bush-")) return { label: clearing.stage === "bush-hidden" ? "Прячется в кусте" : "Исследует куст",
    detail: "Возится среди листьев и ягод. Скоро выберется обратно." };
  if (fauna.encounter) {
    const { kind, phase } = fauna.encounter;
    if (phase === "release" || phase === "interrupt") return { label: kind === "butterfly" ? "Провожает бабочку" : "Провожает светлячка",
      detail: "Даёт маленькому соседу спокойно улететь." };
    if (phase !== "perch") return { label: kind === "butterfly" ? "Заметил бабочку" : "Заметил светлячка",
      detail: "Остановился и ждёт, пока маленький сосед подлетит поближе." };
    return { label: kind === "butterfly" ? "Играет с бабочкой" : "Наблюдает за светлячком",
      detail: "Маленький сосед устроился рядом. Мохлик осторожно рассматривает его." };
  }
  if (life.routine) return { label: forestMindActionLabel(life.routine.kind), detail: life.routine.kind === "mushroom"
    ? "Нашёл выросший гриб и решил им заняться." : "Увлёкся своей находкой на полянке." };
  if (frame.pose === "walk") {
    const action = clearing.behavior.mind.intention?.action;
    const label = action === "mushroom" ? "Идёт к грибу" : action === "leaf" ? "Идёт к листику"
      : action === "bush" ? "Идёт к кусту" : action === "home-sleep" ? "Отправляется домой" : "Гуляет по полянке";
    return { label, detail: "Выбрал место и спокойно идёт к нему." };
  }
  if (frame.pose === "sleep" || frame.pose === "drowsy" || frame.pose === "yawn")
    return { label: "Отдыхает", detail: "Ненадолго устроился отдохнуть. Можно позвать его нажатием." };
  if (clearing.stage === "activity" && clearing.lastActivity)
    return { label: forestMindActionLabel(clearing.lastActivity), detail: "Занимается своими делами на полянке." };
  return { label: "Осматривает полянку", detail: "Немного присматривается и выбирает следующее занятие." };
}
const percent = (value: number) => Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100) / 100;
function eventId(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/** A detached, bounded read model; never gives React ownership of simulation objects. */
export function forestObservationFrame(state: ForestSessionState, options: Options = {}): ForestObservation {
  const mind = state.clearing.behavior.mind;
  const activity = currentActivity(state, options), mood = forestMindMood(mind);
  const memory = state.memory;
  const status = memory?.mode === "unavailable" ? "unavailable" : !memory?.enabled || memory.mode === "ephemeral" ? "session"
    : memory.restored ? "restored" : memory.lastSavedAt !== null ? "saved" : "session";
  return Object.freeze({
    activity: activity.label, detail: `${activity.detail} ${mood.description}`, mood: mood.label,
    needs: Object.freeze({ energy: percent(mind.needs.energy), curiosity: percent(mind.needs.curiosity),
      comfort: percent(mind.needs.comfort), attention: percent(mind.needs.attention) }),
    sleeping: state.clearing.stage === "home-sleep" || clearingActivityFrame(state.clearing).pose === "sleep",
    paused: Boolean(options.paused), memory: Object.freeze({ status, savedAt: memory?.lastSavedAt ?? null }),
    diagnostics: Object.freeze({ reason: mind.intention?.reason ?? activity.detail,
      candidates: Object.freeze(mind.candidates.slice(0, 32).map(candidate => Object.freeze({ id: candidate.key,
        label: forestMindActionLabel(candidate.action), score: candidate.score ?? 0, available: candidate.available,
        reason: `${candidate.selected ? "Выбрано. " : ""}${candidate.reasons.join(". ")}` }))),
      events: Object.freeze(mind.events.slice(-24).map(item => Object.freeze({ id: eventId(`${item.at}:${item.type}:${item.action}:${item.reason}`),
        at: item.at, type: item.type, label: item.action ? forestMindActionLabel(item.action) : item.type === "restored" ? "Память восстановлена" : "Внимание игрока",
        reason: item.reason }))),
    }),
  });
}

/** Semantic transitions publish immediately; meters and scores update at most twice a second. */
export function publishForestObservation(key: string | undefined, state: ForestSessionState, options: Options = {}) {
  if (!key) return;
  const now = options.now ?? Date.now(), previous = entries.get(key);
  const phase = `${state.clearing.stage}:${state.life.routine?.kind}:${state.fauna.encounter?.phase}:${state.pendingAttention}:${state.reaction > 0}:${Boolean(options.paused)}:${Boolean(options.manual)}`;
  if (!options.force && previous?.phase === phase && now < previous.nextAt) return;
  const snapshot = forestObservationFrame(state, options), signature = JSON.stringify(snapshot);
  if (previous?.signature === signature) { previous.nextAt = now + 500; previous.phase = phase; return; }
  entries.set(key, { snapshot, signature, phase, nextAt: now + 500 }); notify(key);
}
