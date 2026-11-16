"use client";

import { useEffect, useEffectEvent, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { ArrowLeft, Crosshair, Download, Expand, Eye, Focus, Hand, Keyboard, Layers, Maximize2, Minimize2, Minus, MousePointer2, PanelRight, Pause, Play, Plus, Redo2, RotateCw, Save, Scaling, Scan, Scissors, SlidersHorizontal, Undo2, X } from "lucide-react";
import defaultScene from "./garage-scene-default.json";
import exampleScene from "./garage-scene-example.json";
import { createGarageSideProfile, GARAGE_SIDE_ASSETS, GARAGE_SIDE_LEVELS } from "./garage-side-profile.mjs";
import { duplicateGarageNode, garageBranchIds, removeGarageNode, validateGarageScene } from "./garage-scene-model.mjs";
import { changeGarageHistory, finishGarageHistoryGesture, getGarageShortcut, redoGarageHistory, undoGarageHistory } from "./garage-editor-shortcuts.mjs";
import type { GarageAsset, GarageNode, GarageScene } from "./garage-scene-types";
import { GarageInspector, GarageNumber, type GarageInspectorTab } from "./garage-inspector";
import { GARAGE_DEVICES, GarageStage, type GarageTool } from "./garage-stage";
import { frameGarageEditorArtwork, garageEditorArtworkBounds, garageEditorNodeBounds, garageEditorWorldPoint, zoomGarageEditorView } from "./garage-editor-view.mjs";
import { garageWaterSetup } from "./garage-water-setup.mjs";
import { GarageLayersPanel } from "./garage-layers-panel";
import { GarageWaterControls } from "./garage-water-controls";
import { attachGarageWaterParts } from "./garage-water-assembly.mjs";
import { defaultGarageOcclusion } from "./garage-occlusion.mjs";
import styles from "./garage-editor.module.css";

const DRAFT_KEY = "zhiv:boat-garage:scene:v1";
const ENDPOINT = "/api/dev/boat-garage";
const initialScene = validateGarageScene(defaultScene);
const assemblyExample = validateGarageScene(exampleScene);
type History = { past: GarageScene[]; scene: GarageScene; future: GarageScene[] };

const narrowDockQuery = "(max-width: 1080px)";
function subscribeDockWidth(notify: () => void) {
  const query = window.matchMedia(narrowDockQuery);
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}
const isNarrowDock = () => window.matchMedia(narrowDockQuery).matches;

export function GarageEditor() {
  const narrowDock = useSyncExternalStore(subscribeDockWidth, isNarrowDock, () => false);
  const [history, setHistory] = useState<History>({ past: [], scene: initialScene, future: [] });
  const scene = history.scene;
  const [selectedId, setSelectedId] = useState<string | null>("stand-left");
  const [deviceId, setDeviceId] = useState("phone");
  const [tool, setTool] = useState<GarageTool>("move");
  const [inspectorTab, setInspectorTab] = useState<GarageInspectorTab>("object");
  const [occlusionEdit, setOcclusionEdit] = useState({ session: 0, redraw: false });
  const [occlusionDraft, setOcclusionDraft] = useState(false);
  const [guides, setGuides] = useState(true), [clean, setClean] = useState(false);
  const [notice, setNotice] = useState("Загружаем сцену проекта…");
  const [revision, setRevision] = useState<string | null>(null), [saved, setSaved] = useState(JSON.stringify(initialScene));
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [draftAvailable, setDraftAvailable] = useState(false);
  const [deviceActualSize, setDeviceActualSize] = useState(false);
  const [mode, setMode] = useState<"assembly" | "devices">("assembly"), [focused, setFocused] = useState(false);
  const [environment, setEnvironment] = useState<"garage" | "water">("garage");
  const [openPanel, setOpenPanel] = useState<"layers" | "properties" | "settings" | null>(null);
  const leftDock = useRef<HTMLElement>(null);
  const rightDock = useRef<HTMLDivElement>(null);
  const guideDialog = useRef<HTMLDialogElement>(null);
  const [waterRunning, setWaterRunning] = useState(false);
  const [surface, setSurface] = useState({ width: 800, height: 600 });
  const [editorView, setEditorView] = useState({ x: 0, y: 0, scale: 1 });
  const autoFit = useRef<"canvas" | "boat" | false>("canvas"), previousSurface = useRef({ width: 800, height: 600 });
  const preview = useRef<HTMLDivElement>(null);
  const device = GARAGE_DEVICES.find(item => item.id === deviceId)!;
  const selected = scene.nodes.find(item => item.id === selectedId);
  const libraryAssets = [...scene.assets, ...[...assemblyExample.assets, ...GARAGE_SIDE_ASSETS].filter(asset => !scene.assets.some(item => item.id === asset.id))];
  const cameraMode = device.width > device.height || device.width >= 700 ? "landscape" : "portrait";
  const camera = scene.cameras[cameraMode];
  const dirty = JSON.stringify(scene) !== saved;
  const waterSetup = garageWaterSetup(scene);
  const canvasWidth = scene.canvas.width, canvasHeight = scene.canvas.height;
  const waterRoot = environment === "water" ? waterSetup.config.rootId : null;
  const previousWaterRoot = useRef(waterRoot);
  const previewScale = deviceActualSize ? 1 : Math.max(.01, Math.min(1, (surface.width - 16) / device.width, (surface.height - 16) / device.height));
  const placementCenter = mode === "assembly" ? garageEditorWorldPoint(editorView, { x: surface.width / 2, y: surface.height / 2 }) : camera;

  useEffect(() => {
    let active = true;
    void fetch(ENDPOINT, { cache: "no-store" }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Сохранение доступно на локальном dev-сервере. Можно работать и экспортировать JSON.");
      const next = validateGarageScene(body.scene);
      if (!active) return;
      setHistory({ past: [], scene: next, future: [] }); setRevision(body.revision); setSaved(JSON.stringify(next));
      setNotice("Сцена проекта загружена.");
    }).catch(() => { if (active) setNotice("Файлы проекта доступны на локальном dev-сервере. Здесь можно расставлять детали и экспортировать JSON."); }).finally(() => {
      if (!active) return;
      try { setDraftAvailable(Boolean(localStorage.getItem(DRAFT_KEY))); } catch { /* Export stays available without storage. */ }
      setReady(true);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!ready || !dirty || draftAvailable) return;
    const timer = setTimeout(() => {
      try { localStorage.setItem(DRAFT_KEY, JSON.stringify({ scene, revision })); }
      catch { /* Explicit project save / export remain available. */ }
    }, 450);
    return () => clearTimeout(timer);
  }, [scene, revision, ready, dirty, draftAvailable]);

  useEffect(() => {
    if (!dirty) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [dirty]);

  const fitMeasuredSurface = useEffectEvent((width: number, height: number) =>
    frameGarageEditorArtwork(scene.canvas, autoFit.current === "boat" ? waterSetup.artworkBounds : null, width, height));

  useEffect(() => {
    const element = preview.current;
    if (!element) return;
    if (previousWaterRoot.current !== waterRoot) {
      previousWaterRoot.current = waterRoot;
      autoFit.current = waterRoot !== null ? "boat" : "canvas";
    }
    const measure = () => {
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight);
      setSurface(current => current.width === width && current.height === height ? current : { width, height });
      if (mode !== "assembly") return;
      const previous = previousSurface.current;
      previousSurface.current = { width, height };
      const fitted = autoFit.current && fitMeasuredSurface(width, height);
      if (fitted) setEditorView(fitted);
      else if (width !== previous.width || height !== previous.height)
        setEditorView(current => ({ ...current, x: current.x + (width - previous.width) / 2, y: current.y + (height - previous.height) / 2 }));
    };
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [mode, canvasWidth, canvasHeight, waterRoot, waterSetup.hasArtwork]);

  useEffect(() => {
    const element = preview.current;
    if (!element || mode !== "assembly") return;
    const wheel = (event: WheelEvent) => {
      if (busy || !ready) return;
      event.preventDefault();
      const rect = element.getBoundingClientRect(), delta = Math.max(-800, Math.min(800, event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1)));
      autoFit.current = false;
      setEditorView(current => zoomGarageEditorView(current, current.scale * Math.exp(-delta * .0015),
        { x: event.clientX - rect.left, y: event.clientY - rect.top }));
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [mode, busy, ready]);

  function fitScene(target: GarageScene, subject: "canvas" | "boat") {
    autoFit.current = subject;
    setEditorView(frameGarageEditorArtwork(target.canvas, subject === "boat" ? garageWaterSetup(target).artworkBounds : null, surface.width, surface.height));
  }
  function fitView() { fitScene(scene, environment === "water" ? "boat" : "canvas"); }
  function fitCanvasView() { fitScene(scene, "canvas"); }
  function fitExampleView() { fitScene(assemblyExample, "boat"); }
  function zoomView(scale: number) {
    autoFit.current = false;
    setEditorView(current => zoomGarageEditorView(current, scale, { x: surface.width / 2, y: surface.height / 2 }));
  }
  function frameSelected() {
    if (!selected) return;
    const artwork = !selected.assetId && garageEditorArtworkBounds(scene, garageBranchIds(scene, selected.id));
    const bounds = artwork || garageEditorNodeBounds(scene, selected.id);
    autoFit.current = false;
    setEditorView(frameGarageEditorArtwork(scene.canvas, bounds, surface.width, surface.height));
  }
  function editOcclusion(redraw = false) {
    setInspectorTab("occlusion");
    setWaterRunning(false); setClean(false); setTool("occlusion");
    setOcclusionEdit(current => ({ session: current.session + 1, redraw }));
    setNotice(redraw ? "Новый контур: ставьте точки по борту; Enter — применить, Escape — отменить. Пока рисунок не закончен, сохранённый контур остаётся прежним."
      : "Тяните точки борта; нажмите на ребро, чтобы добавить точку. Отметьте справа детали, которые надо спрятать за бортом.");
  }
  function selectNode(id: string) {
    setOpenPanel(current => current === "settings" ? null : current);
    setSelectedId(id);
    if (id !== selectedId) setInspectorTab("object");
    if (id !== selectedId && tool === "occlusion") setTool("move");
  }
  function activateTool(next: GarageTool) {
    if (next === "occlusion" && tool === "occlusion" && selected?.occlusion && !clean) {
      setInspectorTab("occlusion"); return;
    }
    if (next === "occlusion" && (!selected?.assetId || selected.locked)) {
      setNotice("Для маски выберите незакреплённое изображение корпуса."); return;
    }
    setWaterRunning(false); setClean(false);
    if (next === "occlusion") {
      if (selected && !selected.occlusion) change({ ...scene, nodes: scene.nodes.map(node => node.id === selected.id ? { ...node, occlusion: defaultGarageOcclusion() } : node) });
      editOcclusion();
    } else {
      if (occlusionDraft) setNotice("Незавершённый рисунок отменён. Сохранённый контур остался прежним.");
      setTool(next);
      if (["move", "rotate", "scale"].includes(next)) setInspectorTab("object");
      else if (["pivot", "socket"].includes(next)) setInspectorTab("attachments");
    }
  }

  function change(next: GarageScene, record = true) {
    setWaterRunning(false);
    try {
      const validated = validateGarageScene(next);
      setHistory(current => changeGarageHistory(current, validated, record));
    } catch (error) { setNotice(error instanceof Error ? error.message : "Изменение не применено."); }
  }
  function undo() { setHistory(current => undoGarageHistory(current)); }
  function redo() { setHistory(current => redoGarageHistory(current)); }
  function remove() { if (selected && !selected.locked) { change(removeGarageNode(scene, selected.id)); setSelectedId(null); } }
  function duplicate() {
    if (!selected) return;
    try { const next = duplicateGarageNode(scene, selected.id); change(next); setSelectedId(next.nodes.at(-1)!.id); setInspectorTab("object"); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Не удалось создать копию."); }
  }
  function add(asset?: GarageAsset) {
    const node: GarageNode = { id: `part-${crypto.randomUUID().slice(0, 8)}`, name: asset?.name ?? "Новая группа", assetId: asset?.id ?? null,
      parentId: null, socketId: null, x: placementCenter.x, y: placementCenter.y, width: asset?.width ?? 1000, height: asset?.height ?? 650,
      scale: asset ? Math.min(350 / asset.width, 220 / asset.height) : 1, rotation: 0, pivotX: .5, pivotY: .5,
      zIndex: 20, visible: true, locked: false, sockets: [] };
    change({ ...scene, assets: asset && !scene.assets.some(item => item.id === asset.id) ? [...scene.assets, asset] : scene.assets, nodes: [...scene.nodes, node] }); setSelectedId(node.id); setInspectorTab("object");
  }
  async function uploadImage(file: File) {
    setBusy(true);
    try {
      if (file.size > 10 * 1024 * 1024) throw new Error("Изображение должно быть не больше 10 МБ.");
      const response = await fetch(ENDPOINT, { method: "PUT", headers: { "content-type": file.type, "x-asset-name": encodeURIComponent(file.name) }, body: file });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Не удалось загрузить изображение.");
      const asset: GarageAsset = body.asset;
      const node: GarageNode = { id: `part-${crypto.randomUUID().slice(0, 8)}`, name: asset.name, assetId: asset.id,
        parentId: null, socketId: null, x: placementCenter.x, y: placementCenter.y, width: asset.width, height: asset.height,
        scale: Math.min(350 / asset.width, 220 / asset.height), rotation: 0, pivotX: .5, pivotY: .5, zIndex: 20, visible: true, locked: false, sockets: [] };
      change({ ...scene, assets: scene.assets.some(item => item.id === asset.id) ? scene.assets : [...scene.assets, asset], nodes: [...scene.nodes, node] });
      setSelectedId(node.id); setInspectorTab("object"); setNotice("Изображение добавлено. Расставьте деталь и сохраните сборку.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Ошибка загрузки."); }
    finally { setBusy(false); }
  }
  async function save() {
    if (occlusionDraft) { setNotice("Завершите контур Enter или отмените Escape перед сохранением."); return; }
    if (!revision) return;
    setBusy(true); setNotice("Сохраняем сборку в проект…");
    try {
      const validated = validateGarageScene(scene);
      const response = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ scene: validated, expectedRevision: revision }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Не удалось сохранить сцену.");
      setRevision(body.revision); setSaved(JSON.stringify(scene));
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* Saved in project. */ }
      setDraftAvailable(false); setNotice("Сборка сохранена в art/world/boat-garage/scene.json.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Ошибка сохранения."); }
    finally { setBusy(false); }
  }
  function exportScene() {
    if (occlusionDraft) { setNotice("Завершите контур Enter или отмените Escape перед экспортом."); return; }
    try {
      const json = JSON.stringify(validateGarageScene(scene), null, 2);
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "boat-garage-scene.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000); setNotice("JSON экспортирован. Изображения хранятся отдельно в проекте.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Ошибка экспорта."); }
  }
  async function importScene(file: File) {
    try {
      if (file.size > 1024 * 1024) throw new Error("JSON должен быть не больше 1 МБ.");
      const next = validateGarageScene(JSON.parse(await file.text())); change(next); fitScene(next, environment === "water" ? "boat" : "canvas"); setSelectedId(next.nodes[0]?.id ?? null); setInspectorTab("object");
      setNotice("Сборка импортирована. Пути изображений должны существовать в этом проекте.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Не удалось импортировать JSON."); }
  }
  function restoreDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
      const next = validateGarageScene(draft.scene);
      change(next); fitScene(next, environment === "water" ? "boat" : "canvas");
      setRevision(typeof draft.revision === "string" && /^[0-9a-f]{64}$/.test(draft.revision) ? draft.revision : null);
      setNotice(draft.revision === revision ? "Черновик восстановлен. Проверьте сцену перед сохранением в проект."
        : "Черновик основан на другой версии проекта. Экспортируйте JSON; сохранение не перезапишет более новую версию.");
    }
    catch { setNotice("Не удалось восстановить черновик."); }
    setDraftAvailable(false);
  }
  // This page owns these shortcuts, even after a toolbar click or a click on empty space.
  // Reattach with the current scene so actions never use a stale selection or camera.
  useEffect(() => {
    function keyboard(event: globalThis.KeyboardEvent) {
      if (busy || !ready || guideDialog.current?.open) return;
      if (event.key === "Escape" && !event.defaultPrevented && openPanel) {
        event.preventDefault(); setOpenPanel(null); return;
      }
      const action = getGarageShortcut(event);
      if (!action) return;
      if (action !== "save") setWaterRunning(false);
      if (action === "save") { event.preventDefault(); if (!event.repeat && revision && dirty) void save(); return; }
      if (action === "undo" || action === "redo") { event.preventDefault(); if (action === "undo") undo(); else redo(); return; }
      if (action === "escape") { event.preventDefault(); setFocused(false); setTool("move"); setClean(false); return; }
      if (["move", "rotate", "scale", "camera", "pivot", "socket", "occlusion"].includes(action)) {
        event.preventDefault(); if (!event.repeat) activateTool(action as GarageTool); return;
      }
      if (clean) return;
      event.preventDefault();
      if (action === "duplicate") { if (!event.repeat) duplicate(); return; }
      if (action === "remove") { if (tool !== "occlusion" && !event.repeat) remove(); return; }
      const step = event.shiftKey ? 10 : 1;
      const dx = action === "left" ? -step : action === "right" ? step : 0;
      const dy = action === "up" ? -step : action === "down" ? step : 0;
      if (selectedId && (dx || dy)) setHistory(current => {
        const node = current.scene.nodes.find(item => item.id === selectedId);
        if (!node || node.locked) return current;
        return changeGarageHistory(current, validateGarageScene({ ...current.scene,
          nodes: current.scene.nodes.map(item => item.id === node.id ? { ...item, x: Math.max(-200000, Math.min(200000, item.x + dx)), y: Math.max(-200000, Math.min(200000, item.y + dy)) } : item) }), !event.repeat);
      });
    }
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  });

  function changeEnvironment(next: "garage" | "water") {
    setEnvironment(next); setWaterRunning(false);
    if (next === "garage" && mode === "assembly") setOpenPanel(null);
  }
  function changeMode(next: "assembly" | "devices") {
    setMode(next);
    if (next === "assembly" && environment === "garage") setOpenPanel(null);
  }
  const drawerVisible = Boolean(openPanel && (narrowDock || focused));
  useEffect(() => {
    if (!drawerVisible) return;
    const dock = openPanel === "layers" ? leftDock.current : rightDock.current;
    const trigger = document.activeElement;
    dock?.querySelector<HTMLElement>("button:not(:disabled), input, select")?.focus({ preventScroll: true });
    return () => {
      if (trigger instanceof HTMLElement && trigger.isConnected && trigger.getClientRects().length)
        trigger.focus({ preventScroll: true });
    };
  }, [drawerVisible, openPanel]);

  const hasSceneSettings = environment === "water" || mode === "devices";
  const showSettings = openPanel === "settings" && hasSceneSettings;

  return <main className={styles.editor} data-focus={focused} tabIndex={-1}>
    <header className={styles.header}>
      <Link href="/" aria-label="Вернуться в игру"><ArrowLeft size={18} /></Link>
      <h1>Сборщик лодки</h1>
      <span className={styles.saveState} data-dirty={dirty}>{dirty ? "Есть изменения" : revision ? "Сцена сохранена" : "Шаблон сцены"}</span>
      <div className={styles.row}><button type="button" onClick={undo} disabled={!history.past.length || busy || occlusionDraft} aria-label="Отменить (Ctrl/⌘ Z)" title="Отменить · Ctrl/⌘ Z"><Undo2 size={17} /></button>
        <button type="button" onClick={redo} disabled={!history.future.length || busy || occlusionDraft} aria-label="Повторить (Ctrl/⌘ Shift Z или Ctrl/⌘ Y)" title="Повторить · Ctrl/⌘ Shift Z"><Redo2 size={17} /></button>
        <button type="button" onClick={exportScene} disabled={!ready || busy || occlusionDraft} aria-label="Экспорт JSON" title="Экспорт JSON"><Download size={16} /><span>JSON</span></button>
        <button className={styles.primary} type="button" onClick={save} aria-label="Сохранить в проект" title={occlusionDraft ? "Сначала завершите контур Enter или отмените Escape" : "Сохранить в проект · Ctrl/⌘ S"} disabled={!revision || busy || !dirty || occlusionDraft}><Save size={16} />В проект</button></div>
    </header>
    <div className={styles.modeToolbar} inert={busy || !ready}>
      <div className={styles.modeTabs} role="group" aria-label="Вид редактора">
        <button type="button" aria-pressed={mode === "assembly"} onClick={() => changeMode("assembly")}>Сборка</button>
        <button type="button" aria-pressed={mode === "devices"} onClick={() => changeMode("devices")}>Устройства</button>
      </div>
      <select className={styles.compactSelect} aria-label="Вид редактора" value={mode} onChange={event => changeMode(event.target.value as typeof mode)}>
        <option value="assembly">Сборка</option><option value="devices">Устройства</option>
      </select>
      <div className={styles.modeTabs} role="group" aria-label="Окружение сборки">
        <button type="button" aria-pressed={environment === "garage"} onClick={() => changeEnvironment("garage")}>Мастерская</button>
        <button type="button" aria-pressed={environment === "water"} onClick={() => changeEnvironment("water")}>На воде</button>
      </div>
      <select className={styles.compactSelect} aria-label="Окружение сборки" value={environment} onChange={event => changeEnvironment(event.target.value as typeof environment)}>
        <option value="garage">Мастерская</option><option value="water">На воде</option>
      </select>
      {environment === "water" && <button type="button" className={styles.play} disabled={!waterSetup.hasArtwork}
        aria-label={waterRunning ? "Пауза и редактировать" : "Проверить плавучесть"} title={waterRunning ? "Остановить плавучесть" : "Проверить плавучесть"}
        aria-pressed={waterRunning} onClick={() => setWaterRunning(value => !value)}>{waterRunning ? <Pause size={16} /> : <Play size={16} />}<span>{waterRunning ? "Пауза" : "Плавучесть"}</span></button>}
      {hasSceneSettings && <button type="button" aria-label="Настройки сцены" title="Настройки сцены" aria-controls={showSettings ? "garage-settings" : undefined} aria-expanded={showSettings}
        onClick={() => setOpenPanel(showSettings ? null : "settings")}><SlidersHorizontal size={16} /><span className={styles.settingsLabel}>Настройки сцены</span></button>}
      <div className={styles.endActions}>
        <button type="button" disabled={busy || !ready} title="Загрузить пример одним отменяемым действием; текущую сборку можно вернуть Ctrl/⌘ Z" onClick={() => {
            change(assemblyExample); fitExampleView(); setSelectedId("starter-hull"); setInspectorTab("object"); setNotice("Пример посадки загружен. Вернуть свою сборку — Ctrl/⌘ Z.");
          }} aria-label="Пример посадки"><span className={styles.exampleFull}>Пример посадки</span><span className={styles.exampleShort}>Пример</span></button>

        <button type="button" aria-pressed={focused} aria-label={focused ? "Вернуть панели" : "На весь экран"} onClick={() => { setFocused(value => !value); setOpenPanel(null); }}
          title={focused ? "Вернуть панели · Esc" : "На весь экран"}>{focused ? <Minimize2 size={16} /> : <Maximize2 size={16} />}<span>{focused ? "Вернуть панели" : "На весь экран"}</span></button>
      </div>
    </div>
    <div className={styles.workspace} data-panel={openPanel ?? "canvas"} inert={busy || !ready}>
      {openPanel && <button type="button" className={styles.backdrop} aria-label="Вернуться на холст" onClick={() => setOpenPanel(null)} />}
      <aside ref={leftDock} className={styles.library} aria-label="Слои и изображения">
        <label className={styles.sidePresets}><span>Лодка сбоку · L0–L5</span><select aria-label="Загрузить боковую сборку лодки" value="" disabled={!ready || busy || occlusionDraft} onChange={event => {
          const level = Number(event.target.value), next = createGarageSideProfile({ hull: level, engine: level, tank: level });
          change(next); fitScene(next, "boat"); setSelectedId("side-hull"); setInspectorTab("object");
          setNotice(`Боковая сборка L${level} загружена. Детали меняются отдельно; вернуть прежнюю сцену — Ctrl/⌘ Z.`);
        }}><option value="" disabled>Выбрать сборку…</option>{GARAGE_SIDE_LEVELS.map(level => <option key={level} value={level}>Лодка · L{level}</option>)}</select></label>
        <GarageLayersPanel scene={scene} assets={libraryAssets} selectedId={selectedId} onSelect={selectNode} onChange={change}
          onAdd={add} onUpload={uploadImage} onImport={importScene} />
      </aside>
      <section inert={drawerVisible} className={styles.center} aria-label={mode === "assembly" ? "Холст сборки" : "Предпросмотр устройств"}>
        <div className={styles.stageArea}>
          <div className={styles.tools} role="group" aria-label="Инструменты холста">{([
            ["move", MousePointer2, "Двигать", "G"], ["rotate", RotateCw, "Повернуть", "R"], ["scale", Scaling, "Масштаб", "S"],
            ["camera", Hand, mode === "assembly" ? "Холст" : "Камера", "H"], ["pivot", Crosshair, "Опора", "P"], ["socket", Crosshair, "Крепление", "A"],
          ] as const).map(([value, Icon, label, key]) => <button key={value} type="button" disabled={busy} aria-label={label} title={`${label} · ${key}`} aria-pressed={tool === value} onClick={() => activateTool(value)}><Icon size={18} /><span>{label}</span></button>)}
            <button type="button" disabled={busy || !selected?.assetId || selected.locked} aria-label="Борт / маска" title="Борт / маска · M" aria-pressed={tool === "occlusion"} onClick={() => activateTool("occlusion")}><Scissors size={18} /><span>Маска</span></button>
            <button type="button" aria-label="Без разметки" title="Без разметки" aria-pressed={clean} onClick={() => setClean(value => !value)}><Eye size={18} /><span>Чистый вид</span></button></div>
          <div className={`${styles.preview} ${mode === "assembly" ? styles.assemblyPreview : ""}`} ref={preview} data-testid="garage-preview" data-mode={mode} data-actual-size={mode === "devices" && deviceActualSize}>
            {mode === "assembly" ? <GarageStage key="assembly" scene={scene} device={device} selectedId={selectedId} tool={tool} guides={guides} clean={clean || (environment === "water" && waterRunning)}
              occlusionEdit={{ ...occlusionEdit, onExit: () => setTool("move"), onDraftChange: setOcclusionDraft }}
              waterPreview={environment === "water" ? { config: waterSetup.config, running: waterRunning } : undefined}
              editingView={{ ...editorView, width: surface.width, height: surface.height }} onViewChange={view => { autoFit.current = false; setEditorView(view); }}
              onSelect={selectNode} onChange={change} onGestureEnd={before => setHistory(current => finishGarageHistoryGesture(current, before))} />
              : <div className={styles.deviceFrame} style={{ width: device.width * previewScale, height: device.height * previewScale }}>
                <div style={{ transform: `scale(${previewScale})`, transformOrigin: "top left" }}>
                  <GarageStage key="device" scene={scene} device={device} selectedId={selectedId} tool={tool} guides={guides} clean={clean || (environment === "water" && waterRunning)}
                    occlusionEdit={{ ...occlusionEdit, onExit: () => setTool("move"), onDraftChange: setOcclusionDraft }}
                    waterPreview={environment === "water" ? { config: waterSetup.config, running: waterRunning } : undefined} onSelect={selectNode}
                    onChange={change} onGestureEnd={before => setHistory(current => finishGarageHistoryGesture(current, before))} />
                </div>
              </div>}
          </div>
        </div>
        <div className={styles.previewFoot}>
          {mode === "assembly" ? <div className={styles.zoomToolbar} aria-label="Масштаб холста">
            <button type="button" title="Уменьшить" aria-label="Уменьшить холст" onClick={() => zoomView(editorView.scale / 1.25)}><Minus size={15} /></button>
            <button type="button" className={styles.zoomReadout} onClick={() => zoomView(1)} title="Вернуть масштаб 100%" aria-label="Масштаб 100%">{Math.round(editorView.scale * 100)}%</button>
            <button type="button" title="Увеличить" aria-label="Увеличить холст" onClick={() => zoomView(editorView.scale * 1.25)}><Plus size={15} /></button>
            <button type="button" onClick={fitView}><Expand size={14} />{environment === "water" ? "Вписать лодку" : "Вписать"}</button>
            {environment === "water" && <button type="button" aria-label="Весь холст" title="Вписать весь холст" onClick={fitCanvasView}><Scan size={15}/><span className={styles.zoomLabel}>Весь холст</span></button>}
            <button type="button" title="Приблизить выбранную деталь" aria-label="К детали" disabled={!selected} onClick={frameSelected}><Focus size={15}/><span className={styles.zoomLabel}>К детали</span></button>
          </div> : <div className={styles.deviceToolbar}>
            <select aria-label="Устройство" value={deviceId} onChange={event => setDeviceId(event.target.value)}>{GARAGE_DEVICES.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
            <button type="button" aria-pressed={deviceActualSize} onClick={() => setDeviceActualSize(value => !value)} title="Устройство в натуральном размере">1:1</button>
            <span>{device.width} × {device.height} · {Math.round(previewScale * 100)}%</span>
          </div>}
          <div className={styles.viewActions}>
            <button type="button" aria-pressed={guides} onClick={() => setGuides(value => !value)} aria-label={mode === "assembly" ? "Область композиции" : "Безопасная область"} title={mode === "assembly" ? "Область композиции" : "Безопасная область"}><Scan size={15}/></button>
            <button type="button" aria-label="Горячие клавиши" title="Горячие клавиши" onClick={() => guideDialog.current?.showModal()}><Keyboard size={16}/></button>
          </div>
        </div>
      </section>
      <div ref={rightDock} className={styles.rightPanel}>
        {showSettings ? <aside className={styles.settingsPane} id="garage-settings" aria-label="Настройки сцены">
          <header><h2>Настройки сцены</h2><button type="button" title="Закрыть настройки" aria-label="Закрыть настройки" onClick={() => setOpenPanel(null)}><X size={16}/></button></header>
          <div className={styles.settingsBody}>
            {environment === "water" && <GarageWaterControls key={waterSetup.config.rootId} scene={scene} config={waterSetup.config} hasArtwork={waterSetup.hasArtwork}
              onChange={waterPreview => change({ ...scene, waterPreview })}
              onAttachParts={partIds => { try { change(attachGarageWaterParts(scene, waterSetup.config.rootId, partIds)); }
                catch (error) { setNotice(error instanceof Error ? error.message : "Не удалось добавить детали в сборку."); } }} />}
            {mode === "devices" && <section className={styles.camera}><h3>Кадр {cameraMode === "portrait" ? "телефона / планшета" : "альбомного экрана"}</h3><div className={styles.fields}>
              {(["x", "y", "width"] as const).map(key => <GarageNumber key={key} label={key === "width" ? "Ширина кадра" : key.toUpperCase()} value={camera[key]} step={10} min={key === "width" ? 300 : -10000}
                onChange={value => change({ ...scene, cameras: { ...scene.cameras, [cameraMode]: { ...camera, [key]: value } } })} />)}
              <button type="button" onClick={() => change({ ...scene, cameras: { ...scene.cameras, [cameraMode]: { x: scene.canvas.width / 2, y: scene.canvas.height / 2, width: cameraMode === "portrait" ? 1280 : scene.canvas.width } } })}>Сбросить кадр</button>
            </div></section>}
          </div>
        </aside> : <GarageInspector scene={scene} node={selected} onChange={change} onDuplicate={duplicate} onRemove={remove} onError={setNotice}
        activeTab={inspectorTab} onTabChange={tab => { setInspectorTab(tab); if (tab !== "occlusion" && tool === "occlusion") setTool("move"); }}
        onEditOcclusion={() => editOcclusion()} onRedrawOcclusion={() => editOcclusion(true)} />}
      </div>
    </div>
    <nav className={styles.drawerNav} aria-label="Рабочие панели" inert={busy || !ready}>
      <button type="button" aria-pressed={openPanel === "layers"} onClick={() => setOpenPanel(openPanel === "layers" ? null : "layers")}><Layers size={16}/>Слои</button>
      <button type="button" aria-pressed={openPanel === null} onClick={() => setOpenPanel(null)}><Focus size={16}/>Холст</button>
      <button type="button" aria-pressed={openPanel === "properties"} onClick={() => setOpenPanel(openPanel === "properties" ? null : "properties")}><PanelRight size={16}/>Свойства</button>
    </nav>
    <div className={styles.status} role="status" data-action={draftAvailable || occlusionDraft}>{occlusionDraft ? "Рисуем новый контур: Enter — применить, Escape — отменить. До завершения рисунка JSON и сохранение недоступны." : notice}{draftAvailable && <span><button type="button" disabled={busy} onClick={restoreDraft}>Восстановить черновик</button><button type="button" disabled={busy} onClick={() => { try { localStorage.removeItem(DRAFT_KEY); } catch {} setDraftAvailable(false); }}>Пропустить</button></span>}</div>
    <dialog ref={guideDialog} className={styles.guide} aria-labelledby="garage-keys-title">
      <header><h2 id="garage-keys-title">Горячие клавиши</h2><button type="button" onClick={() => guideDialog.current?.close()} aria-label="Закрыть подсказку"><X size={16}/></button></header>
      <dl><dt>Ctrl/⌘ Z</dt><dd>Отменить действие</dd><dt>Ctrl/⌘ Shift Z · Ctrl/⌘ Y</dt><dd>Повторить</dd>
            <dt>Alt + ↑ / ↓</dt><dd>Выше или ниже в списке слоёв</dd>
            <dt>Ctrl/⌘ D</dt><dd>Дубликат детали</dd><dt>Ctrl/⌘ S</dt><dd>Сохранить в проект</dd>
            <dt>← ↑ ↓ → · Shift</dt><dd>Сдвиг на 1 · на 10</dd><dt>Delete · Backspace</dt><dd>Удалить деталь</dd>
            <dt>G / V · R · S</dt><dd>Двигать · поворот · масштаб; выберите режим и тяните деталь</dd>
            <dt>H · P · A · M</dt><dd>Холст · опора · крепление · маска борта</dd><dt>Esc</dt><dd>Вернуться к перемещению</dd></dl>
          <p>Рамка двигает выбранный слой, даже если он за другим предметом. Alt + клик — выбрать другой слой. Ручки растягивают свободно, Shift сохраняет пропорции; ручка поворота с Shift даёт шаг 15°. В «Борт / маска» Delete удаляет точку, нажатие на ребро добавляет её; Enter завершает новый контур, Escape отменяет. Колесо — зум; пробел + перетаскивание или средняя кнопка — холст. В полях ввода остаются обычные команды редактирования текста.</p>
    </dialog>
  </main>;
}
