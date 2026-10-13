import type { FixedWorldScene, SiteVisual, WorldBounds } from "@/features/world/tiled/types";
import { boundsInCanvas } from "./canvas-viewport";

/** Match the compositor's padded bounds so the circle includes grounding and
 * foliage overhang, while artwork used only by the full map can load later. */
export function worldArtworkUrls(scene: FixedWorldScene, visuals: Record<string, SiteVisual>, view?: WorldBounds): string[] {
  return [...new Set([
    ...scene.terrain.filter(terrain => boundsInCanvas(view ?? null, terrain.bounds,
      Math.max(16, Math.max(terrain.bounds.width, terrain.bounds.height) * .3))).map(terrain => terrain.image),
    ...scene.sites.filter(site => boundsInCanvas(view ?? null, site.bounds, 16))
      .map(site => visuals[site.id]?.image).filter((url): url is string => Boolean(url)),
  ])];
}
