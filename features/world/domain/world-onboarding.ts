import type { PixelPose } from "@/features/mochlik/pixel-sprite";

export const WORLD_ONBOARDING_VERSION = 2;

type WorldOnboardingStep = { id: string; title: string; summary: string; text: string; hint: string; pose: PixelPose; selector?: string };
export const WORLD_ONBOARDING_STEPS = Object.freeze([
  Object.freeze({ id: "profile", title: "Познакомимся поближе", summary: "Нажми на мой уровень: тут общая статистика, друзья и настройки.", text: "Нажми на кнопку с моим уровнем. Тут общая статистика, друзья и настройки. Осмотрись, а затем продолжим.", hint: "Открой профиль и осмотрись. Подсказка подождёт.", selector: '[data-world-quick="profile"]', pose: "greet" }),
  Object.freeze({ id: "pantry", title: "Заглянем в кладовую", summary: "Здесь хранятся припасы. Нажми на предмет, чтобы открыть быструю продажу.", text: "В кладовой лежат ягоды, рыба и материалы. Нажми на предмет: появятся количество, сумма и кнопка продажи. В «Холодильнике» рыба разложена по видам. Рынок игроков - отдельный раздел для покупки и продажи другим игрокам; там нужно дождаться покупателя.", hint: "Продавать ради обучения не нужно. Кнопка улучшения кладовой находится в её шапке.", selector: '[data-world-quick="pantry"]', pose: "present" }),
  Object.freeze({ id: "garden", title: "Вырастим малину", summary: "Открой ягодный куст. Нажатие на малину сразу начнёт выращивание.", text: "Открой ягодный куст. У каждой ягоды уже показано время: одно нажатие занимает одно место и выращивает один предмет. Готовый урожай нужно забрать.", hint: "Карту можно двигать мышью или пальцем. Приближение - колесом или двумя пальцами.", selector: '[data-recipe-product="berries"]', pose: "sniff" }),
  Object.freeze({ id: "grow", title: "Твой первый урожай", summary: "Нажми на карточку малины. Затем можно идти дальше.", text: "Одно нажатие на малину начнёт выращивание. Я подожду, пока игра подтвердит работу, и расскажу, как забрать урожай.", hint: "Ягоды растут сами. После запуска можно продолжить знакомство и вернуться позже.", selector: '[data-recipe-product="berries"]', pose: "crouch" }),
  Object.freeze({ id: "neighbors", title: "В лесу мы не одни", summary: "Знакомые жители собраны в «Ещё» → «Персонажи».", text: "Шишколап строит, а Плёска помогает с рыбалкой. Когда откроешь лесной участок, на поляну прибежит лесоруб Лопоух. Новые соседи появятся по мере развития хозяйства. Пока их нет, в списке виден только силуэт.", hint: "Выбери знакомого жителя. Покупать или строить что-либо ради знакомства не нужно.", selector: '[data-world-characters-trigger]', pose: "walk" }),
  Object.freeze({ id: "orders", title: "Доска заказов жителей", summary: "Нажми на выделенную доску на карте. Соседи оставляют здесь просьбы и платят за припасы.", text: "Доска заказов на карте открывает журнал просьб соседей. Первый и единственный учебный заказ просит одну малину. Собери её и нажми «Отдать заказ»: получишь монеты. Дальше в «Пути хозяйства» будут небольшие просьбы для улучшения дома.", hint: "Нажми на доску на карте. В журнале видны нужные припасы и награда.", pose: "hold" }),
  Object.freeze({ id: "workshop", title: "Заглянем в мастерскую", summary: "Мастерская превращает бревно в доску для новых построек.", text: "Шишколап даст один учебный набор для первой мастерской: монеты и материалы пойдут прямо в её стройку, твои запасы не расходуются. Запуск - только по твоему нажатию. В готовой мастерской одно бревно превращается в одну доску за две минуты.", hint: "Набор поможет, даже если ты потратил запасы раньше. Второй раз получить его нельзя.", selector: '[data-place="workshop"]', pose: "stretch" }),
  Object.freeze({ id: "expeditions", title: "Куда можно отправиться?", summary: "Вылазки приносят материалы. Открой «В путь» и сначала выбери занятие.", text: "Открой «В путь», выбери занятие, затем маршрут. Время, находки и настоящие затраты видны до отправки. Каменоломня на карте работает отдельно.", hint: "Для знакомства достаточно открыть список. Отправляться сейчас необязательно.", selector: '[data-world-quick="expeditions"]', pose: "reach" }),
  Object.freeze({ id: "help", title: "Подсказки всегда рядом", summary: "Теперь можно исследовать лес. Справка всегда под кнопкой i.", text: "Открой справку кнопкой i. В ней можно выбрать тему или воспользоваться поиском. Подсказки раздела запускаются по «Что здесь делать?».", hint: "Для повтора открой мой профиль → «?» → «Повторить обучение». Во время знакомства кнопка называется «Продолжить обучение».", selector: '[data-world-onboarding-help]', pose: "wonder" }),
] as const satisfies readonly WorldOnboardingStep[]);

export type WorldOnboardingStepId = typeof WORLD_ONBOARDING_STEPS[number]["id"];
export type WorldOnboardingProgress = (
  | { version: 2; status: "started"; stepId: WorldOnboardingStepId }
  | { version: 2; status: "skipped" | "completed"; finishedAt?: number }
) & { cropJobId?: string; /** Observed accepted garden receipt, scoped to this local course/account. */ harvested?: true;
  /** Explicitly completed lessons in this run; skips and old completions cannot create a reward intent. */
  completedSteps?: WorldOnboardingStepId[]; rewardReady?: true };

