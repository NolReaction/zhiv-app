import { TILED_WORLD } from "@/features/world/scene/presentation";
import type { FixedWorldScene, WorldLight, WorldPoint, WorldShadowCaster, WorldShadowReceiver, WorldStudioElementMetadata } from "@/features/world/tiled/types";
import { WORLD_DEV_ENABLED } from "./world-dev-store";
import { retainWorldDevClientState } from "./world-dev-hmr-cache";

export const WORLD_LIGHTING_EDITOR_LIMITS = Object.freeze({ vertices: 64, maxHeight: 300, maxTop: 400, maxSoftness: 12, maxCasters: 128, maxReceivers: 32,
  maxLightHeight: 200, maxLightRadius: 500, maxLightIntensity: 2, maxLightFlicker: 1, maxLights: 128 });
export const WORLD_LIGHTING_LIGHT_PRESETS = Object.freeze({
  lantern: Object.freeze({ height: 24, radius: 160, intensity: 1, color: "#ffd28a", flicker: .04 }),
  torch: Object.freeze({ height: 17, radius: 130, intensity: 1.15, color: "#ffb45d", flicker: .12 }),
  glow: Object.freeze({ height: 12, radius: 100, intensity: .65, color: "#8adbd0", flicker: 0 }),
} satisfies Record<WorldLight["kind"], Required<Pick<WorldLight, "height" | "radius" | "intensity" | "color" | "flicker">>>);
export const WORLD_LIGHTING_EDITOR_CANCEL_EVENT = "world-lighting-editor:cancel";
export type WorldLightingEditorTool = "select" | "move" | "vertex" | "height" | "light" | "pan";
export type WorldLightingEditorOverlay = "all" | "selected" | "off";
export type WorldLightingEditorLightPatch = Partial<Omit<WorldLight, "id">>;
export type WorldLightingLightProjection = Readonly<{ id: string; position: Readonly<WorldPoint>; height: number }>;
export type WorldLightingElementKind = "caster" | "receiver" | "light";
export type WorldLightingElementMetadataPatch = { studioName?: string | null; studioFolder?: string | null };
export type WorldLightingEditorSnapshot = Readonly<{
  sceneId: string;
  enabled: boolean;
  selectedKind: WorldLightingElementKind;
  selectedId: string | null;
  selectedVertex: number | null;
  casters: readonly WorldShadowCaster[];
  receivers: readonly WorldShadowReceiver[];
  dirtyIds: readonly string[];
  dirtyReceiverIds: readonly string[];
  deletedCasters: readonly WorldShadowCaster[];
  deletedReceivers: readonly WorldShadowReceiver[];
  lights: readonly WorldLight[];
  /** Actual rendered bulb coordinates and resolved height; view-only, never exported. */
  lightProjections: readonly WorldLightingLightProjection[];
  dirtyLightIds: readonly string[];
  tool: WorldLightingEditorTool;
  lightKind: WorldLight["kind"];
  snap: number;
  overlay: WorldLightingEditorOverlay;
  showCasters: boolean;
  showReceivers: boolean;
  showWireframe: boolean;
  previewDraft: boolean;
  error: string | null;
  localSaveStatus: "saved" | "pending" | "error";
  localSavedAt: number | null;
  localSaveError: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Changes when authored lighting or Studio metadata changes; selection never changes it. */
  revision: number;
  casterRevision: number;
  receiverRevision: number;
  geometryRevision: number;
  lightRevision: number;
}>;
type CasterPatch = Partial<Pick<WorldShadowCaster, "baseHeight" | "height" | "opacity" | "softness">>;
type GeometryEntry<T> = { id: string; before: T | null; after: T | null };
type LightingPatch = { schemaVersion: 3; sceneId: string; casters: GeometryEntry<WorldShadowCaster>[];
  receivers: GeometryEntry<WorldShadowReceiver>[]; lights: GeometryEntry<WorldLight>[] };
