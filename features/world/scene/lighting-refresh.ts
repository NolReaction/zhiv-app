import type { FixedWorldScene } from "@/features/world/tiled/types";

const lightingKeys = ["lights", "shadowCasters", "shadowReceivers"] as const;
const geometry = (scene: FixedWorldScene) => JSON.stringify(Object.fromEntries(Object.entries(scene)
  .filter(([key]) => !(lightingKeys as readonly string[]).includes(key))));
const listeners = new Set<() => void>();

/** Renderers refresh fixture geometry; Studio reconciles disk changes with its ACKs. */
export function subscribeWorldLightingRefresh(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Torch posts belong to lighting. Terrain, sites and spawn still need normal HMR. */
export function isWorldLightingRefresh(current: FixedWorldScene, next: FixedWorldScene): boolean {
  return geometry(current) === geometry(next);
}

export function acceptWorldLightingRefresh(current: FixedWorldScene, next: FixedWorldScene, commit: () => void): boolean {
  if (!listeners.size || !isWorldLightingRefresh(current, next)) return false;
  // Publish a new immutable snapshot before notifying owners. Mutating the old
  // scene would leave preview, navigation and memory-fingerprint caches stale.
  commit();
  for (const listener of [...listeners]) listener();
  return true;
}
