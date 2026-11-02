import type { EconomyShip } from "@/features/economy/domain/ship-model";
import type { TradeShipCargo } from "@/features/world/objects/trade-ship/trade-ship-cargo";

/** Confirmed loaded goods only. Inventory, pending commands and rewards never
 * create deck props. The server removes a fully loaded voyage on departure. */
export function tradeShipCargo(ship: EconomyShip | null | undefined, departing = false): TradeShipCargo {
  if (!ship?.voyage) return departing && ship?.nextAvailableAt ? ship.departureCargo ?? [1, 1, 1] : [];
  if (!Array.isArray(ship.voyage.orders)) return [];
  return ship.voyage.orders.slice(0, 3).map(order => {
    const entries = Object.entries(order.items).filter(([, amount]) => Number.isFinite(amount) && amount > 0);
    const total = entries.reduce((sum, [, amount]) => sum + amount, 0);
    const loaded = entries.reduce((sum, [id, amount]) => sum + (order.deliveredAt ? amount
      : Math.min(amount, Math.max(0, Number.isFinite(order.loadedItems?.[id]) ? order.loadedItems[id] : 0))), 0);
    return total > 0 ? loaded / total : 0;
  });
}
