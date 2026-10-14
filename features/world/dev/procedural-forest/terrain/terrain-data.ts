import { sampleGround, type GroundSample } from "./layout";

/** Sparse overrides keep the generated ground intact until a brush touches it. */
export const CELL_SIZE = 16;
export const TERRAIN_CHUNK_SIZE = 512;
export const MAX_TERRAIN_CELLS = 20_000;
const WORLD_HEIGHT = 1600;
const MAX_WIDTH = 3200;
const FEATHER_AND_BLEED = CELL_SIZE + 1;

export type TerrainMaterial = "grass" | "path" | "sand" | "water";
export type TerrainBrush = TerrainMaterial | "restore";
export type TerrainState = { baseTrails: boolean; cells: Record<string, TerrainMaterial> };
export type TerrainPreview = {
  cells: ReadonlyMap<string, TerrainMaterial | null>;
  chunkVersions: ReadonlyMap<string, number>;
};
type BrushPoint = { x: number; y: number };

const materials: ReadonlySet<string> = new Set(["grass", "path", "sand", "water"]);
const cellPattern = /^(0|[1-9]\d*):(0|[1-9]\d*)$/;
const own = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key);

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function cellCoordinates(key: string): [number, number] | null {
  if (!cellPattern.test(key)) return null;
  const [x, y] = key.split(":").map(Number);
  return Number.isSafeInteger(x) && Number.isSafeInteger(y) ? [x, y] : null;
}

export function initialTerrain(): TerrainState {
  return { baseTrails: true, cells: {} };
}

export function cloneTerrain(state: TerrainState): TerrainState {
  return { baseTrails: state.baseTrails, cells: { ...state.cells } };
}

/** Import only canonical, bounded cells; never silently clip an imported edit. */
export function validateTerrain(value: unknown, width: number): TerrainState | null {
  if (!Number.isInteger(width) || width <= 0 || width > MAX_WIDTH || width % CELL_SIZE !== 0
    || !record(value) || Reflect.ownKeys(value).some(key => key !== "baseTrails" && key !== "cells")
    || typeof value.baseTrails !== "boolean" || !record(value.cells)) return null;
  const keys = Reflect.ownKeys(value.cells);
  if (keys.length > MAX_TERRAIN_CELLS) return null;
  const cells: Record<string, TerrainMaterial> = {};
  for (const key of keys) {
    if (typeof key !== "string") return null;
    const coordinates = cellCoordinates(key), material = value.cells[key];
    if (!coordinates || coordinates[0] >= width / CELL_SIZE || coordinates[1] >= WORLD_HEIGHT / CELL_SIZE
      || typeof material !== "string" || !materials.has(material)) return null;
    cells[key] = material as TerrainMaterial;
  }
  return { baseTrails: value.baseTrails, cells };
}

export function terrainCellKey(xWorld: number, yWorld: number): string {
  return `${Math.floor(xWorld / CELL_SIZE)}:${Math.floor(yWorld / CELL_SIZE)}`;
}

/** A preview null deliberately restores the base even when a saved override exists. */
export function readTerrainMaterial(x: number, y: number, state: TerrainState, preview?: TerrainPreview): TerrainMaterial | null {
  const key = terrainCellKey(x, y);
  if (preview?.cells.has(key)) return preview.cells.get(key) ?? null;
  return own(state.cells, key) ? state.cells[key] : null;
}

export function applyTerrainPatch(state: TerrainState, patch: ReadonlyMap<string, TerrainMaterial | null>): TerrainState {
  let cells: Record<string, TerrainMaterial> | undefined;
  for (const [key, material] of patch) {
    const coordinates = cellCoordinates(key);
    if (!coordinates || coordinates[0] >= MAX_WIDTH / CELL_SIZE || coordinates[1] >= WORLD_HEIGHT / CELL_SIZE
      || (material !== null && !materials.has(material))) continue;
    const current = own(state.cells, key) ? state.cells[key] : null;
    if (current === material) continue;
    cells ??= { ...state.cells };
    if (material === null) delete cells[key];
    else cells[key] = material;
  }
  return cells ? { baseTrails: state.baseTrails, cells } : state;
}

