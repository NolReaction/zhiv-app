import { createResidentArrivalStore } from "./resident-arrival-storage";

export const minerArrivalStorageKey = (owner: string) => `zhiv.miner-arrival.v1:${encodeURIComponent(owner)}`;
export function createMinerArrivalStore(owner: string, storage?: Pick<Storage, "getItem" | "setItem">) {
  return createResidentArrivalStore(minerArrivalStorageKey(owner), storage);
}
