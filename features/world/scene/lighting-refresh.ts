import type { FixedWorldScene } from "@/features/world/tiled/types";

const lightingKeys = ["lights", "shadowCasters", "shadowReceivers"] as const;
const geometry = (scene: FixedWorldScene) => JSON.stringify(Object.fromEntries(Object.entries(scene)
  .filter(([key]) => !(lightingKeys as readonly string[]).includes(key))));
const listeners = new Set<() => void>();

/** A connected Studio coordinator validates disk changes against its own ACKs. */
export function subscribeWorldLightingRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Keep live scene ownership when Studio changes only authored lighting. */
export function applyWorldLightingRefresh(current: FixedWorldScene, next: FixedWorldScene): boolean {
  if (geometry(current) !== geometry(next)) return false;
  for (const key of lightingKeys) {
    if (next[key] === undefined) delete current[key];
    else Object.assign(current, { [key]: next[key] });
  }
  return true;
}

export function acceptWorldLightingRefresh(current: FixedWorldScene, next: FixedWorldScene): boolean {
  // Outside Studio, retain normal Tiled refresh and editor baseline hydration.
  if (!listeners.size || !applyWorldLightingRefresh(current, next)) return false;
  for (const listener of [...listeners]) listener();
  return true;
}
