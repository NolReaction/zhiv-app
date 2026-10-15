import * as core from "@/packages/engine/src/terrain/terrain-data";
import { FOREST_TERRAIN_DEFINITION } from "./definition";
import type { TerrainState, TerrainMaterial, TerrainBrush, TerrainPreview } from "@/packages/engine/src/terrain/terrain-data";
export type { TerrainState, TerrainMaterial, TerrainBrush, TerrainPreview, TerrainAppearance } from "@/packages/engine/src/terrain/terrain-data";
export { CELL_SIZE, TERRAIN_CHUNK_SIZE, MAX_TERRAIN_CELLS, TERRAIN_DIRTY_HALO, DEFAULT_TERRAIN_APPEARANCE, initialTerrain, cloneTerrain, terrainAppearance, validateTerrainAppearance, updateTerrainAppearance, terrainCellKey, readTerrainMaterial, dirtyTerrainChunks } from "@/packages/engine/src/terrain/terrain-data";
export const validateTerrain = (value: unknown, width: number) => width <= 3200 && width % 16 === 0 ? core.validateTerrain(value, width, 1600) : null;
export const applyTerrainPatch = (state: TerrainState, patch: ReadonlyMap<string, TerrainMaterial | null>) => core.applyTerrainPatch(state, patch, 3200, 1600);
export const strokeTerrainCells = (from: { x: number; y: number }, to: { x: number; y: number }, diameter: number, brush: TerrainBrush, width: number) => core.strokeTerrainCells(from, to, diameter, brush, Math.min(3200, width), 1600);
export const sampleEditedGround = (x: number, y: number, state: TerrainState, preview?: TerrainPreview) => core.sampleEditedGround(x, y, state, preview, FOREST_TERRAIN_DEFINITION);