type EditorGeometry = Readonly<{ casters: readonly WorldShadowCaster[]; receivers: readonly WorldShadowReceiver[]; lights: readonly WorldLight[] }>;
type ShadowPolygon = WorldShadowCaster | WorldShadowReceiver;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const cross = (a: WorldPoint, b: WorldPoint, c: WorldPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const sameCondition = (a: WorldShadowCaster["when"], b: WorldShadowCaster["when"]) => a?.siteId === b?.siteId && a?.level === b?.level;
const sameStudioMetadata = (a: WorldStudioElementMetadata, b: WorldStudioElementMetadata) => a.studioName === b.studioName && a.studioFolder === b.studioFolder;
const studioMetadata = (value: WorldStudioElementMetadata): WorldStudioElementMetadata => ({
  ...(value.studioName !== undefined ? { studioName: value.studioName } : {}),
  ...(value.studioFolder !== undefined ? { studioFolder: value.studioFolder } : {}),
});
function validateStudioMetadata(value: Record<string, unknown>): string | null {
  for (const [key, limit] of [["studioName", 128], ["studioFolder", 256]] as const) {
    const text = value[key];
    if (text !== undefined && (typeof text !== "string" || !text.trim() || text !== text.trim() || text.length > limit
      || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(text))) return key === "studioName"
      ? "Имя объекта должно содержать от 1 до 128 символов без управляющих символов."
      : "Путь папки должен содержать от 1 до 256 символов без управляющих символов.";
  }
  if (typeof value.studioFolder === "string" && value.studioFolder.startsWith("custom:")) {
    const parts = value.studioFolder.slice(7).split("/");
    if (parts.length > 8 || parts.some(part => !part || part !== part.trim() || part.length > 64 || part === "." || part === ".."))
      return "В пути папки поддерживается до 8 названий по 64 символа; разделите вложенные папки знаком /.";
  }
  return null;
}
const samePoints = (a: readonly WorldPoint[], b: readonly WorldPoint[], tolerance = 0) => a.length === b.length
  && a.every((point, index) => Math.abs(point.x - b[index].x) <= tolerance && Math.abs(point.y - b[index].y) <= tolerance);
const equalCaster = (a: WorldShadowCaster | undefined, b: WorldShadowCaster | undefined, tolerance = 0, includeMetadata = true) => a === b || !!a && !!b && a.id === b.id && a.height === b.height
  && a.baseHeight === b.baseHeight && a.opacity === b.opacity && a.softness === b.softness && sameCondition(a.when, b.when) && (!includeMetadata || sameStudioMetadata(a, b)) && samePoints(a.points, b.points, tolerance);
const sameCaster = (a: WorldShadowCaster | undefined, b: WorldShadowCaster | undefined) => equalCaster(a, b);
/** Tiled rotation/offset round trips introduce only floating-point coordinate noise. */
const canonicalCaster = (a: WorldShadowCaster | undefined, b: WorldShadowCaster | undefined) => equalCaster(a, b, 1e-9);
const sameCasters = (a: readonly WorldShadowCaster[], b: readonly WorldShadowCaster[]) => a.length === b.length && a.every((caster, index) => sameCaster(caster, b[index]));
const sameCasterGeometry = (a: readonly WorldShadowCaster[], b: readonly WorldShadowCaster[]) => a.length === b.length && a.every((caster, index) => equalCaster(caster, b[index], 0, false));
const equalReceiver = (a: WorldShadowReceiver | undefined, b: WorldShadowReceiver | undefined, tolerance = 0, includeMetadata = true) => a === b || !!a && !!b && a.id === b.id && a.height === b.height
  && sameCondition(a.when, b.when) && (!includeMetadata || sameStudioMetadata(a, b)) && samePoints(a.points, b.points, tolerance);
const sameReceiver = (a: WorldShadowReceiver | undefined, b: WorldShadowReceiver | undefined) => equalReceiver(a, b);
const canonicalReceiver = (a: WorldShadowReceiver | undefined, b: WorldShadowReceiver | undefined) => equalReceiver(a, b, 1e-9);
const sameReceivers = (a: readonly WorldShadowReceiver[], b: readonly WorldShadowReceiver[]) => a.length === b.length && a.every((receiver, index) => sameReceiver(receiver, b[index]));
const sameReceiverGeometry = (a: readonly WorldShadowReceiver[], b: readonly WorldShadowReceiver[]) => a.length === b.length && a.every((receiver, index) => equalReceiver(receiver, b[index], 0, false));
function freezeCaster(caster: WorldShadowCaster): WorldShadowCaster {
  return Object.freeze({ id: caster.id, points: Object.freeze(caster.points.map(point => Object.freeze({ x: point.x, y: point.y }))) as unknown as WorldPoint[],
    height: caster.height, baseHeight: caster.baseHeight, opacity: caster.opacity, softness: caster.softness, ...studioMetadata(caster),
    ...(caster.when ? { when: Object.freeze({ siteId: caster.when.siteId, level: caster.when.level }) } : {}) });
}
function freezeReceiver(receiver: WorldShadowReceiver): WorldShadowReceiver {
  return Object.freeze({ id: receiver.id, points: Object.freeze(receiver.points.map(point => Object.freeze({ x: point.x, y: point.y }))) as unknown as WorldPoint[],
    height: receiver.height, ...studioMetadata(receiver), ...(receiver.when ? { when: Object.freeze({ siteId: receiver.when.siteId, level: receiver.when.level }) } : {}) });
}
const sameLight = (a: WorldLight | undefined, b: WorldLight | undefined) => a === b || !!a && !!b && a.id === b.id
  && a.position.x === b.position.x && a.position.y === b.position.y && a.kind === b.kind && a.height === b.height
  && a.radius === b.radius && a.intensity === b.intensity && a.color.toLowerCase() === b.color.toLowerCase() && a.flicker === b.flicker
  && a.enabled === b.enabled && a.manualPosition === b.manualPosition && sameStudioMetadata(a, b);
const sameLights = (a: readonly WorldLight[], b: readonly WorldLight[]) => a.length === b.length && a.every((light, index) => sameLight(light, b[index]));
const sameGeometry = (a: EditorGeometry, b: EditorGeometry) => sameCasters(a.casters, b.casters) && sameReceivers(a.receivers, b.receivers) && sameLights(a.lights, b.lights);
function freezeLight(light: WorldLight): WorldLight {
  return Object.freeze({ id: light.id, position: Object.freeze({ x: light.position.x, y: light.position.y }), kind: light.kind,
    radius: light.radius, intensity: light.intensity, color: light.color.toLowerCase(), flicker: light.flicker, ...studioMetadata(light),
    ...(light.height !== undefined ? { height: light.height } : {}),
    ...(light.enabled !== undefined ? { enabled: light.enabled } : {}),
    ...(light.manualPosition !== undefined ? { manualPosition: light.manualPosition } : {}) });
}
const lightKinds: readonly WorldLight["kind"][] = ["lantern", "torch", "glow"];
function validateLight(value: unknown, scene: FixedWorldScene): string | null {
  if (!isRecord(value) || Object.keys(value).some(key => !["id", "position", "kind", "height", "radius", "intensity", "color", "flicker", "enabled", "manualPosition", "studioName", "studioFolder"].includes(key))
    || typeof value.id !== "string" || !value.id.trim() || value.id.length > 128 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value.id) || !lightKinds.some(kind => kind === value.kind)) return "Некорректные данные источника света.";
  if (!isRecord(value.position) || Object.keys(value.position).some(key => key !== "x" && key !== "y") || !finite(value.position.x) || !finite(value.position.y)
    || value.position.x < 0 || value.position.x > scene.width || value.position.y < 0 || value.position.y > scene.height) return "Источник света должен находиться внутри карты.";
  if (value.height !== undefined && (!finite(value.height) || value.height < 1 || value.height > WORLD_LIGHTING_EDITOR_LIMITS.maxLightHeight)) return "Высота источника должна быть от 1 до 200.";
  if (!finite(value.radius) || value.radius <= 0 || value.radius > WORLD_LIGHTING_EDITOR_LIMITS.maxLightRadius) return "Радиус света должен быть больше 0 и не больше 500.";
  if (!finite(value.intensity) || value.intensity < 0 || value.intensity > WORLD_LIGHTING_EDITOR_LIMITS.maxLightIntensity) return "Яркость должна быть от 0 до 2.";
  if (!finite(value.flicker) || value.flicker < 0 || value.flicker > WORLD_LIGHTING_EDITOR_LIMITS.maxLightFlicker) return "Мерцание должно быть от 0 до 1.";
  if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color)) return "Цвет должен иметь формат #rrggbb.";
  if (value.enabled !== undefined && typeof value.enabled !== "boolean" || value.manualPosition !== undefined && typeof value.manualPosition !== "boolean") return "Признаки источника должны быть логическими значениями.";
  return validateStudioMetadata(value);
}
function segmentsIntersect(a: WorldPoint, b: WorldPoint, c: WorldPoint, d: WorldPoint) {
  const epsilon = 1e-9;
  const signs = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)].map(value => Math.abs(value) < epsilon ? 0 : Math.sign(value));
  const on = (p: WorldPoint, q: WorldPoint, r: WorldPoint) => r.x >= Math.min(p.x, q.x) - epsilon && r.x <= Math.max(p.x, q.x) + epsilon
    && r.y >= Math.min(p.y, q.y) - epsilon && r.y <= Math.max(p.y, q.y) + epsilon;
  return signs[0] * signs[1] < 0 && signs[2] * signs[3] < 0
    || !signs[0] && on(a, b, c) || !signs[1] && on(a, b, d) || !signs[2] && on(c, d, a) || !signs[3] && on(c, d, b);
}
const validGeometryId = (id: unknown): id is string => typeof id === "string" && id.length <= 128 && /^[a-z][a-z0-9_-]*$/.test(id);
function validatePolygon(value: unknown, scene: FixedWorldScene): string | null {
  if (!Array.isArray(value)) return "Некорректный контур.";
  const points: WorldPoint[] = [];
  for (const point of value) {
    if (!isRecord(point) || Object.keys(point).some(key => key !== "x" && key !== "y") || !finite(point.x) || !finite(point.y)
      || point.x < 0 || point.x > scene.width || point.y < 0 || point.y > scene.height) return "Вершины должны находиться внутри карты и иметь числовые координаты.";
    points.push({ x: point.x, y: point.y });
  }
  if (points.length < 3 || points.length > WORLD_LIGHTING_EDITOR_LIMITS.vertices) return "В контуре должно быть от 3 до 64 вершин.";
  if (new Set(points.map(point => `${point.x},${point.y}`)).size !== points.length) return "Вершины контура не должны совпадать.";
  const area = points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length]; return sum + point.x * next.y - next.x * point.y;
  }, 0);
  if (Math.abs(area) <= 1e-6) return "Контур должен иметь ненулевую площадь.";
  for (let i = 0; i < points.length; i++) {
    const a = points[i], b = points[(i + 1) % points.length], c = points[(i + 2) % points.length];
    if (Math.abs(cross(a, b, c)) < 1e-9 && (b.x - a.x) * (c.x - b.x) + (b.y - a.y) * (c.y - b.y) < 0) return "Рёбра контура не должны перекрываться.";
    for (let j = i + 1; j < points.length; j++) {
      if ((i + 1) % points.length === j || (j + 1) % points.length === i) continue;
      if (segmentsIntersect(a, b, points[j], points[(j + 1) % points.length])) return "Контур не должен пересекать сам себя.";
    }
  }
  return null;
}
function validateCondition(value: unknown): string | null {
  return value !== undefined && (!isRecord(value) || Object.keys(value).some(key => key !== "siteId" && key !== "level")
    || !validGeometryId(value.siteId) || !Number.isSafeInteger(value.level) || (value.level as number) < 0) ? "Некорректное условие уровня здания." : null;
}
function validateCaster(value: unknown, scene: FixedWorldScene): string | null {
  if (!isRecord(value) || Object.keys(value).some(key => !["id", "points", "height", "baseHeight", "opacity", "softness", "when", "studioName", "studioFolder"].includes(key))
    || !validGeometryId(value.id)) return "Некорректные данные объёма.";
  const polygonError = validatePolygon(value.points, scene); if (polygonError) return polygonError;
  if (!finite(value.height) || value.height <= 0 || value.height > WORLD_LIGHTING_EDITOR_LIMITS.maxHeight) return "Высота должна быть больше 0 и не больше 300.";
  if (!finite(value.baseHeight) || value.baseHeight < 0 || value.baseHeight + value.height > WORLD_LIGHTING_EDITOR_LIMITS.maxTop) return "Основание должно быть не ниже 0, а верх объёма — не выше 400.";
  if (!finite(value.opacity) || value.opacity < 0 || value.opacity > 1) return "Непрозрачность должна быть от 0 до 1.";
  if (!finite(value.softness) || value.softness < 0 || value.softness > WORLD_LIGHTING_EDITOR_LIMITS.maxSoftness) return "Мягкость должна быть от 0 до 12.";
  return validateCondition(value.when) ?? validateStudioMetadata(value);
}
function validateReceiver(value: unknown, scene: FixedWorldScene): string | null {
  if (!isRecord(value) || Object.keys(value).some(key => !["id", "points", "height", "when", "studioName", "studioFolder"].includes(key)) || !validGeometryId(value.id)) return "Некорректные данные поверхности.";
  const polygonError = validatePolygon(value.points, scene); if (polygonError) return polygonError;
  if (!finite(value.height) || value.height < 0 || value.height > WORLD_LIGHTING_EDITOR_LIMITS.maxHeight) return "Высота поверхности должна быть от 0 до 300.";
  return validateCondition(value.when) ?? validateStudioMetadata(value);
}

