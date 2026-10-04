import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import { boundsInCanvas, canvasWorldViewport } from "./canvas-viewport";
import { drawGroundedHero } from "./grounding";
import { forestTrails, type ForestTrail } from "./forest-trails";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

type Resident = { id: string; routeId: string; size: number; speed: number; wait: number; offset: number;
  appearance: { palette: string; head: string | null; neck: string | null } };
export type ForestResidentFrame = WorldPoint & { id: string; size: number; pose: PixelPose; direction: PixelDirection; frame: number;
  appearance: Resident["appearance"] };

// These first neighbours are scenery, not economy actors or extra player saves.
// Two fixed records and four cached gait frames bound the rendering work.
const residents: readonly Resident[] = [
  { id: "forest-carpenter", routeId: "trail-workshop", size: 31, speed: 9, wait: 8, offset: 4,
    appearance: { palette: "autumn", head: "leaf_cap", neck: "amber_scarf" } },
  { id: "shore-neighbour", routeId: "trail-fishing", size: 29, speed: 8, wait: 12, offset: 63,
    appearance: { palette: "fern", head: "explorer_cap", neck: "berry_scarf" } },
];
const direction = (dx: number, dy: number): PixelDirection => Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "front" : "back";

function along(trail: ForestTrail, distance: number, reverse: boolean) {
  let index = 1;
  while (index < trail.distances.length - 1 && trail.distances[index] < distance) index++;
  const a = trail.points[index - 1], b = trail.points[index];
  const ratio = Math.max(0, Math.min(1, (distance - trail.distances[index - 1]) / (trail.distances[index] - trail.distances[index - 1] || 1)));
  return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio,
    direction: direction((b.x - a.x) * (reverse ? -1 : 1), (b.y - a.y) * (reverse ? -1 : 1)) };
}

/** Shared scene time gives both cameras the same positions, with no additional
 * RAF, storage, network, path search or per-frame cache mutation. */
export function forestResidentFrames(scene: FixedWorldScene, elapsed: number, still: boolean): ForestResidentFrame[] {
  const trails = forestTrails(scene), frames: ForestResidentFrame[] = [];
  for (const resident of residents) {
    const trail = trails.get(resident.routeId); if (!trail) continue;
    const travel = trail.length / resident.speed, cycle = travel * 2 + resident.wait * 2;
    const time = still ? travel + resident.wait * .5 : (Math.max(0, Number.isFinite(elapsed) ? elapsed : 0) + resident.offset) % cycle;
    const reverse = time >= travel + resident.wait;
    const walking = time < travel || reverse && time < travel * 2 + resident.wait;
    const walked = reverse ? Math.max(0, trail.length - (time - travel - resident.wait) * resident.speed)
      : Math.min(trail.length, time * resident.speed);
    frames.push({ id: resident.id, ...along(trail, walked, reverse), size: resident.size,
      pose: walking && !still ? "walk" : "idle", frame: walking && !still ? Math.floor(walked / (resident.size * .12)) % 4 : 0,
      appearance: resident.appearance });
  }
  return frames.sort((a, b) => a.y - b.y);
}

export function drawForestResidents(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, elapsed: number,
  still: boolean, heroY: number, layer: "behind" | "front") {
  const view = canvasWorldViewport(ctx);
  for (const resident of forestResidentFrames(scene, elapsed, still)) {
    if ((resident.y < heroY) !== (layer === "behind")) continue;
    if (!boundsInCanvas(view, { x: resident.x - resident.size / 2, y: resident.y - resident.size,
      width: resident.size, height: resident.size }, 3)) continue;
    drawGroundedHero(ctx, resident);
  }
}
