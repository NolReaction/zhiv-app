import { canStartClearingInteraction, clearingActivityFrame, requestClearingOutside } from "../clearing-activity";
import { FOREST_COOKING_ACTION_SECONDS, FOREST_COOKING_CYCLE_SECONDS, forestCookingFrame,
  type CookingAction, type ForestCookingFrame } from "../forest-cooking";
import { cancelForestDirector } from "../forest-director";
import type { ForestSessionState } from "../forest-session";

export type CookingPreviewSelection = { id: number; action: "sequence" | CookingAction; repeat: boolean };
export type CookingPreviewClock = { id: number; startedAt: number | null; requestedAt: number };
type CookingSession = ForestSessionState & { cookingPreview?: CookingPreviewClock };
type PreviewOptions = { blocked?: boolean; still?: boolean };
const labels: Record<CookingPreviewSelection["action"], string> = {
  sequence: "Готовит лесной обед", prepare: "Нарезает ингредиенты", stir: "Помешивает суп", taste: "Пробует суп", serve: "Подаёт обед",
};

function blockedReason(state: CookingSession, options: PreviewOptions): string | null {
  if (options.blocked || state.journeyTravel || state.fishingPreview) return "Сначала дождитесь возвращения Мохлика из вылазки";
  const garden = state.life.garden;
  if (garden.basket?.held || garden.routine?.kind === "harvest-berries" || state.pendingLife === "harvest-berries"
    || garden.harvest && garden.harvest.phase !== "completed") return "Сначала завершите сбор ягод и поставьте корзину";
  return null;
}
function ready(state: CookingSession) {
  const actor = clearingActivityFrame(state.clearing);
  return canStartClearingInteraction(state.clearing) && actor.opacity === 1 && !actor.residing
    && !actor.bush?.occupied && !actor.lift;
}
export function cookingPreviewDuration(selection: CookingPreviewSelection): number {
  return selection.action === "sequence" ? FOREST_COOKING_CYCLE_SECONDS : FOREST_COOKING_ACTION_SECONDS[selection.action];
}

/** Existing route ownership handles every exit. Cooking may freeze only visible
 * outdoor feet; a sleeping or jumping actor never appears at a replacement point. */
export function startCookingPreview(state: CookingSession, selection: CookingPreviewSelection,
  options: PreviewOptions = {}): boolean {
  const reason = blockedReason(state, options);
  if (reason) { state.director.reason = reason; return false; }
  if (options.still && !ready(state)) {
    state.director.reason = "Для выхода из домика или куста временно включите движение"; return false;
  }
  cancelForestDirector(state, "Выбрана репетиция готовки в DEV");
  state.reaction = 0; state.animation = null;
  if (!ready(state)) requestClearingOutside(state.clearing);
  state.cookingPreview = { id: selection.id, startedAt: null, requestedAt: state.elapsed };
  advanceCookingPreview(state, selection, options);
  return Boolean(state.cookingPreview);
}

/** Call before advancing the director. Disable automatic choices while this
 * request exists, and block actor motion only once startedAt is non-null. */
export function advanceCookingPreview(state: CookingSession, selection: CookingPreviewSelection | null | undefined,
  options: PreviewOptions = {}): void {
  const preview = state.cookingPreview;
  if (!preview) return;
  const reason = blockedReason(state, options);
  if (!selection || selection.id !== preview.id || reason) {
    state.cookingPreview = undefined; state.clearing.frozen = false;
    if (reason) state.director.reason = reason;
    return;
  }
  if (preview.startedAt === null) {
    if (!ready(state)) {
      state.director.reason = "Выходит на свободное место перед готовкой";
      if (state.elapsed - preview.requestedAt > 60) {
        state.cookingPreview = undefined;
        state.director.reason = "Не удалось выйти на свободное место для готовки";
      }
      return;
    }
    preview.startedAt = state.elapsed;
  }
  const age = Math.max(0, state.elapsed - preview.startedAt);
  if (!selection.repeat && age >= cookingPreviewDuration(selection)) {
    state.cookingPreview = undefined; state.clearing.frozen = false;
    state.director.reason = "Репетиция готовки завершена — можно выбрать новое занятие";
    return;
  }
  state.clearing.frozen = true;
  state.director.reason = `${labels[selection.action]} · репетиция без расхода продуктов`;
}

/** Read-only: painting either camera cannot start, finish or restart a rehearsal. */
export function cookingPreviewFrame(state: CookingSession, selection: CookingPreviewSelection | null | undefined,
  still = false): ForestCookingFrame | null {
  const preview = state.cookingPreview;
  if (!selection || !preview || selection.id !== preview.id || preview.startedAt === null) return null;
  const age = Math.max(0, state.elapsed - preview.startedAt);
  if (!selection.repeat && age >= cookingPreviewDuration(selection)) return null;
  const actor = clearingActivityFrame(state.clearing);
  if (actor.opacity < 1 || actor.residing || actor.bush?.occupied || actor.lift) return null;
  return { x: actor.x, y: actor.y, size: state.clearing.size, direction: actor.direction,
    ...forestCookingFrame(age, still, selection.action === "sequence" ? undefined : selection.action) };
}
