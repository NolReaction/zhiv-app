"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { FixedWorldScene, WorldLight, WorldShadowCaster, WorldShadowReceiver } from "@/features/world/tiled/types";
import { WORLD_DEV_ENABLED } from "./world-dev-store";
import { worldLightingEditorStore } from "./world-lighting-editor-store";
import { retainWorldDevClientState } from "./world-dev-hmr-cache";
import { subscribeWorldLightingRefresh } from "@/features/world/scene/lighting-refresh";

export type WorldStudioProjectSaveSnapshot = Readonly<{
  status: "probing" | "unavailable" | "ready" | "saving" | "saved" | "error" | "conflict";
  available: boolean;
  paused: boolean;
  savedAt: number | null;
  error: string | null;
  revision: string | null;
  pending: boolean;
}>;
type Draft = { casters: readonly WorldShadowCaster[]; receivers: readonly WorldShadowReceiver[]; lights: readonly WorldLight[] };
type Editor = {
  getSnapshot(): Draft;
  getSceneBaseline(): FixedWorldScene;
  subscribe(listener: () => void): () => void;
  hydrate(): void;
  isGesturing(): boolean;
  saveDraft(): boolean;
  reconcileProjectBaseline(scene: FixedWorldScene): boolean;
  adoptProjectScene(scene: FixedWorldScene, options?: { discardConflictedDraft?: boolean }): boolean;
  hasHydrationConflict(): boolean;
  restoreProjectDraft(scene: FixedWorldScene): "none" | "restored" | "conflict";
};
type Edit<T> = { id: string; before: T | null; after: T | null };
type Patch = { schemaVersion: 3; sceneId: string; casters: Edit<WorldShadowCaster>[]; receivers: Edit<WorldShadowReceiver>[]; lights: Edit<WorldLight>[] };
type Disk = { available: true; revision: string; scene: FixedWorldScene };
type SaveRequest = { requestId: string; expectedRevision: string; patch: Patch };
const endpoint = "/api/dev/world-studio";
let fallbackSequence = 0;
/** randomUUID is absent on ordinary HTTP LAN pages; getRandomValues still works. */
export function createWorldStudioRequestId() {
  if (typeof globalThis.crypto?.randomUUID === "function") return globalThis.crypto.randomUUID();
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
    return `studio-${Array.from(bytes, value => value.toString(16).padStart(2, "0")).join("")}`;
  }
  return `studio-${Date.now().toString(36)}-${++fallbackSequence}-${Math.random().toString(36).slice(2, 14)}`;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
const sceneDraft = (scene: FixedWorldScene): Draft => ({ casters: scene.shadowCasters ?? [], receivers: scene.shadowReceivers ?? [], lights: scene.lights ?? [] });
const fingerprint = (draft: Draft) => canonical({ casters: [...draft.casters].sort((a, b) => a.id.localeCompare(b.id)),
  receivers: [...draft.receivers].sort((a, b) => a.id.localeCompare(b.id)), lights: [...draft.lights].sort((a, b) => a.id.localeCompare(b.id)) });
const equal = (a: unknown, b: unknown) => canonical(a) === canonical(b);
type PolygonPoints = readonly { x: number; y: number }[];
const samePoints = (a: PolygonPoints, b: PolygonPoints) => a.length === b.length
  && a.every((point, index) => Math.abs(point.x - b[index].x) <= 1e-9 && Math.abs(point.y - b[index].y) <= 1e-9);
function sameItem(a: { id: string; points?: PolygonPoints; holes?: readonly PolygonPoints[] } | null, b: typeof a) {
  if (!a || !b) return a === b;
  if (!a.points || !b.points) return equal(a, b);
  const leftHoles = a.holes ?? [], rightHoles = b.holes ?? [];
  return equal({ ...a, points: undefined, holes: undefined }, { ...b, points: undefined, holes: undefined })
    && samePoints(a.points, b.points) && leftHoles.length === rightHoles.length
    && leftHoles.every((ring, index) => samePoints(ring, rightHoles[index]));
}
function sameDraft(a: Draft, b: Draft) {
  return (["casters", "receivers", "lights"] as const).every(key => {
    if (a[key].length !== b[key].length) return false;
    const current = new Map<string, WorldShadowCaster | WorldShadowReceiver | WorldLight>(b[key].map(item => [item.id, item]));
    return a[key].every(item => sameItem(item, current.get(item.id) ?? null));
  });
}
function edits<T extends { id: string }>(before: readonly T[], after: readonly T[]): Edit<T>[] {
  const old = new Map(before.map(value => [value.id, value])), current = new Map(after.map(value => [value.id, value]));
  return [...new Set([...old.keys(), ...current.keys()])].flatMap(id => {
    const a = old.get(id) ?? null, b = current.get(id) ?? null;
    return sameItem(a, b) ? [] : [{ id, before: a, after: b }];
  });
}
/** Every save is relative to the acknowledged disk state, including delete/Undo. */
export function createWorldStudioIncrementalPatch(scene: FixedWorldScene, draft: Draft): Patch {
  return { schemaVersion: 3, sceneId: scene.id, casters: edits(scene.shadowCasters ?? [], draft.casters),
    receivers: edits(scene.shadowReceivers ?? [], draft.receivers), lights: edits(scene.lights ?? [], draft.lights) };
}
const hasEdits = (patch: Patch) => patch.casters.length + patch.receivers.length + patch.lights.length > 0;
function diskResponse(value: unknown, expected: FixedWorldScene): value is Disk {
  if (!value || typeof value !== "object") return false;
  const data = value as Partial<Disk>;
  return data.available === true && typeof data.revision === "string" && /^[0-9a-f]{64}$/.test(data.revision)
    && !!data.scene && data.scene.id === expected.id && data.scene.width === expected.width && data.scene.height === expected.height
    && Array.isArray(data.scene.shadowCasters ?? []) && Array.isArray(data.scene.shadowReceivers ?? []) && Array.isArray(data.scene.lights ?? []);
}

