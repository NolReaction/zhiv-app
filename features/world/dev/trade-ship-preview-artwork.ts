/** Optional DEV artwork never blocks the world's required Tiled image batch. */
export function createTradeShipPreviewArtwork(load: () => Promise<HTMLImageElement>, changed: () => void, failed: () => void) {
  let image: HTMLImageElement | null = null, enabled = false, disposed = false, generation = 0;
  return {
    getImage: () => image,
    setEnabled(next: boolean) {
      if (disposed || next === enabled) return;
      enabled = next; image = null;
      const owner = ++generation;
      if (!enabled) return;
      void Promise.resolve().then(load).then(loaded => {
        if (disposed || !enabled || owner !== generation) return;
        image = loaded; changed();
      }).catch(() => {
        if (!disposed && enabled && owner === generation) failed();
      });
    },
    dispose() { disposed = true; enabled = false; image = null; generation++; },
  };
}
