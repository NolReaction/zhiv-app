import type Phaser from "phaser";
import { siteContactArea } from "@/features/world/scene/grounding";
import { previewSiteVisual } from "@/features/world/tiled/preview-state";
import type { FixedWorldScene, SiteGeometry, WorldLight } from "@/features/world/tiled/types";
import type { PhaserWorldOptions } from "./contracts";
import { worldTextureKey } from "./presentation-assets";
import { createBakedOccluders } from "./presentation-occluders";

export { preloadWorldAssets } from "./presentation-assets";

type PresentationOptions = Pick<PhaserWorldOptions, "levels" | "night" | "shadows" | "reducedMotion">;
type Glow = { object: Phaser.GameObjects.Image; light: WorldLight; phase: number };
let presentationId = 0;

function positionImage(image: Phaser.GameObjects.Image, geometry: Pick<SiteGeometry, "bounds" | "imagePlacement">) {
  const placement = geometry.imagePlacement ?? geometry.bounds;
  image.setOrigin(0, 0).setPosition(placement.x, placement.y)
    .setDisplaySize(placement.width, placement.height).setAngle(geometry.imagePlacement?.rotation ?? 0);
}

function radialCanvas(size: number, shadow: boolean, lightColor = 0xffffff): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size; canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Не удалось подготовить текстуру освещения.");
  const gradient = context.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  const color = shadow ? "23,29,23" : `${lightColor >> 16 & 255},${lightColor >> 8 & 255},${lightColor & 255}`;
  gradient.addColorStop(0, `rgba(${color},${shadow ? .66 : 1})`);
  gradient.addColorStop(shadow ? .3 : .12, `rgba(${color},${shadow ? .5 : .8})`);
  gradient.addColorStop(.6, `rgba(${color},${shadow ? .16 : .2})`);
  gradient.addColorStop(1, `rgba(${color},0)`);
  context.fillStyle = gradient;
  context.fillRect(0, 0, size, size);
  return canvas;
}

/** Native image objects carry placement and depth. Lighting is deliberately an
 * ambient overlay plus local glow, not normal-mapped or occluded illumination. */
