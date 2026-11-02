import { Clock3, Ship } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import { shipDepartureAt, shipOrdersState } from "@/features/economy/domain/ship-orders";
import { worldCountdown } from "@/features/economy/ui/shared/world-stations";

/** The lighthouse uses the same server schedule as the port and the moving ship. */
export function ShipPortStatus({ state, now }: { state: EconomyView; now: number }) {
  const ship = shipOrdersState(state, now);
  const deadline = ship.voyage ? shipDepartureAt(ship.voyage) : ship.nextAvailableAt ? Date.parse(ship.nextAvailableAt) : now;
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <p data-lighthouse-ship-status>{seconds > 0 ? <Clock3 size={14} aria-hidden="true" /> : <Ship size={14} aria-hidden="true" />}{" "}
    {ship.voyage ? <>Корабль у причала. Уйдёт через <strong>{worldCountdown(seconds)}</strong>.</>
      : seconds > 0 ? <>Новый корабль через <strong>{worldCountdown(seconds)}</strong>.</>
      : <>Корабль прибывает с новыми заказами.</>}
  </p>;
}
