import type { FixedWorldScene, WorldBounds, WorldPoint } from "./tiled/types";

type DebugPoint = Readonly<WorldPoint>;
type DebugPolygon = Readonly<{ id: string; points: readonly DebugPoint[] }>;

/** Structural snapshots keep diagnostics independent of the movement and fauna controllers. */
export type LivingWorldDebugNavigation = Readonly<{
  radius: number;
  cellSize: number;
  bounds: Readonly<WorldBounds>;
  grid: Readonly<{ columns: number; rows: number; origin: DebugPoint; walkable: ArrayLike<number> }>;
}>;

export type LivingWorldDebugFauna = Readonly<{
  id: string;
  species?: string;
  mode?: string;
  x: number;
  y: number;
  target?: DebugPoint | null;
  habitatId?: string;
}>;

export type LivingWorldDebugSnapshot = Readonly<{
  debugNavigation?: boolean;
  debugFauna?: boolean;
  nav?: LivingWorldDebugNavigation | null;
  position?: DebugPoint;
  path?: readonly DebugPoint[];
  target?: DebugPoint | null;
  activity?: string | null;
  reason?: string;
  fauna?: readonly LivingWorldDebugFauna[];
  encounter?: Readonly<{ entityId: string; phase: string }> | null;
}>;

const LIMITS = { polygons: 64, vertices: 256, gridSamples: 1024, fauna: 32, anchors: 32 } as const;
const COLORS = { allowed: "#78edb0", obstacle: "#ff8e86", water: "#72cfff", path: "#ffe184", habitat: "#d4a0ff", fauna: "#ffcaf1" };
const finitePoint = (point: DebugPoint | null | undefined): point is DebugPoint => Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y));

function trace(ctx: CanvasRenderingContext2D, points: readonly DebugPoint[], close = false) {
  const count = Math.min(points.length, LIMITS.vertices);
  if (count < (close ? 3 : 2) || !finitePoint(points[0])) return;
  ctx.moveTo(points[0].x, points[0].y);
  for (let index = 1; index < count; index++) {
    if (!finitePoint(points[index])) return;
    ctx.lineTo(points[index].x, points[index].y);
  }
  if (close) ctx.closePath();
}

function polygons(ctx: CanvasRenderingContext2D, entries: readonly DebugPolygon[], color: string, unit: number, dashed = false) {
  if (!entries.length) return;
  ctx.beginPath();
  for (let index = 0; index < Math.min(entries.length, LIMITS.polygons); index++) trace(ctx, entries[index].points, true);
  ctx.setLineDash(dashed ? [5 * unit, 4 * unit] : []);
  ctx.strokeStyle = "rgba(10, 23, 28, .85)"; ctx.lineWidth = 3.5 * unit; ctx.stroke();
  ctx.strokeStyle = color; ctx.lineWidth = 1.5 * unit; ctx.stroke();
  ctx.setLineDash([]);
}

function label(ctx: CanvasRenderingContext2D, text: string, point: DebugPoint, color: string, unit: number, line = 0) {
  if (!finitePoint(point) || !text) return;
  const value = text.length > 72 ? `${text.slice(0, 69)}…` : text;
  const x = point.x + 7 * unit, y = point.y + (line * 13 - 8) * unit;
  ctx.lineWidth = 3 * unit; ctx.strokeStyle = "rgba(7, 15, 20, .95)";
  ctx.strokeText(value, x, y, 290 * unit);
  ctx.fillStyle = color; ctx.fillText(value, x, y, 290 * unit);
}

function marker(ctx: CanvasRenderingContext2D, point: DebugPoint, color: string, unit: number) {
  if (!finitePoint(point)) return;
  ctx.beginPath();
  ctx.moveTo(point.x - 4 * unit, point.y); ctx.lineTo(point.x + 4 * unit, point.y);
  ctx.moveTo(point.x, point.y - 4 * unit); ctx.lineTo(point.x, point.y + 4 * unit);
  ctx.strokeStyle = color; ctx.lineWidth = 1.5 * unit; ctx.stroke();
}

function grid(ctx: CanvasRenderingContext2D, nav: LivingWorldDebugNavigation, unit: number) {
  const { columns, rows, origin, walkable } = nav.grid;
  if (!Number.isSafeInteger(columns) || !Number.isSafeInteger(rows) || columns < 1 || rows < 1
    || !Number.isFinite(nav.cellSize) || nav.cellSize <= 0 || !finitePoint(origin)) return;
  // Sampling caps canvas work even if an author loads a much larger navigation field.
  const stride = Math.max(1, Math.ceil(Math.sqrt(columns * rows / LIMITS.gridSamples)));
  let samples = 0;
  ctx.fillStyle = "rgba(120, 237, 176, .5)";
  const dot = Math.min(nav.cellSize * .3, 2.5 * unit);
  for (let row = 0; row < rows && samples < LIMITS.gridSamples; row += stride) {
    for (let column = 0; column < columns && samples < LIMITS.gridSamples; column += stride) {
      samples++;
      if (!walkable[row * columns + column]) continue;
      ctx.fillRect(origin.x + column * nav.cellSize - dot / 2,
        origin.y + row * nav.cellSize - dot / 2, dot, dot);
    }
  }
}

