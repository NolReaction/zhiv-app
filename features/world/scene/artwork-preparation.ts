import type { FixedWorldScene, SiteVisual } from "@/features/world/tiled/types";
import { forestSiteMaterial, prepareForestObjectArtwork, type ForestObjectMaterial } from "./forest-object-appearance";

/** Opportunistic preparation only: no timeout can force work into a busy frame,
 * no polling timer or extra animation loop, and no download/scale change. */
export function createArtworkPreparation(scene: FixedWorldScene, visuals: Record<string, SiteVisual>,
  images: ReadonlyMap<string, HTMLImageElement>, active: () => boolean) {
  const center = { x: scene.focus.x + scene.focus.width / 2, y: scene.focus.y + scene.focus.height / 2 };
  const candidates: { image: HTMLImageElement; material: ForestObjectMaterial; distance: number }[] = [];
  for (const site of scene.sites) {
    const image = images.get(visuals[site.id]?.image);
    if (image) candidates.push({ image, material: forestSiteMaterial(site),
      distance: Math.hypot(site.anchor.x - center.x, site.anchor.y - center.y) });
  }
  for (const terrain of scene.terrain) {
    const image = images.get(terrain.image);
    if (image && scene.bushes?.some(bush => bush.imageId === terrain.id)) candidates.push({ image, material: "foliage",
      distance: Math.hypot(terrain.bounds.x + terrain.bounds.width / 2 - center.x, terrain.bounds.y + terrain.bounds.height / 2 - center.y) });
  }
  candidates.sort((a, b) => a.distance - b.distance);
  const jobs: ReturnType<typeof prepareForestObjectArtwork>[] = [];
  let index = 0, idle: number | null = null, disposed = false;
  function pause() {
    if (idle !== null) { window.cancelIdleCallback(idle); idle = null; }
  }
  function resume() {
    if (disposed || idle !== null || index >= candidates.length || !active()
      || typeof window.requestIdleCallback !== "function" || typeof window.cancelIdleCallback !== "function") return;
    idle = window.requestIdleCallback(deadline => {
      idle = null;
      if (disposed || !active()) return;
      // Exactly one bounded phase per idle callback. A later callback gives
      // input and the renderer another opportunity to run between phases.
      if (deadline.timeRemaining() >= 4) {
        const candidate = candidates[index];
        const job = jobs[index] ?? (jobs[index] = prepareForestObjectArtwork(candidate.image, candidate.material));
        if (job.step()) index++;
      }
      resume();
    });
  }
  return { pause, resume, dispose() { disposed = true; pause(); for (const job of jobs) job.cancel(); } };
}
