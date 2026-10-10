import type Phaser from "phaser";
import type { FixedWorldScene, WorldBounds } from "@/features/world/tiled/types";

/** URLs include the exporter content hash, so two revisions cannot share a key. */
export function worldTextureKey(url: string): string {
  return `phaser-world-art:${url}`;
}

/** Base RGBA residency estimate, excluding driver overhead and decoded sources. */
export function worldTextureStats(scene: Phaser.Scene, source: FixedWorldScene): { textures: number; rgbaBytes: number } {
  let textures = 0, rgbaBytes = 0;
  for (const url of textureBudgets(source).keys()) {
    const key = worldTextureKey(url);
    if (!scene.textures.exists(key)) continue;
    const texture = scene.textures.get(key);
    textures++;
    for (const image of texture.source) rgbaBytes += image.width * image.height * 4;
  }
  return { textures, rgbaBytes };
}

function textureBudgets(source: FixedWorldScene): Map<string, number> {
  const budgets = new Map<string, number>();
  const include = (url: string, bounds: WorldBounds, background = false) => {
    // The background remains full resolution. Separate objects need enough
    // detail for zoom, without retaining 1.5 MP textures for a 60-unit prop.
    const size = background ? Infinity : Math.min(1024, Math.max(128, Math.ceil(Math.max(bounds.width, bounds.height) * 4)));
    budgets.set(url, Math.max(budgets.get(url) ?? 0, size));
  };
  for (const terrain of source.terrain) {
    include(terrain.image, terrain.imagePlacement ?? terrain.bounds,
      terrain.bounds.width >= source.width * .9 && terrain.bounds.height >= source.height * .9);
  }
  for (const site of source.sites) {
    for (const visual of site.states) include(visual.image, visual.geometry?.imagePlacement ?? visual.geometry?.bounds ?? site.imagePlacement ?? site.bounds);
  }
  return budgets;
}

/** All states are available when the scene starts; repeated URLs are queued once. */
export function preloadWorldAssets(scene: Phaser.Scene, source: FixedWorldScene): void {
  const pending = new Map<string, number>();
  for (const [url, size] of textureBudgets(source)) {
    const key = worldTextureKey(url);
    if (scene.textures.exists(key)) continue;
    pending.set(key, size);
    scene.load.image(key, url);
  }
  if (!pending.size) return;

  const resize = (key: string, type: string, data: unknown) => {
    const limit = pending.get(key);
    if (type !== "image" || limit === undefined || !Number.isFinite(limit) || !(data instanceof HTMLImageElement)) return;
    const scale = Math.min(1, limit / Math.max(data.naturalWidth, data.naturalHeight));
    if (scale >= 1) return;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(data.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(data.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) return;
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(data, 0, 0, canvas.width, canvas.height);
    // filecomplete runs after the texture is installed, before scene.create.
    // No sprite references this texture yet; remove also releases its GPU copy.
    scene.textures.remove(key);
    scene.textures.addCanvas(key, canvas);
  };
  const cleanup = () => {
    scene.load.off("filecomplete", resize);
    scene.load.off("complete", cleanup);
    scene.events.off("shutdown", cleanup);
    scene.events.off("destroy", cleanup);
    pending.clear();
  };
  scene.load.on("filecomplete", resize);
  scene.load.once("complete", cleanup);
  scene.events.once("shutdown", cleanup);
  scene.events.once("destroy", cleanup);
}
