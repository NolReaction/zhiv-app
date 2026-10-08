"use client";
import { useCallback, useSyncExternalStore } from "react";
import { getForestObservation, getServerForestObservation, subscribeForestObservation } from "./forest-observer";
export type { ForestObservation } from "./forest-observer";

export function useForestObservation(presenceKey?: string) {
  const subscribe = useCallback((listener: () => void) => subscribeForestObservation(presenceKey, listener), [presenceKey]);
  const snapshot = useCallback(() => getForestObservation(presenceKey), [presenceKey]);
  return useSyncExternalStore(subscribe, snapshot, getServerForestObservation);
}
