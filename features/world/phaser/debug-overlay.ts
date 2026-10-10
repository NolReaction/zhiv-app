import type Phaser from "phaser";
import type { FixedWorldScene, WorldPoint } from "@/features/world/tiled/types";
import type { PhaserWorldOptions } from "./contracts";

/** Authoring aids are separate from game objects and never enter the exported world. */
export function createPhaserDebugOverlay(scene: Phaser.Scene) {
  const graphics = scene.add.graphics().setDepth(9000);
  function polygon(points: WorldPoint[], color: number, alpha = 0.8, fill = false) {
    if (points.length < 3) return;
    graphics.lineStyle(1.2, color, alpha);
    graphics.fillStyle(color, 0.09);
    graphics.beginPath();
    graphics.moveTo(points[0].x, points[0].y);
    for (const point of points.slice(1)) graphics.lineTo(point.x, point.y);
    graphics.closePath();
    if (fill) graphics.fillPath();
    graphics.strokePath();
  }
  return {
    update(world: FixedWorldScene, options: PhaserWorldOptions) {
      graphics.clear();
      if (options.grid) {
        const size = Math.max(8, Math.min(128, options.gridSize));
        graphics.lineStyle(0.7, 0xf1d683, 0.3);
        for (let x = 0; x <= world.width; x += size) graphics.lineBetween(x, 0, x, world.height);
        for (let y = 0; y <= world.height; y += size) graphics.lineBetween(0, y, world.width, y);
      }
      if (options.geometry) {
        for (const area of world.navigation?.areas ?? []) polygon(area.points, 0xbddd91, 0.28);
        for (const obstacle of world.navigation?.obstacles ?? []) polygon(obstacle.points, 0xf79889, 0.45);
        for (const site of world.sites) {
          polygon(site.collision, 0xf79889, 0.7, true);
          if (site.id !== options.selectedSiteId) polygon(site.hitArea, 0x75dceb, 0.3);
        }
      }
      const selected = world.sites.find(site => site.id === options.selectedSiteId);
      if (!selected) return;
      polygon(selected.hitArea, 0x75dceb, 0.95);
      if (!options.geometry && options.mode !== "place") return;
      polygon(selected.collision, 0xf79889, 1, true);
      graphics.lineStyle(1.5, 0xf1d683, 1);
      graphics.strokeCircle(selected.anchor.x, selected.anchor.y, 5);
      graphics.lineBetween(selected.anchor.x - 8, selected.anchor.y, selected.anchor.x + 8, selected.anchor.y);
      graphics.lineBetween(selected.anchor.x, selected.anchor.y - 8, selected.anchor.x, selected.anchor.y + 8);
      graphics.lineStyle(1, 0xbddd91, 0.8);
      graphics.lineBetween(selected.anchor.x, selected.anchor.y, selected.entry.x, selected.entry.y);
      graphics.fillStyle(0xbddd91, 1);
      graphics.fillTriangle(selected.entry.x, selected.entry.y - 5, selected.entry.x + 5, selected.entry.y + 4, selected.entry.x - 5, selected.entry.y + 4);
    },
    dispose() { graphics.destroy(); },
  };
}
