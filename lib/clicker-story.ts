export const CLICKER_IDLE_RESET_MS = 30_000;
export const CLICKER_MAX_TAP_COUNT = 100_000;

export const CLICKER_MILESTONES = [
  1, 5, 10, 20, 50, 100, 500, 1_000, 10_000, 100_000,
] as const;

export type ClickerMilestone = (typeof CLICKER_MILESTONES)[number];
export type ClickerEffect =
  | "confetti"
  | "rings"
  | "sparks"
  | "finale"
  | "orbit"
  | "comet"
  | "legend"
  | "champion";

type ClickerScene = { at: ClickerMilestone; message: string };

export type ClickerStory = {
  id: string;
  title: string;
  scenes: readonly ClickerScene[];
};

export type ClickerActiveSeries = {
  eventId: string | null;
  tapCount: number;
  startedAtMs: number;
  lastTapAtMs: number;
  storyId: string;
};

export type ClickerProgress = {
  bestSeries: number;
  completedSeries: number;
  storySeed: number;
  lastStoryId: string | null;
  activeSeries: ClickerActiveSeries | null;
  updatedAtMs: number;
};

export type ClickerFinishedSeries = {
  eventId: string | null;
  tapCount: number;
  durationMs: number;
  storyId: string;
  isRecord: boolean;
};

export type ClickerRun = ClickerProgress;
export type ClickerTapPlan = "ADVANCE_LOCAL" | "START_LOCAL" | "REQUEST_SERVER";

export type ClickerLevel = {
  level: number;
  title: string;
  minimumBest: number;
  nextMinimumBest: number | null;
};

export type ClickerFrame = {
  storyId: string;
  storyTitle: string;
  tapCount: number;
  message: string;
  nextMilestone: ClickerMilestone | null;
  level: ClickerLevel;
};

export type ClickerExpiry = {
  progress: ClickerProgress;
  finishedSeries: ClickerFinishedSeries | null;
};

export type ClickerSeriesTimer = {
  remainingMs: number;
  remainingRatio: number;
};

export type ClickerAdvance = ClickerExpiry & {
  crossedMilestones: readonly ClickerMilestone[];
  effect: ClickerEffect | null;
  levelBefore: ClickerLevel;
  levelAfter: ClickerLevel;
};

type BaseStoryMessages = readonly [
  string, string, string, string, string, string, string, string,
];

function createStory(
  id: string,
  title: string,
  messages: BaseStoryMessages,
  championMessage: string,
): ClickerStory {
  return {
    id,
    title,
    scenes: [
      ...CLICKER_MILESTONES.slice(0, 8).map((at, index) => ({
        at,
        message: messages[index],
      })),
      { at: 10_000, message: `Сюжет «${title}» вышел на легендарный масштаб` },
      { at: 100_000, message: championMessage },
    ] as readonly ClickerScene[],
  };
}

