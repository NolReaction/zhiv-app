import { clearingActivityFrame } from "./clearing-activity";
import { forestMindActionLabel, forestMindMood, forestMindMotives, type ForestMindMotives } from "./forest-mind";
import type { ForestSessionState } from "./forest-session";
import type { ForestMemorySyncStatus } from "./forest-memory-sync";
import { FOREST_GARDEN_LIMITS, gardenEligibleBushes } from "./forest-garden";

export type ForestGardenObservation = Readonly<{
  managed?: boolean;
  bushes: ReadonlyArray<Readonly<{ id: string; growth: number; moisture: number; waterIn: number }>>;
  basket: Readonly<{ berries: number; capacity: number }> | null;
  activity: Readonly<{ kind: "water-bush" | "harvest-berries"; phase: string; carryingBasket: boolean }> | null;
  cooldown: number;
  waterReason: string | null; harvestReason: string | null;
}>;

export type ForestObservation = Readonly<{
  activity: string; detail: string; mood: string;
  needs: Readonly<{ energy: number; curiosity: number; comfort: number; attention: number }>;
  sleeping: boolean; paused: boolean;
  memory: Readonly<{ status: "session" | "saved" | "restored" | "unavailable"; savedAt: number | null;
    sync?: ForestMemorySyncStatus }>;
  diagnostics: Readonly<{
    reason: string;
    motives?: Readonly<ForestMindMotives>;
    garden?: ForestGardenObservation;
    candidates: ReadonlyArray<Readonly<{ id: string; label: string; score: number; available: boolean; reason: string }>>;
    events: ReadonlyArray<Readonly<{ id: number; at: number; type: string; label: string; reason: string }>>;
  }>;
}>;
type Options = { paused?: boolean; manual?: boolean; now?: number; force?: boolean; exploration?: string | null };
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
  if (options.exploration) return { label: "В исследовании", detail: options.exploration };
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
  if (life.garden?.routine) {
    const routine = life.garden.routine;
    const phaseDetail: Record<string, string> = {
      "approach-basket": "Идёт за корзинкой, чтобы собрать спелые ягоды.",
      "take-basket": "Поднимает корзинку перед сбором ягод.",
      "approach-bush": routine.kind === "water-bush" ? "Идёт к сухому кусту с лейкой." : "Несёт корзинку к спелым ягодам.",
      water: life.garden.production === undefined ? "Осторожно поливает землю у корней. Влажная почва помогает ягодам расти."
        : "Осторожно поливает землю у корней. Срок созревания задан рецептом.",
      collect: "Аккуратно снимает спелые ягоды и складывает их в корзинку.",
      "return-basket": "Возвращает корзинку с урожаем на её место.",
      deposit: "Ставит собранные ягоды рядом с домом.",
      settle: "Закончил заботиться о кусте и убирает инструмент.",
    };
    return { label: routine.kind === "water-bush" ? "Заботится о ягодном кусте" : "Собирает ягоды в корзинку",
      detail: phaseDetail[routine.phase] ?? "Занимается ягодным кустом на полянке." };
  }
  if (fauna.encounter) {
    const { kind, phase } = fauna.encounter;
    if (phase === "release" || phase === "interrupt") return { label: kind === "butterfly" ? "Провожает бабочку" : "Провожает светлячка",
      detail: "Даёт маленькому соседу спокойно улететь." };
    if (phase !== "perch") return { label: kind === "butterfly" ? "Заметил бабочку" : "Заметил светлячка",
      detail: "Остановился и ждёт, пока маленький сосед подлетит поближе." };
    return { label: kind === "butterfly" ? "Играет с бабочкой" : "Наблюдает за светлячком",
      detail: "Маленький сосед устроился рядом. Мохлик осторожно рассматривает его." };
  }
  if (state.director.campfireVisit) return { label: "Греется у костра", detail: "Устроился у вечернего огня. Можно позвать его нажатием." };
  if (state.pendingLife === "campfire") return { label: "Идёт к костру", detail: state.director.reason };
  if (state.director.birdwatch) return { label: "Наблюдает за птицей",
    detail: "Тихо смотрит на маленького соседа на ветке. Скоро вернётся к своим делам." };
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
const seconds = (value: number) => Math.ceil(Math.max(0, Math.min(3600, Number.isFinite(value) ? value : 0)));

