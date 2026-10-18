export const EARTH_LANDMARK_WIDTH = 56;
export const EARTH_LANDMARK_HEIGHT = 64;
export const EARTH_LANDMARK_FADE_START = 3.8;
export const EARTH_LANDMARK_MAX_ZOOM = 5.2;

type LandmarkCandidate = {
  id: string;
  x: number;
  y: number;
  priority: number;
  covered: boolean;
  width?: number;
  height?: number;
};
type LandmarkView = { scale: number; opacity: number; width: number; height: number };
type Rectangle = { left: number; right: number; top: number; bottom: number };
const LANDMARK_GAP = 4;
const SCALE_STOPS = [[-1.5, 0.68], [0.5, 0.85], [1.8, 1], [EARTH_LANDMARK_FADE_START, 1.12]] as const;

/** The illustration's bottom centre remains attached to its geographic point. */
export function earthLandmarkView(zoom: number): LandmarkView {
  let scale: number = SCALE_STOPS[0][1];
  let opacity = 0;
  if (Number.isFinite(zoom)) {
    opacity = 1;
    for (let index = 1; index < SCALE_STOPS.length; index += 1) {
      const [startZoom, startScale] = SCALE_STOPS[index - 1];
      const [endZoom, endScale] = SCALE_STOPS[index];
      const fraction = Math.max(0, Math.min(1, (zoom - startZoom) / (endZoom - startZoom)));
      scale = startScale + (endScale - startScale) * fraction;
      if (zoom <= endZoom) break;
    }
    const fade = Math.max(0, Math.min(1, (zoom - EARTH_LANDMARK_FADE_START)
      / (EARTH_LANDMARK_MAX_ZOOM - EARTH_LANDMARK_FADE_START)));
    opacity = 1 - fade * fade * (3 - 2 * fade);
  }
  return { scale, opacity, width: EARTH_LANDMARK_WIDTH * scale, height: EARTH_LANDMARK_HEIGHT * scale };
}

/** Greedy, stable decluttering in screen pixels; no coordinate or DOM mutation. */
export function layoutEarthLandmarks(candidates: readonly LandmarkCandidate[], viewport: {
  width: number; height: number;
}, view: LandmarkView): Set<string> {
  const visible = new Set<string>();
  if (![viewport.width, viewport.height, view.width, view.height, view.scale, view.opacity].every(Number.isFinite)
    || viewport.width <= 0 || viewport.height <= 0 || view.width <= 0 || view.height <= 0
    || view.scale <= 0 || view.opacity <= 0) return visible;
  const accepted: Rectangle[] = [];
  const ordered = candidates.map((candidate, index) => ({ candidate, index }))
    .filter(({ candidate }) => !candidate.covered && [candidate.x, candidate.y, candidate.priority].every(Number.isFinite))
    .sort((a, b) => b.candidate.priority - a.candidate.priority || a.index - b.index);
  for (const { candidate } of ordered) {
    if (visible.has(candidate.id)) continue;
    const width = candidate.width ?? view.width;
    const height = candidate.height ?? view.height;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) continue;
    const bounds = { left: candidate.x - width / 2, right: candidate.x + width / 2,
      top: candidate.y - height, bottom: candidate.y };
    if (!Object.values(bounds).every(Number.isFinite)) continue;
    if (bounds.right <= 0 || bounds.left >= viewport.width || bounds.bottom <= 0 || bounds.top >= viewport.height) continue;
    if (accepted.some(other => bounds.left < other.right + LANDMARK_GAP && bounds.right + LANDMARK_GAP > other.left
      && bounds.top < other.bottom + LANDMARK_GAP && bounds.bottom + LANDMARK_GAP > other.top)) continue;
    accepted.push(bounds);
    visible.add(candidate.id);
  }
  return visible;
}
