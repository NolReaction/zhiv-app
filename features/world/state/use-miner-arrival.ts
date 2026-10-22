"use client";
import { gameplayStorageKey } from "@/lib/gameplay-generation";

import type { MarketUnlockOnboardingCourse } from "@/features/world/domain/market-unlock-onboarding";
import { useResidentArrival } from "./use-resident-arrival";

export function useMinerArrival(owner: string, options: { unlocked: boolean; enabled: boolean; onboarding: MarketUnlockOnboardingCourse }) {
  return useResidentArrival(gameplayStorageKey(`zhiv.miner-arrival.v1:${encodeURIComponent(owner)}`), options);
}
