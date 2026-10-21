export const WORLD_DEV_SCENE_ACTORS = [
  { id: "mochlik", label: "Мохлик" }, { id: "plesk", label: "Плёска" }, { id: "builder", label: "Шишколап" },
  { id: "lopukh", label: "Лопоух" }, { id: "kamneshmyg", label: "Камнешмыг" }, { id: "leaftail", label: "Листохвост" },
] as const;
export type WorldDevSceneActor = typeof WORLD_DEV_SCENE_ACTORS[number]["id"];
const all = WORLD_DEV_SCENE_ACTORS.map(actor => actor.id);
const neighbours = ["mochlik", "plesk", "lopukh", "kamneshmyg", "leaftail"] as const;

export const WORLD_DEV_SCENES = [
  { id: "walk", label: "Прогулка", description: "Пройти по доступной тропе с текущего места и остановиться.", seconds: 60, actors: all },
  { id: "work", label: "На работу", description: "Подойти к рабочему месту и показать занятие. Шахтёр входит в пещеру.", seconds: 60,
    actors: ["builder", "lopukh", "kamneshmyg"] },
  { id: "carry", label: "Перенести бревно", description: "Лопоух подходит за древесиной и несёт бревно домой.", seconds: 60, actors: ["lopukh"] },
  { id: "conversation", label: "Разговор с соседом", description: "Подойти к выбранному соседу и закончить короткий разговор.", seconds: 90, actors: all },
  { id: "trade-visit", label: "К окну Листохвоста", description: "Подойти к лавке и поговорить с торговцем у окна.", seconds: 90,
    actors: ["mochlik", "plesk", "builder", "lopukh", "kamneshmyg"] },
  { id: "butterfly", label: "Бабочка на лапе", description: "Дождаться доступной бабочки рядом, принять на лапу и отпустить.", seconds: 45, actors: neighbours },
  { id: "watch-birds", label: "Наблюдение за птицей", description: "Посмотреть на настоящую сидящую птицу рядом.", seconds: 45,
    actors: ["mochlik", "lopukh", "kamneshmyg", "leaftail"] },
  { id: "plesk-home", label: "Дом Плёски", description: "Плёска заканчивает занятие, подходит к дому и заходит внутрь.", seconds: 60, actors: ["plesk"] },
  { id: "home", label: "Зайти домой", description: "Житель подходит к своему дому, проходит порог и остаётся внутри.", seconds: 90, actors: all },
  { id: "narrow-passing", label: "Встречный проход", description: "Лопоух и Камнешмыг подходят к узкому участку настоящей тропы и меняются сторонами.", seconds: 120, actors: ["lopukh"] },
  { id: "occupied-door", label: "Занятая дверь", description: "Камнешмыг подходит к входу Лопоуха, затем освобождает его. Проверяем вход без прохода сквозь соседа.", seconds: 120, actors: ["lopukh"] },
  { id: "carry-crossing", label: "Бревно и встречный сосед", description: "Лопоух несёт настоящее бревно из рабочего цикла; Камнешмыг проходит навстречу по тому же участку.", seconds: 120, actors: ["lopukh"] },
  { id: "work-interruption", label: "Работа во время беседы", description: "Начать разговор, затем выдать тестовое рабочее поручение. Беседа должна уступить работе.", seconds: 120, actors: ["lopukh", "kamneshmyg"] },
  { id: "leaftail-arrival", label: "Листохвост приплывает", description: "Лодка проходит по настоящей воде; торговец сходит на берег и идёт к своему фургону.", seconds: 75, actors: ["leaftail"] },
] as const satisfies readonly { id: string; label: string; description: string; seconds: number; actors: readonly WorldDevSceneActor[] }[];
export type WorldDevSceneScenario = typeof WORLD_DEV_SCENES[number]["id"];
export type WorldDevSceneRequest = Readonly<{ id: number; scenario: WorldDevSceneScenario; actor: WorldDevSceneActor; target?: WorldDevSceneActor; seed?: number }>;
export const WORLD_DEV_SCENE_PHASES = ["queued", "running", "complete", "blocked", "stopped"] as const;
export type WorldDevScenePhase = typeof WORLD_DEV_SCENE_PHASES[number];
export type WorldDevSceneFeedback = Readonly<{ id: number; phase: WorldDevScenePhase; message: string }>;
export type ForestScenePreview = { request: WorldDevSceneRequest; elapsed: number; phase: WorldDevScenePhase; message: string };
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isActor = (value: unknown): value is WorldDevSceneActor => WORLD_DEV_SCENE_ACTORS.some(actor => actor.id === value);
const terminal = (phase: WorldDevScenePhase) => phase === "complete" || phase === "blocked" || phase === "stopped";
const partners: Record<WorldDevSceneActor, WorldDevSceneActor> = {
  mochlik: "plesk", plesk: "mochlik", builder: "lopukh", lopukh: "leaftail", kamneshmyg: "builder", leaftail: "lopukh",
};

