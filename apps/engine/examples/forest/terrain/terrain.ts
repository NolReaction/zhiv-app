import { createTerrainComposer as createComposer, type TerrainPainter } from "@/packages/engine/src/terrain/terrain";
import { FOREST_TERRAIN_DEFINITION } from "./definition";
import { drawTerrain, drawTerrainMaterial, drawWaterOverlay } from "./terrain-style";
export { drawTerrain, drawTerrainMaterial } from "./terrain-style";
export const FOREST_TERRAIN_PAINTER: TerrainPainter = { drawBase: drawTerrain, drawMaterial: drawTerrainMaterial, drawWater: drawWaterOverlay };
export const createTerrainComposer = (makeCanvas: (width: number, height: number) => HTMLCanvasElement) => createComposer(makeCanvas, FOREST_TERRAIN_DEFINITION, FOREST_TERRAIN_PAINTER, { width: 3200, height: 1600 });
