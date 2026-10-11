import type { PixelPose } from "@/features/mochlik/pixel-sprite";

export const WORLD_ONBOARDING_VERSION = 2;

type WorldOnboardingStep = { id: string; title: string; summary: string; text: string; hint: string; pose: PixelPose; selector?: string };
export const WORLD_ONBOARDING_STEPS = Object.freeze([
  Object.freeze({ id: "profile", title: "Познакомимся поближе", summary: "Нажми на мой уровень: здесь достижения, друзья и настройки.", text: "Нажми на кнопку с моим уровнем. В профиле можно посмотреть моё настроение, позвать меня и узнать, как обживается наш лес.", hint: "Открой профиль и осмотрись. Подсказка подождёт.", selector: '[data-world-quick="profile"]', pose: "greet" }),
  Object.freeze({ id: "pantry", title: "Заглянем в кладовую", summary: "Здесь хранятся припасы. Нажми на предмет, чтобы открыть быструю продажу.", text: "В кладовой лежат ягоды, рыба и материалы. Нажми на предмет: появятся количество, сумма и кнопка «Продать торговцу». Рынок игроков — отдельный раздел для покупки и продажи другим игрокам; там нужно дождаться покупателя.", hint: "Продавать ради обучения не нужно. После сбора первые ягоды окажутся здесь.", selector: '[data-world-quick="pantry"]', pose: "present" }),
  Object.freeze({ id: "garden", title: "Попробуем вырастить ягоды", summary: "Открой ягодный куст и выбери обычные ягоды.", text: "Открой ягодный куст и выбери обычные ягоды. Перед началом посмотри время выращивания и награду.", hint: "Карту можно двигать мышью или пальцем. Приближение — колесом или двумя пальцами.", selector: '[data-recipe="grow_berries"]', pose: "sniff" }),
  Object.freeze({ id: "grow", title: "Твой первый урожай", summary: "Нажми «Начать» в карточке ягод. Затем можно идти дальше.", text: "Нажми «Начать» в карточке ягод. Я подожду, пока игра подтвердит выращивание, и расскажу, как забрать урожай.", hint: "Ягоды растут сами. После запуска можно продолжить знакомство и вернуться позже.", selector: '[data-recipe-preparation="grow_berries"] [data-recipe-order] button', pose: "crouch" }),
  Object.freeze({ id: "neighbors", title: "В лесу мы не одни", summary: "Плёска поможет с рыбалкой, Шишколап — со стройкой.", text: "Познакомься с соседями: Плёска помогает с рыбой и снастями, а Шишколап строит и улучшает здания. Их можно найти на карте и в списке персонажей.", hint: "Открой список жителей и выбери, с кем познакомиться. Покупать что-либо необязательно.", selector: '[data-world-characters-trigger]', pose: "walk" }),
  Object.freeze({ id: "orders", title: "Поможем соседям", summary: "Получим ингредиенты, отдадим учебный заказ и заберём монеты.", text: "Шишколап приготовил учебную просьбу. Получи ингредиенты в подсказке, открой заказ и сам нажми «Отдать заказ»: нужные вещи спишутся, а монеты поступят в кошелёк.", hint: "Ингредиенты для практики выдаются один раз. Заказ не исчезнет; его можно выполнить позже.", selector: '[data-world-quick="food"]', pose: "hold" }),
  Object.freeze({ id: "workshop", title: "Заглянем в мастерскую", summary: "Мастерская делает доски и верёвки для новых построек.", text: "В мастерской создают материалы для развития леса. Открой здание и посмотри рецепты: у каждого свои затраты, время и требования.", hint: "Можно изучить рецепт или недостающие условия. Запускать производство ради знакомства не нужно.", selector: '[data-place="workshop"]', pose: "stretch" }),
  Object.freeze({ id: "expeditions", title: "Куда можно отправиться?", summary: "Вылазки приносят материалы. Открой «В путь» и выбери маршрут.", text: "Открой «В путь» и посмотри доступные вылазки. У каждой есть время, награда и требования: их видно до отправки.", hint: "Для знакомства достаточно открыть список. Отправляться сейчас необязательно.", selector: '[data-world-quick="expeditions"]', pose: "reach" }),
  Object.freeze({ id: "help", title: "Подсказки всегда рядом", summary: "Теперь можно исследовать лес. Справка всегда под кнопкой i.", text: "Открой справку кнопкой i. В ней можно выбрать тему или воспользоваться поиском.", hint: "Вернуться к обучению можно по «?» рядом с шестерёнкой в моём профиле или из справки.", selector: '[data-world-onboarding-help]', pose: "wonder" }),
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
