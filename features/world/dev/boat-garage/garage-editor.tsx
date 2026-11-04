"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Crosshair, Download, Expand, Eye, FolderPlus, Hand, ImagePlus, Layers, Maximize2, Minimize2, Minus, MousePointer2, Plus, Redo2, Save, Undo2, Upload } from "lucide-react";
import defaultScene from "./garage-scene-default.json";
import exampleScene from "./garage-scene-example.json";
import { duplicateGarageNode, removeGarageNode, validateGarageScene } from "./garage-scene-model.mjs";
import { changeGarageHistory, finishGarageHistoryGesture, getGarageShortcut, redoGarageHistory, undoGarageHistory } from "./garage-editor-shortcuts.mjs";
import type { GarageAsset, GarageNode, GarageScene } from "./garage-scene-types";
import { GarageInspector, GarageNumber } from "./garage-inspector";
import { GARAGE_DEVICES, GarageStage, type GarageTool } from "./garage-stage";
import { fitGarageEditorView, frameGarageEditorBounds, garageEditorNodeBounds, garageEditorWorldPoint, zoomGarageEditorView } from "./garage-editor-view.mjs";
import { garageWaterSetup } from "./garage-water-setup.mjs";
import { GarageWaterControls } from "./garage-water-controls";
import { attachGarageWaterParts } from "./garage-water-assembly.mjs";
import styles from "./garage-editor.module.css";

const DRAFT_KEY = "zhiv:boat-garage:scene:v1";
const ENDPOINT = "/api/dev/boat-garage";
const initialScene = validateGarageScene(defaultScene);
const assemblyExample = validateGarageScene(exampleScene);
type History = { past: GarageScene[]; scene: GarageScene; future: GarageScene[] };

