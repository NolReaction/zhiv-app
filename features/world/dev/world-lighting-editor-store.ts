import { TILED_WORLD } from "@/features/world/scene/presentation";
import type { FixedWorldScene, WorldLight, WorldPoint, WorldShadowCaster } from "@/features/world/tiled/types";
import { WORLD_DEV_ENABLED } from "./world-dev-store";

export const WORLD_LIGHTING_EDITOR_LIMITS = Object.freeze({ vertices: 64, maxHeight: 300, maxTop: 400, maxSoftness: 12,
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
export type WorldLightingEditorSnapshot = Readonly<{
  enabled: boolean;
  selectedKind: "caster" | "light";
  selectedId: string | null;
  selectedVertex: number | null;
  casters: readonly WorldShadowCaster[];
  dirtyIds: readonly string[];
  lights: readonly WorldLight[];
  /** Actual rendered bulb coordinates and resolved height; view-only, never exported. */
  lightProjections: readonly WorldLightingLightProjection[];
  dirtyLightIds: readonly string[];
  tool: WorldLightingEditorTool;
  lightKind: WorldLight["kind"];
  snap: number;
  overlay: WorldLightingEditorOverlay;
  previewDraft: boolean;
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Changes only when lighting geometry changes; selection never invalidates shadow caches. */
  revision: number;
  casterRevision: number;
  lightRevision: number;
}>;
type CasterPatch = Partial<Pick<WorldShadowCaster, "baseHeight" | "height" | "opacity" | "softness">>;
type LightingPatch = { schemaVersion: 2; sceneId: string; casters: { id: string; before: WorldShadowCaster; after: WorldShadowCaster }[];
  lights: { id: string; before: WorldLight | null; after: WorldLight | null }[] };
type EditorGeometry = Readonly<{ casters: readonly WorldShadowCaster[]; lights: readonly WorldLight[] }>;
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const cross = (a: WorldPoint, b: WorldPoint, c: WorldPoint) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const sameCondition = (a: WorldShadowCaster["when"], b: WorldShadowCaster["when"]) => a?.siteId === b?.siteId && a?.level === b?.level;
const sameCaster = (a: WorldShadowCaster, b: WorldShadowCaster) => a.id === b.id && a.height === b.height
  && a.baseHeight === b.baseHeight && a.opacity === b.opacity && a.softness === b.softness && sameCondition(a.when, b.when)
  && a.points.length === b.points.length && a.points.every((point, index) => point.x === b.points[index].x && point.y === b.points[index].y);
const sameCasters = (a: readonly WorldShadowCaster[], b: readonly WorldShadowCaster[]) => a.length === b.length && a.every((caster, index) => sameCaster(caster, b[index]));
function freezeCaster(caster: WorldShadowCaster): WorldShadowCaster {
  return Object.freeze({ id: caster.id, points: Object.freeze(caster.points.map(point => Object.freeze({ x: point.x, y: point.y }))) as unknown as WorldPoint[],
    height: caster.height, baseHeight: caster.baseHeight, opacity: caster.opacity, softness: caster.softness,
    ...(caster.when ? { when: Object.freeze({ siteId: caster.when.siteId, level: caster.when.level }) } : {}) });
}
const sameLight = (a: WorldLight | undefined, b: WorldLight | undefined) => a === b || !!a && !!b && a.id === b.id
  && a.position.x === b.position.x && a.position.y === b.position.y && a.kind === b.kind && a.height === b.height
  && a.radius === b.radius && a.intensity === b.intensity && a.color.toLowerCase() === b.color.toLowerCase() && a.flicker === b.flicker
  && a.enabled === b.enabled && a.manualPosition === b.manualPosition;
const sameLights = (a: readonly WorldLight[], b: readonly WorldLight[]) => a.length === b.length && a.every((light, index) => sameLight(light, b[index]));
const sameGeometry = (a: EditorGeometry, b: EditorGeometry) => sameCasters(a.casters, b.casters) && sameLights(a.lights, b.lights);
function freezeLight(light: WorldLight): WorldLight {
  return Object.freeze({ id: light.id, position: Object.freeze({ x: light.position.x, y: light.position.y }), kind: light.kind,
    radius: light.radius, intensity: light.intensity, color: light.color.toLowerCase(), flicker: light.flicker,
    ...(light.height !== undefined ? { height: light.height } : {}),
    ...(light.enabled !== undefined ? { enabled: light.enabled } : {}),
    ...(light.manualPosition !== undefined ? { manualPosition: light.manualPosition } : {}) });
}
const lightKinds: readonly WorldLight["kind"][] = ["lantern", "torch", "glow"];
function validateLight(value: unknown, scene: FixedWorldScene): string | null {
  if (!isRecord(value) || Object.keys(value).some(key => !["id", "position", "kind", "height", "radius", "intensity", "color", "flicker", "enabled", "manualPosition"].includes(key))
    || typeof value.id !== "string" || !value.id.trim() || value.id.length > 128 || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value.id) || !lightKinds.some(kind => kind === value.kind)) return "Некорректные данные источника света.";
  if (!isRecord(value.position) || Object.keys(value.position).some(key => key !== "x" && key !== "y") || !finite(value.position.x) || !finite(value.position.y)
    || value.position.x < 0 || value.position.x > scene.width || value.position.y < 0 || value.position.y > scene.height) return "Источник света должен находиться внутри карты.";
  if (value.height !== undefined && (!finite(value.height) || value.height < 1 || value.height > WORLD_LIGHTING_EDITOR_LIMITS.maxLightHeight)) return "Высота источника должна быть от 1 до 200.";
  if (!finite(value.radius) || value.radius <= 0 || value.radius > WORLD_LIGHTING_EDITOR_LIMITS.maxLightRadius) return "Радиус света должен быть больше 0 и не больше 500.";
  if (!finite(value.intensity) || value.intensity < 0 || value.intensity > WORLD_LIGHTING_EDITOR_LIMITS.maxLightIntensity) return "Яркость должна быть от 0 до 2.";
  if (!finite(value.flicker) || value.flicker < 0 || value.flicker > WORLD_LIGHTING_EDITOR_LIMITS.maxLightFlicker) return "Мерцание должно быть от 0 до 1.";
  if (typeof value.color !== "string" || !/^#[0-9a-f]{6}$/i.test(value.color)) return "Цвет должен иметь формат #rrggbb.";
  if (value.enabled !== undefined && typeof value.enabled !== "boolean" || value.manualPosition !== undefined && typeof value.manualPosition !== "boolean") return "Признаки источника должны быть логическими значениями.";
  return null;
}
function segmentsIntersect(a: WorldPoint, b: WorldPoint, c: WorldPoint, d: WorldPoint) {
  const epsilon = 1e-9;
  const signs = [cross(a, b, c), cross(a, b, d), cross(c, d, a), cross(c, d, b)].map(value => Math.abs(value) < epsilon ? 0 : Math.sign(value));
  const on = (p: WorldPoint, q: WorldPoint, r: WorldPoint) => r.x >= Math.min(p.x, q.x) - epsilon && r.x <= Math.max(p.x, q.x) + epsilon
    && r.y >= Math.min(p.y, q.y) - epsilon && r.y <= Math.max(p.y, q.y) + epsilon;
  return signs[0] * signs[1] < 0 && signs[2] * signs[3] < 0
    || !signs[0] && on(a, b, c) || !signs[1] && on(a, b, d) || !signs[2] && on(c, d, a) || !signs[3] && on(c, d, b);
}
function validateCaster(value: unknown, scene: FixedWorldScene): string | null {
  if (!isRecord(value) || Object.keys(value).some(key => !["id", "points", "height", "baseHeight", "opacity", "softness", "when"].includes(key))
    || typeof value.id !== "string" || !Array.isArray(value.points)) return "Некорректные данные объёма.";
  const points: WorldPoint[] = [];
  for (const point of value.points) {
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
  if (!finite(value.height) || value.height <= 0 || value.height > WORLD_LIGHTING_EDITOR_LIMITS.maxHeight) return "Высота должна быть больше 0 и не больше 300.";
  if (!finite(value.baseHeight) || value.baseHeight < 0 || value.baseHeight + value.height > WORLD_LIGHTING_EDITOR_LIMITS.maxTop) return "Основание должно быть не ниже 0, а верх объёма — не выше 400.";
  if (!finite(value.opacity) || value.opacity < 0 || value.opacity > 1) return "Непрозрачность должна быть от 0 до 1.";
  if (!finite(value.softness) || value.softness < 0 || value.softness > WORLD_LIGHTING_EDITOR_LIMITS.maxSoftness) return "Мягкость должна быть от 0 до 12.";
  if (value.when !== undefined && (!isRecord(value.when) || Object.keys(value.when).some(key => key !== "siteId" && key !== "level")
    || typeof value.when.siteId !== "string" || !Number.isInteger(value.when.level))) return "Некорректное условие уровня здания.";
  return null;
}

/** Isolated DEV drafts. The authored scene and player state remain immutable. */
export function createWorldLightingEditorStore(available: boolean, original: FixedWorldScene) {
  const baseline = Object.freeze((original.shadowCasters ?? []).map(freezeCaster));
  const baselineLights = Object.freeze((original.lights ?? []).map(freezeLight));
  const baselineGeometry: EditorGeometry = Object.freeze({ casters: baseline, lights: baselineLights });
  const originals = new Map(baseline.map(caster => [caster.id, caster]));
  const originalLights = new Map(baselineLights.map(light => [light.id, light]));
  const initial: WorldLightingEditorSnapshot = Object.freeze({ enabled: false, selectedKind: "caster", selectedId: null, selectedVertex: null,
    casters: baseline, lights: baselineLights, lightProjections: Object.freeze([]), dirtyIds: Object.freeze([]), dirtyLightIds: Object.freeze([]),
    tool: "select", lightKind: "lantern", snap: 0, overlay: "all", previewDraft: true,
    error: null, canUndo: false, canRedo: false, revision: 0, casterRevision: 0, lightRevision: 0 });
  let state = initial, hydrated = false, lightSequence = 0;
  let gesture: EditorGeometry | null = null;
  const past: EditorGeometry[] = [], future: EditorGeometry[] = [];
  const listeners = new Set<() => void>();
  const sceneCache = new WeakMap<FixedWorldScene, { revision: number; casterRevision: number; scene: FixedWorldScene }>();
  const storageKey = `zhiv:world-lighting-editor:v2:${original.id}`, oldStorageKey = `zhiv:world-lighting-editor:v1:${original.id}`;
  const geometry = (): EditorGeometry => ({ casters: state.casters, lights: state.lights });
  const publish = (patch: Partial<WorldLightingEditorSnapshot>) => {
    if (!available || Object.entries(patch).every(([key, value]) => state[key as keyof WorldLightingEditorSnapshot] === value)) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
  };
  const fail = (error: string) => { publish({ error }); return false; };
  const dirtyIds = (casters: readonly WorldShadowCaster[]) => Object.freeze(casters.filter(caster => !sameCaster(caster, originals.get(caster.id)!)).map(caster => caster.id));
  const dirtyLightIds = (lights: readonly WorldLight[]) => {
    const current = new Map(lights.map(light => [light.id, light]));
    return Object.freeze([...new Set([...baselineLights.map(light => light.id), ...lights.map(light => light.id)])]
      .filter(id => !sameLight(originalLights.get(id), current.get(id))));
  };
  const exportPatch = () => available ? JSON.stringify({ schemaVersion: 2, sceneId: original.id,
    casters: state.casters.filter(caster => state.dirtyIds.includes(caster.id)).map(caster => ({ id: caster.id, before: originals.get(caster.id)!, after: caster })),
    lights: state.dirtyLightIds.map(id => ({ id, before: originalLights.get(id) ?? null, after: state.lights.find(light => light.id === id) ?? null })),
  } satisfies LightingPatch, null, 2) : "";
  const persist = () => {
    if (!available || typeof window === "undefined") return;
    try {
      if (state.dirtyIds.length || state.dirtyLightIds.length) window.localStorage.setItem(storageKey, exportPatch());
      else window.localStorage.removeItem(storageKey);
      if (window.localStorage.getItem(oldStorageKey) !== null) window.localStorage.removeItem(oldStorageKey);
    } catch { fail("Не удалось сохранить черновик в браузере. Экспортируйте правки, чтобы сохранить их."); }
  };
  const recordHistory = (previous: EditorGeometry) => {
    past.push(previous); if (past.length > 100) past.shift(); future.length = 0;
  };
  const applyGeometry = (next: EditorGeometry, record = true, save = true, vertex = state.selectedVertex) => {
    const casterChanged = !sameCasters(next.casters, state.casters), lightChanged = !sameLights(next.lights, state.lights);
    if (!available || !casterChanged && !lightChanged) { publish({ error: null }); return false; }
    const nextDirtyLightIds = lightChanged ? dirtyLightIds(next.lights) : state.dirtyLightIds;
    if (nextDirtyLightIds.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights) {
      fail("В черновике поддерживается не больше 128 изменений источников. Сначала примените текущие правки к карте."); return false;
    }
    if (record && !gesture) recordHistory(geometry());
    const selected = next.casters.find(caster => caster.id === state.selectedId);
    const selectedId = state.selectedKind === "light" && !next.lights.some(light => light.id === state.selectedId) ? null : state.selectedId;
    publish({ casters: casterChanged ? next.casters : state.casters, lights: lightChanged ? next.lights : state.lights,
      dirtyIds: casterChanged ? dirtyIds(next.casters) : state.dirtyIds, dirtyLightIds: nextDirtyLightIds,
      error: null, canUndo: past.length > 0, canRedo: future.length > 0, selectedId,
      selectedVertex: state.selectedKind === "caster" && selected && vertex !== null && vertex < selected.points.length ? vertex : null,
      revision: state.revision + 1, casterRevision: state.casterRevision + Number(casterChanged), lightRevision: state.lightRevision + Number(lightChanged) });
    if (save && !gesture) persist();
    return true;
  };
  const commitGesture = () => {
    if (!available || !gesture) return;
    const previous = gesture; gesture = null;
    if (!sameGeometry(previous, geometry())) { recordHistory(previous); publish({ canUndo: true, canRedo: false }); persist(); }
  };
  const editSelected = (edit: (caster: WorldShadowCaster) => WorldShadowCaster | null, vertex = state.selectedVertex) => {
    if (!available) return;
    const index = state.selectedKind === "caster" ? state.casters.findIndex(caster => caster.id === state.selectedId) : -1;
    if (index < 0) { fail("Сначала выберите объект."); return; }
    const next = edit(state.casters[index]); if (!next) return;
    const error = validateCaster(next, original); if (error) { fail(error); return; }
    if (!sameCondition(next.when, baseline[index].when) || next.id !== baseline[index].id) { fail("ID и уровень объекта изменять нельзя."); return; }
    const copy = [...state.casters]; copy[index] = sameCaster(next, baseline[index]) ? baseline[index] : freezeCaster(next);
    applyGeometry({ casters: Object.freeze(copy), lights: state.lights }, true, true, vertex);
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
    applyGeometry({ casters: state.casters, lights: Object.freeze(copy) });
  };
  const snapCoordinate = (value: number) => state.snap ? Math.round(value / state.snap) * state.snap : value;
  const snapped = (point: WorldPoint): WorldPoint => ({ x: snapCoordinate(point.x), y: snapCoordinate(point.y) });
  const validIndex = (index: number, caster: WorldShadowCaster) => Number.isInteger(index) && index >= 0 && index < caster.points.length;
  const createLight = (light: Omit<WorldLight, "id">): string | null => {
    if (!available) return null;
    if (state.lights.length >= WORLD_LIGHTING_EDITOR_LIMITS.maxLights) { fail("На карте может быть не больше 128 источников света."); return null; }
    let id: string;
    do { id = `studio-light-${++lightSequence}`; } while (originalLights.has(id) || state.lights.some(light => light.id === id) || originals.has(id));
    const next = { ...light, id }, error = validateLight(next, original);
    if (error) { fail(error); return null; }
    if (!applyGeometry({ casters: state.casters, lights: Object.freeze([...state.lights, freezeLight(next)]) })) return null;
    publish({ selectedKind: "light", selectedId: id, selectedVertex: null, error: null }); return id;
  };
  const parsePatch = (text: string, alreadyApplied = false): EditorGeometry | null => {
    const reject = (error: string) => { if (!alreadyApplied) fail(error); return null; };
    let value: unknown;
    try { value = JSON.parse(text); } catch { return reject("Не удалось прочитать JSON с правками."); }
    if (!isRecord(value) || value.schemaVersion !== 1 && value.schemaVersion !== 2
      || Object.keys(value).some(key => !["schemaVersion", "sceneId", "casters", ...(value.schemaVersion === 2 ? ["lights"] : [])].includes(key))
      || value.sceneId !== original.id || !Array.isArray(value.casters) || value.casters.length > 128
      || value.schemaVersion === 2 && (!Array.isArray(value.lights) || value.lights.length > 128)) return reject("Формат правок или ID карты не совпадает.");
    const replacements = new Map<string, WorldShadowCaster>();
    for (const entry of value.casters) {
      if (!isRecord(entry) || Object.keys(entry).some(key => !["id", "before", "after"].includes(key)) || typeof entry.id !== "string"
        || !originals.has(entry.id) || replacements.has(entry.id)) return reject("Правки содержат неизвестный или повторяющийся ID объекта.");
      const beforeError = validateCaster(entry.before, original), afterError = validateCaster(entry.after, original);
      if (beforeError || afterError) return reject(beforeError ?? afterError!);
      const before = entry.before as WorldShadowCaster, after = entry.after as WorldShadowCaster, authored = originals.get(entry.id)!;
      if (before.id !== entry.id || !sameCondition(before.when, authored.when) || after.id !== entry.id || !sameCondition(after.when, authored.when)) return reject("ID и условие уровня здания изменять нельзя.");
      if (alreadyApplied ? !sameCaster(after, authored) : !sameCaster(before, authored)) return reject(`Исходная разметка «${entry.id}» изменилась. Правки не применены.`);
      replacements.set(entry.id, sameCaster(after, authored) ? authored : freezeCaster(after));
    }
    const lightReplacements = new Map<string, WorldLight | null>();
    for (const entry of value.schemaVersion === 2 ? value.lights as unknown[] : []) {
      if (!isRecord(entry) || Object.keys(entry).some(key => !["id", "before", "after"].includes(key)) || typeof entry.id !== "string" || lightReplacements.has(entry.id)
        || entry.before === null && entry.after === null) return reject("Правки содержат некорректный или повторяющийся источник света.");
      const beforeError = entry.before === null ? null : validateLight(entry.before, original), afterError = entry.after === null ? null : validateLight(entry.after, original);
      if (beforeError || afterError) return reject(beforeError ?? afterError!);
      const before = entry.before as WorldLight | null, after = entry.after as WorldLight | null, authored = originalLights.get(entry.id);
      if (before && before.id !== entry.id || after && after.id !== entry.id) return reject("ID источника света изменять нельзя.");
      if (alreadyApplied ? !sameLight(after ?? undefined, authored) : !sameLight(before ?? undefined, authored)) return reject(`Исходный источник «${entry.id}» изменился. Правки не применены.`);
      lightReplacements.set(entry.id, after ? authored && sameLight(after, authored) ? authored : freezeLight(after) : null);
    }
    const lights = baselineLights.filter(light => lightReplacements.get(light.id) !== null).map(light => lightReplacements.get(light.id) ?? light);
    for (const [id, light] of lightReplacements) if (!originalLights.has(id) && light) lights.push(light);
    if (lights.length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights) return reject("На карте может быть не больше 128 источников света.");
    if (dirtyLightIds(lights).length > WORLD_LIGHTING_EDITOR_LIMITS.maxLights) return reject("В черновике поддерживается не больше 128 изменений источников.");
    return Object.freeze({ casters: Object.freeze(baseline.map(caster => replacements.get(caster.id) ?? caster)), lights: Object.freeze(lights) });
  };
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
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
      publish({ lightProjections: Object.freeze([...accepted.values()].map(projection => Object.freeze({ ...projection,
        position: Object.freeze({ ...projection.position }) }))) });
    },
    subscribe(listener: () => void) {
      if (!available) return () => {};
      listeners.add(listener); return () => { listeners.delete(listener); };
    },
    setEnabled(enabled: boolean) {
      if (!available || typeof enabled !== "boolean") return;
      if (!enabled) commitGesture(); publish({ enabled, error: null });
    },
    select(id: string | null, vertex: number | null = null) {
      if (!available) return;
      const caster = state.casters.find(caster => caster.id === id);
      if (id !== null && !caster) { fail("Объект не найден в разметке света."); return; }
      if (vertex !== null && (!caster || !validIndex(vertex, caster))) { fail("Вершина контура не найдена."); return; }
      if (id !== state.selectedId || state.selectedKind !== "caster") commitGesture();
      publish({ selectedKind: "caster", selectedId: id, selectedVertex: vertex, error: null });
    },
    selectLight(id: string | null) {
      if (!available) return;
      if (id !== null && !state.lights.some(light => light.id === id)) { fail("Источник света не найден."); return; }
      if (id !== state.selectedId || state.selectedKind !== "light") commitGesture();
      publish({ selectedKind: "light", selectedId: id, selectedVertex: null, error: null });
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
    setPreviewDraft(previewDraft: boolean) { if (available && typeof previewDraft === "boolean") { commitGesture(); publish({ previewDraft, error: null }); } },
    beginGesture() { if (available && !gesture) gesture = geometry(); },
    isGesturing: () => available && gesture !== null,
    commitGesture,
    cancelGesture() {
      if (!available || !gesture) return;
      const previous = gesture; gesture = null; applyGeometry(previous, false, false);
    },
    patchSelected(patch: CasterPatch) {
      if (!available) return;
      if (!isRecord(patch) || Object.keys(patch).some(key => !["baseHeight", "height", "opacity", "softness"].includes(key))) { fail("Неизвестное свойство объёма."); return; }
      editSelected(caster => ({ ...caster, ...patch }));
    },
    moveVertex(index: number, point: WorldPoint) {
      editSelected(caster => {
        if (!validIndex(index, caster)) { fail("Вершина контура не найдена."); return null; }
        return { ...caster, points: caster.points.map((previous, at) => at === index ? finite(point?.x) && finite(point?.y) ? snapped(point) : point : previous) };
      });
    },
    addVertex(index: number, point: WorldPoint) {
      editSelected(caster => {
        if (!validIndex(index, caster)) { fail("Ребро контура не найдено."); return null; }
        return { ...caster, points: [...caster.points.slice(0, index + 1), point, ...caster.points.slice(index + 1)] };
      }, state.selectedVertex !== null && state.selectedVertex > index ? state.selectedVertex + 1 : state.selectedVertex);
    },
    deleteVertex(index: number) {
      editSelected(caster => {
        if (!validIndex(index, caster)) { fail("Вершина контура не найдена."); return null; }
        return { ...caster, points: caster.points.filter((_, at) => at !== index) };
      }, state.selectedVertex === index ? null : state.selectedVertex !== null && state.selectedVertex > index ? state.selectedVertex - 1 : state.selectedVertex);
    },
    patchLight: editLight,
    addLight(position: WorldPoint, kind: WorldLight["kind"]): string | null {
      if (!available) return null;
      if (!lightKinds.includes(kind) || !finite(position?.x) || !finite(position?.y)) { fail("Укажите вид источника и координаты внутри карты."); return null; }
      return createLight({ kind, position: snapped(position), ...WORLD_LIGHTING_LIGHT_PRESETS[kind], enabled: true, manualPosition: true });
    },
    duplicateLight(): string | null {
      if (!available) return null;
      const source = state.selectedKind === "light" ? state.lights.find(light => light.id === state.selectedId) : undefined;
      if (!source) { fail("Сначала выберите источник света."); return null; }
      const offset = state.snap || 10;
      const effective = effectiveLight(source);
      return createLight({ ...source, position: { x: Math.min(original.width, effective.position.x + offset), y: Math.min(original.height, effective.position.y + offset) },
        ...(effective.height !== undefined ? { height: effective.height } : {}), enabled: true, manualPosition: true });
    },
    removeLight() {
      if (!available) return;
      const source = state.selectedKind === "light" ? state.lights.find(light => light.id === state.selectedId) : undefined;
      if (!source) { fail("Сначала выберите источник света."); return; }
      if (originalLights.has(source.id)) editLight({ enabled: false });
      else applyGeometry({ casters: state.casters, lights: Object.freeze(state.lights.filter(light => light.id !== source.id)) });
    },
    moveSelectedBy(dx: number, dy: number) {
      if (!available) return;
      if (!finite(dx) || !finite(dy)) { fail("Смещение должно быть числовым."); return; }
      if (dx === 0 && dy === 0) return;
      if (state.selectedKind === "light") {
        const light = state.lights.find(light => light.id === state.selectedId);
        if (!light) { fail("Сначала выберите источник света."); return; }
        const effective = effectiveLight(light);
        editLight({ position: snapped({ x: effective.position.x + dx, y: effective.position.y + dy }) });
      } else editSelected(caster => {
        const anchor = caster.points[0], target = snapped({ x: anchor.x + dx, y: anchor.y + dy });
        return { ...caster, points: caster.points.map(point => ({ x: point.x + target.x - anchor.x, y: point.y + target.y - anchor.y })) };
      });
    },
    resetSelected() {
      if (!available) return;
      commitGesture();
      if (state.selectedKind === "caster") editSelected(caster => originals.get(caster.id)!);
      else {
        const id = state.selectedId;
        if (id === null) { fail("Сначала выберите источник света."); return; }
        const authored = originalLights.get(id);
        applyGeometry({ casters: state.casters, lights: Object.freeze(state.lights.flatMap(light => light.id === id ? authored ? [authored] : [] : [light])) });
      }
    },
    resetAll() { if (available) { commitGesture(); if (!applyGeometry(baselineGeometry)) persist(); } },
    undo() {
      if (!available) return;
      commitGesture(); const previous = past.pop(); if (!previous) return;
      future.push(geometry()); applyGeometry(previous, false);
    },
    redo() {
      if (!available) return;
      commitGesture(); const next = future.pop(); if (!next) return;
      past.push(geometry()); applyGeometry(next, false);
    },
    hydrate() {
      if (!available || hydrated || typeof window === "undefined") return;
      hydrated = true;
      try {
        const latest = window.localStorage.getItem(storageKey), key = latest === null ? oldStorageKey : storageKey;
        const text = latest ?? window.localStorage.getItem(oldStorageKey); if (text === null) return;
        if (parsePatch(text, true)) { window.localStorage.removeItem(key); return; }
        const next = parsePatch(text); if (next) applyGeometry(next, false, false);
      } catch { fail("Не удалось прочитать черновик из браузера. Можно импортировать файл с правками."); }
    },
    exportPatch,
    importPatch(text: string) {
      if (!available || typeof text !== "string") return false;
      const next = parsePatch(text); if (!next) return false;
      commitGesture(); applyGeometry(next); return true;
    },
    applyToScene(scene: FixedWorldScene): FixedWorldScene {
      if (!available || !state.previewDraft || scene.id !== original.id || !state.dirtyIds.length && !state.dirtyLightIds.length) return scene;
      const cached = sceneCache.get(scene); if (cached?.revision === state.revision) return cached.scene;
      const edits = new Map(state.casters.filter(caster => state.dirtyIds.includes(caster.id)).map(caster => [caster.id, caster]));
      const reuseCasters = cached?.casterRevision === state.casterRevision;
      let casterChanged = reuseCasters && cached.scene.shadowCasters !== scene.shadowCasters, lightChanged = false;
      const casters = reuseCasters ? cached.scene.shadowCasters : edits.size ? scene.shadowCasters?.map(caster => {
        const edit = edits.get(caster.id);
        if (!edit || !sameCondition(edit.when, caster.when) || sameCaster(edit, caster)) return caster;
        casterChanged = true; return edit;
      }) : scene.shadowCasters;
      const currentLights = new Map(state.lights.map(light => [light.id, light]));
      const sourceIds = new Set((scene.lights ?? []).map(light => light.id));
      const lights: WorldLight[] = [];
      for (const light of scene.lights ?? []) {
        if (!state.dirtyLightIds.includes(light.id)) { lights.push(light); continue; }
        const edit = currentLights.get(light.id);
        if (!sameLight(edit, light)) lightChanged = true;
        if (edit) lights.push(edit);
      }
      for (const id of state.dirtyLightIds) {
        const edit = currentLights.get(id);
        if (!sourceIds.has(id) && !originalLights.has(id) && edit) { lights.push(edit); lightChanged = true; }
      }
      const result = casterChanged || lightChanged ? Object.freeze({ ...scene,
        ...(casterChanged ? { shadowCasters: Object.freeze(casters!) as unknown as WorldShadowCaster[] } : {}),
        ...(lightChanged ? { lights: Object.freeze(lights) as unknown as WorldLight[] } : {}) }) : scene;
      sceneCache.set(scene, { revision: state.revision, casterRevision: state.casterRevision, scene: result }); return result;
    },
  };
}

export const worldLightingEditorStore = createWorldLightingEditorStore(WORLD_DEV_ENABLED, TILED_WORLD);
