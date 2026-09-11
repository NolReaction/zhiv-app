export class HabitatAssetError extends Error {
  constructor(readonly timedOut = false) { super(timedOut ? "Habitat asset timed out" : "Habitat asset unavailable"); }
}
const images = new Map<string, Promise<HTMLImageElement>>();

/** Shared downloads have a deadline and can be retried after a network failure. */
export function loadHabitatImage(path: string, priority: "high" | "low" = "high"): Promise<HTMLImageElement> {
  const cached = images.get(path); if (cached) return cached;
  const request = new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.decoding = "async"; image.fetchPriority = priority;
    const timer = setTimeout(() => finish(new HabitatAssetError(true)), priority === "low" ? 60_000 : 15_000);
    function finish(error?: Error) {
      clearTimeout(timer); image.onload = null; image.onerror = null;
      if (error) { image.src = ""; reject(error); } else resolve(image);
    }
    image.onload = () => finish(); image.onerror = () => finish(new HabitatAssetError()); image.src = path;
  }).catch(error => { images.delete(path); throw error; });
  images.set(path, request); return request;
}
