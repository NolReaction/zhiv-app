import { cloneSceneDocument, MAX_PROJECT_DOCUMENT_BYTES, validProjectId, validProjectName, validateSceneDocument, type SceneDocument } from "@/packages/engine/src/scene/document";
import { initialLighting } from "@/packages/engine/src/lighting/lighting-data";
import { initialTerrain } from "@/packages/engine/src/terrain/terrain-data";
import { validateSceneSize } from "@/packages/engine/src/scene/contracts";
import { getEditorCatalog, getEditorPreset, snapshotEditorPreset } from "./editor-presets";
import { parseScene } from "./editor-scene";

export type CreateProjectOptions = { id?: string; name?: string; presetId?: string; presetVersion?: number; seed?: number; width?: number; height?: number };

/** IDs are generated when a project is created, including in hosts without a browser. */
export function createProjectId(): string {
  return `project:${typeof globalThis.crypto?.randomUUID === "function" ? globalThis.crypto.randomUUID() : `${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`}`;
}

export function createProjectDocument(options: CreateProjectOptions = {}): SceneDocument {
  const presetId = options.presetId ?? "forest-v5", presetVersion = options.presetVersion ?? 1;
  const preset = getEditorPreset(presetId, presetVersion);
  if (!preset) throw new Error(`Шаблон «${presetId}» версии ${presetVersion} не поддерживается.`);
  const id = options.id ?? createProjectId(), name = (options.name ?? "Новый проект").trim();
  if (!validProjectId(id)) throw new Error("Нужен корректный ID проекта длиной до 128 символов.");
  if (!validProjectName(name)) throw new Error("Название проекта должно содержать от 1 до 100 символов без управляющих символов.");
  const width = options.width ?? preset.defaultSize.width, height = options.height ?? preset.defaultSize.height;
  if (!validateSceneSize({ width, height })) throw new Error("Размер сцены должен быть целым, от 1 до 8192 по стороне и не более 64 млн пикселей.");
  const seed = options.seed ?? preset.defaultSeed;
  if (!Number.isInteger(seed) || seed < 0 || seed > 2_147_483_647) throw new Error("Seed должен быть целым числом от 0 до 2147483647.");
  const document: SceneDocument = { version: 6, id, name, presetId: preset.id, presetVersion: preset.version, seed, width, height,
    baseObjects: snapshotEditorPreset(preset, { width, height }, seed), planted: [], removed: [], modified: [], assets: [],
    layers: preset.layers.map(layer => ({ ...layer })), folders: preset.folders.map(folder => ({ ...folder })), terrain: initialTerrain(), lighting: initialLighting() };
  const validated = validateProjectDocument(document);
  if (!validated) throw new Error("Не удалось создать корректный проект из выбранного шаблона.");
  return validated;
}

/** The generic core verifies structure; the editor verifies content availability. It never regenerates v6 snapshots. */
export function validateProjectDocument(value: unknown): SceneDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const metadata = value as Record<string, unknown>;
  if (typeof metadata.presetId !== "string" || typeof metadata.presetVersion !== "number") return null;
  const preset = getEditorPreset(metadata.presetId, metadata.presetVersion);
  if (!preset) return null;
  const document = validateSceneDocument(value, { catalog: preset.runtime.catalog, editMargin: preset.overscanMargin });
  if (!document) return null;
  const catalog = getEditorCatalog(preset);
  if ([...document.baseObjects, ...document.planted, ...document.modified].some(object => !catalog[object.kind] || object.variant >= catalog[object.kind].variants)) return null;
  return document;
}

/** Legacy parsing keeps every v1–v5 migration rule; the resulting generated baseline is frozen once. */
export function parseProjectDocument(json: string): SceneDocument | null {
  if (typeof json !== "string" || json.length > MAX_PROJECT_DOCUMENT_BYTES || new TextEncoder().encode(json).length > MAX_PROJECT_DOCUMENT_BYTES) return null;
  try {
    const value: unknown = JSON.parse(json);
    if (value && typeof value === "object" && (value as Record<string, unknown>).version === 6) return validateProjectDocument(value);
    const legacy = parseScene(json), preset = getEditorPreset("forest-v5", 1);
    if (!legacy || !preset) return null;
    return validateProjectDocument({ ...legacy, version: 6, id: "project:legacy-forest", name: "Лесной проект", presetId: preset.id, presetVersion: preset.version,
      height: 1600, baseObjects: snapshotEditorPreset(preset, { width: legacy.width, height: 1600 }, legacy.seed) });
  } catch { return null; }
}

export function serializeProjectDocument(document: SceneDocument): string {
  const encoder = new TextEncoder(), pretty = JSON.stringify(document, null, 2);
  if (encoder.encode(pretty).length <= MAX_PROJECT_DOCUMENT_BYTES) return pretty;
  const compact = JSON.stringify(document);
  if (encoder.encode(compact).length > MAX_PROJECT_DOCUMENT_BYTES) throw new Error("Проект превышает лимит переносимого JSON в 32 МиБ. Удали лишние ресурсы или предметы и повтори экспорт.");
  return compact;
}
export const cloneProjectDocument = cloneSceneDocument;

/** Key order in sparse terrain records is irrelevant; scene and object array order remains meaningful. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameValue(value, b[index]));
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  const left = a as Record<string, unknown>, right = b as Record<string, unknown>, leftKeys = Object.keys(left), rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every(key => Object.prototype.hasOwnProperty.call(right, key) && sameValue(left[key], right[key]));
}

/** Completed commands own snapshots; drag previews and unchanged commands do not consume history. */
export function createProjectHistory(initial: SceneDocument, limit = 60) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("История должна содержать от 1 до 1000 команд.");
  let current = cloneSceneDocument(initial);
  const before: SceneDocument[] = [], after: SceneDocument[] = [];
  const getDocument = () => cloneSceneDocument(current);
  return {
    getScene: getDocument,
    getDocument,
    get canUndo() { return before.length > 0; },
    get canRedo() { return after.length > 0; },
    commit(document: SceneDocument) {
      if (sameValue(current, document)) return false;
      before.push(current); if (before.length > limit) before.shift();
      current = cloneSceneDocument(document); after.length = 0; return true;
    },
    undo() {
      const previous = before.pop(); if (!previous) return null;
      after.push(current); current = previous; return getDocument();
    },
    redo() {
      const next = after.pop(); if (!next) return null;
      before.push(current); current = next; return getDocument();
    },
  };
}