export const CLICKER_STORIES = [
  createStory("space", "Космическая экспедиция", [
    "Экипаж на связи", "Предстартовая проверка пройдена", "Двигатели запущены",
    "Орбита достигнута", "Земля стала маленькой", "Пойман сигнал издалека",
    "Открыта неизвестная планета", "Курс проложен за пределы галактики",
  ], "Ваш позывной услышала вся Вселенная"),
  createStory("lab", "Лаборатория бодрости", [
    "Опыт начался", "Датчики довольны", "Формула бодрости найдена",
    "Энергия вышла за шкалу", "Халат получил повышение", "Открыт элемент Живоний",
    "Наука просит ещё одну серию", "Учебники переписывают прямо сейчас",
  ], "Нобелевка уже печатается"),
  createStory("hike", "Большой поход", [
    "Карта развернута", "Рюкзак собран", "Тропа найдена", "Первый перевал взят",
    "Облака остались внизу", "Привал с отличным видом", "Вершина уже под ногами",
    "Маршрут появился во всех путеводителях",
  ], "Флаг «Я живой» поднят над миром"),
  createStory("arcade", "Аркадный режим", [
    "Игра началась", "Обучение пройдено", "Первое комбо собрано", "Новый уровень открыт",
    "Бонусный мир найден", "Редкий трофей получен", "Таблица рекордов заметила вас",
    "Финальный босс запросил паузу",
  ], "Статус легенды разблокирован"),
  createStory("garden", "Сад на крыше", [
    "Семечко посажено", "Появился росток", "Листья раскрылись", "Сад набирает цвет",
    "Прилетели первые пчёлы", "Созрели первые плоды", "Крыша стала зелёным островом",
    "Сад кормит целый квартал",
  ], "Ботаника вами гордится"),
  createStory("ocean", "Глубокий океан", [
    "Батискаф погружается", "Поверхность осталась наверху",
    "Включены глубоководные фонари", "Обнаружен незнакомый силуэт",
    "Кит передал привет", "Найдена светящаяся долина", "Сонар видит нечто огромное",
    "Достигнута неизведанная глубина",
  ], "Дно нанесено на карту"),
  createStory("magic", "Магическая академия", [
    "Письмо из академии доставлено", "Первая искра получилась",
    "Заклинание запомнило вас", "Метла прошла техосмотр",
    "Библиотека открыла тайный этаж", "Дракон согласился на селфи",
    "Экзаменатор потерял дар речи", "Академия назвала башню в вашу честь",
  ], "Диплом великого мага подписан"),
  createStory("time", "Машина времени", [
    "Хронодвигатель включён", "Вчера осталось позади",
    "Первый временной скачок завершён", "Динозавры заметили гостя",
    "Будущее отправило сообщение", "Парадокс аккуратно обойдён",
    "Все часы начали спешить", "Тысячелетия промелькнули за окном",
  ], "История добавила вашу главу"),
  createStory("cinema", "Киностудия", [
    "Камера включена", "Первый дубль снят", "Сценарий набирает обороты",
    "Каскадёр просит повторить", "Саундтрек уже застрял в голове", "Премьера назначена",
    "Красная дорожка готова", "Зрители требуют продолжение",
  ], "Главный хит века снят"),
  createStory("future", "Город будущего", [
    "Первый модуль установлен", "Улицы включили подсветку", "Роботы вышли на смену",
    "Открыта воздушная трасса", "Дома научились здороваться", "Запущен парк на облаках",
    "Город стал полностью автономным", "Первый район появился на Луне",
  ], "Идеальный мегаполис запущен"),
  createStory("observatory", "Ночная обсерватория", [
    "Купол обсерватории открыт", "Линза поймала первый свет",
    "Сатурн согласился на портрет", "Комета махнула хвостом",
    "Звёзды сложились в новое слово", "Безымянная луна получила имя",
    "Открыта система из пяти солнц", "Телескоп увидел край наблюдаемого мира",
  ], "Эта ночь внесена в вечный атлас"),
  createStory("bakery", "Ночная пекарня", [
    "Закваска проснулась", "Первая партия отправилась в печь",
    "Улица пахнет свежим хлебом", "Круассан достиг идеальной формы",
    "Очередь вышла за угол", "Булочки начали получать имена", "Весь район просит добавки",
    "Пекарня кормит город без остановки",
  ], "Рецепт стал мировой легендой"),
  createStory("detective", "Детективное бюро", [
    "Дело открыто", "Первая улика найдена", "Алиби заметно нервничает",
    "След ведёт на крышу", "Кот явно знает больше", "Шифр наконец сдался",
    "Все свидетели собрались в одной комнате", "Архив нераскрытых дел опустел",
  ], "Дело закрыто, чайник оправдан"),
  createStory("orchestra", "Оркестр на крыше", [
    "Пюпитры расставлены", "Скрипки настроились", "Город услышал первую ноту",
    "Ветер подхватил мелодию", "Соседние крыши включились в ритм",
    "Голуби исполнили сложное соло", "На площади начались танцы",
    "Музыку услышал соседний город",
  ], "Финальный аккорд встретил рассвет"),
  createStory("express", "Полуночный экспресс", [
    "Билет найден в кармане", "Поезд мягко тронулся", "Огни города остались позади",
    "Проводник принёс чай и тайну", "За окном появилось северное сияние",
    "Маршрут проявился на старой карте", "Экспресс обогнал рассвет",
    "Рельсы протянулись через океан",
  ], "Конечная стала началом новой истории"),
  createStory("lighthouse", "Маяк на краю света", [
    "Фонарь маяка зажжён", "Первый луч разрезал туман",
    "Рыбацкая лодка ответила гудком", "Шторм решил обойти берег",
    "Чайки назначили вас смотрителем", "В море появился далёкий парус",
    "Все корабли нашли дорогу домой", "Свет достиг другого материка",
  ], "Маяк пережил самую длинную ночь"),
  createStory("robots", "Мастерская роботов", [
    "Мастерская включена", "Первый сервопривод ожил", "Робот сказал «привет»",
    "Его научили танцевать", "Он задал философский вопрос", "Кофемашина починена",
    "Роботы открыли собственный кружок", "Мастерская автоматизировала весь район",
  ], "Почётный статус человека подтверждён"),
  createStory("polar", "Полярная станция", [
    "Генератор станции запущен", "Температура признала поражение",
    "Радар увидел далёкую метель", "Пингвин пришёл на собеседование",
    "Ледник рассказал древнюю историю", "Полярная ночь стала чуть светлее",
    "Сияние заняло всё небо", "Станция установила рекорд автономности",
  ], "Легендарный отчёт отправлен домой"),
  createStory("library", "Библиотека после закрытия", [
    "Последний читатель ушёл", "Одна книга осталась открытой",
    "Полки начали тихо переговариваться", "Из атласа подул морской ветер",
    "Детективы нашли потерянную главу", "Словарь придумал новое слово",
    "Все истории собрались в одном зале", "Каталог пополнился целой вселенной",
  ], "Библиотека выбрала вас хранителем"),
  createStory("weather", "Бюро хорошей погоды", [
    "Прогноз принят в работу", "Облака аккуратно пронумерованы", "Дождь перенесён на ночь",
    "Ветер получил правильный маршрут", "Радуга согласована без очереди",
    "Солнцу выдали дополнительный час", "Город открыл все окна",
    "Хорошая погода объявлена бессрочной",
  ], "Идеальный день официально утверждён"),
  createStory("radio", "Радио на всю галактику", [
    "Передатчик прогрелся", "Первый позывной ушёл в эфир",
    "Луна заказала любимую песню", "Марс прислал голосовое сообщение",
    "Сигнал обогнул далёкую звезду", "В эфире стало тесно от слушателей",
    "Галактика подпевает припеву", "Передача идёт во всех звёздных системах",
  ], "Ваш голос услышали вообще все"),
  createStory("museum", "Ночь в музее", [
    "Двери музея закрылись", "Старые часы пробили полночь", "Рыцарь поправил шлем",
    "Мамонт попросил потише", "Картины обменялись пейзажами",
    "Динозавр нашёл потерянную табличку", "Экспонаты устроили общий портрет",
    "История вышла из всех витрин",
  ], "К открытию всё почти вернулось на места"),
  createStory("dragons", "Школа драконов", [
    "Первое яйцо треснуло", "Маленький дракон чихнул искрой", "Урок полёта начался",
    "Облако оказалось удобной подушкой", "Огненное дыхание прошло зачёт",
    "Замок получил нового защитника", "Стая построилась над башнями",
    "Все драконы освоили высший пилотаж",
  ], "Вы стали великим наставником драконов"),
  createStory("volcano", "Экспедиция к вулкану", [
    "Базовый лагерь разбит", "Сейсмограф начертил приветствие",
    "Тропа стала заметно теплее", "Кратер показался из облаков",
    "Найден редкий чёрный кристалл", "Лава выбрала безопасный маршрут",
    "Образцы доставлены в лагерь", "Экспедиция заглянула в сердце горы",
  ], "Вулкану присвоено ваше имя"),
] as const satisfies readonly ClickerStory[];

