import type { EngineObject, SceneSize } from "@/packages/engine/src/scene/contracts";
import { validateSceneSize } from "@/packages/engine/src/scene/contracts";
import * as geometry from "@/packages/engine/src/scene/objects";
import * as stacking from "@/packages/engine/src/scene/stacking";
import * as folders from "@/packages/engine/src/scene/folders";
import * as transform from "@/packages/engine/src/input/transform";
import { sampleEditedGround, type TerrainPreview, type TerrainState } from "@/packages/engine/src/terrain/terrain-data";
import { editorFolderForKind, resolveEditorPreset, type EditorPreset, type EditorPresetReference } from "./editor-presets";

/** All editor geometry and placement use the selected project's catalog and dimensions. */
export function createEditorCatalogTools(input: EditorPreset | EditorPresetReference | string, size: SceneSize) {
  if (!validateSceneSize(size)) throw new RangeError("Неверный размер сцены.");
  const preset = resolveEditorPreset(input), catalog = preset.runtime.catalog;
  const dimensions = Object.freeze({ width: size.width, height: size.height });
  const defaultFolderForKind = (kind: string) => editorFolderForKind(preset, kind);
  const objectDepth = (object: EngineObject) => stacking.objectDepth(object, catalog[object.kind]?.depthOffset);
  function canPlace(kind: string, x: number, y: number, terrain?: TerrainState, preview?: TerrainPreview): boolean {
    const entry = Object.hasOwn(preset.catalog, kind) ? preset.catalog[kind] : undefined;
    if (!entry || ![x, y].every(Number.isFinite) || x < 0 || y < 0 || x > dimensions.width || y > dimensions.height) return false;
    if (entry.placement === "land") {
      const ground = terrain ? sampleEditedGround(x, y, terrain, preview, preset.runtime.terrain) : preset.runtime.terrain.sampleGround(x, y);
      if (ground.water >= -28 || ground.path >= .2) return false;
    }
    return preset.placementRule?.({ kind, x, y, size: dimensions, terrain, preview }) ?? true;
  }
  return {
    preset, catalog: preset.catalog, dimensions, defaultFolderForKind,
    objectLocalBounds: (object: EngineObject) => geometry.objectLocalBounds(object, catalog),
    objectBounds: (object: EngineObject) => geometry.objectBounds(object, catalog),
    objectCorners: (object: EngineObject) => geometry.objectCorners(object, catalog),
    objectAngle: (object: EngineObject) => geometry.objectAngle(object, catalog),
    getObjectShadowHeight: (object: EngineObject) => geometry.getObjectShadowHeight(object, catalog),
    objectDepth,
    stackKey: (object: EngineObject) => stacking.stackKey(object, objectDepth(object)),
    objectLayerId: stacking.objectLayerId,
    objectFolderId: (object: EngineObject, values: readonly folders.SceneFolder[] = preset.folders) => folders.objectFolderId(object, values, defaultFolderForKind),
    compareObjects: (a: EngineObject, b: EngineObject, layers: readonly stacking.SceneLayer[] = preset.layers) => geometry.compareObjects(a, b, layers, catalog),
    pickObject: <T extends EngineObject>(objects: readonly T[], x: number, y: number, layers: readonly stacking.SceneLayer[] = preset.layers, values: readonly folders.SceneFolder[] = preset.folders) => geometry.pickObject(objects, x, y, layers, values, catalog),
    isObjectVisible: (object: EngineObject, layers: readonly stacking.SceneLayer[] = preset.layers, values: readonly folders.SceneFolder[] = preset.folders) => stacking.isObjectVisible(object, layers, values, defaultFolderForKind),
    isObjectLocked: (object: EngineObject, layers: readonly stacking.SceneLayer[] = preset.layers, values: readonly folders.SceneFolder[] = preset.folders) => stacking.isObjectLocked(object, layers, values, defaultFolderForKind),
    folderAncestors: (id: string | null, values: readonly folders.SceneFolder[] = preset.folders) => folders.folderAncestors(id, values),
    folderContains: (parent: string | null, child: string | null, values: readonly folders.SceneFolder[] = preset.folders) => folders.folderContains(parent, child, values),
    isFolderVisible: (id: string | null, values: readonly folders.SceneFolder[] = preset.folders) => folders.isFolderVisible(id, values),
    isFolderLocked: (id: string | null, values: readonly folders.SceneFolder[] = preset.folders) => folders.isFolderLocked(id, values),
    resizeHandlePositions: (object: EngineObject) => transform.resizeHandlePositions(object, catalog),
    findResizeHandle: (object: EngineObject, point: transform.ResizePoint, zoom: number, radiusCss?: number) => transform.findResizeHandle(object, point, zoom, radiusCss, catalog),
    beginResize: (object: EngineObject, corner: transform.ResizeCorner, grab: transform.ResizePoint) => transform.beginResize(object, corner, grab, catalog),
    resizedObject: (session: transform.ResizeSession, point: transform.ResizePoint, width = dimensions.width, height = dimensions.height) => transform.resizedObject(session, point, width, height),
    canPlace,
    canPlant(x: number, y: number, width = dimensions.width, terrain?: TerrainState, preview?: TerrainPreview) {
      const entry = Object.values(preset.catalog).find(value => value.placement === "land") ?? Object.values(preset.catalog)[0];
      return Boolean(entry) && x <= width && canPlace(entry.kind, x, y, terrain, preview);
    },
    isVegetation: (object: EngineObject | string) => Boolean(preset.catalog[typeof object === "string" ? object : object.kind]?.tags.includes("vegetation")),
    anchorMargin: (object: EngineObject, isBase = false) => isBase && preset.catalog[object.kind]?.tags.includes("overscan") ? preset.overscanMargin : 0,
  };
}
