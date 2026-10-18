"use client";

import type { MarketUnlockOnboardingCourse } from "@/features/world/domain/market-unlock-onboarding";
import { useResidentArrival } from "./use-resident-arrival";

export function useMinerArrival(owner: string, options: { unlocked: boolean; enabled: boolean; onboarding: MarketUnlockOnboardingCourse }) {
  return useResidentArrival(`zhiv.miner-arrival.v1:${encodeURIComponent(owner)}`, options);
}