/** Isolated DEV drafts. The authored scene and player state remain immutable. */
export function createWorldLightingEditorStore(available: boolean, originalScene: FixedWorldScene) {
  let original = originalScene;
  let baseline = Object.freeze((original.shadowCasters ?? []).map(freezeCaster));
  let baselineReceivers = Object.freeze((original.shadowReceivers ?? []).map(freezeReceiver));
  let baselineLights = Object.freeze((original.lights ?? []).map(freezeLight));
  let baselineGeometry: EditorGeometry = Object.freeze({ casters: baseline, receivers: baselineReceivers, lights: baselineLights });
  const originals = new Map(baseline.map(caster => [caster.id, caster]));
  const originalReceivers = new Map(baselineReceivers.map(receiver => [receiver.id, receiver]));
  const originalLights = new Map(baselineLights.map(light => [light.id, light]));
  const initialCasterIds = new Set(baseline.map(item => item.id)), initialReceiverIds = new Set(baselineReceivers.map(item => item.id));
  const knownCasterIds = new Set(initialCasterIds), knownReceiverIds = new Set(initialReceiverIds), knownLightIds = new Set(baselineLights.map(item => item.id));
  const initial: WorldLightingEditorSnapshot = Object.freeze({ sceneId: original.id, enabled: false, selectedKind: "caster", selectedId: null, selectedVertex: null,
    casters: baseline, receivers: baselineReceivers, lights: baselineLights, lightProjections: Object.freeze([]),
    dirtyIds: Object.freeze([]), dirtyReceiverIds: Object.freeze([]), dirtyLightIds: Object.freeze([]), deletedCasters: Object.freeze([]), deletedReceivers: Object.freeze([]),
    tool: "select", lightKind: "lantern", snap: 0, overlay: "selected", showCasters: true, showReceivers: false, showWireframe: false, previewDraft: true,
    error: null, localSaveStatus: "saved", localSavedAt: null, localSaveError: null,
    canUndo: false, canRedo: false, revision: 0, casterRevision: 0, receiverRevision: 0, geometryRevision: 0, lightRevision: 0 });
  let state = initial, hydrated = false, sequence = 0;
  let hydrationConflict = false, conflictedDraft: string | null = null;
  let gesture: EditorGeometry | null = null;
  let gestureSaveState: Pick<WorldLightingEditorSnapshot, "localSaveStatus" | "localSavedAt" | "localSaveError"> | null = null;
  const past: EditorGeometry[] = [], future: EditorGeometry[] = [];
  const listeners = new Set<() => void>();
  const sceneCache = new WeakMap<FixedWorldScene, { revision: number; casterRevision: number; receiverRevision: number; visibilityKey: string; scene: FixedWorldScene }>();
  const baselineSceneCache = new WeakMap<FixedWorldScene, { revision: number; casterRevision: number; receiverRevision: number; visibilityKey: string; scene: FixedWorldScene }>();
  let baselineRevision = 0, baselineCasterRevision = 0, baselineReceiverRevision = 0;
  const storageKey = `zhiv:world-lighting-editor:v3:${original.id}`;
  const oldStorageKeys = [`zhiv:world-lighting-editor:v2:${original.id}`, `zhiv:world-lighting-editor:v1:${original.id}`];
  const geometry = (): EditorGeometry => ({ casters: state.casters, receivers: state.receivers, lights: state.lights });
  const publish = (patch: Partial<WorldLightingEditorSnapshot>) => {
    if (!available || Object.entries(patch).every(([key, value]) => state[key as keyof WorldLightingEditorSnapshot] === value)) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
  };
  const fail = (error: string) => { publish({ error }); return false; };
  const dirty = <T extends { id: string }>(values: readonly T[], baseline: readonly T[], same: (a: T | undefined, b: T | undefined) => boolean) => {
    const authored = new Map(baseline.map(item => [item.id, item])), current = new Map(values.map(item => [item.id, item]));
    return Object.freeze([...new Set([...baseline.map(item => item.id), ...values.map(item => item.id)])].filter(id => !same(authored.get(id), current.get(id))));
  };
  const dirtyMetadata = (next: EditorGeometry) => ({
    dirtyIds: dirty(next.casters, baseline, canonicalCaster), dirtyReceiverIds: dirty(next.receivers, baselineReceivers, canonicalReceiver), dirtyLightIds: dirty(next.lights, baselineLights, sameLight),
    deletedCasters: Object.freeze(baseline.filter(item => !next.casters.some(current => current.id === item.id))),
    deletedReceivers: Object.freeze(baselineReceivers.filter(item => !next.receivers.some(current => current.id === item.id))),
  });
  const entries = <T extends { id: string }>(ids: readonly string[], authored: Map<string, T>, current: readonly T[]): GeometryEntry<T>[] =>
    ids.map(id => ({ id, before: authored.get(id) ?? null, after: current.find(item => item.id === id) ?? null }));
  const exportPatch = () => available ? JSON.stringify({ schemaVersion: 3, sceneId: original.id,
    casters: entries(state.dirtyIds, originals, state.casters), receivers: entries(state.dirtyReceiverIds, originalReceivers, state.receivers),
    lights: entries(state.dirtyLightIds, originalLights, state.lights),
  } satisfies LightingPatch, null, 2) : "";
  const exportSceneBackup = () => available ? JSON.stringify({ type: "world-studio-backup", schemaVersion: 1, sceneId: original.id,
    width: original.width, height: original.height, casters: state.casters, receivers: state.receivers, lights: state.lights }, null, 2) : "";
  const persist = (): boolean => {
    if (!available) return false;
    if (hydrationConflict) {
      const error = "Сохранённый черновик не совпадает с проектом. Скачайте непрочитанный черновик, затем импортируйте правки или явно сбросьте черновик.";
      publish({ localSaveStatus: "error", localSaveError: error, error }); return false;
    }
    if (typeof window === "undefined") { publish({ localSaveStatus: "pending" }); return false; }
    try {
      if (state.dirtyIds.length || state.dirtyReceiverIds.length || state.dirtyLightIds.length) window.localStorage.setItem(storageKey, exportPatch());
      else window.localStorage.removeItem(storageKey);
      for (const key of oldStorageKeys) if (window.localStorage.getItem(key) !== null) window.localStorage.removeItem(key);
      const clearError = state.error === state.localSaveError;
      publish({ localSaveStatus: "saved", localSavedAt: Date.now(), localSaveError: null, ...(clearError ? { error: null } : {}) });
      return true;
    } catch {
      const error = "Не удалось сохранить черновик в браузере. Повторите сохранение или экспортируйте файл с правками.";
      publish({ localSaveStatus: "error", localSaveError: error, error }); return false;
    }
  };
  const recordHistory = (previous: EditorGeometry) => {
    past.push(previous); if (past.length > 100) past.shift(); future.length = 0;
  };
  const applyGeometry = (next: EditorGeometry, record = true, save = true, vertex = state.selectedVertex) => {
    const casterChanged = !sameCasters(next.casters, state.casters), receiverChanged = !sameReceivers(next.receivers, state.receivers), lightChanged = !sameLights(next.lights, state.lights);
    const geometryChanged = !sameCasterGeometry(next.casters, state.casters) || !sameReceiverGeometry(next.receivers, state.receivers);
    if (!available || !casterChanged && !receiverChanged && !lightChanged) { publish({ error: null }); return false; }
    const metadata = dirtyMetadata(next);
    if (next.casters.length > WORLD_LIGHTING_EDITOR_LIMITS.maxCasters || metadata.dirtyIds.length > WORLD_LIGHTING_EDITOR_LIMITS.maxCasters) {
      fail("В черновике поддерживается не больше 128 объёмов и изменений объёмов."); return false;
    }
    if (next.receivers.length > WORLD_LIGHTING_EDITOR_LIMITS.maxReceivers || metadata.dirtyReceiverIds.length > WORLD_LIGHTING_EDITOR_LIMITS.maxReceivers) {
      fail("В черновике поддерживается не больше 32 поверхностей и изменений поверхностей."); return false;
    }
    if (next.lights.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights || metadata.dirtyLightIds.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights) {
      fail("В черновике поддерживается не больше 128 источников и изменений источников. Сначала примените текущие правки к карте."); return false;
    }
    if (record && !gesture) recordHistory(geometry());
    next.casters.forEach(item => knownCasterIds.add(item.id)); next.receivers.forEach(item => knownReceiverIds.add(item.id)); next.lights.forEach(item => knownLightIds.add(item.id));
    const selected = (state.selectedKind === "caster" ? next.casters : state.selectedKind === "receiver" ? next.receivers : next.lights).find(item => item.id === state.selectedId);
    publish({ casters: casterChanged ? next.casters : state.casters, receivers: receiverChanged ? next.receivers : state.receivers,
      lights: lightChanged ? next.lights : state.lights, ...metadata,
      error: null, localSaveStatus: "pending", canUndo: past.length > 0, canRedo: future.length > 0, selectedId: selected ? state.selectedId : null,
      selectedVertex: selected && "points" in selected && vertex !== null && vertex < selected.points.length ? vertex : null,
      revision: state.revision + 1, casterRevision: state.casterRevision + Number(casterChanged), receiverRevision: state.receiverRevision + Number(receiverChanged),
      geometryRevision: state.geometryRevision + Number(geometryChanged), lightRevision: state.lightRevision + Number(lightChanged) });
    if (save && !gesture) persist();
    return true;
  };
  const commitGesture = () => {
    if (!available || !gesture) return;
    const previous = gesture, saveState = gestureSaveState; gesture = null; gestureSaveState = null;
    if (!sameGeometry(previous, geometry())) { recordHistory(previous); publish({ canUndo: true, canRedo: false }); persist(); }
    else if (saveState) publish(saveState);
  };
  const editSelected = (edit: (polygon: ShadowPolygon) => ShadowPolygon | null, vertex = state.selectedVertex) => {
    if (!available) return;
    const receiver = state.selectedKind === "receiver", values: readonly ShadowPolygon[] = receiver ? state.receivers : state.casters;
    const index = state.selectedKind === "light" ? -1 : values.findIndex(item => item.id === state.selectedId);
    if (index < 0) { fail("Сначала выберите объём или поверхность."); return; }
    const current = values[index], next = edit(current); if (!next) return;
    const error = receiver ? validateReceiver(next, original) : validateCaster(next, original); if (error) { fail(error); return; }
    if (next.id !== current.id || !sameCondition(next.when, current.when)) { fail("ID и уровень объекта изменять нельзя."); return; }
    if (receiver) {
      const authored = originalReceivers.get(next.id), copy = [...state.receivers];
      copy[index] = authored && sameReceiver(next, authored) ? authored : freezeReceiver(next);
      applyGeometry({ ...geometry(), receivers: Object.freeze(copy) }, true, true, vertex);
    } else {
      const authored = originals.get(next.id), copy = [...state.casters];
      copy[index] = authored && sameCaster(next as WorldShadowCaster, authored) ? authored : freezeCaster(next as WorldShadowCaster);
      applyGeometry({ ...geometry(), casters: Object.freeze(copy) }, true, true, vertex);
    }
  };
  const effectiveLight = (light: WorldLight) => {
    const projection = !light.manualPosition ? state.lightProjections.find(item => item.id === light.id) : undefined;
    return { position: projection?.position ?? light.position, height: light.height ?? projection?.height };
  };
  const editLight = (patch: WorldLightingEditorLightPatch) => {
    if (!available) return;
    if (!isRecord(patch) || Object.keys(patch).some(key => !["position", "kind", "height", "radius", "intensity", "color", "flicker", "enabled", "manualPosition"].includes(key))) {
      fail("Неизвестное свойство источника света."); return;
    }
    const index = state.selectedKind === "light" ? state.lights.findIndex(light => light.id === state.selectedId) : -1;
    if (index < 0) { fail("Сначала выберите источник света."); return; }
    const current = state.lights[index], next = { ...current, ...patch };
    if (patch.position) {
      next.manualPosition = true;
      const height = effectiveLight(current).height;
      if (current.height === undefined && !("height" in patch) && height !== undefined && height >= 1 && height <= WORLD_LIGHTING_EDITOR_LIMITS.maxLightHeight) next.height = height;
    }
    const error = validateLight(next, original); if (error) { fail(error); return; }
    next.color = next.color.toLowerCase();
    const copy = [...state.lights], authored = originalLights.get(next.id);
    copy[index] = authored && sameLight(next, authored) ? authored : freezeLight(next);
    applyGeometry({ ...geometry(), lights: Object.freeze(copy) });
  };
  const snapCoordinate = (value: number) => state.snap ? Math.round(value / state.snap) * state.snap : value;
  const snapped = (point: WorldPoint): WorldPoint => ({ x: snapCoordinate(point.x), y: snapCoordinate(point.y) });
  const validIndex = (index: number, polygon: ShadowPolygon) => Number.isInteger(index) && index >= 0 && index < polygon.points.length;
  const freshId = (kind: WorldLightingElementKind) => {
    let id: string;
    do { id = `studio-${kind}-${++sequence}`; } while (originals.has(id) || originalReceivers.has(id) || originalLights.has(id)
      || state.casters.some(item => item.id === id) || state.receivers.some(item => item.id === id) || state.lights.some(item => item.id === id));
    return id;
  };
  const createLight = (light: Omit<WorldLight, "id">): string | null => {
    if (!available) return null;
    const next = { ...light, id: freshId("light") }, error = validateLight(next, original);
    if (error) { fail(error); return null; }
    if (!applyGeometry({ ...geometry(), lights: Object.freeze([...state.lights, freezeLight(next)]) })) return null;
    publish({ selectedKind: "light", selectedId: next.id, selectedVertex: null, error: null }); return next.id;
  };
  const createPolygon = (kind: "caster" | "receiver", position: WorldPoint): string | null => {
    if (!available) return null;
    if (!finite(position?.x) || !finite(position?.y) || position.x < 0 || position.x > original.width || position.y < 0 || position.y > original.height) {
      fail("Укажите координаты нового объекта внутри карты."); return null;
    }
    const center = snapped(position), width = Math.min(30, original.width), height = Math.min(30, original.height);
    const left = Math.max(0, Math.min(original.width - width, center.x - width / 2)), top = Math.max(0, Math.min(original.height - height, center.y - height / 2));
    const common = { id: freshId(kind), points: [{ x: left, y: top }, { x: left + width, y: top }, { x: left + width, y: top + height }, { x: left, y: top + height }] };
    const next = kind === "caster" ? { ...common, height: 30, baseHeight: 0, opacity: 1, softness: 2 } : { ...common, height: 0 };
    const error = kind === "caster" ? validateCaster(next, original) : validateReceiver(next, original); if (error) { fail(error); return null; }
    const changed = kind === "caster" ? applyGeometry({ ...geometry(), casters: Object.freeze([...state.casters, freezeCaster(next as WorldShadowCaster)]) })
      : applyGeometry({ ...geometry(), receivers: Object.freeze([...state.receivers, freezeReceiver(next)]) });
    if (!changed) return null;
    publish({ selectedKind: kind, selectedId: next.id, selectedVertex: null, error: null }); return next.id;
  };
  const parsePatch = (text: string, alreadyApplied = false): EditorGeometry | null => {
    const reject = (error: string) => { if (!alreadyApplied) fail(error); return null; };
    let value: unknown;
    try { value = JSON.parse(text); } catch { return reject("Не удалось прочитать JSON с правками."); }
    if (!isRecord(value) || ![1, 2, 3].includes(value.schemaVersion as number)
      || Object.keys(value).some(key => !["schemaVersion", "sceneId", "casters", ...(value.schemaVersion !== 1 ? ["lights"] : []), ...(value.schemaVersion === 3 ? ["receivers"] : [])].includes(key))
      || value.sceneId !== original.id || !Array.isArray(value.casters) || value.casters.length > WORLD_LIGHTING_EDITOR_LIMITS.maxCasters
      || value.schemaVersion !== 1 && (!Array.isArray(value.lights) || value.lights.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights)
      || value.schemaVersion === 3 && (!Array.isArray(value.receivers) || value.receivers.length > WORLD_LIGHTING_EDITOR_LIMITS.maxReceivers)) return reject("Формат правок или ID карты не совпадает.");
    const creations = new Set<string>();
    const section = <T extends { id: string; when?: WorldShadowCaster["when"] }>(input: unknown[], kind: WorldLightingElementKind, base: readonly T[], authored: Map<string, T>,
      validate: (value: unknown, scene: FixedWorldScene) => string | null, same: (a: T | undefined, b: T | undefined) => boolean, freeze: (value: T) => T): readonly T[] | null => {
      const edits = new Map<string, T | null>();
      for (const entry of input) {
        if (!isRecord(entry) || Object.keys(entry).some(key => !["id", "before", "after"].includes(key)) || !Object.hasOwn(entry, "before") || !Object.hasOwn(entry, "after")
          || typeof entry.id !== "string" || edits.has(entry.id) || entry.before === null && entry.after === null
          || kind !== "light" && !validGeometryId(entry.id)
          || value.schemaVersion !== 3 && kind === "caster" && (entry.before === null || entry.after === null || !authored.has(entry.id))) return reject("Правки содержат неизвестный, повторяющийся или некорректный ID объекта.");
        const beforeError = entry.before === null ? null : validate(entry.before, original), afterError = entry.after === null ? null : validate(entry.after, original);
        if (beforeError || afterError) return reject(beforeError ?? afterError!);
        const before = entry.before as T | null, after = entry.after as T | null, live = authored.get(entry.id);
        if (before && before.id !== entry.id || after && after.id !== entry.id) return reject("ID объекта изменять нельзя.");
        if (kind !== "light" && before && after && !sameCondition(before.when, after.when)) return reject("Условие уровня здания изменять нельзя.");
        if (alreadyApplied ? !same(after ?? undefined, live) : !same(before ?? undefined, live)) return reject(`Исходная разметка «${entry.id}» изменилась. Правки не применены.`);
        if (before === null) {
          const otherKindId = kind !== "caster" && originals.has(entry.id) || kind !== "receiver" && originalReceivers.has(entry.id) || kind !== "light" && originalLights.has(entry.id);
          if (otherKindId || creations.has(entry.id)) return reject("ID нового объекта уже используется в другом разделе.");
          creations.add(entry.id);
          if (after?.when && !original.sites.some(site => site.id === after.when!.siteId && site.states.some(state => state.level === after.when!.level))) return reject("Новый объект ссылается на неизвестный уровень здания.");
        }
        edits.set(entry.id, after ? live && same(after, live) ? live : freeze(after) : null);
      }
      const result = base.filter(item => edits.get(item.id) !== null).map(item => edits.get(item.id) ?? item);
      for (const [id, item] of edits) if (!authored.has(id) && item) result.push(item);
      return Object.freeze(result);
    };
    const casters = section(value.casters, "caster", baseline, originals, validateCaster, canonicalCaster, freezeCaster); if (!casters) return null;
    const receivers = section(value.schemaVersion === 3 ? value.receivers as unknown[] : [], "receiver", baselineReceivers, originalReceivers, validateReceiver, canonicalReceiver, freezeReceiver); if (!receivers) return null;
    const lights = section(value.schemaVersion !== 1 ? value.lights as unknown[] : [], "light", baselineLights, originalLights, validateLight, sameLight, freezeLight); if (!lights) return null;
    const next = Object.freeze({ casters, receivers, lights }), metadata = dirtyMetadata(next);
    if (casters.length > WORLD_LIGHTING_EDITOR_LIMITS.maxCasters || metadata.dirtyIds.length > WORLD_LIGHTING_EDITOR_LIMITS.maxCasters) return reject("На карте и в черновике может быть не больше 128 объёмов.");
    if (receivers.length > WORLD_LIGHTING_EDITOR_LIMITS.maxReceivers || metadata.dirtyReceiverIds.length > WORLD_LIGHTING_EDITOR_LIMITS.maxReceivers) return reject("На карте и в черновике может быть не больше 32 поверхностей.");
    if (lights.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights || metadata.dirtyLightIds.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights) return reject("На карте и в черновике может быть не больше 128 источников света.");
    return next;
  };
  const selectPolygon = (kind: "caster" | "receiver", id: string | null, vertex: number | null = null) => {
    if (!available) return;
    const polygon = (kind === "caster" ? state.casters : state.receivers).find(item => item.id === id);
    if (id !== null && !polygon) { fail("Объект не найден в разметке света."); return; }
    if (vertex !== null && (!polygon || !validIndex(vertex, polygon))) { fail("Вершина контура не найдена."); return; }
    if (id !== state.selectedId || state.selectedKind !== kind) commitGesture();
    publish({ selectedKind: kind, selectedId: id, selectedVertex: vertex, error: null });
  };
  const parseSceneBackup = (text: string): EditorGeometry | null => {
    let value: unknown;
    try { value = JSON.parse(text); } catch { fail("Не удалось прочитать резервную копию студии."); return null; }
    if (!isRecord(value) || value.type !== "world-studio-backup" || value.schemaVersion !== 1 || value.sceneId !== original.id
      || value.width !== original.width || value.height !== original.height
      || Object.keys(value).some(key => !["type", "schemaVersion", "sceneId", "width", "height", "casters", "receivers", "lights"].includes(key))
      || !Array.isArray(value.casters) || value.casters.length > WORLD_LIGHTING_EDITOR_LIMITS.maxCasters
      || !Array.isArray(value.receivers) || value.receivers.length > WORLD_LIGHTING_EDITOR_LIMITS.maxReceivers
      || !Array.isArray(value.lights) || value.lights.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights) { fail("Формат резервной копии или размеры карты не совпадают."); return null; }
    const newIds = new Set<string>();
    const section = <T extends { id: string; when?: WorldShadowCaster["when"] }>(values: unknown[], kind: WorldLightingElementKind,
      authored: Map<string, T>, validate: (value: unknown, scene: FixedWorldScene) => string | null, freeze: (value: T) => T): readonly T[] | null => {
      const ids = new Set<string>(), result: T[] = [];
      for (const item of values) {
        const error = validate(item, original); if (error) { fail(error); return null; }
        const element = item as T, baseline = authored.get(element.id);
        if (ids.has(element.id)) { fail("Резервная копия содержит повторяющийся ID."); return null; } ids.add(element.id);
        if (kind !== "light" && baseline && !sameCondition(element.when, baseline.when)) { fail("Условие уровня здания изменять нельзя."); return null; }
        if (!baseline) {
          if (newIds.has(element.id) || kind !== "caster" && originals.has(element.id) || kind !== "receiver" && originalReceivers.has(element.id) || kind !== "light" && originalLights.has(element.id)) {
            fail("ID нового объекта уже используется в другом разделе."); return null;
          }
          newIds.add(element.id);
          if (element.when && !original.sites.some(site => site.id === element.when!.siteId && site.states.some(state => state.level === element.when!.level))) {
            fail("Новый объект ссылается на неизвестный уровень здания."); return null;
          }
        }
        result.push(freeze(element));
      }
      return Object.freeze(result);
    };
    const casters = section(value.casters, "caster", originals, validateCaster, freezeCaster); if (!casters) return null;
    const receivers = section(value.receivers, "receiver", originalReceivers, validateReceiver, freezeReceiver); if (!receivers) return null;
    const importedLights = section(value.lights, "light", originalLights, validateLight, freezeLight); if (!importedLights) return null;
    // Missing authored lamps need a tombstone, otherwise the painted building creates its automatic lamp again.
    const lightIds = new Set(importedLights.map(item => item.id));
    const lights = Object.freeze([...importedLights, ...baselineLights.filter(item => !lightIds.has(item.id)).map(item => freezeLight({ ...item, enabled: false }))]);
    const next = Object.freeze({ casters, receivers, lights }), metadata = dirtyMetadata(next);
    if (lights.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights || metadata.dirtyIds.length > WORLD_LIGHTING_EDITOR_LIMITS.maxCasters || metadata.dirtyReceiverIds.length > WORLD_LIGHTING_EDITOR_LIMITS.maxReceivers || metadata.dirtyLightIds.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights) {
      fail("Резервная копия содержит слишком много изменений относительно текущего проекта."); return null;
    }
    return next;
  };
  const removeLight = () => {
    if (!available) return;
    const source = state.selectedKind === "light" ? state.lights.find(light => light.id === state.selectedId) : undefined;
    if (!source) { fail("Сначала выберите источник света."); return; }
    if (originalLights.has(source.id)) editLight({ enabled: false });
    else applyGeometry({ ...geometry(), lights: Object.freeze(state.lights.filter(light => light.id !== source.id)) });
  };
  const restoredValues = <T extends { id: string }>(values: readonly T[], base: readonly T[], authored: T): readonly T[] => {
    const next = new Map(values.map(item => [item.id, item])); next.set(authored.id, authored);
    const baseIds = new Set(base.map(item => item.id));
    return Object.freeze([...base.flatMap(item => next.has(item.id) ? [next.get(item.id)!] : []), ...values.filter(item => !baseIds.has(item.id))]);
  };
  const validateProjectScene = (scene: FixedWorldScene): boolean => {
    if (!isRecord(scene) || scene.id !== original.id || scene.width !== original.width || scene.height !== original.height
      || !Array.isArray(scene.sites) || scene.shadowCasters !== undefined && !Array.isArray(scene.shadowCasters)
      || scene.shadowReceivers !== undefined && !Array.isArray(scene.shadowReceivers) || scene.lights !== undefined && !Array.isArray(scene.lights)) return fail("Данные проекта относятся к другой карте.");
    const casters = scene.shadowCasters ?? [], receivers = scene.shadowReceivers ?? [], lights = scene.lights ?? [];
    if (casters.length > WORLD_LIGHTING_EDITOR_LIMITS.maxCasters || receivers.length > WORLD_LIGHTING_EDITOR_LIMITS.maxReceivers || lights.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights) return fail("Проект превышает ограничения разметки света.");
    for (const [values, validate] of [[casters, validateCaster], [receivers, validateReceiver], [lights, validateLight]] as const) {
      const ids = new Set<string>();
      for (const item of values) {
        const error = validate(item, scene); if (error) return fail(error);
        if (ids.has(item.id)) return fail("Проект содержит повторяющийся ID объекта."); ids.add(item.id);
      }
    }
    return true;
  };
  const assignBaseline = (scene: FixedWorldScene) => {
    original = scene;
    baseline = Object.freeze((scene.shadowCasters ?? []).map(freezeCaster)); baselineReceivers = Object.freeze((scene.shadowReceivers ?? []).map(freezeReceiver)); baselineLights = Object.freeze((scene.lights ?? []).map(freezeLight));
    baselineGeometry = Object.freeze({ casters: baseline, receivers: baselineReceivers, lights: baselineLights });
    originals.clear(); baseline.forEach(item => originals.set(item.id, item)); originalReceivers.clear(); baselineReceivers.forEach(item => originalReceivers.set(item.id, item));
    originalLights.clear(); baselineLights.forEach(item => originalLights.set(item.id, item));
  };
  const baselineChanged = (previous: EditorGeometry) => {
    const casterChanged = !sameCasters(previous.casters, baseline), receiverChanged = !sameReceivers(previous.receivers, baselineReceivers);
    if (casterChanged || receiverChanged || !sameLights(previous.lights, baselineLights)) baselineRevision++;
    baselineCasterRevision += Number(casterChanged); baselineReceiverRevision += Number(receiverChanged);
  };
  const replaceProjectBaseline = (scene: FixedWorldScene, preserveDraft: boolean): boolean => {
    if (!available || !validateProjectScene(scene)) return false;
    if (hydrationConflict) return fail("Непрочитанный черновик сохранён. Сначала восстановите его из проекта или скачайте и явно сбросьте.");
    if (gesture) return fail("Дождитесь окончания перетаскивания перед обновлением сохранённого проекта.");
    const previousBaseline = baselineGeometry; assignBaseline(scene); baselineChanged(previousBaseline);
    baseline.forEach(item => knownCasterIds.add(item.id)); baselineReceivers.forEach(item => knownReceiverIds.add(item.id)); baselineLights.forEach(item => knownLightIds.add(item.id));
    if (!preserveDraft) {
      past.length = 0; future.length = 0;
      applyGeometry(baselineGeometry, false, false);
      publish({ canUndo: false, canRedo: false });
    }
    publish({ ...dirtyMetadata(geometry()), error: null, localSaveStatus: "pending" });
    persist(); return true;
  };
  const restoreProjectDraft = (scene: FixedWorldScene): "none" | "restored" | "conflict" => {
    if (!available || typeof window === "undefined") return "none";
    if (!validateProjectScene(scene)) return "conflict";
    let text: string | null = null;
    try {
      for (const key of [storageKey, ...oldStorageKeys]) { text = window.localStorage.getItem(key); if (text !== null) break; }
    } catch {
      const error = "Не удалось прочитать локальный черновик для восстановления проекта.";
      publish({ error, localSaveStatus: "error", localSaveError: error }); return "conflict";
    }
    if (text === null) return "none";
    if (gesture || state.canUndo || state.dirtyIds.length || state.dirtyReceiverIds.length || state.dirtyLightIds.length) {
      fail("Сохранены новые правки. Сначала сохраните или экспортируйте текущий черновик."); return "conflict";
    }
    const previous = original, previousBaseline = baselineGeometry;
    assignBaseline(scene);
    const applied = parsePatch(text, true), next = applied ? baselineGeometry : parsePatch(text);
    if (!next) { assignBaseline(previous); hydrationConflict = true; conflictedDraft = text; publish({ localSaveStatus: "error", localSaveError: state.error }); return "conflict"; }
    hydrationConflict = false; conflictedDraft = null;
    baselineChanged(previousBaseline);
    baseline.forEach(item => knownCasterIds.add(item.id)); baselineReceivers.forEach(item => knownReceiverIds.add(item.id)); baselineLights.forEach(item => knownLightIds.add(item.id));
    past.length = 0; future.length = 0; applyGeometry(next, false, false);
    publish({ ...dirtyMetadata(geometry()), canUndo: false, canRedo: false, error: null, localSaveStatus: "pending" });
    persist(); return "restored";
  };
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    getSceneBaseline: () => original,
    reconcileProjectBaseline: (scene: FixedWorldScene) => replaceProjectBaseline(scene, true),
    adoptProjectScene(scene: FixedWorldScene, options?: { discardConflictedDraft?: boolean }) {
      if (!available || !validateProjectScene(scene)) return false;
      if (gesture) return fail("Дождитесь окончания перетаскивания перед загрузкой сохранённого проекта.");
      if (options?.discardConflictedDraft === true) { hydrationConflict = false; conflictedDraft = null; }
      return replaceProjectBaseline(scene, false);
    },
    restoreProjectDraft,
    hasHydrationConflict: () => hydrationConflict,
    exportConflictedDraft: () => available ? conflictedDraft : null,
    setLightProjections(projections: readonly WorldLightingLightProjection[]) {
      if (!available || !Array.isArray(projections)) return;
      const known = new Set(state.lights.map(light => light.id)), accepted = new Map<string, WorldLightingLightProjection>();
      for (const projection of projections) {
        if (!isRecord(projection) || typeof projection.id !== "string" || !known.has(projection.id) || accepted.has(projection.id)
          || !isRecord(projection.position) || !finite(projection.position.x) || !finite(projection.position.y) || !finite(projection.height)) continue;
        accepted.set(projection.id, { id: projection.id, position: { x: projection.position.x, y: projection.position.y }, height: projection.height });
        if (accepted.size === WORLD_LIGHTING_EDITOR_LIMITS.maxLights) break;
      }
      if (accepted.size === state.lightProjections.length && state.lightProjections.every(projection => {
        const next = accepted.get(projection.id);
        return next && next.position.x === projection.position.x && next.position.y === projection.position.y && next.height === projection.height;
      })) return;
      publish({ lightProjections: Object.freeze([...accepted.values()].map(projection => Object.freeze({ ...projection, position: Object.freeze({ ...projection.position }) }))) });
    },
    subscribe(listener: () => void) {
      if (!available) return () => {};
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    setEnabled(enabled: boolean) {
      if (!available || typeof enabled !== "boolean") return;
      if (!enabled) commitGesture(); publish({ enabled, error: null });
    },
    select: (id: string | null, vertex: number | null = null) => selectPolygon("caster", id, vertex),
    selectReceiver: (id: string | null, vertex: number | null = null) => selectPolygon("receiver", id, vertex),
    selectLight(id: string | null) {
      if (!available) return;
      if (id !== null && !state.lights.some(light => light.id === id)) { fail("Источник света не найден."); return; }
      if (id !== state.selectedId || state.selectedKind !== "light") commitGesture();
      publish({ selectedKind: "light", selectedId: id, selectedVertex: null, error: null });
    },
    setElementMetadata(kind: WorldLightingElementKind, id: string, patch: WorldLightingElementMetadataPatch): boolean {
      if (!available) return false;
      if (!["caster", "receiver", "light"].includes(kind) || !isRecord(patch)
        || Object.keys(patch).some(key => key !== "studioName" && key !== "studioFolder")) return fail("Неизвестное свойство объекта студии.");
      const values = kind === "caster" ? state.casters : kind === "receiver" ? state.receivers : state.lights;
      const current = values.find(item => item.id === id);
      if (!current) return fail("Объект не найден в разметке света.");
      const next = { ...current };
      for (const key of ["studioName", "studioFolder"] as const) {
        if (!Object.hasOwn(patch, key)) continue;
        const value = patch[key];
        if (value !== null && typeof value !== "string") return fail("Название объекта и папка должны быть строками.");
        const trimmed = value?.trim();
        if (!trimmed) delete next[key]; else next[key] = trimmed;
      }
      const error = validateStudioMetadata(next); if (error) return fail(error);
      commitGesture();
      if (sameStudioMetadata(current, next)) { publish({ error: null }); return true; }
      if (kind === "caster") return applyGeometry({ ...geometry(), casters: Object.freeze(state.casters.map(item => item.id === id ? freezeCaster(next as WorldShadowCaster) : item)) });
      if (kind === "receiver") return applyGeometry({ ...geometry(), receivers: Object.freeze(state.receivers.map(item => item.id === id ? freezeReceiver(next as WorldShadowReceiver) : item)) });
      return applyGeometry({ ...geometry(), lights: Object.freeze(state.lights.map(item => item.id === id ? freezeLight(next as WorldLight) : item)) });
    },
    setTool(tool: WorldLightingEditorTool) {
      if (!available) return;
      if (!["select", "move", "vertex", "height", "light", "pan"].includes(tool)) { fail("Неизвестный инструмент."); return; }
      commitGesture(); publish({ tool, error: null });
    },
    setLightKind(lightKind: WorldLight["kind"]) {
      if (!available) return;
      if (!lightKinds.includes(lightKind)) { fail("Неизвестный вид источника."); return; }
      commitGesture(); publish({ lightKind, error: null });
    },
    setSnap(snap: number) {
      if (!available) return;
      if (![0, 1, 5, 10].includes(snap)) { fail("Шаг привязки должен быть 0, 1, 5 или 10."); return; }
      commitGesture(); publish({ snap, error: null });
    },
    setOverlay(overlay: WorldLightingEditorOverlay) {
      if (!available) return;
      if (!["all", "selected", "off"].includes(overlay)) { fail("Неизвестный режим контуров."); return; }
      publish({ overlay, error: null });
    },
    setShowCasters(showCasters: boolean) { if (typeof showCasters === "boolean") publish({ showCasters }); },
    setShowReceivers(showReceivers: boolean) { if (typeof showReceivers === "boolean") publish({ showReceivers }); },
    setShowWireframe(showWireframe: boolean) { if (typeof showWireframe === "boolean") publish({ showWireframe }); },
    setPreviewDraft(previewDraft: boolean) { if (available && typeof previewDraft === "boolean") { commitGesture(); publish({ previewDraft, error: null }); } },
    beginGesture() {
      if (available && !gesture) {
        gesture = geometry(); gestureSaveState = { localSaveStatus: state.localSaveStatus, localSavedAt: state.localSavedAt, localSaveError: state.localSaveError };
      }
    },
    isGesturing: () => available && gesture !== null,
    commitGesture,
    cancelGesture() {
      if (!available || !gesture) return;
      const previous = gesture, saveState = gestureSaveState; gesture = null; gestureSaveState = null; applyGeometry(previous, false, false);
      if (saveState) publish(saveState);
    },
    patchSelected(patch: CasterPatch) {
      if (!available) return;
      if (state.selectedKind !== "caster" || !isRecord(patch) || Object.keys(patch).some(key => !["baseHeight", "height", "opacity", "softness"].includes(key))) { fail("Неизвестное свойство объёма."); return; }
      editSelected(caster => ({ ...caster, ...patch }));
    },
    patchReceiver(patch: Partial<Pick<WorldShadowReceiver, "height">>) {
      if (!available) return;
      if (state.selectedKind !== "receiver" || !isRecord(patch) || Object.keys(patch).some(key => key !== "height")) { fail("Неизвестное свойство поверхности."); return; }
      editSelected(receiver => ({ ...receiver, ...patch }));
    },
    moveVertex(index: number, point: WorldPoint) {
      editSelected(polygon => {
        if (!validIndex(index, polygon)) { fail("Вершина контура не найдена."); return null; }
        return { ...polygon, points: polygon.points.map((previous, at) => at === index ? finite(point?.x) && finite(point?.y) ? snapped(point) : point : previous) };
      });
    },
    addVertex(index: number, point: WorldPoint) {
      editSelected(polygon => {
        if (!validIndex(index, polygon)) { fail("Ребро контура не найдено."); return null; }
        return { ...polygon, points: [...polygon.points.slice(0, index + 1), point, ...polygon.points.slice(index + 1)] };
      }, state.selectedVertex !== null && state.selectedVertex > index ? state.selectedVertex + 1 : state.selectedVertex);
    },
    deleteVertex(index: number) {
      editSelected(polygon => {
        if (!validIndex(index, polygon)) { fail("Вершина контура не найдена."); return null; }
        return { ...polygon, points: polygon.points.filter((_, at) => at !== index) };
      }, state.selectedVertex === index ? null : state.selectedVertex !== null && state.selectedVertex > index ? state.selectedVertex - 1 : state.selectedVertex);
    },
    patchLight: editLight,
    addLight(position: WorldPoint, kind: WorldLight["kind"]): string | null {
      if (!available) return null;
      if (!lightKinds.includes(kind) || !finite(position?.x) || !finite(position?.y)) { fail("Укажите вид источника и координаты внутри карты."); return null; }
      return createLight({ kind, position: snapped(position), ...WORLD_LIGHTING_LIGHT_PRESETS[kind], enabled: true, manualPosition: true });
    },
    addCaster: (position: WorldPoint) => createPolygon("caster", position),
    addReceiver: (position: WorldPoint) => createPolygon("receiver", position),
    duplicateLight(): string | null {
      if (!available) return null;
      const source = state.selectedKind === "light" ? state.lights.find(light => light.id === state.selectedId) : undefined;
      if (!source) { fail("Сначала выберите источник света."); return null; }
      const offset = state.snap || 10, effective = effectiveLight(source);
      return createLight({ ...source, position: { x: Math.min(original.width, effective.position.x + offset), y: Math.min(original.height, effective.position.y + offset) },
        ...(effective.height !== undefined ? { height: effective.height } : {}), enabled: true, manualPosition: true });
    },
    removeLight,
    removeSelected() {
      if (!available) return;
      commitGesture();
      if (state.selectedId === null) { fail("Сначала выберите объект."); return; }
      if (state.selectedKind === "light") removeLight();
      else if (state.selectedKind === "caster") applyGeometry({ ...geometry(), casters: Object.freeze(state.casters.filter(item => item.id !== state.selectedId)) });
      else applyGeometry({ ...geometry(), receivers: Object.freeze(state.receivers.filter(item => item.id !== state.selectedId)) });
    },
    restoreElement(kind: WorldLightingElementKind, id: string) {
      if (!available) return false;
      commitGesture();
      if (kind === "caster") {
        const authored = originals.get(id); if (!authored) return fail("Исходный объём не найден.");
        applyGeometry({ ...geometry(), casters: restoredValues(state.casters, baseline, authored) });
        if (!state.casters.some(item => item.id === id)) return false;
      } else if (kind === "receiver") {
        const authored = originalReceivers.get(id); if (!authored) return fail("Исходная поверхность не найдена.");
        applyGeometry({ ...geometry(), receivers: restoredValues(state.receivers, baselineReceivers, authored) });
        if (!state.receivers.some(item => item.id === id)) return false;
      } else if (kind === "light") {
        const authored = originalLights.get(id); if (!authored) return fail("Исходный источник не найден.");
        const restored = authored.enabled === false ? freezeLight({ ...authored, enabled: true }) : authored;
        applyGeometry({ ...geometry(), lights: restoredValues(state.lights, baselineLights, restored) });
        if (!state.lights.some(item => item.id === id)) return false;
      } else return fail("Неизвестный вид объекта.");
      publish({ selectedKind: kind, selectedId: id, selectedVertex: null, error: null }); return true;
    },
    moveSelectedBy(dx: number, dy: number) {
      if (!available) return;
      if (!finite(dx) || !finite(dy)) { fail("Смещение должно быть числовым."); return; }
      if (dx === 0 && dy === 0) return;
      if (state.selectedKind === "light") {
        const light = state.lights.find(light => light.id === state.selectedId);
        if (!light) { fail("Сначала выберите источник света."); return; }
        const effective = effectiveLight(light); editLight({ position: snapped({ x: effective.position.x + dx, y: effective.position.y + dy }) });
      } else editSelected(polygon => {
        const anchor = polygon.points[0], target = snapped({ x: anchor.x + dx, y: anchor.y + dy });
        return { ...polygon, points: polygon.points.map(point => ({ x: point.x + target.x - anchor.x, y: point.y + target.y - anchor.y })) };
      });
    },
    resetSelected() {
      if (!available) return;
      commitGesture(); const id = state.selectedId;
      if (id === null) { fail("Сначала выберите объект."); return; }
      if (state.selectedKind === "caster") {
        const authored = originals.get(id); applyGeometry({ ...geometry(), casters: Object.freeze(state.casters.flatMap(item => item.id === id ? authored ? [authored] : [] : [item])) });
      } else if (state.selectedKind === "receiver") {
        const authored = originalReceivers.get(id); applyGeometry({ ...geometry(), receivers: Object.freeze(state.receivers.flatMap(item => item.id === id ? authored ? [authored] : [] : [item])) });
      } else {
        const authored = originalLights.get(id); applyGeometry({ ...geometry(), lights: Object.freeze(state.lights.flatMap(item => item.id === id ? authored ? [authored] : [] : [item])) });
      }
    },
    resetAll() { if (available) { commitGesture(); hydrationConflict = false; conflictedDraft = null; if (!applyGeometry(baselineGeometry)) persist(); } },
    undo() {
      if (!available) return;
      commitGesture(); const previous = past.pop(); if (!previous) return;
      future.push(geometry());
      if (!applyGeometry(previous, false)) { future.pop(); past.push(previous); publish({ canUndo: past.length > 0, canRedo: future.length > 0 }); }
    },
    redo() {
      if (!available) return;
      commitGesture(); const next = future.pop(); if (!next) return;
      past.push(geometry());
      if (!applyGeometry(next, false)) { past.pop(); future.push(next); publish({ canUndo: past.length > 0, canRedo: future.length > 0 }); }
    },
    hydrate() {
      if (!available || hydrated || typeof window === "undefined") return;
      hydrated = true;
      try {
        let text: string | null = null, key = storageKey;
        for (const candidate of [storageKey, ...oldStorageKeys]) {
          text = window.localStorage.getItem(candidate); if (text !== null) { key = candidate; break; }
        }
        if (text === null) return;
        if (parsePatch(text, true)) { window.localStorage.removeItem(key); publish({ localSaveStatus: "saved", localSavedAt: Date.now(), localSaveError: null }); return; }
        const next = parsePatch(text);
        if (next) {
          applyGeometry(next, false, false); publish({ localSaveStatus: "saved", localSavedAt: Date.now(), localSaveError: null });
          if (key !== storageKey) persist();
        } else { hydrationConflict = true; conflictedDraft = text; publish({ localSaveStatus: "error", localSaveError: state.error }); }
      } catch {
        const error = "Не удалось прочитать черновик из браузера. Можно импортировать файл с правками.";
        publish({ localSaveStatus: "error", localSaveError: error, error });
      }
    },
    saveDraft() { if (!available) return false; commitGesture(); return persist(); },
    retryLocalSave() { if (!available) return false; commitGesture(); return persist(); },
    exportPatch,
    exportSceneBackup,
    importSceneBackup(text: string) {
      if (!available || typeof text !== "string") return false;
      const next = parseSceneBackup(text); if (!next) return false;
      hydrationConflict = false; conflictedDraft = null;
      commitGesture(); if (!applyGeometry(next)) persist(); return true;
    },
    importPatch(text: string) {
      if (!available || typeof text !== "string") return false;
      let backup = false;
      try { const value: unknown = JSON.parse(text); backup = isRecord(value) && value.type === "world-studio-backup"; } catch { /* The parser reports the malformed JSON. */ }
      const next = backup ? parseSceneBackup(text) : parsePatch(text); if (!next) return false;
      hydrationConflict = false; conflictedDraft = null;
      commitGesture(); if (!applyGeometry(next)) persist(); return true;
    },
    applyToScene(scene: FixedWorldScene, levels?: Readonly<Record<string, number>>): FixedWorldScene {
      if (!available || scene.id !== original.id) return scene;
      const current = state.previewDraft ? geometry() : baselineGeometry;
      const revision = state.previewDraft ? state.revision : baselineRevision;
      const casterRevision = state.previewDraft ? state.casterRevision : baselineCasterRevision, receiverRevision = state.previewDraft ? state.receiverRevision : baselineReceiverRevision;
      const cache = state.previewDraft ? sceneCache : baselineSceneCache;
      const conditionalSites = [...new Set([...current.casters, ...current.receivers].flatMap(item => item.when ? [item.when.siteId] : []))].sort();
      const visibilityKey = levels ? conditionalSites.map(id => `${id}:${levels[id]}`).join("|") : "all";
      const cached = cache.get(scene); if (cached?.revision === revision && cached.visibilityKey === visibilityKey) return cached.scene;
      const overlay = <T extends ShadowPolygon>(source: T[] | undefined, values: readonly T[], known: Set<string>, initialIds: Set<string>, same: (a: T | undefined, b: T | undefined) => boolean): T[] | undefined => {
        const edits = new Map(values.map(item => [item.id, item])), sourceIds = new Set((source ?? []).map(item => item.id));
        let changed = false;
        const result: T[] = [];
        for (const item of source ?? []) {
          if (!known.has(item.id)) { result.push(item); continue; }
          const edit = edits.get(item.id);
          if (edit && !sameCondition(edit.when, item.when)) { result.push(item); continue; }
          if (!same(edit, item)) changed = true;
          if (edit) result.push(edit);
        }
        for (const edit of values) {
          const visible = !edit.when || (levels ? levels[edit.when.siteId] === edit.when.level : scene === original || scene === originalScene);
          if (!sourceIds.has(edit.id) && !initialIds.has(edit.id) && visible) { result.push(edit); changed = true; }
        }
        return changed ? Object.freeze(result) as unknown as T[] : source;
      };
      const casters = cached?.casterRevision === casterRevision && cached.visibilityKey === visibilityKey ? cached.scene.shadowCasters
        : overlay(scene.shadowCasters, current.casters, knownCasterIds, initialCasterIds, sameCaster);
      const receivers = cached?.receiverRevision === receiverRevision && cached.visibilityKey === visibilityKey ? cached.scene.shadowReceivers
        : overlay(scene.shadowReceivers, current.receivers, knownReceiverIds, initialReceiverIds, sameReceiver);
      const currentLights = new Map(current.lights.map(light => [light.id, light])), sourceIds = new Set((scene.lights ?? []).map(light => light.id));
      let lightChanged = false;
      const lights: WorldLight[] = [];
      for (const light of scene.lights ?? []) {
        if (!knownLightIds.has(light.id)) { lights.push(light); continue; }
        const edit = currentLights.get(light.id); if (!sameLight(edit, light)) lightChanged = true;
        if (edit) lights.push(edit);
      }
      for (const edit of current.lights) {
        if (!sourceIds.has(edit.id)) { lights.push(edit); lightChanged = true; }
      }
      const result = casters !== scene.shadowCasters || receivers !== scene.shadowReceivers || lightChanged ? Object.freeze({ ...scene,
        ...(casters !== scene.shadowCasters ? { shadowCasters: casters } : {}), ...(receivers !== scene.shadowReceivers ? { shadowReceivers: receivers } : {}),
        ...(lightChanged ? { lights: Object.freeze(lights) as unknown as WorldLight[] } : {}) }) : scene;
      cache.set(scene, { revision, casterRevision, receiverRevision, visibilityKey, scene: result }); return result;
    },
  };
}

export const worldLightingEditorStore = retainWorldDevClientState("lighting-editor",
  `v3:2:${TILED_WORLD.id}:${TILED_WORLD.width}:${TILED_WORLD.height}`,
  () => createWorldLightingEditorStore(WORLD_DEV_ENABLED, TILED_WORLD)).value;
