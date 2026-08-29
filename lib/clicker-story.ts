export const CLICKER_IDLE_RESET_MS = 30_000;
export const CLICKER_STORY_LENGTH = 100;
export const CLICKER_CHAMPION_TAP = 100_000;
export const CLICKER_MAX_TAP_COUNT = Number.MAX_SAFE_INTEGER;

export const CLICKER_SCENE_TAPS = [1, 5, 10, 20, 35, 50, 75, 100] as const;

export type ClickerEffect = "confetti" | "rings" | "sparks" | "finale" | "champion";

type ClickerScene = {
  at: number;
  message: string;
};

export type ClickerStory = {
  id: string;
  title: string;
  scenes: readonly ClickerScene[];
};

export type ClickerReward = {
  id: string;
  at: number;
  title: string;
  message: string;
  effect: ClickerEffect;
};

export type ClickerProgress = {
  totalTaps: number;
  storySeed: number;
};

export type ClickerRun = ClickerProgress & {
  lastTapAtMs: number | null;
};

export type ClickerTapPlan = "ADVANCE_LOCAL" | "START_LOCAL" | "REQUEST_SERVER";

export type ClickerFrame = {
  storyId: string;
  storyTitle: string;
  storyIndex: number;
  storyTap: number;
  totalTaps: number;
  message: string;
  effect: ClickerEffect | null;
  nextSceneAt: number;
  progress: number;
  isStoryFinal: boolean;
  reachedReward: ClickerReward | null;
  latestReward: ClickerReward | null;
  nextRewardAt: number | null;
};

type StoryMessages = readonly [string, string, string, string, string, string, string, string];

function createStory(id: string, title: string, messages: StoryMessages): ClickerStory {
  return {
    id,
    title,
    scenes: CLICKER_SCENE_TAPS.map((at, index) => ({ at, message: messages[index] })),
  };
}

