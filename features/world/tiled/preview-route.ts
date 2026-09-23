import type { PixelDirection } from "@/features/mochlik/pixel-sprite";
import { previewPointInPolygon } from "./preview-state";
import type { FixedWorldScene, WorldPath, WorldPoint } from "./types";

export type PreviewActor = WorldPoint & { direction: PixelDirection; walking: boolean; frame: number };
export type PreviewRouteStatus = { pathId: string | null; moving: boolean; error: string | null };
type CheckedPath = { id: string; points: WorldPoint[]; lengths: number[]; total: number; error: string | null };
const distance = (a: WorldPoint, b: WorldPoint) => Math.hypot(a.x - b.x, a.y - b.y);

function checkPath(scene: FixedWorldScene, path: WorldPath): CheckedPath {
  const lengths = path.points.slice(1).map((point, i) => distance(point, path.points[i]));
  const total = lengths.reduce((sum, value) => sum + value, 0);
  const result = { id: path.id, points: path.points, lengths, total, error: null as string | null };
  const inBounds = (point: WorldPoint) => Number.isFinite(point.x) && Number.isFinite(point.y)
    && point.x >= 0 && point.y >= 0 && point.x <= scene.width && point.y <= scene.height;
  if (path.points.length < 2 || !Number.isFinite(total) || total <= 0 || !path.points.every(inBounds)) {
    return { ...result, error: "Нужна линия хотя бы из двух разных точек внутри карты." };
  }
  // Sample every segment, including its endpoints; never connect separately authored routes.
  const safe = (point: WorldPoint) => scene.sites.every(site => ![[0, 0], [-8, 0], [8, 0], [0, -5], [0, 5]].some(([x, y]) =>
    previewPointInPolygon({ x: point.x + x, y: point.y + y }, site.collision)));
  for (let i = 0; i < lengths.length; i++) {
    const from = path.points[i], to = path.points[i + 1], samples = Math.max(1, Math.ceil(lengths[i] / 3));
    for (let step = 0; step <= samples; step++) {
      if (!safe({ x: from.x + (to.x - from.x) * step / samples, y: from.y + (to.y - from.y) * step / samples })) {
        return { ...result, error: "Линия пересекает коллизию постройки. Исправьте её в Tiled." };
      }
    }
  }
  return result;
}

/** Local authoring playback only: no journeys, game commands or inferred connecting paths. */
export function createPreviewRoute(scene: FixedWorldScene) {
  const paths = scene.paths.map(path => checkPath(scene, path));
  const home = scene.sites.find(site => site.id === "home") ?? scene.sites[0];
  const spawn = scene.actor?.spawn ?? home?.entry ?? null;
  let selected: CheckedPath | null = null, pathId: string | null = null, error: string | null = null;
  let position = 0, destination = 0, direction: PixelDirection = "front";
  const moving = () => Math.abs(destination - position) > .001;

  function select(id: string | null) {
    pathId = id; selected = paths.find(path => path.id === id) ?? null;
    error = id === null ? null : selected?.error ?? (selected ? null : "Маршрут не найден в карте.");
    position = 0; destination = 0; direction = "front";
    return !error;
  }
  function travel(to: number, instant: boolean) {
    if (!selected || error) return false;
    destination = to;
    if (instant) position = destination;
    return true;
  }
  function legacyPath() {
    const path = paths.find(item => item.id === "home-walk" && !item.error);
    if (!path) return null;
    if (pathId !== path.id) {
      select(path.id);
      position = home && distance(path.points.at(-1)!, home.entry) < distance(path.points[0], home.entry) ? path.total : 0;
      destination = position;
    }
    return path;
  }
  return {
    choices: paths.map(({ id, error }) => ({ id, error })),
    status: (): PreviewRouteStatus => ({ pathId, moving: moving(), error }),
    select,
    moving,
    advance(seconds: number) {
      if (!Number.isFinite(seconds)) return;
      position += Math.sign(destination - position) * Math.min(Math.abs(destination - position), Math.max(0, seconds) * 52);
    },
    settle() { position = destination; },
    reset() { select(null); },
    start(instant: boolean) {
      if (!selected || error) return false;
      if (position >= selected.total) position = 0;
      return travel(selected.total, instant);
    },
    reverse(instant: boolean) {
      if (!selected || error) return false;
      return travel(moving() ? destination > position ? 0 : selected.total : position > 0 ? 0 : selected.total, instant);
    },
    // Compatibility for existing callers of the original home-walk preview API.
    walkTo(siteId: string, instant: boolean) {
      if (siteId !== home?.id) return false;
      const path = legacyPath();
      if (!path || !home) return false;
      return travel(distance(path.points.at(-1)!, home.entry) < distance(path.points[0], home.entry) ? path.total : 0, instant);
    },
    stroll(instant: boolean) {
      const path = legacyPath();
      if (!path) return false;
      const origin = home && distance(path.points.at(-1)!, home.entry) < distance(path.points[0], home.entry) ? path.total : 0;
      return travel(origin === 0 ? path.total : 0, instant);
    },
    at(elapsed: number, animate: boolean): PreviewActor | null {
      if (!selected || error) return spawn ? { ...spawn, direction: "front", walking: false, frame: 0 } : null;
      let remaining = position;
      for (let i = 0; i < selected.lengths.length; i++) {
        const length = selected.lengths[i];
        if (!length || (remaining > length && i < selected.lengths.length - 1)) { remaining -= length; continue; }
        const from = selected.points[i], to = selected.points[i + 1], progress = Math.min(1, remaining / length);
        if (moving()) {
          const sign = Math.sign(destination - position), dx = (to.x - from.x) * sign, dy = (to.y - from.y) * sign;
          direction = Math.abs(dx) > Math.abs(dy) ? dx < 0 ? "left" : "right" : dy < 0 ? "back" : "front";
        }
        return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress,
          direction, walking: moving() && animate, frame: moving() && animate ? Math.floor(elapsed * 7) % 4 : 0 };
      }
      return { ...selected.points.at(-1)!, direction, walking: false, frame: 0 };
    },
  };
}
