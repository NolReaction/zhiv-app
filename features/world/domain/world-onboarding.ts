import type { PixelPose } from "@/features/mochlik/pixel-sprite";

export const WORLD_ONBOARDING_VERSION = 2;

type WorldOnboardingStep = { id: string; title: string; summary: string; text: string; hint: string; pose: PixelPose; selector?: string };
export const WORLD_ONBOARDING_STEPS = Object.freeze([
  Object.freeze({ id: "profile", title: "Познакомимся поближе", summary: "Нажми на мой уровень: тут общая статистика, друзья и настройки.", text: "Нажми на кнопку с моим уровнем. Тут общая статистика, друзья и настройки. Осмотрись, а затем продолжим.", hint: "Открой профиль и осмотрись. Подсказка подождёт.", selector: '[data-world-quick="profile"]', pose: "greet" }),
  Object.freeze({ id: "pantry", title: "Заглянем в кладовую", summary: "Здесь хранятся припасы. Нажми на предмет, чтобы открыть быструю продажу.", text: "В кладовой лежат ягоды, рыба и материалы. Нажми на предмет: появятся количество, сумма и кнопка продажи. В «Холодильнике» рыба разложена по видам. Рынок игроков - отдельный раздел для покупки и продажи другим игрокам; там нужно дождаться покупателя.", hint: "Продавать ради обучения не нужно. Кнопка улучшения кладовой находится в её шапке.", selector: '[data-world-quick="pantry"]', pose: "present" }),
  Object.freeze({ id: "garden", title: "Вырастим малину", summary: "Открой ягодный куст. Нажатие на малину сразу начнёт выращивание.", text: "Открой ягодный куст. У каждой ягоды уже показано время: одно нажатие занимает одно место и выращивает один предмет. Готовый урожай нужно забрать.", hint: "Карту можно двигать мышью или пальцем. Приближение - колесом или двумя пальцами.", selector: '[data-recipe-product="berries"]', pose: "sniff" }),
  Object.freeze({ id: "grow", title: "Твой первый урожай", summary: "Нажми на карточку малины. Затем можно идти дальше.", text: "Одно нажатие на малину начнёт выращивание. Я подожду, пока игра подтвердит работу, и расскажу, как забрать урожай.", hint: "Ягоды растут сами. После запуска можно продолжить знакомство и вернуться позже.", selector: '[data-recipe-product="berries"]', pose: "crouch" }),
  Object.freeze({ id: "neighbors", title: "В лесу мы не одни", summary: "Плёска поможет с рыбалкой, Шишколап - со стройкой.", text: "Познакомься с соседями: Плёска помогает с рыбой и снастями, а Шишколап строит и улучшает здания. Их можно найти на карте и в списке персонажей.", hint: "Открой список жителей и выбери, с кем познакомиться. Покупать что-либо необязательно.", selector: '[data-world-characters-trigger]', pose: "walk" }),
  Object.freeze({ id: "orders", title: "Поможем соседям", summary: "Соберём припасы, отдадим учебный заказ и заберём монеты.", text: "Нажми «Заказы» внизу карты, чтобы открыть журнал. Четыре учебные просьбы появляются по очереди: малина, бревна, компоты и доски. Добывай и готовь товары, затем нажимай «Отдать заказ»: припасы спишутся, а монеты поступят в кошелёк.", hint: "Заказы не исчезнут. Все четыре помогут построить хозяйство и улучшить дом.", selector: '[data-world-orders-entry]', pose: "hold" }),
  Object.freeze({ id: "workshop", title: "Заглянем в мастерскую", summary: "Мастерская превращает бревно в доску для новых построек.", text: "Построй лесной участок и костёр, выполни первые просьбы, затем обустрой мастерскую. Здесь одно бревно превращается в одну доску за две минуты.", hint: "Строительство оплачивается монетами и материалами из кладовой. Условия видны в плане.", selector: '[data-place="workshop"]', pose: "stretch" }),
  Object.freeze({ id: "expeditions", title: "Куда можно отправиться?", summary: "Вылазки приносят материалы. Открой «В путь» и сначала выбери занятие.", text: "Открой «В путь», выбери занятие, затем маршрут. Время, находки и настоящие затраты видны до отправки. Каменоломня на карте работает отдельно.", hint: "Для знакомства достаточно открыть список. Отправляться сейчас необязательно.", selector: '[data-world-quick="expeditions"]', pose: "reach" }),
  Object.freeze({ id: "help", title: "Подсказки всегда рядом", summary: "Теперь можно исследовать лес. Справка всегда под кнопкой i.", text: "Открой справку кнопкой i. В ней можно выбрать тему или воспользоваться поиском. Подсказки раздела запускаются по «Что здесь делать?».", hint: "Для повтора открой мой профиль → «?» → «Повторить обучение». Во время знакомства кнопка называется «Продолжить обучение».", selector: '[data-world-onboarding-help]', pose: "wonder" }),
] as const satisfies readonly WorldOnboardingStep[]);

export type WorldOnboardingStepId = typeof WORLD_ONBOARDING_STEPS[number]["id"];
export type WorldOnboardingProgress = (
  | { version: 2; status: "started"; stepId: WorldOnboardingStepId }
  | { version: 2; status: "skipped" | "completed"; finishedAt?: number }
) & { cropJobId?: string };

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
    const jobId = cropId(record.cropJobId);
    const crop = jobId ? { cropJobId: jobId } : {};
    if (record.status === "skipped" || record.status === "completed") {
      const finishedAt = finishTime(record.finishedAt);
      return { version: 2, status: record.status, ...crop, ...(finishedAt === undefined ? {} : { finishedAt }) };
    }
    if (record.status === "started" && WORLD_ONBOARDING_STEPS.some(step => step.id === record.stepId)) {
      return { version: 2, status: "started", stepId: record.stepId as WorldOnboardingStepId, ...crop };
    }
  } catch { /* A damaged preference must never block entry into the game. */ }
  return null;
}

export type WorldOnboardingEvent =
  | { type: "start" | "replay" }
  | { type: "step"; stepId: WorldOnboardingStepId }
  | { type: "skip" | "complete"; now: number }
  | { type: "crop"; jobId?: string };

/** Local guide progress only. The caller observes real game actions; this never issues one. */
export function transitionWorldOnboarding(progress: WorldOnboardingProgress | null, event: WorldOnboardingEvent): WorldOnboardingProgress | null {
  const crop = progress?.cropJobId ? { cropJobId: progress.cropJobId } : {};
  switch (event.type) {
    case "start": return { version: 2, status: "started", stepId: "profile" };
    case "replay": return { version: 2, status: "started", stepId: "profile" };
    case "step": return { version: 2, status: "started", stepId: event.stepId, ...crop };
    case "skip":
    case "complete": {
      // Repeated completion/skip must not restart the reward deferral. Legacy
      // terminal records intentionally remain undated until an explicit replay.
      const finishedAt = progress && progress.status !== "started" ? progress.finishedAt : finishTime(event.now);
      return { version: 2, status: event.type === "skip" ? "skipped" : "completed", ...crop,
        ...(finishedAt === undefined ? {} : { finishedAt }) };
    }
    case "crop": {
      if (!progress) return null;
      const { cropJobId: previous, ...rest } = progress;
      const jobId = cropId(event.jobId);
      return jobId ? { ...rest, cropJobId: jobId } : previous ? rest : progress;
    }
  }
}