export const CLICKER_STORIES = [
  createStory("space", "Космическая экспедиция", [
    "Экипаж на связи",
    "Предстартовая проверка пройдена",
    "Двигатели запущены",
    "Орбита достигнута",
    "Земля стала маленькой",
    "Пойман сигнал издалека",
    "Курс — к новым мирам",
    "Экспедиция стала легендой",
  ]),
  createStory("lab", "Лаборатория бодрости", [
    "Опыт начался",
    "Датчики довольны",
    "Формула бодрости найдена",
    "Энергия вышла за шкалу",
    "Халат получил повышение",
    "Наука просит повторить",
    "Открыт элемент Живоний",
    "Нобелевка уже печатается",
  ]),
  createStory("hike", "Большой поход", [
    "Карта развернута",
    "Рюкзак собран",
    "Тропа найдена",
    "Первый перевал взят",
    "Облака остались внизу",
    "Привал с отличным видом",
    "Вершина уже рядом",
    "Флаг «Я живой» поднят",
  ]),
  createStory("arcade", "Аркадный режим", [
    "Игра началась",
    "Обучение пройдено",
    "Новый уровень открыт",
    "Комбо набирает силу",
    "Бонусный мир найден",
    "Редкий трофей получен",
    "Финальный босс удивлён",
    "Режим легенды открыт",
  ]),
  createStory("garden", "Сад на крыше", [
    "Семечко посажено",
    "Появился росток",
    "Листья раскрылись",
    "Сад набирает цвет",
    "Прилетели первые пчёлы",
    "Созрели первые плоды",
    "Сад виден из космоса",
    "Ботаника вами гордится",
  ]),
  createStory("ocean", "Глубокий океан", [
    "Батискаф погружается",
    "Поверхность осталась наверху",
    "Включены глубоководные фонари",
    "Обнаружен незнакомый силуэт",
    "Кит передал привет",
    "Найдена светящаяся долина",
    "Сонар видит нечто огромное",
    "Дно нанесено на карту",
  ]),
  createStory("magic", "Магическая академия", [
    "Письмо из академии доставлено",
    "Первая искра получилась",
    "Заклинание запомнило вас",
    "Метла прошла техосмотр",
    "Библиотека открыла тайный этаж",
    "Дракон согласился на селфи",
    "Экзаменатор потерял дар речи",
    "Диплом великого мага подписан",
  ]),
  createStory("time", "Машина времени", [
    "Хронодвигатель включён",
    "Вчера осталось позади",
    "Первый временной скачок завершён",
    "Динозавры заметили гостя",
    "Будущее отправило сообщение",
    "Парадокс аккуратно обойдён",
    "Все часы начали спешить",
    "История добавила новую главу",
  ]),
  createStory("cinema", "Киностудия", [
    "Камера включена",
    "Первый дубль снят",
    "Сценарий набирает обороты",
    "Каскадёр просит повторить",
    "Саундтрек уже застрял в голове",
    "Премьера назначена",
    "Красная дорожка готова",
    "Фильм стал главным хитом",
  ]),
  createStory("future", "Город будущего", [
    "Первый модуль установлен",
    "Улицы включили подсветку",
    "Роботы вышли на смену",
    "Открыта воздушная трасса",
    "Дома научились здороваться",
    "Запущен парк на облаках",
    "Город стал полностью автономным",
    "Будущее официально наступило",
  ]),
  createStory("observatory", "Ночная обсерватория", [
    "Купол обсерватории открыт",
    "Линза поймала первый свет",
    "Сатурн согласился на портрет",
    "Комета махнула хвостом",
    "Звёзды сложились в новое слово",
    "Безымянная луна получила имя",
    "Рассвет терпеливо ждёт снаружи",
    "Эта ночь внесена в атлас",
  ]),
  createStory("bakery", "Ночная пекарня", [
    "Закваска проснулась",
    "Первая партия отправилась в печь",
    "Улица пахнет свежим хлебом",
    "Круассан достиг идеальной формы",
    "Очередь вышла за угол",
    "Булочки начали получать имена",
    "Весь город просит добавки",
    "Пекарня стала местной легендой",
  ]),
  createStory("detective", "Детективное бюро", [
    "Дело открыто",
    "Первая улика найдена",
    "Алиби заметно нервничает",
    "След ведёт на крышу",
    "Кот явно знает больше",
    "Шифр наконец сдался",
    "Подозреваемый купил билет в один конец",
    "Дело закрыто, чайник оправдан",
  ]),
  createStory("orchestra", "Оркестр на крыше", [
    "Пюпитры расставлены",
    "Скрипки настроились",
    "Город услышал первую ноту",
    "Ветер подхватил мелодию",
    "Соседние крыши включились в ритм",
    "Голуби исполнили сложное соло",
    "На площади начались танцы",
    "Финальный аккорд встретил рассвет",
  ]),
  createStory("express", "Полуночный экспресс", [
    "Билет найден в кармане",
    "Поезд мягко тронулся",
    "Огни города остались позади",
    "Проводник принёс чай и тайну",
    "За окном промелькнуло северное сияние",
    "Маршрут появился на старой карте",
    "Конечная стала началом",
    "Экспресс прибыл точно в новую историю",
  ]),
  createStory("lighthouse", "Маяк на краю света", [
    "Фонарь маяка зажжён",
    "Первый луч разрезал туман",
    "Рыбацкая лодка ответила гудком",
    "Шторм решил обойти берег",
    "Чайки назначили вас смотрителем",
    "В море появился далёкий парус",
    "Все корабли нашли дорогу домой",
    "Маяк пережил самую длинную ночь",
  ]),
  createStory("robots", "Мастерская роботов", [
    "Мастерская включена",
    "Первый сервопривод ожил",
    "Робот сказал «привет»",
    "Его научили танцевать",
    "Он задал философский вопрос",
    "Кофемашина починена",
    "Робот запросил отпуск",
    "Почётный статус человека получен",
  ]),
  createStory("polar", "Полярная станция", [
    "Генератор станции запущен",
    "Температура признала поражение",
    "Радар увидел далёкую метель",
    "Пингвин пришёл на собеседование",
    "Ледник рассказал древнюю историю",
    "Полярная ночь стала чуть светлее",
    "Сияние заняло всё небо",
    "Экспедиция отправила легендарный отчёт",
  ]),
  createStory("library", "Библиотека после закрытия", [
    "Последний читатель ушёл",
    "Одна книга осталась открытой",
    "Полки начали тихо переговариваться",
    "Из атласа подул морской ветер",
    "Детективы нашли потерянную главу",
    "Словарь придумал новое слово",
    "Все истории собрались в одном зале",
    "Библиотека выбрала вас хранителем",
  ]),
  createStory("weather", "Бюро хорошей погоды", [
    "Прогноз принят в работу",
    "Облака аккуратно пронумерованы",
    "Дождь перенесён на ночь",
    "Ветер получил правильный маршрут",
    "Радуга согласована без очереди",
    "Солнцу выдали дополнительный час",
    "Город открыл все окна",
    "Идеальный день официально утверждён",
  ]),
  createStory("radio", "Радио на всю галактику", [
    "Передатчик прогрелся",
    "Первый позывной ушёл в эфир",
    "Луна заказала любимую песню",
    "Марс прислал голосовое сообщение",
    "Сигнал обогнул далёкую звезду",
    "В эфире стало тесно от слушателей",
    "Галактика подпевает припеву",
    "Ваш голос услышала сама Вселенная",
  ]),
  createStory("museum", "Ночь в музее", [
    "Двери музея закрылись",
    "Старые часы пробили полночь",
    "Рыцарь поправил шлем",
    "Мамонт попросил потише",
    "Картины обменялись пейзажами",
    "Динозавр нашёл потерянную табличку",
    "Экспонаты устроили общий портрет",
    "К открытию всё почти вернулось на места",
  ]),
  createStory("dragons", "Школа драконов", [
    "Первое яйцо треснуло",
    "Маленький дракон чихнул искрой",
    "Урок полёта начался",
    "Облако оказалось удобной подушкой",
    "Огненное дыхание прошло зачёт",
    "Замок получил нового защитника",
    "Стая построилась над башнями",
    "Вы стали почётным наставником драконов",
  ]),
  createStory("volcano", "Экспедиция к вулкану", [
    "Базовый лагерь разбит",
    "Сейсмограф начертил приветствие",
    "Тропа стала заметно теплее",
    "Кратер показался из облаков",
    "Найден редкий чёрный кристалл",
    "Лава выбрала безопасный маршрут",
    "Образцы доставлены в лагерь",
    "Вулкану присвоено ваше имя",
  ]),
] as const satisfies readonly ClickerStory[];

