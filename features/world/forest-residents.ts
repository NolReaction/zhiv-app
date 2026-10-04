import { boundsInCanvas, canvasWorldViewport } from "./canvas-viewport";
import { withForestOcclusion, forestPointOccluded } from "./forest-occlusion";
import { pleskResidentFrame, type PleskResidentFrame } from "./plesk-resident";
import { drawPleskResident, pleskRenderBounds, pleskHitBounds } from "./plesk-painter";
import type { FixedWorldScene, WorldPoint } from "./tiled/types";

export type ForestResidentFrame = PleskResidentFrame;

/** One shared scene clock drives the resident in both cameras. */
export function forestResidentFrames(scene: FixedWorldScene, elapsed: number, still: boolean): ForestResidentFrame[] {
  const resident = pleskResidentFrame(scene, elapsed, still);
  return resident ? [resident] : [];
}

/** Only the body is interactive; the fishing line never steals water taps. */
export function forestResidentAt(scene: FixedWorldScene, elapsed: number, still: boolean, point: WorldPoint): "plesk" | null {
  const resident = pleskResidentFrame(scene, elapsed, still);
  if (!resident || !Number.isFinite(point.x) || !Number.isFinite(point.y)
    || forestPointOccluded(scene, resident.y, point)) return null;
  const bounds = pleskHitBounds(resident);
  return point.x >= bounds.x && point.x <= bounds.x + bounds.width
    && point.y >= bounds.y && point.y <= bounds.y + bounds.height ? resident.id : null;
}

export function drawForestResidents(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, elapsed: number,
  still: boolean, heroY: number, layer: "behind" | "front", image?: HTMLImageElement) {
  if (!image?.naturalWidth || !image.naturalHeight) return;
  const view = canvasWorldViewport(ctx);
  for (const resident of forestResidentFrames(scene, elapsed, still)) {
    if ((resident.y < heroY) !== (layer === "behind")) continue;
    const bounds = pleskRenderBounds(resident);
    if (!boundsInCanvas(view, bounds, 3)) continue;
    withForestOcclusion(ctx, scene, resident, () => drawPleskResident(ctx, resident, image, still), bounds);
  }
}
