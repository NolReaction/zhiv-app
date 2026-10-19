/** Cache policy sees public viewport/tile coordinates, never GPS or account data. */
export type EarthCacheView = { longitude: number; latitude: number; zoom: number };
export type EarthCacheBudgets = Readonly<{
  diskBytes: number; diskEntries: number; memoryBytes: number; memoryEntries: number;
  concurrency: number; pendingEntries: number; resourceBytes: number; tileEntries: number;
}>;
const MIB = 1024 * 1024;
const bounded = (value: number | undefined, fallback: number, maximum: number) =>
  Number.isFinite(value) && value! > 0 ? Math.max(1, Math.min(maximum, Math.floor(value!))) : fallback;

/** Optional platform hints only reduce limits; no browser/device can enlarge hard caps. */
export function earthCacheBudgets(options: {
  maxBytes?: number; maxEntries?: number; concurrency?: number; deviceMemory?: number;
  quotaBytes?: number | null; usageBytes?: number | null; storedBytes?: number;
} = {}): EarthCacheBudgets {
  const constrained = Number.isFinite(options.deviceMemory) && options.deviceMemory! <= 4;
  let diskBytes = bounded(options.maxBytes, (constrained ? 32 : 64) * MIB, 100 * MIB);
  const quota = options.quotaBytes, usage = options.usageBytes;
  if (typeof quota === "number" && Number.isFinite(quota) && quota >= 0) {
    diskBytes = Math.min(diskBytes, Math.floor(quota * 0.02));
    if (typeof usage === "number" && Number.isFinite(usage) && usage >= 0) {
      // Existing map bytes are already allocated: do not shrink repeatedly because of our own usage.
      diskBytes = Math.min(diskBytes, Math.floor(Math.max(0, quota - usage) * 0.25 + (options.storedBytes ?? 0)));
    }
  }
  const diskEntries = bounded(options.maxEntries, constrained ? 256 : 384, 512);
  const concurrency = bounded(options.concurrency, constrained ? 2 : 4, constrained ? 2 : 4);
  return Object.freeze({ diskBytes, diskEntries, memoryBytes: Math.min(bounded(options.maxBytes, 16 * MIB, 32 * MIB), (constrained ? 8 : 16) * MIB),
    memoryEntries: Math.min(diskEntries, constrained ? 64 : 96), concurrency,
    tileEntries: constrained ? 32 : Number.isFinite(options.deviceMemory) && options.deviceMemory! >= 8 ? 96 : 64,
    pendingEntries: constrained ? 32 : 64, resourceBytes: Math.floor((constrained ? 16 : 32) * MIB / (2 * concurrency)) });
}

function tile(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "tiles.openfreemap.org") return null;
    const match = parsed.pathname.match(/^\/planet\/[^/]+\/(\d+)\/(\d+)\/(\d+)\.pbf$/);
    if (!match) return null;
    const [z, x, y] = match.slice(1).map(Number), scale = 2 ** z;
    return z <= 22 && x < scale && y < scale ? { z, x: (x + 0.5) / scale, y: (y + 0.5) / scale } : null;
  } catch { return null; }
}

/** Session-only, bounded reuse history. No viewport or extra location history is persisted. */
export function createEarthCachePolicy({ now = Date.now, historyLimit = 512 }: { now?: () => number; historyLimit?: number } = {}) {
  const history = new Map<string, { hits: number; used: number }>();
  let view: EarthCacheView | null = null;
  const limit = bounded(historyLimit, 512, 512);
  function score(url: string, saved: number) {
    const visit = history.get(url), age = Math.max(0, now() - (visit?.used ?? saved));
    const reuse = Math.log2(visit?.hits ?? 1) * 4 / (1 + age / 86_400_000);
    let result = reuse + 3 / (1 + age / 600_000);
    const location = tile(url);
    if (!location) return result;
    if (view) {
      const x = ((view.longitude + 180) % 360 + 360) % 360 / 360;
      const latitude = Math.max(-85, Math.min(85, view.latitude)) * Math.PI / 180;
      const y = (1 - Math.log(Math.tan(latitude) + 1 / Math.cos(latitude)) / Math.PI) / 2;
      const rawDx = Math.abs(location.x - x), dx = Math.min(rawDx, 1 - rawDx);
      const distance = Math.hypot(dx, location.y - y);
      const radius = 3 / 2 ** Math.min(location.z, Math.max(0, Math.floor(view.zoom)));
      result += 20 * Math.max(0, 1 - distance / radius);
    }
    // A distant detailed street tile is less reusable than a broad overview at equal reuse.
    return result - Math.max(0, location.z - 8) * 0.2;
  }
  return {
    setView(next: EarthCacheView | null) {
      view = next && [next.longitude, next.latitude, next.zoom].every(Number.isFinite)
        && Math.abs(next.latitude) <= 90 && next.zoom >= -2 && next.zoom <= 24 ? { ...next } : null;
    },
    touch(url: string) {
      const prior = history.get(url);
      history.delete(url);
      history.set(url, { hits: Math.min(8, (prior?.hits ?? 0) + 1), used: now() });
      while (history.size > limit) history.delete(history.keys().next().value!);
    },
    compare(left: { url: string; size: number; saved: number }, right: { url: string; size: number; saved: number }) {
      return score(left.url, left.saved) - score(right.url, right.saved)
        || left.saved - right.saved || right.size - left.size || (left.url < right.url ? -1 : left.url > right.url ? 1 : 0);
    },
    historySize: () => history.size,
  };
}
