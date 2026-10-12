"use client";

import { useEffect, useRef } from "react";
import type { EconomyCommand, EconomyView } from "@/features/economy/domain/model";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { locked } from "@/features/economy/sync/controller-state";

/** Quotes and loadout choices belong to the displayed owner and revision.
 * One latch also keeps equip → depart in the same frame from bypassing receipt confirmation. */
export function useFishingCommand({ economy, state }: { economy: EconomyController; state: EconomyView }) {
  const sent = useRef(false);
  useEffect(() => { if (!economy.busy) sent.current = false; }, [economy.busy, economy.error, economy.uncertain, state.ownerPublicId, state.revision]);
  const current = economy.snapshot?.ownerPublicId === state.ownerPublicId && economy.snapshot?.revision === state.revision;
  const blocked = locked(economy) || !current;
  function send(action: EconomyCommand["action"], targetId: string, quantity = 1, totalPrice = 0, allowed = true) {
    if (blocked || !allowed || sent.current) return;
    sent.current = true;
    economy.act(action, targetId, quantity, totalPrice);
  }
  return { blocked, send };
}
