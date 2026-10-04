import type { PixelDirection, PixelPose } from "@/features/mochlik/pixel-sprite";
import { boundsInCanvas, canvasWorldViewport } from "./canvas-viewport";
import { drawGroundedHero } from "./grounding";
import { withForestOcclusion } from "./forest-occlusion";
import { forestDestinations, forestTrails, type ForestTrail } from "./forest-trails";
import { createWorldNavigation, findWorldPath } from "./navigation";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

type Resident = { id: string; routeId: string; destinations: readonly string[]; size: number; speed: number; wait: number; offset: number;
  appearance: { palette: string; head: string | null; neck: string | null } };
export type ForestResidentFrame = WorldPoint & { id: string; size: number; pose: PixelPose; direction: PixelDirection; frame: number;
  appearance: Resident["appearance"] };
type TourLeg = { trail: ForestTrail; start: number; arrival: number; end: number };
type ResidentTour = { resident: Resident; legs: TourLeg[]; duration: number };
type DestinationGraph = Map<string, Map<string, ForestTrail>>;

// These first neighbours are scenery, not economy actors or extra player saves.
// Their appearances can change without changing the destination-based movement.
const residents: readonly Resident[] = [
  { id: "forest-carpenter", routeId: "trail-workshop", destinations: ["home", "workshop", "quarry", "fishing"],
    size: 31, speed: 9, wait: 8, offset: 4,
    appearance: { palette: "autumn", head: "leaf_cap", neck: "amber_scarf" } },
  { id: "shore-neighbour", routeId: "trail-fishing", destinations: ["fishing", "quarry", "workshop", "home"],
    size: 29, speed: 8, wait: 12, offset: 63,
    appearance: { palette: "fern", head: "explorer_cap", neck: "berry_scarf" } },
];
const tourCache = new WeakMap<FixedWorldScene, readonly ResidentTour[]>();
const direction = (dx: number, dy: number): PixelDirection => Math.abs(dx) > Math.abs(dy) ? dx > 0 ? "right" : "left" : dy > 0 ? "front" : "back";

function along(trail: ForestTrail, distance: number, reverse: boolean) {
  let index = 1;
  while (index < trail.distances.length - 1 && trail.distances[index] < distance) index++;
  const a = trail.points[index - 1], b = trail.points[index];
  const ratio = Math.max(0, Math.min(1, (distance - trail.distances[index - 1]) / (trail.distances[index] - trail.distances[index - 1] || 1)));
  return { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio,
    direction: direction((b.x - a.x) * (reverse ? -1 : 1), (b.y - a.y) * (reverse ? -1 : 1)) };
}

function measuredTrail(id: string, points: readonly WorldPoint[]): ForestTrail {
  const distances = [0];
  for (let i = 1; i < points.length; i++) distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  return { id, points, distances, length: distances.at(-1)! };
}

function largestComponent(graph: DestinationGraph): string[] {
  const seen = new Set<string>(); let largest: string[] = [];
  for (const id of graph.keys()) {
    if (seen.has(id)) continue;
    const component = [id]; seen.add(id);
    for (let i = 0; i < component.length; i++) for (const next of graph.get(component[i])!.keys()) {
      if (!seen.has(next)) { seen.add(next); component.push(next); }
    }
    if (component.length > largest.length) largest = component;
  }
  return largest;
}

/** A failed direct search can use already verified legs via another destination.
 * No segment is invented and a disconnected marker never causes a teleport. */
function connectingLegs(graph: DestinationGraph, from: string, to: string): { destination: string; trail: ForestTrail }[] {
  const previous = new Map<string, string>(), pending = [from];
  for (let i = 0; i < pending.length && !previous.has(to); i++) for (const next of graph.get(pending[i])!.keys()) {
    if (next === from || previous.has(next)) continue;
    previous.set(next, pending[i]); pending.push(next);
  }
  if (!previous.has(to)) return [];
  const result: { destination: string; trail: ForestTrail }[] = [];
  for (let at = to; at !== from;) {
    const before = previous.get(at)!;
    result.push({ destination: at, trail: graph.get(before)!.get(at)! }); at = before;
  }
  return result.reverse();
}

