import type { SiteGeometry } from "./tiled/types";

type Artwork = HTMLImageElement | HTMLCanvasElement;
type Geometry = Pick<SiteGeometry, "bounds" | "imagePlacement">;
type SourceCache = { width: number; height: number; levels: Map<number, Entry> };
type Entry = { canvas: HTMLCanvasElement; bytes: number; bucket: number; owner: SourceCache };
const CACHE_BYTES = 16 * 1024 * 1024;
const MAX_LEVEL = 1024;

/** Static artwork only. Panning never changes a key; scale tiers are rounded UP
 * to retain at least one texture pixel per physical screen pixel. Larger views
 * use the original. A single background cannot evict the entire sprite cache. */
export function createArtworkMipCache(budget = CACHE_BYTES) {
  const sources = new WeakMap<Artwork, SourceCache>(), recent = new Set<Entry>();
  let bytes = 0;
  function remove(entry: Entry) {
    if (!recent.delete(entry)) return;
    entry.owner.levels.delete(entry.bucket); bytes -= entry.bytes;
  }
  function image(ctx: CanvasRenderingContext2D, geometry: Geometry, source: Artwork): Artwork {
    if (typeof document === "undefined") return source;
    const width = "naturalWidth" in source ? source.naturalWidth : source.width;
    const height = "naturalHeight" in source ? source.naturalHeight : source.height;
    const t = ctx.getTransform?.();
    if (!t || !width || !height) return source;
    const placement = geometry.imagePlacement ?? geometry.bounds;
    const angle = (geometry.imagePlacement?.rotation ?? 0) % 360 * Math.PI / 180;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const physicalWidth = Math.hypot(t.a * cos + t.c * sin, t.b * cos + t.d * sin) * placement.width;
    const physicalHeight = Math.hypot(t.c * cos - t.a * sin, t.d * cos - t.b * sin) * placement.height;
    const largest = Math.max(width, height), requested = largest * Math.max(physicalWidth / width, physicalHeight / height);
    if (!Number.isFinite(requested) || requested <= 0) return source;
    const bucket = Math.max(32, 2 ** Math.ceil(Math.log2(requested)));
    if (bucket > MAX_LEVEL || bucket >= largest) return source;
    const targetWidth = Math.max(1, Math.ceil(width * bucket / largest));
    const targetHeight = Math.max(1, Math.ceil(height * bucket / largest));
    const cost = targetWidth * targetHeight * 4;
    if (cost > budget / 4) return source;
    let owner = sources.get(source);
    if (owner && (owner.width !== width || owner.height !== height)) {
      for (const entry of owner.levels.values()) remove(entry);
      owner = undefined;
    }
    if (!owner) { owner = { width, height, levels: new Map() }; sources.set(source, owner); }
    const previous = owner.levels.get(bucket);
    if (previous) { recent.delete(previous); recent.add(previous); return previous.canvas; }
    const canvas = document.createElement("canvas"); canvas.width = targetWidth; canvas.height = targetHeight;
    const target = canvas.getContext("2d"); if (!target) return source;
    // The costly large-factor filter runs once per source/scale, never per pan.
    target.imageSmoothingEnabled = true; target.imageSmoothingQuality = "high";
    target.drawImage(source, 0, 0, targetWidth, targetHeight);
    while (bytes + cost > budget && recent.size) remove(recent.values().next().value!);
    const entry = { canvas, bytes: cost, bucket, owner };
    owner.levels.set(bucket, entry); recent.add(entry); bytes += cost;
    return canvas;
  }
  return { image, clear() { for (const entry of recent) remove(entry); }, get retainedBytes() { return bytes; } };
}

export const worldArtworkMipCache = createArtworkMipCache();