export const CLICKER_LEVELS = [
  { level: 1, title: "Новичок", minimumBest: 0 },
  { level: 2, title: "Искра", minimumBest: 5 },
  { level: 3, title: "Ритм", minimumBest: 10 },
  { level: 4, title: "Импульс", minimumBest: 20 },
  { level: 5, title: "Разгон", minimumBest: 50 },
  { level: 6, title: "Сотник", minimumBest: 100 },
  { level: 7, title: "Марафонец", minimumBest: 500 },
  { level: 8, title: "Тысячник", minimumBest: 1_000 },
  { level: 9, title: "Титан", minimumBest: 10_000 },
  { level: 10, title: "Чемпион", minimumBest: 100_000 },
] as const;

const STORY_STEPS = [1, 5, 7, 11, 13, 17, 19, 23] as const;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MILESTONE_EFFECTS = new Map<ClickerMilestone, ClickerEffect>([
  [5, "confetti"], [20, "rings"], [50, "sparks"], [100, "finale"],
  [500, "orbit"], [1_000, "comet"], [10_000, "legend"], [100_000, "champion"],
]);

function normalizeCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) return 0;
  return Math.min(value, CLICKER_MAX_TAP_COUNT);
}

function normalizeCompletedSeries(value: number): number {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function normalizeSeed(value: number): number {
  return Number.isSafeInteger(value) ? value >>> 0 : 0;
}

function storyById(storyId: string): ClickerStory | null {
  return CLICKER_STORIES.find((story) => story.id === storyId) ?? null;
}

export function clickerSeedFromPublicId(publicId: string): number {
  let hash = 0x811c9dc5;
  for (const character of publicId) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function getStoryForSeries(storySeed: number, completedSeries: number): ClickerStory {
  const seed = normalizeSeed(storySeed);
  const start = seed % CLICKER_STORIES.length;
  const step = STORY_STEPS[(seed >>> 8) % STORY_STEPS.length];
  const index = (start + normalizeCompletedSeries(completedSeries) * step)
    % CLICKER_STORIES.length;
  return CLICKER_STORIES[index];
}

export function getClickerLevel(bestSeries: number): ClickerLevel {
  const best = normalizeCount(bestSeries);
  let current: (typeof CLICKER_LEVELS)[number] = CLICKER_LEVELS[0];
  let nextMinimumBest: number | null = CLICKER_LEVELS[1]?.minimumBest ?? null;
  for (let index = 0; index < CLICKER_LEVELS.length; index += 1) {
    const candidate = CLICKER_LEVELS[index];
    if (candidate.minimumBest > best) break;
    current = candidate;
    nextMinimumBest = CLICKER_LEVELS[index + 1]?.minimumBest ?? null;
  }
  return { ...current, nextMinimumBest };
}

export function createClickerRun(storySeed = 0): ClickerProgress {
  return {
    bestSeries: 0,
    completedSeries: 0,
    storySeed: normalizeSeed(storySeed),
    lastStoryId: null,
    activeSeries: null,
    updatedAtMs: 0,
  };
}

export function getNextClickerMilestone(tapCount: number): ClickerMilestone | null {
  const count = normalizeCount(tapCount);
  return CLICKER_MILESTONES.find((milestone) => milestone > count) ?? null;
}

export function getClickerSeriesTimer(
  progress: ClickerProgress,
  nowMs = Date.now(),
): ClickerSeriesTimer {
  const active = progress.activeSeries;
  if (!active) return { remainingMs: 0, remainingRatio: 0 };
  const remainingMs = Math.min(
    CLICKER_IDLE_RESET_MS,
    Math.max(0, active.lastTapAtMs + CLICKER_IDLE_RESET_MS - nowMs),
  );
  return {
    remainingMs,
    remainingRatio: remainingMs / CLICKER_IDLE_RESET_MS,
  };
}

export function expireClickerSeries(
  progress: ClickerProgress,
  nowMs = Date.now(),
): ClickerExpiry {
  const active = progress.activeSeries;
  if (!active) return { progress, finishedSeries: null };
  const elapsed = nowMs - active.lastTapAtMs;
  if (elapsed >= 0 && elapsed < CLICKER_IDLE_RESET_MS) {
    return { progress, finishedSeries: null };
  }
  const tapCount = normalizeCount(active.tapCount);
  const next: ClickerProgress = {
    ...progress,
    bestSeries: Math.max(normalizeCount(progress.bestSeries), tapCount),
    completedSeries: normalizeCompletedSeries(progress.completedSeries) + 1,
    lastStoryId: active.storyId,
    activeSeries: null,
    updatedAtMs: Math.max(0, nowMs),
  };
  return {
    progress: next,
    finishedSeries: {
      eventId: active.eventId,
      tapCount,
      durationMs: Math.max(0, active.lastTapAtMs - active.startedAtMs),
      storyId: active.storyId,
      isRecord: tapCount >= normalizeCount(progress.bestSeries),
    },
  };
}

export function getClickerTransitionEffect(fromTap: number, toTap: number): ClickerEffect | null {
  const from = normalizeCount(fromTap);
  const to = normalizeCount(toTap);
  if (to <= from) return null;
  let effect: ClickerEffect | null = null;
  for (const milestone of CLICKER_MILESTONES) {
    if (milestone > from && milestone <= to) effect = MILESTONE_EFFECTS.get(milestone) ?? effect;
  }
  return effect;
}

export function advanceClickerRun(
  progress: ClickerProgress,
  nowMs = Date.now(),
  steps = 1,
  eventId: string | null = null,
): ClickerAdvance {
  const expired = expireClickerSeries(progress, nowMs);
  const current = expired.progress;
  const levelBefore = getClickerLevel(current.bestSeries);
  const safeSteps = Number.isSafeInteger(steps) ? Math.max(1, steps) : 1;
  const currentTapCount = current.activeSeries?.tapCount ?? 0;
  const nextTapCount = Math.min(currentTapCount + safeSteps, CLICKER_MAX_TAP_COUNT);
  const story = current.activeSeries
    ? storyById(current.activeSeries.storyId)
      ?? getStoryForSeries(current.storySeed, current.completedSeries)
    : getStoryForSeries(current.storySeed, current.completedSeries);
  const activeSeries: ClickerActiveSeries = current.activeSeries
    ? { ...current.activeSeries, tapCount: nextTapCount, lastTapAtMs: nowMs, storyId: story.id }
    : { eventId, tapCount: nextTapCount, startedAtMs: nowMs, lastTapAtMs: nowMs, storyId: story.id };
  const bestSeries = Math.max(normalizeCount(current.bestSeries), nextTapCount);
  const crossedMilestones = CLICKER_MILESTONES.filter(
    (milestone) => milestone > currentTapCount && milestone <= nextTapCount,
  );
  const next: ClickerProgress = {
    ...current,
    bestSeries,
    activeSeries,
    updatedAtMs: Math.max(0, nowMs),
  };
  return {
    progress: next,
    finishedSeries: expired.finishedSeries,
    crossedMilestones,
    effect: getClickerTransitionEffect(currentTapCount, nextTapCount),
    levelBefore,
    levelAfter: getClickerLevel(bestSeries),
  };
}

export function planClickerTap(
  progress: ClickerProgress,
  serverCooldownActive: boolean,
  nowMs = Date.now(),
  hasPendingServerRetry = false,
): ClickerTapPlan {
  if (hasPendingServerRetry) return "REQUEST_SERVER";
  const active = progress.activeSeries;
  if (active && nowMs >= active.lastTapAtMs && nowMs - active.lastTapAtMs < CLICKER_IDLE_RESET_MS) {
    return "ADVANCE_LOCAL";
  }
  return serverCooldownActive ? "START_LOCAL" : "REQUEST_SERVER";
}

export function getClickerFrame(progress: ClickerProgress): ClickerFrame | null {
  const active = progress.activeSeries;
  if (!active || active.tapCount < 1) return null;
  const story = storyById(active.storyId)
    ?? getStoryForSeries(progress.storySeed, progress.completedSeries);
  let scene = story.scenes[0];
  for (const candidate of story.scenes) {
    if (candidate.at > active.tapCount) break;
    scene = candidate;
  }
  return {
    storyId: story.id,
    storyTitle: story.title,
    tapCount: active.tapCount,
    message: scene.message,
    nextMilestone: getNextClickerMilestone(active.tapCount),
    level: getClickerLevel(progress.bestSeries),
  };
}

export function mergeClickerProgress(
  first: ClickerProgress,
  second: ClickerProgress,
): ClickerProgress {
  // The caller passes the stored snapshot first and the in-memory snapshot second.
  // Equal millisecond timestamps are common with multi-touch, so the second snapshot
  // must win the tie or a later tap can disappear after reload.
  const latest = first.updatedAtMs > second.updatedAtMs ? first : second;
  return {
    ...latest,
    bestSeries: Math.max(normalizeCount(first.bestSeries), normalizeCount(second.bestSeries)),
    completedSeries: Math.max(
      normalizeCompletedSeries(first.completedSeries),
      normalizeCompletedSeries(second.completedSeries),
    ),
  };
}

export function serializeClickerProgress(progress: ClickerProgress): string {
  return JSON.stringify({
    version: 2,
    bestSeries: normalizeCount(progress.bestSeries),
    completedSeries: normalizeCompletedSeries(progress.completedSeries),
    storySeed: normalizeSeed(progress.storySeed),
    lastStoryId: progress.lastStoryId && storyById(progress.lastStoryId)
      ? progress.lastStoryId
      : null,
    activeSeries: progress.activeSeries
      ? {
          eventId: progress.activeSeries.eventId,
          tapCount: normalizeCount(progress.activeSeries.tapCount),
          startedAtMs: progress.activeSeries.startedAtMs,
          lastTapAtMs: progress.activeSeries.lastTapAtMs,
          storyId: storyById(progress.activeSeries.storyId)
            ? progress.activeSeries.storyId
            : getStoryForSeries(progress.storySeed, progress.completedSeries).id,
        }
      : null,
    updatedAtMs: Math.max(0, progress.updatedAtMs),
  });
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function parseClickerProgress(value: string, fallbackSeed = 0): ClickerProgress | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed)) return null;
    if (parsed.version === 1) {
      if (
        !("totalTaps" in parsed) || !Number.isSafeInteger(parsed.totalTaps)
        || Number(parsed.totalTaps) < 0 || !("storySeed" in parsed)
        || !Number.isSafeInteger(parsed.storySeed)
      ) return null;
      // v0.4.0 stored lifetime taps, not an uninterrupted series. Promoting that
      // value to a record would fabricate a result, so the corrected game starts clean.
      return createClickerRun(fallbackSeed);
    }
    if (
      parsed.version !== 2 || !("bestSeries" in parsed)
      || !Number.isSafeInteger(parsed.bestSeries) || Number(parsed.bestSeries) < 0
      || Number(parsed.bestSeries) > CLICKER_MAX_TAP_COUNT
      || !("completedSeries" in parsed) || !Number.isSafeInteger(parsed.completedSeries)
      || Number(parsed.completedSeries) < 0 || !("storySeed" in parsed)
      || !Number.isSafeInteger(parsed.storySeed) || !("lastStoryId" in parsed)
      || (parsed.lastStoryId !== null
        && (typeof parsed.lastStoryId !== "string" || !storyById(parsed.lastStoryId)))
      || !("activeSeries" in parsed) || !("updatedAtMs" in parsed)
      || !isSafeTimestamp(parsed.updatedAtMs)
    ) return null;

    let activeSeries: ClickerActiveSeries | null = null;
    if (parsed.activeSeries !== null) {
      if (
        typeof parsed.activeSeries !== "object" || !("tapCount" in parsed.activeSeries)
        || !Number.isSafeInteger(parsed.activeSeries.tapCount)
        || Number(parsed.activeSeries.tapCount) < 1
        || Number(parsed.activeSeries.tapCount) > CLICKER_MAX_TAP_COUNT
        || !("startedAtMs" in parsed.activeSeries)
        || !isSafeTimestamp(parsed.activeSeries.startedAtMs)
        || !("lastTapAtMs" in parsed.activeSeries)
        || !isSafeTimestamp(parsed.activeSeries.lastTapAtMs)
        || Number(parsed.activeSeries.lastTapAtMs) < Number(parsed.activeSeries.startedAtMs)
        || ("eventId" in parsed.activeSeries
          && parsed.activeSeries.eventId !== null
          && (typeof parsed.activeSeries.eventId !== "string"
            || !UUID_V4.test(parsed.activeSeries.eventId)))
        || !("storyId" in parsed.activeSeries)
        || typeof parsed.activeSeries.storyId !== "string"
        || !storyById(parsed.activeSeries.storyId)
      ) return null;
      activeSeries = {
        eventId: "eventId" in parsed.activeSeries
          && typeof parsed.activeSeries.eventId === "string"
          ? parsed.activeSeries.eventId
          : null,
        tapCount: Number(parsed.activeSeries.tapCount),
        startedAtMs: Number(parsed.activeSeries.startedAtMs),
        lastTapAtMs: Number(parsed.activeSeries.lastTapAtMs),
        storyId: parsed.activeSeries.storyId,
      };
    }

    return {
      bestSeries: Number(parsed.bestSeries),
      completedSeries: Number(parsed.completedSeries),
      storySeed: normalizeSeed(Number(parsed.storySeed ?? fallbackSeed)),
      lastStoryId: parsed.lastStoryId,
      activeSeries,
      updatedAtMs: parsed.updatedAtMs,
    };
  } catch {
    return null;
  }
}
