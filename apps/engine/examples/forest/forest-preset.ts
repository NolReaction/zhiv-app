import type { EnginePreset } from "@/packages/engine/src/scene/contracts";
import { FOREST_CATALOG } from "./forest-catalog";
import { forestObjects, initialProps } from "./scene/objects";
import { FOREST_TERRAIN_DEFINITION } from "./terrain/definition";
import { FOREST_TERRAIN_PAINTER } from "./terrain/terrain";

/** The example owns map layout, built-in art and all defaults from the existing forest. */
export const DEFAULT_FOREST_PRESET: EnginePreset = Object.freeze({
  id: "forest-v5", catalog: FOREST_CATALOG, generateObjects: forestObjects, initialObjects: initialProps,
  terrain: FOREST_TERRAIN_DEFINITION, terrainPainter: FOREST_TERRAIN_PAINTER,
  terrainBounds: { width: 3200, height: 1600 },
});
export const DEFAULT_FOREST_SAMPLE_IMAGE = Object.freeze({ url: "/examples/forest/home-level-1.png", fileName: "home-level-1.png", label: "Дом 1 уровня" });
