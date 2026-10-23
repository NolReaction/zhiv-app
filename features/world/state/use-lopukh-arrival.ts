"use client";
import { gameplayStorageKey } from "@/lib/gameplay-generation";

import { useResidentArrival, type ResidentArrivalOptions } from "./use-resident-arrival";

export function useLopukhArrival(owner: string, options: ResidentArrivalOptions) {
  return useResidentArrival(gameplayStorageKey(`zhiv.lopukh-arrival.v1:${encodeURIComponent(owner)}`), options);
}