/** Rasterize a continuous capsule so sparse pointer events cannot leave holes. */
export function strokeTerrainCells(from: BrushPoint, to: BrushPoint, diameter: number, brush: TerrainBrush, width: number): Map<string, TerrainMaterial | null> {
  const result = new Map<string, TerrainMaterial | null>();
  if (![from.x, from.y, to.x, to.y, diameter, width].every(Number.isFinite) || width <= 0
    || (brush !== "restore" && !materials.has(brush))) return result;
  const radius = Math.max(24, Math.min(320, diameter)) / 2;
  const columns = Math.min(MAX_WIDTH / CELL_SIZE, Math.ceil(width / CELL_SIZE));
  const x0 = Math.max(0, Math.floor((Math.min(from.x, to.x) - radius) / CELL_SIZE));
  const x1 = Math.min(columns - 1, Math.floor((Math.max(from.x, to.x) + radius) / CELL_SIZE));
  const y0 = Math.max(0, Math.floor((Math.min(from.y, to.y) - radius) / CELL_SIZE));
  const y1 = Math.min(WORLD_HEIGHT / CELL_SIZE - 1, Math.floor((Math.max(from.y, to.y) + radius) / CELL_SIZE));
  const dx = to.x - from.x, dy = to.y - from.y, lengthSquared = dx * dx + dy * dy;
  const material = brush === "restore" ? null : brush;
  for (let cy = y0; cy <= y1; cy++) {
    for (let cx = x0; cx <= x1; cx++) {
      const x = (cx + .5) * CELL_SIZE, y = (cy + .5) * CELL_SIZE;
      const projection = lengthSquared ? Math.max(0, Math.min(1, ((x - from.x) * dx + (y - from.y) * dy) / lengthSquared)) : 0;
      if ((x - from.x - projection * dx) ** 2 + (y - from.y - projection * dy) ** 2 <= radius ** 2) result.set(`${cx}:${cy}`, material);
    }
  }
  return result;
}

/** Feathering and the one-pixel tile bleed also invalidate neighbouring chunks. */
export function dirtyTerrainChunks(cellKeys: Iterable<string>): Set<string> {
  const result = new Set<string>();
  for (const key of cellKeys) {
    const coordinates = cellCoordinates(key);
    if (!coordinates) continue;
    const x = coordinates[0] * CELL_SIZE, y = coordinates[1] * CELL_SIZE;
    const x0 = Math.floor((x - FEATHER_AND_BLEED) / TERRAIN_CHUNK_SIZE);
    const x1 = Math.floor((x + CELL_SIZE + FEATHER_AND_BLEED) / TERRAIN_CHUNK_SIZE);
    const y0 = Math.floor((y - FEATHER_AND_BLEED) / TERRAIN_CHUNK_SIZE);
    const y1 = Math.floor((y + CELL_SIZE + FEATHER_AND_BLEED) / TERRAIN_CHUNK_SIZE);
    for (let cy = y0; cy <= y1; cy++) for (let cx = x0; cx <= x1; cx++) result.add(`${cx}:${cy}`);
  }
  return result;
}

export function sampleEditedGround(x: number, y: number, state: TerrainState, preview?: TerrainPreview): GroundSample {
  switch (readTerrainMaterial(x, y, state, preview)) {
    case "grass": return { path: 0, water: -256, clearing: 0 };
    case "path": return { path: 1, water: -256, clearing: 1 };
    case "sand": return { path: 0, water: -256, clearing: 1 };
    case "water": return { path: 0, water: 256, clearing: 1 };
    default: return sampleGround(x, y, state.baseTrails);
  }
}
