import type Phaser from "phaser";
import { drawSiteImage } from "@/features/world/tiled/site-image";
import type { FixedWorldScene, WorldBounds, WorldImage, WorldOccluder } from "@/features/world/tiled/types";
import { worldTextureKey } from "./presentation-assets";

type OccluderImage = {
  object: Phaser.GameObjects.Image;
  key: string;
  points: WorldOccluder["points"];
  ground: WorldImage;
};

function polygonBounds(polygon: WorldOccluder): WorldBounds | null {
  if (polygon.points.length < 3) return null;
  const xs = polygon.points.map(point => point.x), ys = polygon.points.map(point => point.y);
  const x = Math.floor(Math.min(...xs)) - 1, y = Math.floor(Math.min(...ys)) - 1;
  const width = Math.ceil(Math.max(...xs)) - x + 1, height = Math.ceil(Math.max(...ys)) - y + 1;
  return [x, y, width, height].every(Number.isFinite) && width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** Baked tree silhouettes are a few small cropped textures, never a map-sized
 * render target per tree. The authored frontY joins normal sprite depth sorting. */
export function createBakedOccluders(scene: Phaser.Scene, prefix: string) {
  const images = new Map<string, OccluderImage>();
  let serial = 0;
  const remove = (id: string) => {
    const current = images.get(id);
    if (!current) return;
    current.object.destroy();
    scene.textures.remove(current.key);
    images.delete(id);
  };

  return {
    update(world: FixedWorldScene) {
      const ground = world.terrain.find(terrain => terrain.bounds.width >= world.width * .9 && terrain.bounds.height >= world.height * .9);
      const retained = new Set<string>();
      if (ground) {
        const source = scene.textures.get(worldTextureKey(ground.image)).getSourceImage();
        if (source instanceof HTMLImageElement || source instanceof HTMLCanvasElement) {
          for (const polygon of world.occluders ?? []) {
            // Conditional building silhouettes already exist as transparent
            // sprites. Copying the background here would erase their artwork.
            if (polygon.when) continue;
            retained.add(polygon.id);
            const current = images.get(polygon.id);
            if (current?.points === polygon.points && current.ground === ground) {
              current.object.setDepth(polygon.frontY);
              continue;
            }
            remove(polygon.id);
            const bounds = polygonBounds(polygon);
            if (!bounds) continue;
            const scale = Math.min(2, 512 / Math.max(bounds.width, bounds.height));
            const canvas = document.createElement("canvas");
            canvas.width = Math.max(1, Math.ceil(bounds.width * scale));
            canvas.height = Math.max(1, Math.ceil(bounds.height * scale));
            const context = canvas.getContext("2d");
            if (!context) continue;
            context.scale(canvas.width / bounds.width, canvas.height / bounds.height);
            context.translate(-bounds.x, -bounds.y);
            context.beginPath();
            polygon.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y));
            context.closePath();
            context.clip();
            drawSiteImage(context, ground, source);
            const key = `${prefix}:occluder:${++serial}`;
            scene.textures.addCanvas(key, canvas);
            const object = scene.add.image(bounds.x, bounds.y, key).setOrigin(0, 0)
              .setDisplaySize(bounds.width, bounds.height).setDepth(polygon.frontY);
            images.set(polygon.id, { object, key, points: polygon.points, ground });
          }
        }
      }
      for (const id of images.keys()) if (!retained.has(id)) remove(id);
    },
    dispose() {
      for (const id of images.keys()) remove(id);
    },
  };
}
