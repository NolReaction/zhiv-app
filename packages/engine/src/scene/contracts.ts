import type { TerrainDefinition } from "../terrain/layout.ts";
import type { TerrainPainter } from "../terrain/terrain.ts";

export type Point = { x: number; y: number };
export type Bounds = Point & { width: number; height: number };
export type SceneSize = { width: number; height: number };
/** A content ID is resolved through the supplied catalog, never through a game import. */
export type EngineObject<K extends string = string> = {
  id: string; kind: K; x: number; y: number; scale: number; variant: number;
  rotation?: number; assetId?: string; imageWidth?: number; imageHeight?: number;
  layerId?: string; folderId?: string | null; hidden?: boolean; locked?: boolean;
  name?: string; stackOrder?: number[]; shadowHeight?: number;
};
export type ObjectDefinition = {
  bounds: Bounds | ((object: EngineObject) => Bounds);
  intrinsicAngle?: number; shadowHeight?: number; depthOffset?: number; folderId?: string;
  hitTest?: (object: EngineObject, local: Point) => boolean;
  draw?: (context: CanvasRenderingContext2D, object: EngineObject) => void;
  sprite?: { bounds: Bounds; scale: number };
  contactShadow?: { bounds: Bounds; scale: number; draw: (context: CanvasRenderingContext2D) => void };
};
export type ObjectCatalog = Readonly<Record<string, ObjectDefinition>>;
/** Presets contain authored content and deterministic generation, not editor state. */
export type EnginePreset = {
  id: string; catalog: ObjectCatalog;
  generateObjects?: (seed: number, bounds: Bounds) => EngineObject[];
  initialObjects?: () => EngineObject[];
  terrain: TerrainDefinition; terrainPainter: TerrainPainter;
  /** Optional fixed extent keeps generated water continuous when a project expands. */
  terrainBounds?: SceneSize;
};
export const MAX_SCENE_DIMENSION = 8192;
export const MAX_SCENE_PIXELS = 64_000_000;
export function validateSceneSize(size: SceneSize): boolean {
  return Number.isInteger(size.width) && Number.isInteger(size.height) && size.width > 0 && size.height > 0
    && size.width <= MAX_SCENE_DIMENSION && size.height <= MAX_SCENE_DIMENSION && size.width * size.height <= MAX_SCENE_PIXELS;
}
