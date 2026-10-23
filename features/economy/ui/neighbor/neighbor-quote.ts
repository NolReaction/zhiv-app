import type { NeighborView } from "@/features/economy/domain/neighbor-model";
import { economyMarketUnlocked, marketItemUnlocked, marketMinimumPrice } from "@/features/economy/domain/market-rules";
import { locked } from "@/features/economy/sync/controller-state";
import type { EconomyController } from "@/features/economy/sync/use-economy";

export type NeighborQuote = { owner: string; revision: number; cycleId: string; offerId: string; itemId: string;
  quantity: number; totalPrice: number; expiresAt: number };
export function neighborQuoteReason(economy: EconomyController, neighbor: NeighborView, quote: NeighborQuote, now = economy.now): string | null {
  const state = economy.snapshot;
  if (!state || economy.snapshotConfirmed === false) return "Проверяем ваши запасы.";
  if (economy.uncertain) return "Проверяем предыдущий запрос. Не оформляйте покупку заново.";
  if (locked(economy)) return "Дождитесь подтверждения предыдущего действия.";
  if (state.ownerPublicId !== quote.owner || neighbor.ownerPublicId !== quote.owner || state.revision !== quote.revision
    || neighbor.shop.cycleId !== quote.cycleId) return "Данные обновились. Выберите товар ещё раз.";
  if (!economyMarketUnlocked(state, state.catalog)) return "Лавка откроется вместе с вашим лесным рынком.";
  if (!neighbor.shop.available) return "Лавка временно закрыта. Загляните позже.";
  if (now >= Date.parse(neighbor.shop.refreshAt) || now >= quote.expiresAt) return "Предложение устарело. Обновите лавку.";
  const offer = neighbor.shop.offers.find(item => item.id === quote.offerId);
  if (!offer || offer.purchased) return "Эта партия уже куплена. Новые товары появятся завтра.";
  if (offer.itemId !== quote.itemId || offer.quantity !== quote.quantity || offer.totalPrice !== quote.totalPrice)
    return "Предложение изменилось. Выберите товар ещё раз.";
  if (!marketItemUnlocked(state, offer.itemId, state.catalog)) return "Этот товар пока вам не открыт.";
  if (state.wallet.coins < offer.totalPrice) return `Не хватает ${(offer.totalPrice - state.wallet.coins).toLocaleString("ru-RU")} монет.`;
  if (state.storage.available < offer.quantity) return `Нужно ${offer.quantity} мест в кладовой, свободно ${state.storage.available}.`;
  const budget = economy.market?.ownerPublicId === quote.owner ? economy.market.tradeBudget : null;
  if (budget && now < Date.parse(budget.resetsAt) && budget.buysUsed + marketMinimumPrice(offer.itemId, offer.quantity, state.catalog) > budget.limit)
    return "Дневной объём покупок исчерпан. Приходите завтра.";
  return null;
}
export function createNeighborQuote(economy: EconomyController, neighbor: NeighborView, offer: NeighborView["shop"]["offers"][number]): NeighborQuote | null {
  const state = economy.snapshot;
  return state ? { owner: state.ownerPublicId, revision: state.revision, cycleId: neighbor.shop.cycleId, offerId: offer.id,
    itemId: offer.itemId, quantity: offer.quantity, totalPrice: offer.totalPrice,
    expiresAt: Math.min(Date.parse(neighbor.shop.refreshAt), economy.now + 120_000) } : null;
}
