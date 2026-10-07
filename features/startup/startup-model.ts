import type { ActivityMode } from "@/features/activity/session";
import type { SceneLoadState } from "./scene-load-state";

export type StartupPresentation = {
  ready: boolean;
  progress: number;
  message: string;
  detail: string | null;
  retryAvailable: boolean;
};

export type StartupInputs = {
  screen: "loading" | "load-error" | "onboarding" | "home" | "session-lost";
  online: boolean;
  identityError: string | null;
  appearanceReady: boolean;
  simpleView: boolean;
  sceneRequired: boolean;
  activityMode: ActivityMode;
  activityError: string | null;
  worldReady: boolean;
  economyReady: boolean;
  gameReady: boolean;
  gameFailed: boolean;
  scene: SceneLoadState;
  modules: SceneLoadState;
};

/** Progress is completed startup work, not elapsed time or downloaded bytes. */
export function startupPresentation(input: StartupInputs): StartupPresentation {
  const done = (message: string): StartupPresentation => ({ ready: true, progress: 100, message, detail: null, retryAvailable: false });
  if (input.screen === "onboarding" || input.screen === "session-lost") return done("Добро пожаловать домой");
  // Waiting for assets never bypasses the existing five-minute AFK gate.
  if (input.screen === "home" && input.activityMode === "away") return done("Игра приостановлена");
  const identity = input.screen === "home";
  const simple = input.appearanceReady && (input.simpleView || !input.sceneRequired);
  const connected = input.activityMode === "active";
  const sceneReady = simple || input.scene === "ready";
  const modulesReady = simple || input.modules === "ready";
  const progress = identity ? 14 + Number(input.appearanceReady) * 6 + Number(connected) * 18
    + Number(input.worldReady) * 14 + Number(input.economyReady) * 14 + Number(input.gameReady) * 10
    + Number(modulesReady) * 8 + Number(sceneReady) * 16 : 0;
  const pending = (message: string, detail: string | null = null, retryAvailable = false): StartupPresentation => ({
    ready: false, progress: Math.min(98, progress), message, detail, retryAvailable,
  });
  if (!input.online) return pending("Ждём подключения", "Продолжим автоматически, когда вернётся сеть.");
  if (input.screen === "load-error") return pending("Не удалось связаться с сервером", input.identityError ?? "Пробуем снова. Ваш профиль сохранён.", true);
  if (!identity) return pending("Находим дорогу домой");
  if (!input.appearanceReady) return pending("Готовим ваш уголок");
  if (!connected) return pending(input.activityMode === "error" ? "Восстанавливаем связь" : "Проверяем сохранение",
    input.activityError ?? null, input.activityMode === "error");
  if (!input.worldReady || !input.economyReady) return pending("Загружаем ваш мир");
  if (!input.gameReady) return pending("Вспоминаем ваши достижения", input.gameFailed ? "Ответ задерживается. Повторяем проверку…" : null, input.gameFailed);
  if (!modulesReady || !sceneReady) {
    const failed = input.scene === "error" || input.modules === "error";
    return pending(failed ? "Лес ещё загружается" : "Пробуждаем лес", failed ? "Повторяем загрузку. Уже готовое сохраняем." : null, failed);
  }
  return done("Лес вас заждался");
}
