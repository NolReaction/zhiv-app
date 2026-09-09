import type { SettlementArt } from "./art";
import { areaBounds, canPlace, settlementCatalog, type BuildingKind, type Settlement } from "./model";
import { project, SCENE_WIDTH, SCENE_HEIGHT } from "./geometry";

export type Placement = { kind: BuildingKind; moving: boolean; x: number; y: number };
export type SceneView = { zoom: number; pan: { x: number; y: number }; showGrid: boolean; selected: BuildingKind | null; placement: Placement | null };
function diamond(ctx: CanvasRenderingContext2D, x: number, y: number, size = 1) {
  const corners = [project(x, y), project(x + size, y), project(x + size, y + size), project(x, y + size)];
  ctx.beginPath(); corners.forEach((point, i) => { if (i) ctx.lineTo(point.x, point.y); else ctx.moveTo(point.x, point.y); }); ctx.closePath();
}
function building(ctx: CanvasRenderingContext2D, art: SettlementArt, kind: BuildingKind, level: number, x: number, y: number, ghost = false) {
  const point = project(x + 1, y + 1), cell = art.buildings.naturalWidth / 2, width = 207;
  ctx.save(); if (ghost) ctx.globalAlpha = .64;
  ctx.drawImage(art.buildings, level === 2 ? cell : 0, kind === "storehouse" ? cell : 0, cell, cell,
    point.x - width * .512, point.y - width * .708, width, width);
  ctx.restore();
}
function fence(ctx: CanvasRenderingContext2D, art: SettlementArt, x: number, y: number, axis: "x" | "y", gate = false) {
  const from = axis === "x" ? project(x, y) : project(x, y + 1);
  const to = axis === "x" ? project(x + 1, y) : project(x, y);
  const rising = axis === "y", cell = art.fence.width / 2;
  // Measured post-bottom anchors in the source's equal quadrants.
  const leftX = rising ? 114 : 113, rightX = rising ? 508 : 509;
  const leftY = gate ? (rising ? 517 : 354) : (rising ? 576 : 396);
  const rightY = gate ? (rising ? 354 : 517) : (rising ? 396 : 576);
  const sx = (to.x - from.x) / (rightX - leftX), sy = (to.y - from.y) / (rightY - leftY);
  ctx.drawImage(art.fence, rising ? 0 : cell, gate ? cell : 0, cell, cell,
    from.x - leftX * sx, from.y - leftY * sy, cell * sx, cell * sy);
}
export function renderSettlement(ctx: CanvasRenderingContext2D, art: SettlementArt, state: Settlement, view: SceneView) {
  ctx.clearRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);
  ctx.save(); ctx.translate(500 + view.pan.x, 350 + view.pan.y); ctx.scale(view.zoom, view.zoom); ctx.translate(-500, -350);
  // Ground is one texture under every building; construction never replaces it.
  ctx.save(); diamond(ctx, -.28, -.28, 10.56); ctx.shadowColor = "#04120eb0"; ctx.shadowBlur = 40; ctx.shadowOffsetY = 24;
  ctx.fillStyle = "#354626"; ctx.fill(); ctx.restore();
  ctx.save(); const origin = project(-.28, -.28);
  ctx.transform(1, .5, -1, .5, origin.x, origin.y);
  ctx.drawImage(art.grass, 0, 0, 433, 433); ctx.restore();
  const { min, max } = areaBounds(state.areaLevel);
  for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) {
    diamond(ctx, x, y);
    const unlocked = x >= min && y >= min && x < max && y < max;
    ctx.fillStyle = unlocked ? ((x + y) % 2 ? "#e4eb9d0b" : "#ffffff04") : "#11251e50";
    ctx.fill();
    if (view.showGrid || view.placement) { ctx.strokeStyle = unlocked ? "#e1ebc346" : "#d3dfb018"; ctx.lineWidth = .8; ctx.stroke(); }
  }
  diamond(ctx, min, min, max - min); ctx.strokeStyle = "#e6edab80"; ctx.lineWidth = 1.7; ctx.stroke();
  for (let i = 0; i < 10; i++) { fence(ctx, art, i, 0, "x"); fence(ctx, art, 0, i, "y"); }
  const placement = view.placement;
  if (placement) {
    diamond(ctx, placement.x, placement.y, 2);
    const allowed = canPlace(state, placement.x, placement.y, placement.moving ? placement.kind : undefined);
    ctx.fillStyle = allowed ? "#c7f49755" : "#e0776155"; ctx.fill();
    ctx.lineWidth = 2.5; ctx.strokeStyle = allowed ? "#e7ffd0" : "#ffd0ba"; ctx.stroke();
  }
  for (const item of [...state.buildings].sort((a, b) => a.x + a.y - b.x - b.y)) {
    if (placement?.moving && placement.kind === item.kind) continue;
    if (view.selected === item.kind && !placement) {
      diamond(ctx, item.x, item.y, 2); ctx.fillStyle = "#e9ecbd36"; ctx.fill(); ctx.strokeStyle = "#f5e6b4"; ctx.lineWidth = 2.5; ctx.stroke();
    }
    building(ctx, art, item.kind, item.level, item.x, item.y);
  }
  if (placement) building(ctx, art, placement.kind, state.buildings.find(item => item.kind === placement.kind)?.level ?? 1, placement.x, placement.y, true);
  for (let i = 0; i < settlementCatalog.gridSize; i++) {
    fence(ctx, art, i, 10, "x", i === 4 || i === 5);
    fence(ctx, art, 10, i, "y");
  }
  ctx.restore();
}
