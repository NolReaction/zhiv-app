"use client";

import type { MarketUnlockOnboardingCourse } from "@/features/world/domain/market-unlock-onboarding";
import { leaftailArrivalStorageKey } from "./leaftail-arrival-storage";
import { useResidentArrival } from "./use-resident-arrival";

export function useLeaftailArrival(owner: string, options: { unlocked: boolean; enabled: boolean; onboarding: MarketUnlockOnboardingCourse }) {
  return useResidentArrival(leaftailArrivalStorageKey(owner), options);
}
