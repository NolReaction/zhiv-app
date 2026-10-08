import type { AudioListenerFrame, AudioPoint } from "./types";

export const clamp01 = (value: number) => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
export const dbToGain = (db: number) => Number.isFinite(db) ? Math.pow(10, Math.max(-96, Math.min(12, db)) / 20) : 0;
const smooth = (value: number) => { const t = clamp01(value); return t * t * (3 - 2 * t); };

export function distanceGain(distance: number, innerRadius: number, outerRadius: number): number {
  if (![distance, innerRadius, outerRadius].every(Number.isFinite) || innerRadius < 0 || outerRadius <= innerRadius) return 0;
  return 1 - smooth((Math.max(0, distance) - innerRadius) / (outerRadius - innerRadius));
}

export function stereoPan(source: AudioPoint, listener: AudioListenerFrame): number {
  const width = listener.viewportWidth;
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(source.x) || !Number.isFinite(listener.position.x)) return 0;
  // Subtle stereo positioning remains comfortable with headphones and mono speakers.
  return Math.max(-0.8, Math.min(0.8, (source.x - listener.position.x) / (width / 2)));
}

function segmentDistance(p: AudioPoint, a: AudioPoint, b: AudioPoint): number {
  const dx = b.x - a.x, dy = b.y - a.y, length = dx * dx + dy * dy;
  const t = length > 0 ? clamp01(((p.x - a.x) * dx + (p.y - a.y) * dy) / length) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

/** Zero inside/on the polygon; Euclidean distance outside, not distance to its centre. */
export function polygonDistance(point: AudioPoint, points: readonly AudioPoint[]): number {
  if (points.length < 3 || ![point, ...points].every(p => Number.isFinite(p.x) && Number.isFinite(p.y))) return Infinity;
  let inside = false, distance = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const a = points[j], b = points[i];
    distance = Math.min(distance, segmentDistance(point, a, b));
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside ? 0 : distance;
}

export function zoneGain(point: AudioPoint, points: readonly AudioPoint[], fadeDistance: number): number {
  const distance = polygonDistance(point, points);
  if (!Number.isFinite(distance)) return 0;
  if (distance === 0) return 1;
  return Number.isFinite(fadeDistance) && fadeDistance > 0 ? 1 - smooth(distance / fadeDistance) : 0;
}
