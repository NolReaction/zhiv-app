import type { WorldPoint } from "./tiled/types";
import { previewPointInPolygon } from "./tiled/preview-state";

export type BerryLayout = WorldPoint & { radius: number };
const berryLayouts = new WeakMap<readonly WorldPoint[], BerryLayout[]>();
const blend = (a: WorldPoint, b: WorldPoint, t: number) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** One reachable cluster and a few quiet clusters across the authored foliage. */
export function forestGardenBerryLayout(plant: { id: string; points: WorldPoint[] }, entry: WorldPoint): BerryLayout[] {
  const cached = berryLayouts.get(plant.points);
  if (cached) return cached;
  if (plant.points.length < 3) return [];
  const xs = plant.points.map(p => p.x), ys = plant.points.map(p => p.y);
  const left = Math.min(...xs), top = Math.min(...ys), width = Math.max(...xs) - left, height = Math.max(...ys) - top;
  if (![left, top, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return [];
  const radius = Math.min(1.6, Math.min(width, height) * .028);
  const accepted: BerryLayout[] = [];
  const add = (point: WorldPoint) => {
    if (![[0, 0], [-radius * 1.8, 0], [radius * 1.8, 0], [0, -radius * 1.8], [0, radius * 1.8]].every(([dx, dy]) =>
      previewPointInPolygon({ x: point.x + dx, y: point.y + dy }, plant.points))) return;
    if (accepted.some(other => Math.hypot(other.x - point.x, other.y - point.y) < radius * 7)) return;
    accepted.push({ ...point, radius });
  };
  const edge = plant.points.reduce((nearest, point) => Math.hypot(point.x - entry.x, point.y - entry.y)
    < Math.hypot(nearest.x - entry.x, nearest.y - entry.y) ? point : nearest);
  const middle = { x: left + width / 2, y: top + height / 2 };
  // A lower-front cluster is below the near ear when the hero works beside it.
  // The same cluster determines the safe approach and the visible paw contact.
  for (const heightRatio of [.92, .89, .86]) {
    add({ x: middle.x + (entry.x < middle.x ? -1 : 1) * width * .065, y: top + height * heightRatio });
    if (accepted.length) break;
  }
  if (!accepted.length) for (const inset of [.13, .18, .23, .28]) { add(blend(edge, middle, inset)); if (accepted.length) break; }
  let seed = [...plant.id].reduce((hash, char) => Math.imul(hash, 31) + char.charCodeAt(0) | 0, 13) >>> 0;
  const random = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 0x100000000);
  for (let attempt = 0; attempt < 90 && accepted.length < 7; attempt++) {
    add({ x: left + width * (.16 + random() * .68), y: top + height * (.19 + random() * .62) });
  }
  berryLayouts.set(plant.points, accepted);
  return accepted;
}

