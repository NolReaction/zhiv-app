/** Supported portable rendering API. Editor UI, persistence and example content are separate applications. */
export { createScenePainter } from "./rendering/renderer.ts";
export type { SceneRenderOptions, CanvasFactory, ImageLoader } from "./rendering/renderer.ts";
export type { EngineObject, EnginePreset, ObjectCatalog, ObjectDefinition, Bounds, Point, SceneSize } from "./scene/contracts.ts";
export { validateSceneSize, MAX_SCENE_DIMENSION, MAX_SCENE_PIXELS } from "./scene/contracts.ts";
export { EMPTY_TERRAIN_DEFINITION } from "./terrain/layout.ts";
export type { TerrainDefinition, GroundSample } from "./terrain/layout.ts";
export { SOLID_TERRAIN_PAINTER } from "./terrain/terrain.ts";
export type { TerrainPainter } from "./terrain/terrain.ts";
export type { TerrainState, TerrainMaterial, TerrainPreview } from "./terrain/terrain-data.ts";
export { initialTerrain } from "./terrain/terrain-data.ts";
export type { LightingState, ScenePointLight } from "./lighting/lighting-data.ts";
export { initialLighting } from "./lighting/lighting-data.ts";
export type { ImageAsset } from "./assets/image-assets.ts";
export type { SceneDocument, SceneDocumentValidationOptions } from "./scene/document.ts";
export { SCENE_DOCUMENT_VERSION, MAX_PROJECT_DOCUMENT_BYTES, validateSceneDocument, cloneSceneDocument } from "./scene/document.ts";
