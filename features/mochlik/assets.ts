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
    const timer = setTimeout(() => finish(new HabitatAssetError(true)), priority === "low" ? 180_000 : 15_000);
    function finish(error?: Error) {
      clearTimeout(timer); image.onload = null; image.onerror = null;
      if (error) { image.src = ""; reject(error); } else resolve(image);
    }
    image.onload = () => finish(); image.onerror = () => finish(new HabitatAssetError()); image.src = path;
  }).catch(error => { images.delete(path); throw error; });
  images.set(path, request); return request;
}

/** Upgrade a usable preview without stranding it after one interrupted download. */
export function createAssetUpgrade(task: () => Promise<void>, active: () => boolean) {
  const delays = [2_000, 8_000, 30_000];
  let disposed = false, running = false, exhausted = false, attempt = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const clear = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  async function run() {
    clear();
    if (disposed || running || !active()) return;
    running = true;
    try { await task(); }
    catch {
      if (attempt >= delays.length) exhausted = true;
      else if (!disposed && active()) timer = setTimeout(() => { void run(); }, delays[attempt++]);
    } finally { running = false; }
  }
  function retry() {
    if (disposed || running || exhausted || timer !== undefined) return;
    void run();
  }
  function reconnect() { if (disposed || running) return; clear(); exhausted = false; attempt = 0; retry(); }
  function visibility() { if (document.hidden) clear(); else reconnect(); }
  window.addEventListener?.("online", reconnect); window.addEventListener?.("focus", reconnect);
  document.addEventListener?.("visibilitychange", visibility);
  return {
    retry,
    dispose() {
      disposed = true; clear();
      window.removeEventListener?.("online", reconnect); window.removeEventListener?.("focus", reconnect);
      document.removeEventListener?.("visibilitychange", visibility);
    },
  };
}
