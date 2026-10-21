import type { EngineObject, EnginePreset, ObjectCatalog, SceneSize } from "@/packages/engine/src/scene/contracts";
import { validateSceneSize } from "@/packages/engine/src/scene/contracts";
import { sampleEditedGround, type TerrainPreview, type TerrainState } from "@/packages/engine/src/terrain/terrain-data";
import { DEFAULT_LAYERS, type SceneLayer } from "@/packages/engine/src/scene/stacking";
import type { SceneFolder } from "@/packages/engine/src/scene/folders";
import { DEFAULT_FOREST_PRESET } from "@/apps/engine/examples/forest/forest-preset";
import { DEFAULT_FOLDERS } from "@/apps/engine/examples/forest/scene/folders";
import { INITIAL_SEED, reservedForProp } from "@/apps/engine/examples/forest/scene/objects";
import { EMPTY_PRESET } from "@/apps/engine/examples/empty/empty-preset";

export type EditorCatalogEntry = Readonly<{
  kind: string; name: string; variants: number; variantEditable: boolean;
  defaultScale: number; defaultFolderId?: string; tags: readonly string[]; placement: "land" | "any" | "image";
}>;
export type EditorCatalog = Readonly<Record<string, EditorCatalogEntry>>;
export type EditorPresetReference = Readonly<{ presetId: string; presetVersion: number }>;
export type EditorPlacementContext = Readonly<{
  kind: string; x: number; y: number; size: SceneSize; terrain?: TerrainState; preview?: TerrainPreview;
}>;
export type EditorPreset = Readonly<{
  id: string; version: number; name: string; description: string;
  defaultSize: Readonly<SceneSize>; defaultSeed: number; overscanMargin: number;
  runtime: EnginePreset; catalog: EditorCatalog;
  layers: readonly SceneLayer[]; folders: readonly SceneFolder[];
  /** A preset may reserve authored space; the controller contains no map-specific switches. */
  placementRule?: (context: EditorPlacementContext) => boolean;
}>;
function catalog(entries: EditorCatalogEntry[], runtime: ObjectCatalog): EditorCatalog {
  return Object.freeze(Object.assign(Object.create(null), Object.fromEntries(entries.map(entry => [entry.kind, Object.freeze({ ...entry, defaultFolderId: runtime[entry.kind]?.folderId, tags: Object.freeze([...entry.tags]) })]))));
}
const FOREST_EDITOR_CATALOG = catalog([
  { kind: "tree", name: "Дерево", variants: 24, variantEditable: true, defaultScale: .92, tags: ["vegetation", "overscan"], placement: "land" },
  { kind: "shrub", name: "Куст", variants: 24, variantEditable: true, defaultScale: 1, tags: ["vegetation", "overscan"], placement: "land" },
  { kind: "rock", name: "Камень", variants: 24, variantEditable: true, defaultScale: 1, tags: ["overscan"], placement: "any" },
  { kind: "ruins", name: "Руины", variants: 24, variantEditable: false, defaultScale: 1, tags: ["prop"], placement: "any" },
  { kind: "bridge", name: "Мост", variants: 24, variantEditable: false, defaultScale: 1, tags: ["prop"], placement: "any" },
  { kind: "jetty", name: "Причал", variants: 24, variantEditable: false, defaultScale: 1, tags: ["prop"], placement: "any" },
  // Legacy v2–v5 accepted all 24 variant values for images; the renderer ignores them.
  { kind: "image", name: "PNG-картинка", variants: 24, variantEditable: false, defaultScale: 1, tags: ["image"], placement: "image" },
], DEFAULT_FOREST_PRESET.catalog);
const EMPTY_EDITOR_CATALOG = catalog([
  { kind: "crate", name: "Ящик", variants: 3, variantEditable: true, defaultScale: 1, tags: ["prop"], placement: "any" },
  { kind: "beacon", name: "Маячок", variants: 2, variantEditable: true, defaultScale: 1, tags: ["prop", "signal"], placement: "any" },
  { kind: "image", name: "PNG-картинка", variants: 1, variantEditable: false, defaultScale: 1, tags: ["image"], placement: "image" },
], EMPTY_PRESET.catalog);
const EMPTY_FOLDERS: readonly SceneFolder[] = Object.freeze([
  Object.freeze({ id: "props", name: "Предметы", parentId: null, visible: true, locked: false }),
  Object.freeze({ id: "signals", name: "Маячки", parentId: null, visible: true, locked: false }),
  Object.freeze({ id: "images", name: "Изображения", parentId: null, visible: true, locked: false }),
]);
export const EDITOR_PRESETS: readonly EditorPreset[] = Object.freeze([
  Object.freeze({ id: "forest-v5", version: 1, name: "Лес", description: "Исходный лес с тропами, рекой и процедурными предметами.",
    defaultSize: Object.freeze({ width: 1600, height: 1600 }), defaultSeed: INITIAL_SEED, overscanMargin: 320,
    runtime: DEFAULT_FOREST_PRESET, catalog: FOREST_EDITOR_CATALOG, layers: DEFAULT_LAYERS, folders: DEFAULT_FOLDERS,
    placementRule(context: EditorPlacementContext) {
      if (FOREST_EDITOR_CATALOG[context.kind]?.placement !== "land") return true;
      if (reservedForProp(context.x, context.y)) return false;
      const ground = context.terrain ? sampleEditedGround(context.x, context.y, context.terrain, context.preview, DEFAULT_FOREST_PRESET.terrain)
        : DEFAULT_FOREST_PRESET.terrain.sampleGround(context.x, context.y);
      return ground.water < -28 && ground.path < .2;
    },
  }),
  Object.freeze({ id: "empty-v1", version: 1, name: "Пустая сцена", description: "Чистая рабочая область с независимыми ящиками и маячками.",
    defaultSize: Object.freeze({ width: 1024, height: 768 }), defaultSeed: 0, overscanMargin: 0,
    runtime: EMPTY_PRESET, catalog: EMPTY_EDITOR_CATALOG, layers: DEFAULT_LAYERS, folders: EMPTY_FOLDERS,
  }),
]);
export function getEditorPreset(id: string, version = 1): EditorPreset | undefined {
  return EDITOR_PRESETS.find(preset => preset.id === id && preset.version === version);
}
export function resolveEditorPreset(input: EditorPreset | EditorPresetReference | string): EditorPreset {
  const preset = typeof input === "string" ? getEditorPreset(input)
    : "presetId" in input ? getEditorPreset(input.presetId, input.presetVersion) : input;
  if (!preset) throw new RangeError("Неизвестный шаблон сцены или его версия.");
  return preset;
}
export function getEditorCatalog(input: EditorPreset | EditorPresetReference | string): EditorCatalog {
  return resolveEditorPreset(input).catalog;
}
export function editorFolderForKind(input: EditorPreset | EditorPresetReference | string, kind: string): string {
  const preset = resolveEditorPreset(input);
  return preset.runtime.catalog[kind]?.folderId ?? preset.catalog[kind]?.defaultFolderId ?? kind;
}
const cloneObject = (object: EngineObject): EngineObject => ({ ...object, ...(object.stackOrder ? { stackOrder: [...object.stackOrder] } : {}) });
/** Baseline records are captured once in a document; renderer imports never invoke a new generator. */
export function snapshotEditorPreset(input: EditorPreset | EditorPresetReference | string, size?: SceneSize, seed?: number): EngineObject[] {
  const preset = resolveEditorPreset(input), requestedSize = size ?? preset.defaultSize, sourceSeed = seed ?? preset.defaultSeed;
  const dimensions = { width: requestedSize.width, height: requestedSize.height };
  if (!validateSceneSize(dimensions) || !Number.isInteger(sourceSeed) || sourceSeed < 0 || sourceSeed > 2_147_483_647) throw new RangeError("Неверный размер сцены или seed.");
  return [...(preset.runtime.generateObjects?.(sourceSeed, { x: 0, y: 0, ...dimensions }) ?? []), ...(preset.runtime.initialObjects?.() ?? [])].map(cloneObject);
}
/** Frozen baseline plus a dynamic extent support independent documents, including larger forest projects. */
export function createDocumentRuntimePreset(input: EditorPreset | EditorPresetReference | string, baseObjects: readonly EngineObject[], size: SceneSize): EnginePreset {
  const preset = resolveEditorPreset(input);
  if (!validateSceneSize(size)) throw new RangeError("Неверный размер сцены.");
  const baseline = baseObjects.map(object => {
    const copy = cloneObject(object); if (copy.stackOrder) Object.freeze(copy.stackOrder); return Object.freeze(copy);
  });
  Object.freeze(baseline);
  const original = preset.runtime.terrainBounds;
  let width = Math.max(original?.width ?? size.width, size.width), height = Math.max(original?.height ?? size.height, size.height);
  // The renderer's extent shares its pixel budget; a skinny large project may
  // legitimately exceed that budget after combining it with a preset extent.
  if (!validateSceneSize({ width, height })) { width = size.width; height = size.height; }
  return Object.freeze({ ...preset.runtime, generateObjects: undefined,
    initialObjects: () => baseline.slice() as EngineObject[], terrainBounds: Object.freeze({ width, height }),
  });
}