export function createWorldStudioProjectSave({ editor, available, fetcher = fetch, debounceMs = 800,
  now = Date.now, requestId = createWorldStudioRequestId }: {
  editor: Editor; available: boolean; fetcher?: typeof fetch; debounceMs?: number; now?: () => number; requestId?: () => string;
}) {
  const initial: WorldStudioProjectSaveSnapshot = Object.freeze({ status: available ? "probing" : "unavailable", available: false,
    paused: false, savedAt: null, error: null, revision: null, pending: false });
  let state = initial, connected = false, connecting: Promise<void> | null = null;
  let disk: Disk | null = null, unsubscribe: (() => void) | null = null;
  let unsubscribeRefresh: (() => void) | null = null;
  let deferredBaseline: FixedWorldScene | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null, running: Promise<void> | null = null, failedRequest: SaveRequest | null = null;
  let loadingProject: Promise<boolean> | null = null;
  let checkingProject: Promise<void> | null = null, disposed = false;
  let checked: { draft: Draft; revision: string; changed: boolean } | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<WorldStudioProjectSaveSnapshot>) => {
    if (disposed) return;
    if (Object.entries(patch).every(([key, value]) => state[key as keyof WorldStudioProjectSaveSnapshot] === value)) return;
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
  };
  const cancelTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const changed = () => {
    if (!disk) return false;
    const draft = editor.getSnapshot();
    if (checked && checked.revision === disk.revision && checked.draft.casters === draft.casters
      && checked.draft.receivers === draft.receivers && checked.draft.lights === draft.lights) return checked.changed;
    const result = !sameDraft(draft, sceneDraft(disk.scene));
    checked = { draft, revision: disk.revision, changed: result };
    return result;
  };
  const schedule = () => {
    cancelTimer();
    if (disposed || loadingProject || checkingProject) return;
    // Pointer previews are frequent and uncommitted; neither serialize nor diff them.
    if (editor.isGesturing()) return;
    if (deferredBaseline) {
      const acknowledged = deferredBaseline;
      deferredBaseline = null;
      if (!editor.reconcileProjectBaseline(acknowledged)) {
        publish({ status: "error", error: "Файлы сохранены, но черновик не удалось сверить. Скачайте JSON перед перезагрузкой." }); return;
      }
    }
    const pending = changed();
    publish({ pending });
    if (!state.available || state.paused || running || state.status === "conflict" || state.status === "error") return;
    if (!pending) { if (state.status !== "probing") publish({ status: state.savedAt === null ? "ready" : "saved" }); return; }
    timer = setTimeout(() => { timer = null; void save(false); }, debounceMs);
  };
  const save = async (manual: boolean) => {
    cancelTimer();
    if (disposed || loadingProject || checkingProject) return;
    if (running) return running;
    if (!disk || !state.available || state.status === "conflict" || editor.hasHydrationConflict() || editor.isGesturing() || state.paused && !manual) return;
    editor.saveDraft();
    let body: SaveRequest;
    try { body = failedRequest ?? { requestId: requestId(), expectedRevision: disk.revision,
      patch: structuredClone(createWorldStudioIncrementalPatch(disk.scene, editor.getSnapshot())) }; }
    catch (error) { publish({ status: "error", error: error instanceof Error ? error.message : "Не удалось подготовить сохранение." }); return; }
    if (!hasEdits(body.patch)) { publish({ pending: false, status: state.savedAt === null ? "ready" : "saved" }); return; }
    failedRequest = body;
    publish({ status: "saving", error: null, pending: true });
    running = (async () => {
      try {
        const response = await fetcher(endpoint, { method: "POST", credentials: "omit", cache: "no-store",
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (disposed) return;
        const data = await response.json();
        if (disposed) return;
        if (response.status === 409) { publish({ status: "conflict", error: data.message ?? "Файлы изменены в другом редакторе. Черновик остался в браузере." }); return; }
        if (!response.ok || !diskResponse(data, editor.getSceneBaseline())) throw new Error(data.message ?? "Не удалось сохранить файлы проекта.");
        disk = data;
        failedRequest = null;
        // The store keeps edits made while this request was in flight and all Undo history.
        if (editor.isGesturing()) deferredBaseline = data.scene;
        else if (!editor.reconcileProjectBaseline(data.scene)) throw new Error("Файлы сохранены, но черновик не удалось сверить. Скачайте JSON перед перезагрузкой.");
        publish({ status: "saved", error: null, revision: data.revision, savedAt: now(), pending: changed() });
      } catch (error) { publish({ status: "error", error: error instanceof Error ? error.message : "Сеть недоступна. Черновик остался в браузере." }); }
      finally { running = null; schedule(); }
    })();
    return running;
  };
  const connect = async () => {
    if (disposed || !available || connected) return connecting ?? undefined;
    connected = true;
    editor.hydrate();
    const beforeProbe = fingerprint(editor.getSnapshot()), hydrationConflict = editor.hasHydrationConflict();
    unsubscribe = editor.subscribe(schedule);
    publish({ status: "probing", error: null });
    connecting = (async () => {
      try {
        const response = await fetcher(endpoint, { method: "GET", credentials: "omit", cache: "no-store" });
        if (disposed) return;
        if (!response.ok) { publish({ status: "unavailable", available: false,
          error: "Автосохранение в файлы доступно при npm run dev:local / dev:lan. Здесь сохраняется черновик браузера; JSON можно скачать." }); return; }
        const data = await response.json();
        if (disposed) return;
        if (!diskResponse(data, editor.getSceneBaseline())) throw new Error("Локальный сервер вернул другую карту.");
        disk = data;
        publish({ available: true, revision: data.revision });
        unsubscribeRefresh ??= subscribeWorldLightingRefresh(() => { void recheck(); });
        if (hydrationConflict) {
          if (fingerprint(editor.getSnapshot()) !== beforeProbe || editor.restoreProjectDraft(data.scene) !== "restored") {
            publish({ status: "conflict", pending: true, error: "Сохранённый черновик не соответствует карте проекта. Он сохранён отдельно и не будет перезаписан." }); return;
          }
        }
        if (editor.hasHydrationConflict()) { publish({ status: "conflict", pending: true,
          error: "Черновик не удалось восстановить. Скачайте его перед выбором версии проекта." }); return; }
        const browser = editor.getSnapshot(), authored = sceneDraft(editor.getSceneBaseline()), server = sceneDraft(data.scene);
        if (sameDraft(browser, server)) {
          if (!editor.reconcileProjectBaseline(data.scene)) throw new Error("Не удалось сверить сохранённую карту.");
        } else if (sameDraft(browser, authored)) {
          if (!editor.adoptProjectScene(data.scene)) throw new Error("Не удалось загрузить карту проекта.");
        } else if (!sameDraft(server, authored)) {
          publish({ status: "conflict", pending: true, error: "Карта проекта и черновик изменились отдельно. Черновик сохранён в браузере; файлы не перезаписаны." }); return;
        }
        failedRequest = null;
        publish({ status: "ready", error: null });
        schedule();
      } catch (error) { publish({ status: "unavailable", available: false, error: error instanceof Error ? error.message : "Локальный сервер недоступен." }); }
      finally { connecting = null; }
    })();
    return connecting;
  };
  const requestSave = async () => { await connect(); await save(true); };
  const retry = async () => {
    if (disposed) return;
    await checkingProject;
    if (disposed) return;
    if (state.status === "conflict" || !state.available) {
      connected = false; unsubscribe?.(); unsubscribe = null; unsubscribeRefresh?.(); unsubscribeRefresh = null;
      await connect(); return;
    }
    publish({ status: "ready", error: null });
    await save(true);
  };
  const setPaused = (paused: boolean) => { publish({ paused }); schedule(); };
  /** HMR after our generated-world write must preserve the acknowledged session. */
  const recheck = async (): Promise<void> => {
    if (disposed || !available || !connected) return;
    if (loadingProject) { await loadingProject; return recheck(); }
    if (checkingProject) return checkingProject;
    cancelTimer();
    checkingProject = (async () => {
      try {
        await running; await connecting;
        if (disposed || !disk || !state.available) return;
        const response = await fetcher(endpoint, { method: "GET", credentials: "omit", cache: "no-store" });
        if (disposed) return;
        const data = await response.json();
        if (disposed) return;
        if (!response.ok || !diskResponse(data, editor.getSceneBaseline())) throw new Error(data.message ?? "Не удалось сверить проект после обновления карты.");
        if (data.revision === disk.revision) return;
        if (editor.hasHydrationConflict() || editor.isGesturing() || !sameDraft(editor.getSnapshot(), sceneDraft(disk.scene))) {
          publish({ status: "conflict", pending: true,
            error: "Карта изменена в другом редакторе. Ваши правки сохранены в браузере; выберите версию проекта явно." }); return;
        }
        // Only a clean browser draft can follow an external Tiled refresh automatically.
        if (!editor.adoptProjectScene(data.scene)) throw new Error("Не удалось принять обновлённую карту. Черновик сохранён.");
        disk = data; deferredBaseline = null; failedRequest = null; checked = null;
        publish({ status: "ready", revision: data.revision, error: null, pending: false, savedAt: null });
      } catch (error) {
        publish({ status: "error", error: error instanceof Error ? error.message : "Не удалось сверить обновлённый проект. Черновик сохранён." });
      } finally { checkingProject = null; schedule(); }
    })();
    return checkingProject;
  };
  /** Explicit UI choice, offered only after the user has downloaded a backup. */
  const loadProjectVersion = async (): Promise<boolean> => {
    if (disposed || !available) return false;
    if (loadingProject) return loadingProject;
    if (checkingProject) { await checkingProject; return loadProjectVersion(); }
    cancelTimer();
    loadingProject = (async () => {
      // An earlier POST/GET must settle before choosing a fresh disk baseline.
      await running; await connecting;
      if (disposed) return false;
      const before = fingerprint(editor.getSnapshot());
      publish({ status: "probing", error: null });
      try {
        if (editor.isGesturing()) throw new Error("Сначала завершите перетаскивание объекта.");
        const response = await fetcher(endpoint, { method: "GET", credentials: "omit", cache: "no-store" });
        if (disposed) return false;
        const data = await response.json();
        if (disposed) return false;
        if (!response.ok || !diskResponse(data, editor.getSceneBaseline())) throw new Error(data.message ?? "Не удалось загрузить версию проекта. Черновик сохранён.");
        if (editor.isGesturing() || fingerprint(editor.getSnapshot()) !== before)
          throw new Error("Во время загрузки появились новые правки. Они сохранены; повторите выбор версии проекта.");
        if (!editor.adoptProjectScene(data.scene, { discardConflictedDraft: true })) throw new Error("Версию проекта не удалось прочитать. Черновик сохранён.");
        disk = data; deferredBaseline = null; failedRequest = null; checked = null;
        if (!unsubscribe) unsubscribe = editor.subscribe(schedule);
        unsubscribeRefresh ??= subscribeWorldLightingRefresh(() => { void recheck(); });
        connected = true;
        publish({ available: true, status: "ready", revision: data.revision, error: null, pending: false, savedAt: null });
        return true;
      } catch (error) {
        publish({ status: "error", error: error instanceof Error ? error.message : "Не удалось загрузить версию проекта. Черновик сохранён." });
        return false;
      } finally { loadingProject = null; schedule(); }
    })();
    return loadingProject;
  };
  return {
    getSnapshot: () => state, getServerSnapshot: () => initial,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    connect, requestSave, retry, setPaused, loadProjectVersion, recheck,
    dispose() {
      disposed = true; cancelTimer(); unsubscribe?.(); unsubscribe = null;
      unsubscribeRefresh?.(); unsubscribeRefresh = null; listeners.clear(); connected = false;
    },
  };
}

export function retainWorldStudioProjectSave(options: Parameters<typeof createWorldStudioProjectSave>[0]) {
  const retained = retainWorldDevClientState("world-studio-project-save", "2", () => createWorldStudioProjectSave(options), {
    identity: options.editor, dispose: previous => previous.dispose(),
  });
  if (retained.reused) void retained.value.recheck();
  return retained.value;
}

export const worldStudioProjectSave = retainWorldStudioProjectSave({ editor: worldLightingEditorStore, available: WORLD_DEV_ENABLED });

export function useWorldStudioProjectSave() {
  const snapshot = useSyncExternalStore(worldStudioProjectSave.subscribe, worldStudioProjectSave.getSnapshot, worldStudioProjectSave.getServerSnapshot);
  useEffect(() => { void worldStudioProjectSave.connect(); }, []);
  return { ...snapshot, saveNow: worldStudioProjectSave.requestSave, retry: worldStudioProjectSave.retry,
    setPaused: worldStudioProjectSave.setPaused, loadProjectVersion: worldStudioProjectSave.loadProjectVersion };
}