export function worldDevScenesFor(actor: WorldDevSceneActor) {
  return WORLD_DEV_SCENES.filter(scene => (scene.actors as readonly string[]).includes(actor));
}

/** Requests select an existing actor and a finite presentation; they own no
 * actor coordinates, economy jobs, account identifiers or persistence. */
export function normalizeWorldDevSceneRequest(value: unknown): WorldDevSceneRequest | null {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || (value.id as number) <= 0 || !isActor(value.actor)) return null;
  const scene = WORLD_DEV_SCENES.find(scene => scene.id === value.scenario);
  if (!scene || !(scene.actors as readonly string[]).includes(value.actor)) return null;
  if (value.seed !== undefined && (!Number.isSafeInteger(value.seed) || (value.seed as number) < 1 || (value.seed as number) > 0xffffffff)) return null;
  const seed = value.seed === undefined ? {} : { seed: value.seed as number };
  if (scene.id === "conversation") {
    const target = value.target === undefined ? partners[value.actor] : value.target;
    if (!isActor(target) || target === value.actor) return null;
    return Object.freeze({ id: value.id as number, scenario: scene.id, actor: value.actor, target, ...seed });
  }
  if (scene.id === "trade-visit") return Object.freeze({ id: value.id as number, scenario: scene.id, actor: value.actor, target: "leaftail", ...seed });
  if (scene.id === "work-interruption") return Object.freeze({ id: value.id as number, scenario: scene.id, actor: value.actor,
    target: value.actor === "lopukh" ? "kamneshmyg" : "lopukh", ...seed });
  return Object.freeze({ id: value.id as number, scenario: scene.id, actor: value.actor, ...seed });
}

export function normalizeWorldDevSceneFeedback(id: number, phase: unknown, message: unknown): WorldDevSceneFeedback | null {
  if (!Number.isSafeInteger(id) || id <= 0 || !WORLD_DEV_SCENE_PHASES.some(value => value === phase)
    || typeof message !== "string" || !message.trim()) return null;
  return Object.freeze({ id, phase: phase as WorldDevScenePhase, message: message.trim().slice(0, 240) });
}

export function createForestScenePreview(request: WorldDevSceneRequest): ForestScenePreview | null {
  const normalized = normalizeWorldDevSceneRequest(request);
  return normalized ? { request: normalized, elapsed: 0, phase: "queued", message: "Подготовка репетиции…" } : null;
}

export function setForestScenePreviewStatus(state: ForestScenePreview, phase: WorldDevScenePhase, message: string): boolean {
  const feedback = normalizeWorldDevSceneFeedback(state.request.id, phase, message);
  if (!feedback || terminal(state.phase) || state.phase === feedback.phase && state.message === feedback.message) return false;
  state.phase = feedback.phase; state.message = feedback.message; return true;
}

/** The shared session owner supplies its time. Sampling a preview, another
 * camera, reduced motion and a paused/backgrounded scene cannot consume it. */
export function advanceForestScenePreview(state: ForestScenePreview, delta: number,
  environment: { paused?: boolean; reducedMotion?: boolean } = {}): boolean {
  if (terminal(state.phase)) return false;
  if (environment.paused || environment.reducedMotion || !Number.isFinite(delta) || delta <= 0) return true;
  const duration = WORLD_DEV_SCENES.find(scene => scene.id === state.request.scenario)!.seconds;
  state.elapsed = Math.min(duration, state.elapsed + Math.min(.5, delta));
  if (state.elapsed >= duration) setForestScenePreviewStatus(state, "complete", "Репетиция завершена по лимиту времени.");
  else if (state.phase === "queued") setForestScenePreviewStatus(state, "running", "Репетиция идёт на карте.");
  return !terminal(state.phase);
}

export function forestScenePreviewFeedback(state: ForestScenePreview): WorldDevSceneFeedback {
  return Object.freeze({ id: state.request.id, phase: state.phase, message: state.message });
}
