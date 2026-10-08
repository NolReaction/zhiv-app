export const WORLD_ONBOARDING_VERSION = 1;

export const WORLD_ONBOARDING_STEPS = Object.freeze([
  Object.freeze({ id: "clearing", title: "Это наша полянка", text: "Здесь я живу, а ты помогаешь мне обустроить лес. Нажми на постройку, чтобы узнать, что в ней можно сделать.", hint: "Карту можно двигать пальцем или мышью. Развести два пальца — приблизить.", icon: "map" }),
  Object.freeze({ id: "profile", title: "Как я себя чувствую?", text: "Кнопка с уровнем открывает мой профиль. Там можно посмотреть настроение, позвать меня и забрать ежедневный подарок.", hint: "Мой профиль — слева вверху, рядом с кнопкой назад.", selector: '[data-world-quick="profile"]', icon: "leaf" }),
  Object.freeze({ id: "pantry", title: "Все находки — в кладовой", text: "Ягоды, рыба и материалы хранятся здесь. Заглядывай в кладовую перед стройкой: сразу увидишь, что уже есть и чего не хватает.", hint: "Место ограничено. Кладовую можно расширять.", selector: '[data-world-quick="pantry"]', icon: "package" }),
  Object.freeze({ id: "expeditions", title: "Отправимся за находками", text: "В «В путь» выбирай вылазку. Я отправлюсь за ресурсами, а когда вернусь, здесь можно будет забрать добычу.", hint: "Перед отправкой посмотри время, стоимость и нужные предметы.", selector: '[data-world-quick="expeditions"]', icon: "compass" }),
  Object.freeze({ id: "help", title: "Я рядом, если запутаешься", text: "Кнопка с буквой i открывает справку. Напиши свой вопрос или выбери раздел — там есть короткие объяснения и подсказки по текущей ситуации.", hint: "Эту прогулку можно повторить: «Ещё» → «Обучение» или через справку.", selector: '[data-world-onboarding-help]', icon: "help" }),
] as const);

export type WorldOnboardingStepId = typeof WORLD_ONBOARDING_STEPS[number]["id"];
export type WorldOnboardingProgress =
  | { version: 1; status: "started"; stepId: WorldOnboardingStepId }
  | { version: 1; status: "skipped" | "completed" };

export function parseWorldOnboarding(raw: string | null): WorldOnboardingProgress | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return null;
    const record = value as Record<string, unknown>;
    if (record.version !== WORLD_ONBOARDING_VERSION) return null;
    if (record.status === "skipped" || record.status === "completed") return { version: 1, status: record.status };
    if (record.status === "started" && WORLD_ONBOARDING_STEPS.some(step => step.id === record.stepId)) {
      return { version: 1, status: "started", stepId: record.stepId as WorldOnboardingStepId };
    }
  } catch { /* A damaged preference must never block entry into the game. */ }
  return null;
}
