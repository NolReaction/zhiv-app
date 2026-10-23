"use client";

import { leaftailArrivalStorageKey } from "./leaftail-arrival-storage";
import { useResidentArrival, type ResidentArrivalOptions } from "./use-resident-arrival";

export function useLeaftailArrival(owner: string, options: ResidentArrivalOptions) {
  return useResidentArrival(leaftailArrivalStorageKey(owner), options);
}
