import { boatArtworkLayers, type BoatArtLoadout } from "./fishing-boat-artwork";

/** Optional boat parts never block the forest. The scene owns invalidation and lifetime. */
export function createFishingBoatArtwork(
  load: (src: string) => Promise<HTMLImageElement>,
  changed: () => void,
  failed: () => void = () => {},
  clock: () => number = Date.now,
) {
  const images = new Map<string, HTMLImageElement>();
  const pending = new Set<string>(), retryAfter = new Map<string, number>();
  let current = new Set<string>(), disposed = false;
  function request() {
    if (disposed) return;
    for (const src of current) {
      if (images.has(src) || pending.has(src) || clock() < (retryAfter.get(src) ?? 0)) continue;
      pending.add(src);
      void load(src).then(image => {
        if (disposed) return;
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error("Invalid fishing boat artwork");
        images.set(src, image); retryAfter.delete(src);
        if (current.has(src)) changed();
      }).catch(() => {
        if (disposed) return;
        retryAfter.set(src, clock() + 30_000);
        if (current.has(src)) failed();
      }).finally(() => pending.delete(src));
    }
  }
  return {
    update(loadout: BoatArtLoadout | null) {
      current = new Set(loadout ? boatArtworkLayers(loadout).map(layer => layer.src) : []);
      request();
    },
    getImages(): ReadonlyMap<string, HTMLImageElement> { return images; },
    retry() { retryAfter.clear(); request(); },
    dispose() { disposed = true; current.clear(); images.clear(); retryAfter.clear(); },
  };
}
