import { GameplayReconciliationError } from "./session";

type GameplaySession = {
  reconcile: () => Promise<boolean>;
  getReconciliationError: () => string | null;
};

/** Read the sessions after awaiting: render-time error snapshots are stale here. */
export async function reconcileGameplaySessions(world: GameplaySession, economy: GameplaySession) {
  const results = await Promise.all([world.reconcile(), economy.reconcile()]);
  if (results.every(Boolean)) return true;
  const details = [
    !results[0] && `Мир: ${world.getReconciliationError() ?? "не удалось подтвердить сохранение. Повторите проверку."}`,
    !results[1] && `Хозяйство: ${economy.getReconciliationError() ?? "не удалось подтвердить сохранение. Повторите проверку."}`,
  ].filter(Boolean);
  throw new GameplayReconciliationError(details.join(" "));
}
