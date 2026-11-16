"use client";

import { useEffect, useRef } from "react";
import { shipDepartureAt, shipOrdersState, shipOrdersUnlocked } from "../domain/ship-orders";
import type { EconomyController } from "./use-economy";

/** Preparing cargo is an authoritative command, sent once per confirmed revision. */
export function useShipOrdersArrival(economy: EconomyController, owner: string, enabled: boolean) {
  const attempted = useRef<string | null>(null);
  const { snapshot, snapshotConfirmed, busy, uncertain, directActionsAvailable, now, act } = economy;
  useEffect(() => {
    if (!enabled || !snapshotConfirmed || !snapshot || snapshot.ownerPublicId !== owner
      || busy || uncertain || !directActionsAvailable || !shipOrdersUnlocked(snapshot)) return;
    const ship = shipOrdersState(snapshot);
    const legacyComplete = ship.voyage?.orders.every(order => order.deliveredAt != null);
    const expired = Boolean(ship.voyage && !legacyComplete && now >= shipDepartureAt(ship.voyage));
    if (ship.voyage && !legacyComplete && !expired) return;
    if (!ship.voyage && ship.nextAvailableAt && now < Date.parse(ship.nextAvailableAt)) return;
    const action = expired ? "expire_ship_voyage" : legacyComplete ? "claim_ship_voyage" : "open_ship_voyage";
    const key = `${owner}:${snapshot.revision}:${action}`;
    if (attempted.current === key) return;
    if (act(action, ship.voyage?.id ?? "port")) attempted.current = key;
  }, [enabled, snapshot, snapshotConfirmed, owner, busy, uncertain, directActionsAvailable, now, act]);
}
