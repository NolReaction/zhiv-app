import { EMPTY_TERRAIN_DEFINITION } from "@/packages/engine/src/terrain/layout";
import { SOLID_TERRAIN_PAINTER, type TerrainPainter } from "@/packages/engine/src/terrain/terrain";
import type { EnginePreset, ObjectCatalog } from "@/packages/engine/src/scene/contracts";

function polygon(ctx: CanvasRenderingContext2D, points: readonly [number, number][], color: string) {
  ctx.beginPath(); points.forEach(([x, y], index) => { if (index) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
  ctx.closePath(); ctx.fillStyle = color; ctx.fill(); ctx.strokeStyle = "#36414d"; ctx.lineWidth = 1.2; ctx.stroke();
}
export const EMPTY_CATALOG: ObjectCatalog = Object.freeze({
  crate: {
    bounds: { x: -26, y: -48, width: 52, height: 50 }, shadowHeight: 42, folderId: "props",
    draw(ctx, object) {
      const colors = [["#d9b987", "#aa8054", "#86633f"], ["#a6cdbd", "#729c8e", "#4b7569"], ["#dfaaa3", "#b57670", "#8f5551"]][object.variant % 3];
      polygon(ctx, [[-24, -38], [0, -48], [24, -38], [0, -28]], colors[0]);
      polygon(ctx, [[-24, -38], [0, -28], [0, 0], [-24, -10]], colors[1]);
      polygon(ctx, [[0, -28], [24, -38], [24, -10], [0, 0]], colors[2]);
      ctx.strokeStyle = "#65594d"; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(-23, -33); ctx.lineTo(0, -5); ctx.lineTo(23, -33); ctx.stroke();
    },
  },
  beacon: {
    bounds: { x: -16, y: -86, width: 32, height: 88 }, shadowHeight: 80, folderId: "signals",
    draw(ctx, object) {
      const color = object.variant % 2 ? "#f3b363" : "#72d9dc";
      ctx.fillStyle = "#627381"; ctx.fillRect(-5, -68, 10, 65);
      polygon(ctx, [[-14, -8], [0, -14], [14, -8], [14, -3], [0, 2], [-14, -3]], "#798891");
      ctx.fillStyle = "#40545e"; ctx.fillRect(-12, -82, 24, 26);
      ctx.fillStyle = color; ctx.fillRect(-8, -78, 16, 17);
      ctx.strokeStyle = "#e4f8f9"; ctx.lineWidth = 1; ctx.strokeRect(-8, -78, 16, 17);
      polygon(ctx, [[-15, -82], [0, -86], [15, -82]], "#89969c");
    },
  },
  image: {
    bounds: object => ({ x: -(object.imageWidth ?? 0) / 2, y: -(object.imageHeight ?? 0), width: object.imageWidth ?? 0, height: object.imageHeight ?? 0 }),
    shadowHeight: 80, folderId: "images",
  },
});
const EMPTY_TERRAIN_PAINTER: TerrainPainter = {
  ...SOLID_TERRAIN_PAINTER,
  drawBase(ctx, _seed, bounds) { ctx.fillStyle = "#bdc6c9"; ctx.fillRect(bounds.x, bounds.y, bounds.width, bounds.height); },
};
/** A blank workspace supplies its own content and has no dependency on forest artwork or layout. */
export const EMPTY_PRESET: EnginePreset = Object.freeze({
  id: "empty-v1", catalog: EMPTY_CATALOG, terrain: EMPTY_TERRAIN_DEFINITION, terrainPainter: EMPTY_TERRAIN_PAINTER,
});