export const CLICKER_REWARDS = [
  {
    id: "century",
    at: 100,
    title: "Первая сотня",
    message: "Счётчик больше не новичок",
    effect: "finale",
  },
  {
    id: "five-hundred",
    at: 500,
    title: "Пять сотен",
    message: "Пять больших историй позади, счёт идёт дальше",
    effect: "rings",
  },
  {
    id: "thousand",
    at: 1_000,
    title: "Тысяча тапов",
    message: "Четыре цифры. Полёт устойчивый",
    effect: "sparks",
  },
  {
    id: "five-digits",
    at: 10_000,
    title: "Пятизначная орбита",
    message: "Это уже отдельная форма связи",
    effect: "finale",
  },
  {
    id: "champion",
    at: CLICKER_CHAMPION_TAP,
    title: "Легендарный режим",
    message: "Сто тысяч. Кнопка всё помнит",
    effect: "champion",
  },
] as const satisfies readonly ClickerReward[];

const SCENE_EFFECTS = new Map<number, ClickerEffect>([
  [5, "confetti"],
  [20, "rings"],
  [50, "sparks"],
  [100, "finale"],
]);

function normalizeStoryIndex(storyIndex: number): number {
  if (!Number.isSafeInteger(storyIndex)) return 0;
  return ((storyIndex % CLICKER_STORIES.length) + CLICKER_STORIES.length)
    % CLICKER_STORIES.length;
}

function normalizeTapCount(tapCount: number): number {
  if (!Number.isSafeInteger(tapCount) || tapCount < 0) return 0;
  return Math.min(tapCount, CLICKER_MAX_TAP_COUNT);
}

export function createClickerRun(storySeed = 0, totalTaps = 0): ClickerRun {
  return {
    storySeed: normalizeStoryIndex(storySeed),
    totalTaps: normalizeTapCount(totalTaps),
    lastTapAtMs: null,
  };
}

export function advanceClickerRun(
  run: ClickerRun,
  nowMs = Date.now(),
  steps = 1,
): ClickerRun {
  const safeSteps = Number.isSafeInteger(steps) ? Math.max(1, steps) : 1;
  return {
    storySeed: normalizeStoryIndex(run.storySeed),
    totalTaps: Math.min(normalizeTapCount(run.totalTaps) + safeSteps, CLICKER_MAX_TAP_COUNT),
    lastTapAtMs: nowMs,
  };
}

export function expireClickerSeries(run: ClickerRun, nowMs = Date.now()): ClickerRun {
  if (
    run.lastTapAtMs !== null &&
    nowMs - run.lastTapAtMs >= CLICKER_IDLE_RESET_MS
  ) {
    return {
      ...run,
      storySeed: normalizeStoryIndex(run.storySeed),
      lastTapAtMs: null,
    };
  }
  return run;
}

