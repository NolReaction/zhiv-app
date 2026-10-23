"use client";
import { gameplayStorageKey } from "@/lib/gameplay-generation";

import { useResidentArrival, type ResidentArrivalOptions } from "./use-resident-arrival";

export function useMinerArrival(owner: string, options: ResidentArrivalOptions) {
  return useResidentArrival(gameplayStorageKey(`zhiv.miner-arrival.v1:${encodeURIComponent(owner)}`), options);
}