export function createWorldPresentation(scene: Phaser.Scene, initialWorld: FixedWorldScene, initialOptions: PresentationOptions) {
  const prefix = `phaser-world-presentation:${++presentationId}`;
  const shadowKey = `${prefix}:contact`;
  scene.textures.addCanvas(shadowKey, radialCanvas(128, true));
  const glowTextures = new Map<string, string>();
  const terrain = new Map<string, Phaser.GameObjects.Image>();
  const sites = new Map<string, Phaser.GameObjects.Image>();
  const shadows = new Map<string, Phaser.GameObjects.Image>();
  const glows = new Map<string, Glow>();
  const occluders = createBakedOccluders(scene, prefix);
  const darkness = scene.add.rectangle(0, 0, initialWorld.width, initialWorld.height, 0x0d2133, .44)
    .setOrigin(0, 0).setDepth(8000);
  let options = initialOptions;
  let disposed = false;

  function imageFor(collection: Map<string, Phaser.GameObjects.Image>, id: string, url: string) {
    const key = worldTextureKey(url);
    let image = collection.get(id);
    if (!image) {
      image = scene.add.image(0, 0, key);
      collection.set(id, image);
    } else if (image.texture.key !== key) image.setTexture(key);
    return image;
  }
  function prune(collection: Map<string, Phaser.GameObjects.Image>, retained: Set<string>) {
    for (const [id, image] of collection) {
      if (retained.has(id)) continue;
      image.destroy(); collection.delete(id);
    }
  }
  function update(world: FixedWorldScene, nextOptions: PresentationOptions) {
    if (disposed) return;
    options = nextOptions;
    const terrainIds = new Set<string>(), siteIds = new Set<string>(), shadowIds = new Set<string>();
    const bushes = new Map((world.bushes ?? []).filter(bush => bush.imageId).map(bush => [bush.imageId!, bush]));
    world.terrain.forEach((layer, index) => {
      terrainIds.add(layer.id);
      const image = imageFor(terrain, layer.id, layer.image);
      positionImage(image, layer);
      const bush = bushes.get(layer.id);
      const depth = bush ? Math.max(...bush.points.map(point => point.y)) : -1000 + index;
      image.setDepth(depth);
    });
    for (const site of world.sites) {
      const visual = previewSiteVisual(site, options.levels);
      if (!visual) continue;
      siteIds.add(site.id);
      const image = imageFor(sites, site.id, visual.image);
      positionImage(image, site);
      image.setDepth(site.anchor.y);
      // An ellipse under a broken bridge would incorrectly darken its open
      // water gap. Its original artwork remains responsible for that contact.
      const contact = site.id === "bridge" ? null : siteContactArea(site);
      if (contact) {
        shadowIds.add(site.id);
        let shadow = shadows.get(site.id);
        if (!shadow) {
          shadow = scene.add.image(0, 0, shadowKey).setDepth(-10);
          shadows.set(site.id, shadow);
        }
        shadow.setPosition(contact.x + contact.width / 2, contact.y + contact.height / 2)
          .setDisplaySize(contact.width * 1.25, contact.height * 1.3)
          .setAlpha(options.night ? .42 : .57).setVisible(options.shadows);
      }
    }
    prune(terrain, terrainIds); prune(sites, siteIds); prune(shadows, shadowIds);
    occluders.update(world);
    darkness.setSize(world.width, world.height).setVisible(options.night);
    const lightIds = new Set<string>();
    for (const light of world.lights ?? []) {
      lightIds.add(light.id);
      let glowKey = glowTextures.get(light.color);
      if (!glowKey) {
        glowKey = `${prefix}:glow:${light.color}`;
        // Canvas fallback does not implement sprite tint. Baking this tiny
        // shared palette texture preserves warm light in both renderers.
        scene.textures.addCanvas(glowKey, radialCanvas(128, false, Number.parseInt(light.color.slice(1), 16)));
        glowTextures.set(light.color, glowKey);
      }
      let glow = glows.get(light.id);
      if (!glow) {
        glow = { object: scene.add.image(light.position.x, light.position.y, glowKey).setDepth(8001).setBlendMode("SCREEN"),
          light, phase: glows.size * 1.37 };
        glows.set(light.id, glow);
      }
      glow.light = light;
      if (glow.object.texture.key !== glowKey) glow.object.setTexture(glowKey);
      glow.object.setPosition(light.position.x, light.position.y).setDisplaySize(light.radius * 2, light.radius * 2)
        .setAlpha(Math.min(.64, light.intensity * .38)).setVisible(options.night);
    }
    for (const [id, glow] of glows) if (!lightIds.has(id)) { glow.object.destroy(); glows.delete(id); }
    const colors = new Set((world.lights ?? []).map(light => light.color));
    for (const [color, key] of glowTextures) if (!colors.has(color)) { scene.textures.remove(key); glowTextures.delete(color); }
  }
  update(initialWorld, initialOptions);

  return {
    update,
    tick(time: number) {
      if (disposed || !options.night || options.reducedMotion) return;
      for (const { object, light, phase } of glows.values()) {
        const flicker = 1 + Math.sin(time * .006 + phase) * Math.min(.15, light.flicker) * .5;
        object.setAlpha(Math.min(.64, light.intensity * .38) * flicker);
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const collection of [terrain, sites, shadows]) { for (const image of collection.values()) image.destroy(); collection.clear(); }
      for (const glow of glows.values()) glow.object.destroy();
      glows.clear(); occluders.dispose(); darkness.destroy();
      scene.textures.remove(shadowKey);
      for (const key of glowTextures.values()) scene.textures.remove(key);
      glowTextures.clear();
    },
  };
}