export function GarageEditor() {
  const [history, setHistory] = useState<History>({ past: [], scene: initialScene, future: [] });
  const scene = history.scene;
  const [selectedId, setSelectedId] = useState<string | null>("stand-left");
  const [deviceId, setDeviceId] = useState("phone");
  const [tool, setTool] = useState<GarageTool>("move");
  const [guides, setGuides] = useState(true), [clean, setClean] = useState(false);
  const [notice, setNotice] = useState("Загружаем сцену проекта…");
  const [revision, setRevision] = useState<string | null>(null), [saved, setSaved] = useState(JSON.stringify(initialScene));
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [draftAvailable, setDraftAvailable] = useState(false);
  const [previewScale, setPreviewScale] = useState(.65);
  const [mode, setMode] = useState<"assembly" | "devices">("assembly"), [focused, setFocused] = useState(false);
  const [environment, setEnvironment] = useState<"garage" | "water">("garage");
  const [waterRunning, setWaterRunning] = useState(false);
  const [surface, setSurface] = useState({ width: 800, height: 600 });
  const [editorView, setEditorView] = useState({ x: 0, y: 0, scale: 1 });
  const autoFit = useRef(true), previousSurface = useRef({ width: 800, height: 600 });
  const preview = useRef<HTMLDivElement>(null), imageInput = useRef<HTMLInputElement>(null), jsonInput = useRef<HTMLInputElement>(null);
  const device = GARAGE_DEVICES.find(item => item.id === deviceId)!;
  const selected = scene.nodes.find(item => item.id === selectedId);
  const libraryAssets = [...scene.assets, ...assemblyExample.assets.filter(asset => !scene.assets.some(item => item.id === asset.id))];
  const cameraMode = device.width > device.height || device.width >= 700 ? "landscape" : "portrait";
  const camera = scene.cameras[cameraMode];
  const dirty = JSON.stringify(scene) !== saved;
  const waterSetup = garageWaterSetup(scene);
  const canvasWidth = scene.canvas.width, canvasHeight = scene.canvas.height;
  const placementCenter = mode === "assembly" ? garageEditorWorldPoint(editorView, { x: surface.width / 2, y: surface.height / 2 }) : camera;

  useEffect(() => {
    let active = true;
    void fetch(ENDPOINT, { cache: "no-store" }).then(async response => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.message ?? "Сохранение доступно на локальном dev-сервере. Можно работать и экспортировать JSON.");
      const next = validateGarageScene(body.scene);
      if (!active) return;
      setHistory({ past: [], scene: next, future: [] }); setRevision(body.revision); setSaved(JSON.stringify(next));
      setNotice("Сцена проекта загружена. Изменения сохраняются кнопкой «В проект».");
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

  useEffect(() => {
    const element = preview.current;
    if (!element) return;
    const measure = () => {
      const width = Math.max(1, element.clientWidth), height = Math.max(1, element.clientHeight);
      const previous = previousSurface.current;
      previousSurface.current = { width, height };
      setSurface(current => current.width === width && current.height === height ? current : { width, height });
      setPreviewScale(Math.max(.12, Math.min(1, (width - 32) / device.width, (height - 32) / device.height)));
      if (mode === "assembly") setEditorView(current => autoFit.current ? fitGarageEditorView({ width: canvasWidth, height: canvasHeight }, width, height)
        : { ...current, x: current.x + (width - previous.width) / 2, y: current.y + (height - previous.height) / 2 });
    };
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [device, mode, canvasWidth, canvasHeight]);

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

  function fitView() {
    autoFit.current = true;
    setEditorView(fitGarageEditorView(scene.canvas, surface.width, surface.height));
  }
  function zoomView(scale: number) {
    autoFit.current = false;
    setEditorView(current => zoomGarageEditorView(current, scale, { x: surface.width / 2, y: surface.height / 2 }));
  }
  function frameSelected() {
    const bounds = selectedId && garageEditorNodeBounds(scene, selectedId);
    if (!bounds) return;
    autoFit.current = false;
    setEditorView(frameGarageEditorBounds(bounds, surface.width, surface.height, 60));
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
    try { const next = duplicateGarageNode(scene, selected.id); change(next); setSelectedId(next.nodes.at(-1)!.id); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Не удалось создать копию."); }
  }
  function add(asset?: GarageAsset) {
    const node: GarageNode = { id: `part-${crypto.randomUUID().slice(0, 8)}`, name: asset?.name ?? "Новая группа", assetId: asset?.id ?? null,
      parentId: null, socketId: null, x: placementCenter.x, y: placementCenter.y, width: asset?.width ?? 1000, height: asset?.height ?? 650,
      scale: asset ? Math.min(350 / asset.width, 220 / asset.height) : 1, rotation: 0, pivotX: .5, pivotY: .5,
      zIndex: 20, visible: true, locked: false, sockets: [] };
    change({ ...scene, assets: asset && !scene.assets.some(item => item.id === asset.id) ? [...scene.assets, asset] : scene.assets, nodes: [...scene.nodes, node] }); setSelectedId(node.id);
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
      setSelectedId(node.id); setNotice("Изображение добавлено. Расставьте деталь и сохраните сборку.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Ошибка загрузки."); }
    finally { setBusy(false); }
  }
  async function save() {
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
      const next = validateGarageScene(JSON.parse(await file.text())); change(next); setSelectedId(next.nodes[0]?.id ?? null);
      setNotice("Сборка импортирована. Пути изображений должны существовать в этом проекте.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Не удалось импортировать JSON."); }
  }
  function restoreDraft() {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY) ?? "null");
      change(validateGarageScene(draft.scene));
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
      if (busy || !ready) return;
      const action = getGarageShortcut(event);
      if (!action) return;
      if (action !== "save") setWaterRunning(false);
      if (action === "save") { event.preventDefault(); if (!event.repeat && revision && dirty) void save(); return; }
      if (action === "undo" || action === "redo") { event.preventDefault(); if (action === "undo") undo(); else redo(); return; }
      if (action === "escape") { event.preventDefault(); setFocused(false); setTool("move"); setClean(false); return; }
      if (clean) return;
      event.preventDefault();
      if (action === "duplicate") { if (!event.repeat) duplicate(); return; }
      if (action === "remove") { if (!event.repeat) remove(); return; }
      if (["move", "camera", "pivot", "socket"].includes(action)) { setTool(action as GarageTool); return; }
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

  return <main className={styles.editor} data-focus={focused} tabIndex={-1}>
    <header className={styles.header}><Link href="/" aria-label="Вернуться в игру"><ArrowLeft size={19} /></Link>
      <div className={styles.heading}><small>МОХЛИК · ИНСТРУМЕНТЫ РАЗРАБОТКИ</small><h1>Сборщик лодки</h1></div>
      <span className={styles.saveState}>{dirty ? "Есть изменения" : revision ? "Сцена сохранена" : "Шаблон сцены"}</span>
      <div className={styles.row}><button type="button" onClick={undo} disabled={!history.past.length || busy} aria-label="Отменить (Ctrl/⌘ Z)" title="Отменить · Ctrl/⌘ Z"><Undo2 size={17} /></button>
        <button type="button" onClick={redo} disabled={!history.future.length || busy} aria-label="Повторить (Ctrl/⌘ Shift Z или Ctrl/⌘ Y)" title="Повторить · Ctrl/⌘ Shift Z или Ctrl/⌘ Y"><Redo2 size={17} /></button>
        <button type="button" onClick={exportScene} disabled={!ready || busy}><Download size={16} />JSON</button>
        <button className={styles.primary} type="button" onClick={save} title="Сохранить в проект · Ctrl/⌘ S" disabled={!revision || busy || !dirty}><Save size={16} />В проект</button></div>
    </header>
    <div className={styles.status} role="status">{notice}{draftAvailable && <span><button type="button" disabled={busy} onClick={restoreDraft}>Восстановить черновик</button><button type="button" disabled={busy} onClick={() => { try { localStorage.removeItem(DRAFT_KEY); } catch {} setDraftAvailable(false); }}>Пропустить</button></span>}</div>
    <div className={styles.workspace} inert={busy || !ready}>
      <aside className={styles.library}>
        <div className={styles.sectionHead}><h2>Изображения</h2><button title="Импортировать сборку JSON" type="button" disabled={busy} onClick={() => jsonInput.current?.click()}><Upload size={15} /></button></div>
        <button className={styles.upload} type="button" disabled={busy || !ready} onClick={() => imageInput.current?.click()}><ImagePlus size={18} />Загрузить PNG / WebP</button>
        <input ref={imageInput} hidden type="file" accept="image/png,image/webp,image/jpeg" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadImage(file); event.target.value = ""; }} />
        <input ref={jsonInput} hidden type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void importScene(file); event.target.value = ""; }} />
        <div className={styles.assets}>{libraryAssets.map(asset => <button key={asset.id} type="button" disabled={busy} title="Добавить экземпляр на сцену" onClick={() => add(asset)}>
          {/* Raster originals stay independent from the scene layout. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={asset.src} alt="" /><span>{asset.name}</span><small>{asset.width} × {asset.height}</small></button>)}</div>
        <div className={styles.sectionHead}><h2><Layers size={16} />Слои</h2><button type="button" title="Добавить группу" onClick={() => add()} disabled={busy}><FolderPlus size={16} /></button></div>
        <div className={styles.layers}>{[...scene.nodes].sort((a, b) => b.zIndex - a.zIndex).map(node => <button type="button" key={node.id}
          aria-pressed={selectedId === node.id} onClick={() => setSelectedId(node.id)} className={selectedId === node.id ? styles.selected : ""}>
          <span>{node.parentId ? "↳ " : ""}{node.name}</span><small>{node.locked ? "🔒" : node.visible ? node.zIndex : "скрыт"}</small></button>)}</div>
        <p className={styles.hint}>Корпус, мотор и снаряжение загружайте отдельными изображениями. Для Мохлика понадобятся задняя часть корпуса и передний борт.</p>
      </aside>
      <section className={styles.center} aria-label={mode === "assembly" ? "Холст сборки" : "Предпросмотр устройств"}>
        <div className={styles.modeToolbar}>
          <div className={styles.modeTabs}><button type="button" aria-pressed={mode === "assembly"} onClick={() => setMode("assembly")}>Сборка</button>
            <button type="button" aria-pressed={mode === "devices"} onClick={() => setMode("devices")}>Устройства</button></div>
          <div className={styles.modeTabs} aria-label="Окружение сборки">
            <button type="button" aria-pressed={environment === "garage"} onClick={() => { setEnvironment("garage"); setWaterRunning(false); }}>Мастерская</button>
            <button type="button" aria-pressed={environment === "water"} onClick={() => { setEnvironment("water"); setWaterRunning(false); }}>На воде</button>
          </div>
          <button type="button" disabled={busy || !ready} title="Загрузить пример одним отменяемым действием; текущую сборку можно вернуть Ctrl/⌘ Z" onClick={() => {
            change(assemblyExample); setSelectedId("starter-hull"); setNotice("Пример посадки загружен. Ctrl/⌘ Z вернёт вашу сборку; файл проекта не изменён.");
          }}>Пример посадки</button>
          <button type="button" aria-pressed={focused} onClick={() => { setFocused(value => !value); setMode("assembly"); }} title="Скрыть панели; Esc — выйти">
            {focused ? <Minimize2 size={15} /> : <Maximize2 size={15} />}{focused ? "Вернуть панели" : "На весь экран"}</button>
        </div>
        {mode === "devices" && <div className={styles.deviceToolbar}>{GARAGE_DEVICES.map(item => <button type="button" key={item.id} aria-pressed={deviceId === item.id} onClick={() => setDeviceId(item.id)}>{item.name}</button>)}</div>}
        <div className={styles.tools}>{([
          ["move", MousePointer2, "Двигать"], ["camera", Hand, mode === "assembly" ? "Холст" : "Камера"], ["pivot", Crosshair, "Опора"], ["socket", Crosshair, "Крепление"],
        ] as const).map(([value, Icon, label]) => <button key={value} type="button" disabled={busy || clean} aria-pressed={tool === value} onClick={() => { setWaterRunning(false); setTool(value); }}><Icon size={15} />{label}</button>)}
          <button type="button" aria-pressed={clean} onClick={() => setClean(value => !value)}><Eye size={15} />Без разметки</button></div>
        {environment === "water" && <GarageWaterControls key={waterSetup.config.rootId} scene={scene} config={waterSetup.config} running={waterRunning} hasArtwork={waterSetup.hasArtwork}
          onRunningChange={setWaterRunning} onChange={waterPreview => change({ ...scene, waterPreview })}
          onAttachParts={partIds => { try { change(attachGarageWaterParts(scene, waterSetup.config.rootId, partIds)); }
            catch (error) { setNotice(error instanceof Error ? error.message : "Не удалось добавить детали в сборку."); } }} />}
        {mode === "assembly" && <div className={styles.zoomToolbar} aria-label="Масштаб холста">
          <button type="button" title="Уменьшить" aria-label="Уменьшить холст" onClick={() => zoomView(editorView.scale / 1.25)}><Minus size={15} /></button>
          <span>{Math.round(editorView.scale * 100)}%</span>
          <button type="button" title="Увеличить" aria-label="Увеличить холст" onClick={() => zoomView(editorView.scale * 1.25)}><Plus size={15} /></button>
          <button type="button" onClick={fitView}><Expand size={14} />Вписать</button><button type="button" onClick={() => zoomView(1)}>100%</button>
          <button type="button" disabled={!selected} onClick={frameSelected}>К детали</button>
        </div>}
        <div className={`${styles.preview} ${mode === "assembly" ? styles.assemblyPreview : ""}`} ref={preview} data-testid="garage-preview" data-mode={mode}>
          {mode === "assembly" ? <GarageStage key="assembly" scene={scene} device={device} selectedId={selectedId} tool={tool} guides={guides} clean={clean || (environment === "water" && waterRunning)}
            waterPreview={environment === "water" ? { config: waterSetup.config, running: waterRunning } : undefined}
            editingView={{ ...editorView, width: surface.width, height: surface.height }} onViewChange={view => { autoFit.current = false; setEditorView(view); }}
            onSelect={setSelectedId} onChange={change} onGestureEnd={before => setHistory(current => finishGarageHistoryGesture(current, before))} />
            : <div className={styles.deviceFrame} style={{ width: device.width * previewScale, height: device.height * previewScale }}>
              <div style={{ transform: `scale(${previewScale})`, transformOrigin: "top left" }}>
                <GarageStage key="device" scene={scene} device={device} selectedId={selectedId} tool={tool} guides={guides} clean={clean || (environment === "water" && waterRunning)}
                  waterPreview={environment === "water" ? { config: waterSetup.config, running: waterRunning } : undefined} onSelect={setSelectedId}
                  onChange={change} onGestureEnd={before => setHistory(current => finishGarageHistoryGesture(current, before))} />
              </div>
            </div>}
        </div>
        <div className={styles.previewFoot}><span>{mode === "assembly" ? `${scene.canvas.width} × ${scene.canvas.height} · холст` : `${device.width} × ${device.height} · ${Math.round(previewScale * 100)}%`}</span>
          <label><input type="checkbox" checked={guides} onChange={event => setGuides(event.target.checked)} />{mode === "assembly" ? "Область композиции" : "Безопасная область"}</label>
          <span>{mode === "assembly" ? "Колесо — зум · пробел / средняя кнопка — двигать холст" : "Панель улучшений — отдельный макет UI"}</span></div>
        <details className={styles.shortcuts}><summary>Горячие клавиши</summary>
          <dl><dt>Ctrl/⌘ Z</dt><dd>Отменить действие</dd><dt>Ctrl/⌘ Shift Z · Ctrl/⌘ Y</dt><dd>Повторить</dd>
            <dt>Ctrl/⌘ D</dt><dd>Дубликат детали</dd><dt>Ctrl/⌘ S</dt><dd>Сохранить в проект</dd>
            <dt>← ↑ ↓ → · Shift</dt><dd>Сдвиг на 1 · на 10</dd><dt>Delete · Backspace</dt><dd>Удалить деталь</dd>
            <dt>V · H · P · A</dt><dd>Двигать · камера · опора · крепление</dd><dt>Esc</dt><dd>Вернуться к перемещению</dd></dl>
          <p>Рамка двигает выбранный слой, даже если он за другим предметом. Alt + клик — выбрать другой слой. Ручки растягивают свободно, Shift сохраняет пропорции; ручка поворота с Shift даёт шаг 15°. Колесо — зум; пробел + перетаскивание или средняя кнопка — холст. В полях ввода остаются обычные команды редактирования текста.</p>
        </details>
        {mode === "devices" && <details className={styles.camera}><summary>Кадр {cameraMode === "portrait" ? "телефона / планшета" : "альбомного экрана"}</summary><div className={styles.fields}>
          {(["x", "y", "width"] as const).map(key => <GarageNumber key={key} label={key === "width" ? "Ширина кадра" : key.toUpperCase()} value={camera[key]} step={10} min={key === "width" ? 300 : -10000}
            onChange={value => change({ ...scene, cameras: { ...scene.cameras, [cameraMode]: { ...camera, [key]: value } } })} />)}
          <button type="button" onClick={() => change({ ...scene, cameras: { ...scene.cameras, [cameraMode]: { x: scene.canvas.width / 2, y: scene.canvas.height / 2, width: cameraMode === "portrait" ? 1280 : scene.canvas.width } } })}>Сбросить кадр</button>
        </div></details>}
      </section>
      <GarageInspector scene={scene} node={selected} onChange={change} onDuplicate={duplicate} onRemove={remove} onError={setNotice} />
    </div>
  </main>;
}
