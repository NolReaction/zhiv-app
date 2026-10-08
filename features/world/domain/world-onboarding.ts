import type { PixelPose } from "@/features/mochlik/pixel-sprite";

export const WORLD_ONBOARDING_VERSION = 2;

type WorldOnboardingStep = { id: string; title: string; text: string; hint: string; pose: PixelPose; selector?: string };
export const WORLD_ONBOARDING_STEPS = Object.freeze([
  Object.freeze({ id: "profile", title: "Познакомимся поближе", text: "Нажми на кнопку с моим уровнем. В профиле можно посмотреть моё настроение, позвать меня и найти ежедневный подарок.", hint: "Открой профиль и осмотрись. Подсказка подождёт.", selector: '[data-world-quick="profile"]', pose: "greet" }),
  Object.freeze({ id: "pantry", title: "Заглянем в кладовую", text: "Открой кладовую: здесь лежат ягоды, рыба и материалы. Счётчик места помогает понять, сколько ещё поместится.", hint: "После сбора наши первые ягоды окажутся здесь.", selector: '[data-world-quick="pantry"]', pose: "present" }),
  Object.freeze({ id: "garden", title: "Попробуем вырастить ягоды", text: "Открой ягодный куст и выбери обычные ягоды. Перед началом посмотри время выращивания и награду.", hint: "Карту можно двигать мышью или пальцем. Приближение — колесом или двумя пальцами.", selector: '[data-recipe="grow_berries"]', pose: "sniff" }),
  Object.freeze({ id: "grow", title: "Твой первый урожай", text: "Нажми «Начать» в карточке ягод. Я подожду, пока игра подтвердит выращивание, и расскажу, как забрать урожай.", hint: "Ягоды растут сами. После запуска можно продолжить знакомство и вернуться позже.", selector: '[data-recipe-preparation="grow_berries"] [data-recipe-order] button', pose: "crouch" }),
  Object.freeze({ id: "expeditions", title: "Куда можно отправиться?", text: "Открой «В путь» и посмотри доступные вылазки. У каждой есть время, награда и требования: их видно до отправки.", hint: "Для знакомства достаточно открыть список. Отправляться сейчас необязательно.", selector: '[data-world-quick="expeditions"]', pose: "reach" }),
  Object.freeze({ id: "help", title: "Подсказки всегда рядом", text: "Открой справку кнопкой i. В ней можно выбрать тему или написать вопрос о текущем действии.", hint: "Вернуться к обучению можно через «Ещё» → «Обучение» или из справки.", selector: '[data-world-onboarding-help]', pose: "wonder" }),
] as const satisfies readonly WorldOnboardingStep[]);

export type WorldOnboardingStepId = typeof WORLD_ONBOARDING_STEPS[number]["id"];
export type WorldOnboardingProgress = (
  | { version: 2; status: "started"; stepId: WorldOnboardingStepId }
  | { version: 2; status: "skipped" | "completed" }
) & { cropJobId?: string };

const legacyStepIds = ["clearing", "profile", "pantry", "expeditions", "help"];

function cropId(value: unknown): string | undefined {
  return typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value) ? value : undefined;
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
    if (record.status === "skipped" || record.status === "completed") return { version: 2, status: record.status, ...crop };
    if (record.status === "started" && WORLD_ONBOARDING_STEPS.some(step => step.id === record.stepId)) {
      return { version: 2, status: "started", stepId: record.stepId as WorldOnboardingStepId, ...crop };
    }
  } catch { /* A damaged preference must never block entry into the game. */ }
  return null;
}

export type WorldOnboardingEvent =
  | { type: "start" | "replay" }
  | { type: "step"; stepId: WorldOnboardingStepId }
  | { type: "skip" | "complete" }
  | { type: "crop"; jobId?: string };

/** Local guide progress only. The caller observes real game actions; this never issues one. */
export function transitionWorldOnboarding(progress: WorldOnboardingProgress | null, event: WorldOnboardingEvent): WorldOnboardingProgress | null {
  const crop = progress?.cropJobId ? { cropJobId: progress.cropJobId } : {};
  switch (event.type) {
    case "start": return { version: 2, status: "started", stepId: "profile", ...crop };
    case "replay": return { version: 2, status: "started", stepId: "profile" };
    case "step": return { version: 2, status: "started", stepId: event.stepId, ...crop };
    case "skip": return { version: 2, status: "skipped", ...crop };
    case "complete": return { version: 2, status: "completed", ...crop };
    case "crop": {
      if (!progress) return null;
      const { cropJobId: previous, ...rest } = progress;
      const jobId = cropId(event.jobId);
      return jobId ? { ...rest, cropJobId: jobId } : previous ? rest : progress;
    }
  }
}