const legacyStepIds = ["clearing", "profile", "pantry", "expeditions", "help"];

function cropId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : undefined;
}

function finishTime(value: unknown): number | undefined {
  // Match the finite epoch-millisecond range supported by Date, without fractions.
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 8_640_000_000_000_000 ? value : undefined;
}

export function parseWorldOnboarding(raw: string | null): WorldOnboardingProgress | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const record = value as Record<string, unknown>;
    if (record.version === 1) {
      // A new tutorial must respect the player's previous decision to leave it.
      if (record.status === "skipped" || record.status === "completed") return { version: 2, status: record.status };
      if (record.status === "started" && typeof record.stepId === "string" && legacyStepIds.includes(record.stepId)) {
        return { version: 2, status: "started", stepId: "profile" };
      }
      return null;
    }
    if (record.version !== WORLD_ONBOARDING_VERSION) return null;
    const completedSteps = Array.isArray(record.completedSteps)
      ? WORLD_ONBOARDING_STEPS.map(step => step.id).filter(id => (record.completedSteps as unknown[]).includes(id)) : [];
    const course = completedSteps.length ? { completedSteps } : {};
    const jobId = cropId(record.cropJobId);
    const crop = { ...(jobId && record.harvested !== true ? { cropJobId: jobId } : {}), ...(record.harvested === true ? { harvested: true as const } : {}) };
    if (record.status === "skipped" || record.status === "completed") {
      const finishedAt = finishTime(record.finishedAt);
      return { version: 2, status: record.status, ...crop, ...course, ...(finishedAt === undefined ? {} : { finishedAt }),
        ...(record.status === "completed" && record.rewardReady === true && completedSteps.length === WORLD_ONBOARDING_STEPS.length
          ? { rewardReady: true as const } : {}) };
    }
    if (record.status === "started" && WORLD_ONBOARDING_STEPS.some(step => step.id === record.stepId)) {
      return { version: 2, status: "started", stepId: record.stepId as WorldOnboardingStepId, ...crop, ...course };
    }
  } catch { /* A damaged preference must never block entry into the game. */ }
  return null;
}

export type WorldOnboardingEvent =
  | { type: "start" | "replay" }
  | { type: "step"; stepId: WorldOnboardingStepId; completeCurrent?: boolean }
  | { type: "skip" | "complete"; now: number }
  | { type: "reward-acknowledged" }
  | { type: "crop"; jobId?: string }
  | { type: "harvest"; jobId: string };

/** Local guide progress only. The caller observes real game actions; this never issues one. */
export function transitionWorldOnboarding(progress: WorldOnboardingProgress | null, event: WorldOnboardingEvent): WorldOnboardingProgress | null {
  const crop = { ...(progress?.cropJobId ? { cropJobId: progress.cropJobId } : {}), ...(progress?.harvested ? { harvested: true as const } : {}) };
  const completed = new Set(progress?.completedSteps);
  const course = () => completed.size ? { completedSteps: WORLD_ONBOARDING_STEPS.map(step => step.id).filter(id => completed.has(id)) } : {};
  switch (event.type) {
    case "reward-acknowledged": {
      if (!progress || progress.status !== "completed" || !progress.rewardReady) return progress;
      const next = { ...progress };
      delete next.rewardReady;
      return next;
    }
    case "start": return { version: 2, status: "started", stepId: "profile" };
    case "replay": return { version: 2, status: "started", stepId: "profile" };
    case "step": {
      if (event.completeCurrent && progress?.status === "started") completed.add(progress.stepId);
      return { version: 2, status: "started", stepId: event.stepId, ...crop, ...course() };
    }
    case "skip":
    case "complete": {
      // Repeated completion/skip must not restart the reward deferral. Legacy
      // terminal records intentionally remain undated until an explicit replay.
      const finishedAt = progress && progress.status !== "started" ? progress.finishedAt : finishTime(event.now);
      if (event.type === "complete" && progress?.status === "started" && progress.stepId === "help" && progress.completedSteps) completed.add("help");
      return { version: 2, status: event.type === "skip" ? "skipped" : "completed", ...crop, ...course(),
        ...(finishedAt === undefined ? {} : { finishedAt }),
        ...(event.type === "complete" && completed.size === WORLD_ONBOARDING_STEPS.length ? { rewardReady: true as const } : {}) };
    }
    case "harvest": {
      // A late receipt cannot finish another crop or a freshly replayed course.
      if (!progress || !cropId(event.jobId) || progress.cropJobId !== event.jobId) return progress;
      const next = { ...progress, harvested: true as const };
      delete next.cropJobId;
      return next;
    }
    case "crop": {
      if (!progress) return null;
      const { cropJobId: previous, ...rest } = progress;
      const jobId = cropId(event.jobId);
      // An old crop observation must not resurrect a received harvest after
      // its receipt or completion. Explicit replay starts a fresh local run.
      if (jobId && progress.harvested) return progress;
      return jobId ? { ...rest, cropJobId: jobId } : previous ? rest : progress;
    }
  }
}

/** Keep the first order on its real collection lesson until a receipt was observed.
 * Completed/legacy requests remain payable with their saved terms. */
export function worldOnboardingNeedsHarvest(progress: WorldOnboardingProgress | null,
  order: { items: Record<string, number> } | null | undefined, lessonDone = false): boolean {
  return progress?.status === "started" && progress.stepId === "orders" && !progress.harvested && !lessonDone
    && order?.items.berries === 1 && Object.keys(order.items).length === 1;
}