/** The bounded network is prepared once per immutable scene: at most 16 points
 * and 120 path searches. Both residents and cameras reuse the resulting tours. */
function residentTours(scene: FixedWorldScene): readonly ResidentTour[] {
  const cached = tourCache.get(scene); if (cached) return cached;
  const tours: ResidentTour[] = [], destinations = forestDestinations(scene);
  const nav = destinations.size > 1 && createWorldNavigation(scene, (scene.actor?.size ?? 50) * .1);
  if (nav) {
    const points = [...destinations.values()], graph: DestinationGraph = new Map(points.map(point => [point.id, new Map()]));
    for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
      const from = points[i], to = points[j], path = findWorldPath(nav, from.position, to.position);
      if (!path || path.length < 2) continue;
      const trail = measuredTrail(`${from.id}:${to.id}`, path);
      if (trail.length <= 1) continue;
      graph.get(from.id)!.set(to.id, trail);
      graph.get(to.id)!.set(from.id, measuredTrail(`${to.id}:${from.id}`, [...path].reverse()));
    }
    const component = largestComponent(graph);
    if (component.length > 1) for (const resident of residents) {
      const order = [...resident.destinations.filter(id => component.includes(id)),
        ...component.filter(id => !resident.destinations.includes(id))];
      const legs: TourLeg[] = []; let elapsed = 0;
      for (let i = 0; i < order.length; i++) {
        const links = connectingLegs(graph, order[i], order[(i + 1) % order.length]);
        for (const { destination, trail } of links) {
          const arrival = elapsed + trail.length / resident.speed, end = arrival + destinations.get(destination)!.pauseSeconds;
          legs.push({ trail, start: elapsed, arrival, end }); elapsed = end;
        }
      }
      if (legs.length && elapsed > 0) tours.push({ resident, legs, duration: elapsed });
    }
  }
  tourCache.set(scene, tours); return tours;
}

function destinationFrames(scene: FixedWorldScene, elapsed: number, still: boolean): ForestResidentFrame[] {
  const frames: ForestResidentFrame[] = [];
  for (const { resident, legs, duration } of residentTours(scene)) {
    const time = still ? legs[0].arrival : (elapsed + resident.offset) % duration;
    const leg = legs.find(candidate => time < candidate.end) ?? legs.at(-1)!;
    const walked = Math.min(leg.trail.length, Math.max(0, time - leg.start) * resident.speed);
    const walking = !still && time < leg.arrival;
    frames.push({ id: resident.id, ...along(leg.trail, walked, false), size: resident.size,
      pose: walking ? "walk" : "idle", frame: walking ? Math.floor(walked / (resident.size * .12)) % 4 : 0,
      appearance: resident.appearance });
  }
  return frames;
}

/** Shared scene time gives both cameras the same positions, with no additional
 * RAF, storage, network, path search or per-frame cache mutation. */
export function forestResidentFrames(scene: FixedWorldScene, elapsed: number, still: boolean): ForestResidentFrame[] {
  const clock = Math.max(0, Number.isFinite(elapsed) ? elapsed : 0);
  if (scene.destinations !== undefined) return destinationFrames(scene, clock, still).sort((a, b) => a.y - b.y);
  const trails = forestTrails(scene), frames: ForestResidentFrame[] = [];
  for (const resident of residents) {
    const trail = trails.get(resident.routeId); if (!trail) continue;
    const travel = trail.length / resident.speed, cycle = travel * 2 + resident.wait * 2;
    const time = still ? travel + resident.wait * .5 : (clock + resident.offset) % cycle;
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
    withForestOcclusion(ctx, scene, resident, () => drawGroundedHero(ctx, resident));
  }
}
