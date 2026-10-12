import type { EconomyCommand, EconomyResult, EconomyView } from "./model";

export type LocalSaleReceipt = Readonly<{
  id: string; ownerPublicId: string; revision: number; itemId: string; quantity: number; coins: number;
}>;

/** Only the exact confirmed local sale is a practice result. A refreshed wallet,
 * an unrelated command or a replay whose changes are already loaded is not. */
export function localSaleFromReceipt(before: EconomyView | null, result: EconomyResult,
  command: EconomyCommand): LocalSaleReceipt | null {
  const after = result.state;
  if (command.action !== "sell" || !before || before.ownerPublicId !== after.ownerPublicId
    || command.ownerPublicId !== after.ownerPublicId || command.expectedRevision !== before.revision
    || result.acceptedRevision !== before.revision + 1 || after.revision !== result.acceptedRevision) return null;
  const quantity = (before.inventory[command.targetId] ?? 0) - (after.inventory[command.targetId] ?? 0);
  const coins = after.wallet.coins - before.wallet.coins;
  if (!Number.isSafeInteger(quantity) || quantity <= 0 || quantity !== command.quantity
    || !Number.isSafeInteger(coins) || coins <= 0) return null;
  return Object.freeze({ id: command.requestId, ownerPublicId: after.ownerPublicId, revision: result.acceptedRevision,
    itemId: command.targetId, quantity, coins });
}
