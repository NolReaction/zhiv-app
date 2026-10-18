import { boundsInCanvas, canvasWorldViewport } from "@/features/world/scene/canvas-viewport";
import { withForestOcclusion, forestPointOccluded } from "@/features/world/scene/forest-occlusion";
import { pleskResidentFrame, type PleskResidentFrame } from "@/features/world/characters/plesk/plesk-resident";
import { drawPleskResident, pleskRenderBounds, pleskHitBounds } from "@/features/world/characters/plesk/plesk-painter";
import { drawBuilderResident, builderRenderBounds, builderHitBounds } from "@/features/world/characters/builder/builder-painter";
import type { BuilderResidentFrame } from "@/features/world/characters/builder/builder-types";
import type { ForestVillagerFrame } from "./forest-villager-types";
import { drawLopukhResident, lopukhRenderBounds, lopukhHitBounds } from "./lopukh/lopukh-painter";
import { drawKamneshmygResident, kamneshmygRenderBounds, kamneshmygHitBounds } from "./kamneshmyg/kamneshmyg-painter";
import { drawLeaftailResident, leaftailRenderBounds, leaftailHitBounds } from "./leaftail/leaftail-painter";
import type { WorldResidentId } from "./world-characters-model";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

export type ForestResidentFrame = PleskResidentFrame | BuilderResidentFrame | ForestVillagerFrame;

function renderBounds(frame: ForestResidentFrame) {
  if (frame.id === "builder") return builderRenderBounds(frame);
  if (frame.id === "plesk") return pleskRenderBounds(frame);
  return frame.id === "lopukh" ? lopukhRenderBounds(frame) : frame.id === "kamneshmyg"
    ? kamneshmygRenderBounds(frame) : leaftailRenderBounds(frame);
}
function hitBounds(frame: ForestResidentFrame) {
  if (frame.id === "builder") return builderHitBounds(frame);
  if (frame.id === "plesk") return pleskHitBounds(frame);
  return frame.id === "lopukh" ? lopukhHitBounds(frame) : frame.id === "kamneshmyg"
    ? kamneshmygHitBounds(frame) : leaftailHitBounds(frame);
}
function drawResident(ctx: CanvasRenderingContext2D, frame: ForestResidentFrame, still: boolean) {
  if (frame.id === "builder") drawBuilderResident(ctx, frame, still);
  else if (frame.id === "plesk") drawPleskResident(ctx, frame, still);
  else if (frame.id === "lopukh") drawLopukhResident(ctx, frame, still);
  else if (frame.id === "kamneshmyg") drawKamneshmygResident(ctx, frame, still);
  else drawLeaftailResident(ctx, frame, still);
}

/** One shared scene clock drives the resident in both cameras. */
export function forestResidentFrames(scene: FixedWorldScene, elapsed: number, still: boolean): ForestResidentFrame[] {
  const resident = pleskResidentFrame(scene, elapsed, still);
  return resident ? [resident] : [];
}

/** Only the body is interactive; the fishing line never steals water taps. */
export function forestResidentAt(scene: FixedWorldScene, elapsed: number, still: boolean, point: WorldPoint,
  frames: readonly ForestResidentFrame[] = forestResidentFrames(scene, elapsed, still)): WorldResidentId | null {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  // Resolve the visible frontmost body, rather than the first resident in the registry.
  for (const resident of [...frames].sort((a, b) => b.y - a.y)) {
    if ("opacity" in resident && (resident.opacity ?? 1) <= .05) continue;
    if (forestPointOccluded(scene, resident.y, point, resident.id === "plesk" ? resident.doorwayOcclusion : undefined)) continue;
    const bounds = hitBounds(resident);
    if (point.x >= bounds.x && point.x <= bounds.x + bounds.width
      && point.y >= bounds.y && point.y <= bounds.y + bounds.height) return resident.id;
  }
  return null;
}

export function drawForestResidents(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, elapsed: number,
  still: boolean, heroY: number, layer: "behind" | "front",
  frames: readonly ForestResidentFrame[] = forestResidentFrames(scene, elapsed, still)) {
  const view = canvasWorldViewport(ctx);
  for (const resident of [...frames].sort((a, b) => a.y - b.y)) {
    if ((resident.y < heroY) !== (layer === "behind")) continue;
    const bounds = renderBounds(resident);
    if (!boundsInCanvas(view, bounds, 3)) continue;
    withForestOcclusion(ctx, scene, resident, target => drawResident(target, resident, still), bounds);
  }
}
