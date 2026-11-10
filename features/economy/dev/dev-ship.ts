import type { EconomyState } from "@/features/economy/domain/model";
import { createShipVoyage, shipOrdersState, shipOrdersUnlocked } from "@/features/economy/domain/ship-orders";
import { creditEconomyItems, EconomyRuleError } from "@/features/economy/domain/rules";
import type { EconomyDevCommand } from "./dev-model";

/** Total outstanding cargo, counting shared materials across all unfinished orders. */
export function missingDevShipCargo(state: Pick<EconomyState, "ship" | "inventory">): Record<string, number> {
  const needed: Record<string, number> = {};
  for (const order of shipOrdersState(state).voyage?.orders ?? []) {
    if (order.deliveredAt) continue;
    for (const [id, quantity] of Object.entries(order.items))
      needed[id] = (needed[id] ?? 0) + Math.max(0, quantity - (order.loadedItems[id] ?? 0));
  }
  return Object.fromEntries(Object.entries(needed).map(([id, quantity]) => [id, Math.max(0, quantity - (state.inventory[id] ?? 0))]).filter(([, quantity]) => Number(quantity) > 0));
}

/** Only called after the development API has checked its gate, owner and receipt. */
export function applyDevShipCommand(state: EconomyState, command: EconomyDevCommand, now: number, newId: () => string): string {
  if (!shipOrdersUnlocked(state)) throw new EconomyRuleError("ECONOMY_SHIP_LOCKED", "Сначала восстановите маяк: примените готовое поселение дома 3 или выше");
  const ship = shipOrdersState(state);
  if (command.action === "prepare_ship") {
    if (ship.voyage) return "DEV: корабль уже у причала, его грузы сохранены";
    const voyage = createShipVoyage(state, now, newId());
    if (!voyage) throw new EconomyRuleError("ECONOMY_SHIP_UNAVAILABLE", "Для грузов не хватает производств. Примените готовое поселение дома 3 или выше");
    state.ship = { ...ship, voyage, nextAvailableAt: null };
    return "DEV: корабль с тремя грузами готов. Загрузите товары обычными кнопками корабля";
  }
  if (command.action === "grant_ship_cargo") {
    if (!ship.voyage || ship.voyage.id !== command.targetId)
      throw new EconomyRuleError("ECONOMY_SHIP_CHANGED", "Состав корабля изменился. Обновите DEV и повторите выдачу");
    const missing = missingDevShipCargo(state);
    const quantity = Object.values(missing).reduce((sum, value) => sum + value, 0);
    creditEconomyItems(state, missing);
    return quantity ? `DEV: добавлено ${quantity} ед. недостающего груза. Загрузите его в корабль` : "DEV: в кладовой уже хватает товаров для всех оставшихся грузов";
  }
  if (command.action === "shorten_ship_wait") {
    if (ship.voyage) throw new EconomyRuleError("ECONOMY_SHIP_ACTIVE", "Сначала завершите грузы корабля обычной загрузкой");
    if (!ship.nextAvailableAt || Date.parse(ship.nextAvailableAt) <= now)
      throw new EconomyRuleError("ECONOMY_SHIP_READY", "Корабль уже может прибыть");
    state.ship = { ...ship, nextAvailableAt: new Date(now + 5_000).toISOString() };
    return "DEV: до следующего корабля 5 секунд. Закройте мастерскую, чтобы проверить прибытие";
  }
  throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Неизвестный сценарий корабля", 400);
}
