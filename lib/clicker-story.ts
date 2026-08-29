export const CLICKER_IDLE_RESET_MS = 30_000;
export const CLICKER_FINAL_TAP = 100;

export type ClickerEffect = "confetti" | "rings" | "sparks" | "finale";

type ClickerScene = {
  at: number;
  message: string;
  effect?: ClickerEffect;
};

export type ClickerStory = {
  id: string;
  title: string;
  scenes: readonly ClickerScene[];
};

export type ClickerRun = {
  storyIndex: number;
  tapCount: number;
  lastTapAtMs: number | null;
};

export type ClickerTapPlan = "ADVANCE_LOCAL" | "START_LOCAL" | "REQUEST_SERVER";

export type ClickerFrame = {
  storyId: string;
  storyTitle: string;
  tapCount: number;
  message: string;
  effect: ClickerEffect | null;
  nextSceneAt: number | null;
  progress: number;
  isFinal: boolean;
};

export const CLICKER_STORIES = [
  {
    id: "space",
    title: "Космическая экспедиция",
    scenes: [
      { at: 1, message: "Экипаж на связи" },
      { at: 5, message: "Предстартовая проверка пройдена", effect: "confetti" },
      { at: 10, message: "Двигатели запущены" },
      { at: 20, message: "Орбита достигнута", effect: "rings" },
      { at: 35, message: "Земля стала маленькой" },
      { at: 50, message: "Пойман сигнал издалека", effect: "sparks" },
      { at: 75, message: "Курс — к новым мирам" },
      { at: 100, message: "Экспедиция стала легендой", effect: "finale" },
    ],
  },
  {
    id: "lab",
    title: "Лаборатория бодрости",
    scenes: [
      { at: 1, message: "Опыт начался" },
      { at: 5, message: "Датчики довольны", effect: "confetti" },
      { at: 10, message: "Формула бодрости найдена" },
      { at: 20, message: "Энергия вышла за шкалу", effect: "rings" },
      { at: 35, message: "Халат получил повышение" },
      { at: 50, message: "Наука просит повторить", effect: "sparks" },
      { at: 75, message: "Открыт элемент Живоний" },
      { at: 100, message: "Нобелевка уже печатается", effect: "finale" },
    ],
  },
  {
    id: "hike",
    title: "Большой поход",
    scenes: [
      { at: 1, message: "Карта развернута" },
      { at: 5, message: "Рюкзак собран", effect: "confetti" },
      { at: 10, message: "Тропа найдена" },
      { at: 20, message: "Первый перевал взят", effect: "rings" },
      { at: 35, message: "Облака остались внизу" },
      { at: 50, message: "Привал с отличным видом", effect: "sparks" },
      { at: 75, message: "Вершина уже рядом" },
      { at: 100, message: "Флаг «Я живой» поднят", effect: "finale" },
    ],
  },
  {
    id: "arcade",
    title: "Аркадный режим",
    scenes: [
      { at: 1, message: "Игра началась" },
      { at: 5, message: "Обучение пройдено", effect: "confetti" },
      { at: 10, message: "Новый уровень открыт" },
      { at: 20, message: "Комбо набирает силу", effect: "rings" },
      { at: 35, message: "Бонусный мир найден" },
      { at: 50, message: "Редкий трофей получен", effect: "sparks" },
      { at: 75, message: "Финальный босс удивлён" },
      { at: 100, message: "Режим легенды открыт", effect: "finale" },
    ],
  },
  {
    id: "garden",
    title: "Сад на крыше",
    scenes: [
      { at: 1, message: "Семечко посажено" },
      { at: 5, message: "Появился росток", effect: "confetti" },
      { at: 10, message: "Листья раскрылись" },
      { at: 20, message: "Сад набирает цвет", effect: "rings" },
      { at: 35, message: "Прилетели первые пчёлы" },
      { at: 50, message: "Созрели первые плоды", effect: "sparks" },
      { at: 75, message: "Сад виден из космоса" },
      { at: 100, message: "Ботаника вами гордится", effect: "finale" },
    ],
  },
] as const satisfies readonly ClickerStory[];

function normalizeStoryIndex(storyIndex: number): number {
  if (!Number.isSafeInteger(storyIndex)) return 0;
  return ((storyIndex % CLICKER_STORIES.length) + CLICKER_STORIES.length)
    % CLICKER_STORIES.length;
}

export function createClickerRun(storyIndex = 0): ClickerRun {
  return {
    storyIndex: normalizeStoryIndex(storyIndex),
    tapCount: 0,
    lastTapAtMs: null,
  };
}

export function advanceClickerRun(run: ClickerRun, nowMs = Date.now()): ClickerRun {
  const storyIndex = normalizeStoryIndex(run.storyIndex);
  if (run.tapCount >= CLICKER_FINAL_TAP) {
    return {
      storyIndex: normalizeStoryIndex(storyIndex + 1),
      tapCount: 1,
      lastTapAtMs: nowMs,
    };
  }
  return {
    storyIndex,
    tapCount: Math.max(0, run.tapCount) + 1,
    lastTapAtMs: nowMs,
  };
}

export function rotateClickerStory(run: ClickerRun): ClickerRun {
  return createClickerRun(run.storyIndex + 1);
}

export function resetExpiredClickerRun(run: ClickerRun, nowMs = Date.now()): ClickerRun {
  if (
    run.tapCount > 0 &&
    run.lastTapAtMs !== null &&
    nowMs - run.lastTapAtMs >= CLICKER_IDLE_RESET_MS
  ) {
    return rotateClickerStory(run);
  }
  return run;
}

export function planClickerTap(
  run: ClickerRun,
  serverCooldownActive: boolean,
): ClickerTapPlan {
  if (run.tapCount > 0) return "ADVANCE_LOCAL";
  return serverCooldownActive ? "START_LOCAL" : "REQUEST_SERVER";
}

export function getClickerFrame(run: ClickerRun): ClickerFrame | null {
  if (!Number.isSafeInteger(run.tapCount) || run.tapCount < 1) return null;

  const story: ClickerStory = CLICKER_STORIES[normalizeStoryIndex(run.storyIndex)];
  const tapCount = Math.min(run.tapCount, CLICKER_FINAL_TAP);
  let scene: ClickerScene = story.scenes[0];
  let nextScene: ClickerScene | undefined;

  for (const candidate of story.scenes) {
    if (candidate.at <= tapCount) scene = candidate;
    else {
      nextScene = candidate;
      break;
    }
  }

  const progress = nextScene
    ? Math.max(0, Math.min((tapCount - scene.at) / (nextScene.at - scene.at), 1))
    : 1;

  return {
    storyId: story.id,
    storyTitle: story.title,
    tapCount,
    message: scene.message,
    effect: scene.at === tapCount ? scene.effect ?? null : null,
    nextSceneAt: nextScene?.at ?? null,
    progress,
    isFinal: nextScene === undefined,
  };
}