function navigation(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, snapshot: LivingWorldDebugSnapshot, unit: number) {
  polygons(ctx, scene.navigation?.areas ?? [], COLORS.allowed, unit);
  polygons(ctx, scene.navigation?.obstacles ?? [], COLORS.obstacle, unit);
  polygons(ctx, scene.sites.slice(0, LIMITS.polygons).map(site => ({ id: site.id, points: site.collision })), COLORS.obstacle, unit);
  polygons(ctx, scene.water?.surfaces ?? [], COLORS.water, unit);
  if (snapshot.nav) grid(ctx, snapshot.nav, unit);
  if (snapshot.path?.length) {
    ctx.beginPath(); trace(ctx, snapshot.path);
    ctx.strokeStyle = COLORS.path; ctx.lineWidth = 2 * unit; ctx.stroke();
  }
  const position = snapshot.position ?? scene.actor?.spawn;
  if (finitePoint(position)) {
    const radius = snapshot.nav?.radius;
    if (radius !== undefined && Number.isFinite(radius) && radius > 0) {
      ctx.beginPath(); ctx.arc(position.x, position.y, radius, 0, Math.PI * 2);
      ctx.strokeStyle = COLORS.path; ctx.lineWidth = 1.5 * unit; ctx.stroke();
    }
    label(ctx, snapshot.activity ? `занятие: ${snapshot.activity}` : "Мохлик", position, COLORS.path, unit);
    if (snapshot.reason) label(ctx, snapshot.reason, position, COLORS.path, unit, 1);
  }
  if (finitePoint(snapshot.target)) {
    marker(ctx, snapshot.target, COLORS.path, unit);
    label(ctx, "цель", snapshot.target, COLORS.path, unit);
  }
}

function fauna(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, snapshot: LivingWorldDebugSnapshot, unit: number) {
  polygons(ctx, scene.habitats ?? [], COLORS.habitat, unit, true);
  for (const habitat of (scene.habitats ?? []).slice(0, LIMITS.polygons)) {
    if (habitat.points[0]) label(ctx, `${habitat.id} · ${habitat.species}`, habitat.points[0], COLORS.habitat, unit);
    polygons(ctx, habitat.exclusions ?? [], COLORS.obstacle, unit, true);
    for (const hole of (habitat.exclusions ?? []).slice(0, LIMITS.polygons)) {
      if (hole.points[0]) label(ctx, `${habitat.id}: исключено ${hole.id}`, hole.points[0], COLORS.obstacle, unit, 1);
    }
    for (const anchor of habitat.anchors.slice(0, LIMITS.anchors)) {
      marker(ctx, anchor.position, COLORS.habitat, unit);
    }
  }
  const entities = snapshot.fauna ?? [];
  for (let index = 0; index < Math.min(entities.length, LIMITS.fauna); index++) {
    const entity = entities[index];
    if (!finitePoint(entity)) continue;
    marker(ctx, entity, COLORS.fauna, unit);
    label(ctx, `${entity.id}${entity.mode ? ` · ${entity.mode}` : ""}`, entity, COLORS.fauna, unit);
    if (finitePoint(entity.target)) {
      ctx.beginPath(); ctx.moveTo(entity.x, entity.y); ctx.lineTo(entity.target.x, entity.target.y);
      ctx.setLineDash([3 * unit, 4 * unit]); ctx.strokeStyle = COLORS.fauna; ctx.lineWidth = unit; ctx.stroke(); ctx.setLineDash([]);
      marker(ctx, entity.target, COLORS.fauna, unit);
    }
    if (snapshot.encounter?.entityId === entity.id) {
      label(ctx, `встреча: ${snapshot.encounter.phase}`, entity, COLORS.path, unit, 1);
    }
  }
}

/** DEV-only readout: drawing never advances controllers, builds paths, or alters collision data. */
export function drawLivingWorldDebug(ctx: CanvasRenderingContext2D, scene: FixedWorldScene, snapshot: LivingWorldDebugSnapshot) {
  if (process.env.NODE_ENV !== "development" || !snapshot.debugNavigation && !snapshot.debugFauna) return;
  const transform = ctx.getTransform?.();
  const scale = transform ? Math.hypot(transform.a, transform.b) : 1;
  const unit = 1 / Math.max(.25, Number.isFinite(scale) ? scale : 1);
  ctx.save();
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = "source-over";
  ctx.lineJoin = "round"; ctx.lineCap = "round"; ctx.setLineDash([]);
  ctx.font = `${11 * unit}px monospace`; ctx.textAlign = "left"; ctx.textBaseline = "alphabetic";
  if (snapshot.debugNavigation) navigation(ctx, scene, snapshot, unit);
  if (snapshot.debugFauna) fauna(ctx, scene, snapshot, unit);
  ctx.restore();
}