export function planClickerTap(
  run: ClickerRun,
  serverCooldownActive: boolean,
  nowMs = Date.now(),
): ClickerTapPlan {
  const active = run.lastTapAtMs !== null && nowMs - run.lastTapAtMs < CLICKER_IDLE_RESET_MS;
  if (active) return "ADVANCE_LOCAL";
  return serverCooldownActive ? "START_LOCAL" : "REQUEST_SERVER";
}

function rewardAt(tapCount: number): ClickerReward | null {
  return CLICKER_REWARDS.find((reward) => reward.at === tapCount) ?? null;
}

function latestRewardAt(tapCount: number): ClickerReward | null {
  let latest: ClickerReward | null = null;
  for (const reward of CLICKER_REWARDS) {
    if (reward.at > tapCount) break;
    latest = reward;
  }
  return latest;
}

export function getClickerFrame(run: ClickerRun): ClickerFrame | null {
  const totalTaps = normalizeTapCount(run.totalTaps);
  if (totalTaps < 1) return null;

  const storyCycle = Math.floor((totalTaps - 1) / CLICKER_STORY_LENGTH);
  const storyTap = ((totalTaps - 1) % CLICKER_STORY_LENGTH) + 1;
  const storyIndex = normalizeStoryIndex(run.storySeed + storyCycle);
  const story: ClickerStory = CLICKER_STORIES[storyIndex];
  let scene: ClickerScene = story.scenes[0];
  let nextScene: ClickerScene | undefined;

  for (const candidate of story.scenes) {
    if (candidate.at <= storyTap) scene = candidate;
    else {
      nextScene = candidate;
      break;
    }
  }

  const storyBase = storyCycle * CLICKER_STORY_LENGTH;
  const nextSceneAt = nextScene ? storyBase + nextScene.at : storyBase + CLICKER_STORY_LENGTH + 1;
  const progress = nextScene
    ? Math.max(0, Math.min((storyTap - scene.at) / (nextScene.at - scene.at), 1))
    : 1;
  const reachedReward = rewardAt(totalTaps);
  const nextReward = CLICKER_REWARDS.find((reward) => reward.at > totalTaps) ?? null;

  return {
    storyId: story.id,
    storyTitle: story.title,
    storyIndex,
    storyTap,
    totalTaps,
    message: scene.message,
    effect: reachedReward?.effect ?? (scene.at === storyTap ? SCENE_EFFECTS.get(storyTap) ?? null : null),
    nextSceneAt,
    progress,
    isStoryFinal: storyTap === CLICKER_STORY_LENGTH,
    reachedReward,
    latestReward: latestRewardAt(totalTaps),
    nextRewardAt: nextReward?.at ?? null,
  };
}

export function getClickerTransitionEffect(fromTap: number, toTap: number): ClickerEffect | null {
  const from = normalizeTapCount(fromTap);
  const to = normalizeTapCount(toTap);
  if (to <= from) return null;

  let rewardEffect: ClickerEffect | null = null;
  for (const reward of CLICKER_REWARDS) {
    if (reward.at > from && reward.at <= to) rewardEffect = reward.effect;
  }
  if (rewardEffect) return rewardEffect;

  let latestAt = -1;
  let effect: ClickerEffect | null = null;
  for (const [storyTap, sceneEffect] of SCENE_EFFECTS) {
    const cycle = Math.floor((to - storyTap) / CLICKER_STORY_LENGTH);
    const absoluteTap = cycle * CLICKER_STORY_LENGTH + storyTap;
    if (absoluteTap > from && absoluteTap <= to && absoluteTap > latestAt) {
      latestAt = absoluteTap;
      effect = sceneEffect;
    }
  }
  return effect;
}

export function serializeClickerProgress(progress: ClickerProgress): string {
  return JSON.stringify({
    version: 1,
    totalTaps: normalizeTapCount(progress.totalTaps),
    storySeed: normalizeStoryIndex(progress.storySeed),
  });
}

export function parseClickerProgress(value: string): ClickerProgress | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("version" in parsed) ||
      parsed.version !== 1 ||
      !("totalTaps" in parsed) ||
      !Number.isSafeInteger(parsed.totalTaps) ||
      Number(parsed.totalTaps) < 0 ||
      !("storySeed" in parsed) ||
      !Number.isSafeInteger(parsed.storySeed)
    ) return null;
    return {
      totalTaps: normalizeTapCount(Number(parsed.totalTaps)),
      storySeed: normalizeStoryIndex(Number(parsed.storySeed)),
    };
  } catch {
    return null;
  }
}
