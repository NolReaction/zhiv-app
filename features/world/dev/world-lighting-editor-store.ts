import { TILED_WORLD } from "@/features/world/scene/presentation";
import type { FixedWorldScene, WorldPoint, WorldShadowCaster } from "@/features/world/tiled/types";
import { WORLD_DEV_ENABLED } from "./world-dev-store";

export const WORLD_LIGHTING_EDITOR_LIMITS = Object.freeze({ vertices: 64, maxHeight: 300, maxTop: 400, maxSoftness: 12 });
export const WORLD_LIGHTING_EDITOR_CANCEL_EVENT = "world-lighting-editor:cancel";
export type WorldLightingEditorSnapshot = Readonly<{
  enabled: boolean;
  selectedId: string | null;
  selectedVertex: number | null;
  casters: readonly WorldShadowCaster[];
  dirtyIds: readonly string[];
  error: string | null;
  canUndo: boolean;
  canRedo: boolean;
  /** Changes only when lighting geometry changes; selection never invalidates shadow caches. */
  revision: number;
}>;
type CasterPatch = Partial<Pick<WorldShadowCaster, "baseHeight" | "height" | "opacity" | "softness">>;
type LightingPatch = { schemaVersion: 1; sceneId: string; casters: { id: string; before: WorldShadowCaster; after: WorldShadowCaster }[] };
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
  const originals = new Map(baseline.map(caster => [caster.id, caster]));
  const initial: WorldLightingEditorSnapshot = Object.freeze({ enabled: false, selectedId: null, selectedVertex: null,
    casters: baseline, dirtyIds: Object.freeze([]), error: null, canUndo: false, canRedo: false, revision: 0 });
  let state = initial;
  let gesture: readonly WorldShadowCaster[] | null = null;
  let hydrated = false;
  const past: (readonly WorldShadowCaster[])[] = [], future: (readonly WorldShadowCaster[])[] = [];
  const listeners = new Set<() => void>();
  const sceneCache = new WeakMap<FixedWorldScene, { revision: number; scene: FixedWorldScene }>();
  const storageKey = `zhiv:world-lighting-editor:v1:${original.id}`;
  const publish = (patch: Partial<WorldLightingEditorSnapshot>) => {
    if (!available || Object.entries(patch).every(([key, value]) => state[key as keyof WorldLightingEditorSnapshot] === value)) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
  };
  const fail = (error: string) => { publish({ error }); return false; };
  const dirtyIds = (casters: readonly WorldShadowCaster[]) => Object.freeze(casters.filter(caster => !sameCaster(caster, originals.get(caster.id)!)).map(caster => caster.id));
  const exportPatch = () => available ? JSON.stringify({ schemaVersion: 1, sceneId: original.id,
    casters: state.casters.filter(caster => state.dirtyIds.includes(caster.id)).map(caster => ({ id: caster.id, before: originals.get(caster.id)!, after: caster })),
  } satisfies LightingPatch, null, 2) : "";
  const persist = () => {
    if (!available || typeof window === "undefined") return;
    try {
      if (state.dirtyIds.length) window.localStorage.setItem(storageKey, exportPatch());
      else window.localStorage.removeItem(storageKey);
    } catch { fail("Не удалось сохранить черновик в браузере. Экспортируйте правки, чтобы сохранить их."); }
  };
  const recordHistory = (previous: readonly WorldShadowCaster[]) => {
    past.push(previous); if (past.length > 100) past.shift(); future.length = 0;
  };
  const applyCasters = (casters: readonly WorldShadowCaster[], record = true, save = true, vertex = state.selectedVertex) => {
    if (!available || sameCasters(casters, state.casters)) { publish({ error: null }); return false; }
    if (record && !gesture) recordHistory(state.casters);
    const selected = casters.find(caster => caster.id === state.selectedId);
    publish({ casters, dirtyIds: dirtyIds(casters), error: null, canUndo: past.length > 0, canRedo: future.length > 0,
      selectedVertex: selected && vertex !== null && vertex < selected.points.length ? vertex : null,
      revision: state.revision + 1 });
    if (save && !gesture) persist();
    return true;
  };
  const commitGesture = () => {
    if (!available || !gesture) return;
    const previous = gesture; gesture = null;
    if (!sameCasters(previous, state.casters)) { recordHistory(previous); publish({ canUndo: true, canRedo: false }); persist(); }
  };
  const editSelected = (edit: (caster: WorldShadowCaster) => WorldShadowCaster | null, vertex = state.selectedVertex) => {
    if (!available) return;
    const index = state.casters.findIndex(caster => caster.id === state.selectedId);
    if (index < 0) { fail("Сначала выберите объект."); return; }
    const next = edit(state.casters[index]);
    if (!next) return;
    const error = validateCaster(next, original);
    if (error) { fail(error); return; }
    if (!sameCondition(next.when, baseline[index].when) || next.id !== baseline[index].id) { fail("ID и уровень объекта изменять нельзя."); return; }
    const copy = [...state.casters]; copy[index] = sameCaster(next, baseline[index]) ? baseline[index] : freezeCaster(next);
    applyCasters(Object.freeze(copy), true, true, vertex);
  };
  const validIndex = (index: number, caster: WorldShadowCaster) => Number.isInteger(index) && index >= 0 && index < caster.points.length;
  // After applying an exported patch to Tiled, its exact after-values become the
  // new authoring baseline. Only that complete match may discard an old draft.
  const draftAlreadyApplied = (text: string) => {
    let value: unknown;
    try { value = JSON.parse(text); } catch { return false; }
    if (!isRecord(value) || Object.keys(value).some(key => !["schemaVersion", "sceneId", "casters"].includes(key))
      || value.schemaVersion !== 1 || value.sceneId !== original.id || !Array.isArray(value.casters) || !value.casters.length) return false;
    const ids = new Set<string>();
    return value.casters.every(entry => {
      if (!isRecord(entry) || Object.keys(entry).some(key => !["id", "before", "after"].includes(key)) || typeof entry.id !== "string"
        || ids.has(entry.id) || !originals.has(entry.id) || validateCaster(entry.before, original) || validateCaster(entry.after, original)) return false;
      ids.add(entry.id);
      const before = entry.before as WorldShadowCaster, after = entry.after as WorldShadowCaster, authored = originals.get(entry.id)!;
      return before.id === entry.id && sameCondition(before.when, authored.when) && sameCaster(after, authored);
    });
  };
  const parsePatch = (text: string): readonly WorldShadowCaster[] | null => {
    let value: unknown;
    try { value = JSON.parse(text); } catch { fail("Не удалось прочитать JSON с правками."); return null; }
    if (!isRecord(value) || Object.keys(value).some(key => !["schemaVersion", "sceneId", "casters"].includes(key))
      || value.schemaVersion !== 1 || value.sceneId !== original.id || !Array.isArray(value.casters)) { fail("Формат правок или ID карты не совпадает."); return null; }
    const replacements = new Map<string, WorldShadowCaster>();
    for (const entry of value.casters) {
      if (!isRecord(entry) || Object.keys(entry).some(key => !["id", "before", "after"].includes(key)) || typeof entry.id !== "string"
        || !originals.has(entry.id) || replacements.has(entry.id)) { fail("Правки содержат неизвестный или повторяющийся ID объекта."); return null; }
      const beforeError = validateCaster(entry.before, original), afterError = validateCaster(entry.after, original);
      if (beforeError || afterError) { fail(beforeError ?? afterError!); return null; }
      const before = entry.before as WorldShadowCaster, after = entry.after as WorldShadowCaster, authored = originals.get(entry.id)!;
      if (!sameCaster(before, authored)) { fail(`Исходная разметка «${entry.id}» изменилась. Правки не применены.`); return null; }
      if (after.id !== entry.id || !sameCondition(after.when, authored.when)) { fail("ID и условие уровня здания изменять нельзя."); return null; }
      replacements.set(entry.id, sameCaster(after, authored) ? authored : freezeCaster(after));
    }
    return Object.freeze(baseline.map(caster => replacements.get(caster.id) ?? caster));
  };
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
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
      if (id !== state.selectedId) commitGesture(); publish({ selectedId: id, selectedVertex: vertex, error: null });
    },
    beginGesture() { if (available && !gesture) gesture = state.casters; },
    commitGesture,
    cancelGesture() {
      if (!available || !gesture) return;
      const previous = gesture; gesture = null; applyCasters(previous, false, false);
    },
    patchSelected(patch: CasterPatch) {
      if (!available) return;
      if (!isRecord(patch) || Object.keys(patch).some(key => !["baseHeight", "height", "opacity", "softness"].includes(key))) { fail("Неизвестное свойство объёма."); return; }
      editSelected(caster => ({ ...caster, ...patch }));
    },
    moveVertex(index: number, point: WorldPoint) {
      editSelected(caster => {
        if (!validIndex(index, caster)) { fail("Вершина контура не найдена."); return null; }
        return { ...caster, points: caster.points.map((previous, at) => at === index ? point : previous) };
      });
    },
    /** Inserts after index, including the closing edge at the last index. */
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
    resetSelected() { if (available) { commitGesture(); editSelected(caster => originals.get(caster.id)!); } },
    resetAll() { if (available) { commitGesture(); if (!applyCasters(baseline)) persist(); } },
    undo() {
      if (!available) return;
      commitGesture(); const previous = past.pop(); if (!previous) return;
      future.push(state.casters); applyCasters(previous, false);
    },
    redo() {
      if (!available) return;
      commitGesture(); const next = future.pop(); if (!next) return;
      past.push(state.casters); applyCasters(next, false);
    },
    hydrate() {
      if (!available || hydrated || typeof window === "undefined") return;
      hydrated = true;
      try {
        const text = window.localStorage.getItem(storageKey);
        if (text === null) return;
        if (draftAlreadyApplied(text)) { window.localStorage.removeItem(storageKey); return; }
        const casters = parsePatch(text); if (casters) applyCasters(casters, false, false);
      } catch { fail("Не удалось прочитать черновик из браузера. Можно импортировать файл с правками."); }
    },
    exportPatch,
    importPatch(text: string) {
      if (!available || typeof text !== "string") return false;
      const casters = parsePatch(text); if (!casters) return false;
      commitGesture(); applyCasters(casters); return true;
    },
    applyToScene(scene: FixedWorldScene): FixedWorldScene {
      if (!available || scene.id !== original.id || !state.dirtyIds.length || !scene.shadowCasters?.length) return scene;
      const cached = sceneCache.get(scene); if (cached?.revision === state.revision) return cached.scene;
      const edits = new Map(state.casters.filter(caster => state.dirtyIds.includes(caster.id)).map(caster => [caster.id, caster]));
      let changed = false;
      const casters = scene.shadowCasters.map(caster => {
        const edit = edits.get(caster.id);
        if (!edit || !sameCondition(edit.when, caster.when) || sameCaster(edit, caster)) return caster;
        changed = true; return edit;
      });
      const result = changed ? Object.freeze({ ...scene, shadowCasters: Object.freeze(casters) as unknown as WorldShadowCaster[] }) : scene;
      sceneCache.set(scene, { revision: state.revision, scene: result }); return result;
    },
  };
}

export const worldLightingEditorStore = createWorldLightingEditorStore(WORLD_DEV_ENABLED, TILED_WORLD);
