import type { TerrainDefinition } from "@/packages/engine/src/terrain/layout";
import { sampleGround, sampleWaterSignedDistance, TRAILS } from "./layout";
export const FOREST_TERRAIN_DEFINITION: TerrainDefinition = Object.freeze({ sampleGround, sampleWaterSignedDistance, trails: TRAILS });