function gardenObservation(state: ForestSessionState): ForestGardenObservation | undefined {
  const garden = state.life.garden;
  if (!garden) return undefined;
  const cooldown = seconds(garden.nextActionAt - garden.elapsed);
  const commonReason = !garden.bushes.length ? "Нет ягодного куста с точкой подхода. Проверьте Bushes в Tiled."
    : garden.routine ? "Мохлик уже занимается кустом. Можно отменить занятие."
    : garden.bushes.every(bush => bush.artworkPending) ? "Разместите картинку куста в Tiled поверх его контура. Рост и урожай сохранены."
    : cooldown ? "Мохлик немного отдыхает между занятиями."
    : !garden.bushes.some(bush => bush.workPosition) ? "Нет безопасной точки подхода к кусту. Проверьте свободное место рядом с контуром и WalkAreas в Tiled." : null;
  const waterReason = commonReason ?? (gardenEligibleBushes(garden, "water-bush").length ? null
    : "Полив пока не нужен: куст влажный, недавно полит или ягоды уже созрели.");
  const managed = garden.production !== undefined;
  const harvestReason = managed ? "Соберите готовый урожай кнопкой в меню куста. Результат поступит в кладовую после подтверждения сервера."
    : commonReason ?? (!garden.basket ? "Для корзинки не найдено свободное место рядом с домом."
    : garden.basket.berries + FOREST_GARDEN_LIMITS.harvest > garden.basket.capacity ? "Корзинка заполнена. Новый урожай пока остаётся на кусте."
    : gardenEligibleBushes(garden, "harvest-berries").length ? null : "Ягоды ещё растут. Для проверки нажмите «Созреть ягодам · DEV».");
  return Object.freeze({
    ...(managed ? { managed: true } : {}),
    bushes: Object.freeze(garden.bushes.slice(0, FOREST_GARDEN_LIMITS.maxBushes).map(bush => Object.freeze({
      id: bush.id.slice(0, 128), growth: percent(bush.growth), moisture: percent(bush.moisture), waterIn: seconds(bush.waterIn),
    }))),
    basket: garden.basket ? Object.freeze({ berries: Math.round(Math.max(0, Math.min(FOREST_GARDEN_LIMITS.capacity,
      Number.isFinite(garden.basket.berries) ? garden.basket.berries : 0))), capacity: FOREST_GARDEN_LIMITS.capacity }) : null,
    activity: garden.routine ? Object.freeze({ kind: garden.routine.kind, phase: garden.routine.phase,
      carryingBasket: Boolean(garden.routine.carryingBasket) }) : null,
    cooldown, waterReason, harvestReason,
  });
}
function eventId(value: string) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/** A detached, bounded read model; never gives React ownership of simulation objects. */
export function forestObservationFrame(state: ForestSessionState, options: Options = {}): ForestObservation {
  const mind = state.clearing.behavior.mind;
  const activity = currentActivity(state, options), mood = forestMindMood(mind);
  const motives = forestMindMotives(mind);
  const garden = gardenObservation(state);
  const memory = state.memory;
  const status = memory?.mode === "unavailable" ? "unavailable" : !memory?.enabled || memory.mode === "ephemeral" ? "session"
    : memory.restored ? "restored" : memory.lastSavedAt !== null ? "saved" : "session";
  return Object.freeze({
    activity: activity.label, detail: `${activity.detail} ${mood.description}`, mood: mood.label,
    needs: Object.freeze({ energy: percent(mind.needs.energy), curiosity: percent(mind.needs.curiosity),
      comfort: percent(mind.needs.comfort), attention: percent(mind.needs.attention) }),
    sleeping: !options.exploration && (state.clearing.stage === "home-sleep" || clearingActivityFrame(state.clearing).pose === "sleep"),
    paused: Boolean(options.paused) || memory?.sync?.mode === "other-device",
    memory: Object.freeze({ status, savedAt: memory?.lastSavedAt ?? null,
      ...(memory?.sync ? { sync: Object.freeze({ ...memory.sync }) } : {}) }),
    diagnostics: Object.freeze({ reason: mind.intention?.reason ?? state.director.reason ?? activity.detail,
      motives: Object.freeze({ arousal: percent(motives.arousal), saturation: percent(motives.saturation), variety: percent(motives.variety) }),
      ...(garden ? { garden } : {}),
      candidates: Object.freeze(mind.candidates.slice(0, 32).map(candidate => Object.freeze({ id: candidate.key,
        label: candidate.key === "campfire" ? "Погреться у костра" : candidate.key === "watch-birds" ? "Наблюдает за птицей" : forestMindActionLabel(candidate.action), score: candidate.score ?? 0, available: candidate.available,
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
  const phase = `${state.clearing.stage}:${state.life.routine?.kind}:${state.life.garden?.routine?.kind}:${state.life.garden?.routine?.phase}:${state.fauna.encounter?.phase}:${Boolean(state.director.birdwatch)}:${Boolean(state.director.campfireVisit)}:${state.pendingAttention}:${state.reaction > 0}:${Boolean(options.paused)}:${Boolean(options.manual)}:${state.memory.sync?.mode}:${options.exploration ?? ""}`;
  if (!options.force && previous?.phase === phase && now < previous.nextAt) return;
  const snapshot = forestObservationFrame(state, options), signature = JSON.stringify(snapshot);
  if (previous?.signature === signature) { previous.nextAt = now + 500; previous.phase = phase; return; }
  entries.set(key, { snapshot, signature, phase, nextAt: now + 500 }); notify(key);
}
