import { boundsInCanvas, canvasWorldViewport } from "@/features/world/scene/canvas-viewport";
import { withForestOcclusion, forestPointOccluded } from "@/features/world/scene/forest-occlusion";
import { pleskResidentFrame, type PleskResidentFrame } from "@/features/world/characters/plesk/plesk-resident";
import { drawPleskResident, pleskRenderBounds, pleskHitBounds } from "@/features/world/characters/plesk/plesk-painter";
import { drawBuilderResident, builderRenderBounds, builderHitBounds } from "@/features/world/characters/builder/builder-painter";
import type { BuilderResidentFrame } from "@/features/world/characters/builder/builder-types";
import type { WorldResidentId } from "./world-characters-model";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";

export type ForestResidentFrame = PleskResidentFrame | BuilderResidentFrame;

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
    if (resident.id === "builder" && (resident.opacity ?? 1) <= .05) continue;
    if (forestPointOccluded(scene, resident.y, point)) continue;
    const bounds = resident.id === "builder" ? builderHitBounds(resident) : pleskHitBounds(resident);
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
    const bounds = resident.id === "builder" ? builderRenderBounds(resident) : pleskRenderBounds(resident);
    if (!boundsInCanvas(view, bounds, 3)) continue;
    withForestOcclusion(ctx, scene, resident, target => resident.id === "builder"
      ? drawBuilderResident(target, resident, still) : drawPleskResident(target, resident, still), bounds);
  }
}
