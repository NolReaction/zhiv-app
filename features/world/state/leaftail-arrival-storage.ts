import { gameplayStorageKey } from "@/lib/gameplay-generation";
import { createResidentArrivalStore } from "./resident-arrival-storage";

export const leaftailArrivalStorageKey = (owner: string) => gameplayStorageKey(`zhiv.leaftail-arrival.v1:${encodeURIComponent(owner)}`);

/** Preserve the published key and progress format while sharing arrival semantics. */
export function createLeaftailArrivalStore(owner: string, storage?: Pick<Storage, "getItem" | "setItem">) {
  return createResidentArrivalStore(leaftailArrivalStorageKey(owner), storage);
}
