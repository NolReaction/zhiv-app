import type { EconomyShip } from "@/features/economy/domain/ship-model";
import shipOrdersCatalog from "@/apps/api/src/main/resources/world/ship-orders-catalog.json";
import { sampleTradeShipMotion, TRADE_SHIP_VOYAGE } from "@/features/world/objects/trade-ship/trade-ship-motion";
import type { SceneTradeShipFrame } from "@/features/world/state/trade-ship-arrival";

/** Server cooldown starts at completion. Absolute time prevents replay after a
 * hidden tab, remount or reload, and never brings a ship back before new orders. */
export function tradeShipDepartureFrame(ship: EconomyShip | null | undefined, now: number, still = false): SceneTradeShipFrame | null {
  if (!ship || ship.voyage || !ship.nextAvailableAt || still || !Number.isFinite(now)) return null;
  const returnAt = Date.parse(ship.nextAvailableAt);
  if (!Number.isFinite(returnAt)) return null;
  const elapsed = Math.max(0, (now - returnAt) / 1000 + shipOrdersCatalog.intervalSeconds);
  if (elapsed >= TRADE_SHIP_VOYAGE.departureDuration) return null;
  return { motion: sampleTradeShipMotion("departing", elapsed), voyageId: `departure:${ship.nextAvailableAt}`,
    kind: "arrival", pending: false };
}
