"use client";

import { useEffect } from "react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { pendingMarketSales, watchWorldMarketSales } from "./market-sale-notice";

export function useWorldMarketSales(economy: EconomyController, owner: string, active: boolean) {
  const confirmed = economy.snapshotConfirmed && economy.snapshot?.ownerPublicId === owner;
  const refresh = economy.refreshMarket;
  useEffect(() => {
    if (active && confirmed) return watchWorldMarketSales(refresh);
  }, [active, confirmed, owner, refresh]);
  return confirmed ? pendingMarketSales(owner, economy.market).length : 0;
}
