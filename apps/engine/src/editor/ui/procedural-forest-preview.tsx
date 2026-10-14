"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Activity, FolderOpen, ArrowLeft, ArrowRight, ChevronDown, CircleHelp, Download, Expand, FileJson, Grid2X2, Hand, House, ImagePlus, Layers, Leaf, Minus, MousePointer2, PanelRightClose, PanelRightOpen, Paintbrush, Plus, Redo2, RotateCcw, Shuffle, Sprout, Sun, Trees, Undo2, Upload, X } from "lucide-react";
import type { ForestStatus } from "@/apps/engine/src/editor/input/controller";
import { MAX_SCENE_DIMENSION } from "@/packages/engine/src/scene/contracts";
import { getEditorCatalog, getEditorPreset } from "@/apps/engine/src/editor/scene/editor-presets";
import { serializeProjectDocument } from "@/apps/engine/src/editor/scene/project-document";
import { prepareProjectImport } from "@/apps/engine/src/editor/scene/project-import";
import { createEngineProfiler } from "@/apps/engine/src/editor/diagnostics/engine-profiler";
import { MAX_SCENE_BYTES } from "@/apps/engine/src/editor/scene/editor-scene";
import { editorObjectName } from "./editor-inspector";
import { useEngineProjects } from "./use-engine-projects";
import { ProjectManager } from "./project-manager";
import { EngineDiagnosticsPanel } from "./engine-diagnostics-panel";
import { EditorButton } from "./editor-button";
import { WorkspaceInspector } from "./workspace-inspector";
import { WorkspaceLayers } from "./workspace-layers";
import { WorkspaceTerrain } from "./workspace-terrain";
import { WorkspaceLighting } from "./workspace-lighting";
import { initialLighting } from "@/packages/engine/src/lighting/lighting-data";
import { DEFAULT_TERRAIN_APPEARANCE } from "@/packages/engine/src/terrain/terrain-data";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof import("@/apps/engine/src/editor/input/controller")["createEngineController"]>;
type Popup = "document" | "palette" | "help" | "terrain" | null;
const modes = [{ id: "select", label: "Выбрать", shortcut: "V", icon: MousePointer2 }, { id: "pan", label: "Осмотреть", shortcut: "H", icon: Hand }, { id: "plant", label: "Добавить", shortcut: "B", icon: Sprout }, { id: "erase", label: "Убрать", shortcut: "E", icon: X }, { id: "terrain", label: "Земля", shortcut: "T", icon: Paintbrush }] as const;
const defaultPreset = getEditorPreset("forest-v5")!;

export type ProceduralForestPreviewProps = {
  /** Navigation belongs to the embedding host; the standalone editor has no game destination. */
  backLink?: { href: string; label: string };
  onBack?: () => void;
  documentTitle?: string;
  /** Optional example artwork supplied by the host or a scene preset. */
  sampleImage?: { url: string; fileName: string; label: string };
};

export function ProceduralForestPreview({ backLink, onBack, documentTitle = "Лесная долина", sampleImage }: ProceduralForestPreviewProps = {}) {
  const [profiler] = useState(() => createEngineProfiler());
  const workspace = useEngineProjects(profiler);
  const canvas = useRef<HTMLCanvasElement>(null);
  const sceneFile = useRef<HTMLInputElement>(null);
  const pngFile = useRef<HTMLInputElement>(null);
  const controller = useRef<Controller | null>(null);
  const [editor, setEditor] = useState<Controller | null>(null);
  const fileBusy = useRef(false), fileToken = useRef(0), uiMounted = useRef(false);
  useEffect(() => { const operationToken = fileToken; uiMounted.current = true; return () => { uiMounted.current = false; fileBusy.current = false; operationToken.current++; }; }, []);
  const layersShortcut = useRef<() => void>(() => {});
  const [status, setStatus] = useState<ForestStatus>({ seed: defaultPreset.defaultSeed, width: defaultPreset.defaultSize.width, height: defaultPreset.defaultSize.height, catalog: getEditorCatalog(defaultPreset), objects: 0, zoom: 0, edited: 0, message: "Открываем карту…", selected: null, canUndo: false, canRedo: false, storage: "unavailable", brush: "tree", mode: "select", temporaryPan: false, trees: true, grid: false, assets: [], brushAssetId: null, layers: [], activeLayerId: "world", objectList: [], selectedHidden: false, selectedLocked: false, folders: [], activeFolderId: undefined, selectedFolder: null, terrainBrush: "grass", terrainSize: 80, terrainBaseTrails: true, clearVegetation: false, lighting: initialLighting(), terrainAppearance: DEFAULT_TERRAIN_APPEARANCE, selectedShadowHeight: null });
  const [controllerReady, setReady] = useState(false);
  const [controllerActivation, setControllerActivation] = useState(-1);
  const [projectsOpen, setProjectsOpen] = useState(false), [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [popup, setPopup] = useState<Popup>(null);
  const [dockOpen, setDockOpen] = useState(true);
  const [mobileDockOpen, setMobileDockOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [tab, setTab] = useState<"object" | "layers" | "terrain" | "lighting">("object");
  const activeDocument = workspace.state.document, activeId = activeDocument?.id;
  const ready = controllerReady && status.projectId === activeId && controllerActivation === workspace.activation;
  const catalog = status.catalog ?? getEditorCatalog(defaultPreset), kinds = Object.values(catalog).filter(item => item.placement !== "image");
  const mode = status.mode, activeMode = status.temporaryPan ? "pan" : mode;
  const saveMessage = workspace.loading ? "Открываем…" : workspace.state.saveState === "saved" ? "Сохранено" : workspace.state.saveState === "error" ? "Ошибка сохранения" : "Сохранение…";
  const height = status.height ?? activeDocument?.height ?? defaultPreset.defaultSize.height;
  const panelVisible = isMobile ? mobileDockOpen : dockOpen;
  const activeLayer = status.layers.find(layer => layer.id === status.activeLayerId);
  const inspectSelection = useCallback(() => setTab("object"), []);
  const areaGroup = useCallback(() => { controller.current?.setMode("area"); setMobileDockOpen(false); setPopup(null); canvas.current?.focus({ preventScroll: true }); }, []);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 700px)");
    const sync = () => setIsMobile(query.matches); sync(); query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    layersShortcut.current = () => {
      if (window.matchMedia("(max-width: 700px)").matches) setMobileDockOpen(open => tab === "layers" ? !open : true);
      else setDockOpen(open => tab === "layers" ? !open : true);
      setTab("layers"); setPopup(null);
    };
  }, [tab]);
  useEffect(() => {
    const initialDocument = workspace.session.current?.getState().document;
    if (!initialDocument || !activeId) return;
    let cancelled = false, owned: Controller | null = null;
    void import("@/apps/engine/src/editor/input/controller").then(({ createEngineController }) => {
      if (cancelled || !canvas.current) return;
      owned = createEngineController(canvas.current, next => {
        if (!cancelled && workspace.session.current?.getState().document?.id === initialDocument.id) { setStatus(next); setReady(true); setControllerActivation(workspace.activation); }
      }, {
        initialDocument, profiler, onDocumentChange: workspace.update,
        requestPngImport: () => { if (!fileBusy.current) { setPopup(null); pngFile.current?.click(); } },
        requestLayersToggle: () => layersShortcut.current(),
        requestTerrainTools: () => { setPopup("terrain"); setTab(current => current === "terrain" ? "object" : current); setMobileDockOpen(false); },
      });
      controller.current = owned; setEditor(owned);
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Не удалось открыть карту."); });
    return () => { cancelled = true; if (controller.current === owned) controller.current = null; owned?.dispose(); };
  }, [activeId, profiler, workspace.activation, workspace.session, workspace.update]);
  useEffect(() => { profiler.setEnabled(diagnosticsOpen); controller.current?.setDiagnosticsEnabled(diagnosticsOpen); }, [diagnosticsOpen, profiler, editor]);

  function focusMap() { canvas.current?.focus({ preventScroll: true }); }
  function closePopup() { setPopup(null); focusMap(); }
  function activateTab(next: "object" | "layers" | "terrain" | "lighting") { setTab(next); setPopup(null); if (next === "terrain") controller.current?.setMode("terrain"); }
  function togglePanel() { if (isMobile) setMobileDockOpen(open => !open); else setDockOpen(open => !open); }
  function chooseKind(kind: string) { controller.current?.setBrush(kind); controller.current?.setMode("plant"); closePopup(); }
  function action(run: () => void) { run(); closePopup(); }
  async function documentOperation(label: string, run: (isCurrent: () => boolean) => Promise<unknown>) {
    if (fileBusy.current) return;
    const token = ++fileToken.current; fileBusy.current = true; setBusy(label); setError(null);
    try { await run(() => token === fileToken.current && uiMounted.current); }
    catch (cause) { if (token === fileToken.current && uiMounted.current) setError(cause instanceof Error ? cause.message : "Не удалось прочитать файл."); }
    finally { if (token === fileToken.current) { fileBusy.current = false; if (uiMounted.current) setBusy(null); } }
  }
  async function fileOperation(label: string, run: (target: Controller) => Promise<unknown>) {
    const target = controller.current;
    if (!target) { setError("Редактор карты ещё не готов. Проект можно скачать как JSON или открыть через список проектов."); return; }
    await documentOperation(label, () => run(target));
  }
  async function importPng(file: File | undefined) {
    if (!file) return;
    await fileOperation("Загружаем PNG…", target => target.importPng(file));
    if (pngFile.current) pngFile.current.value = ""; setPopup(null); focusMap();
  }
  async function importSampleImage() {
    if (!sampleImage) return;
    setPopup(null);
    await fileOperation("Загружаем PNG…", async target => {
      const response = await fetch(sampleImage.url);
      if (!response.ok) throw new Error("Не удалось загрузить пример PNG. Попробуй ещё раз или выбери свой PNG.");
      const file = new File([await response.blob()], sampleImage.fileName, { type: "image/png" });
      if (controller.current === target) await target.importPng(file);
    }); focusMap();
  }
  async function importScene(file: File | undefined) {
    if (!file) return;
    await documentOperation("Открываем проект…", async isCurrent => {
      if (file.size > MAX_SCENE_BYTES) throw new Error("Файл сцены слишком большой. Выбери JSON до " + Math.round(MAX_SCENE_BYTES / 1024 / 1024) + " МБ.");
      const imported = await prepareProjectImport(await file.text(), { isCurrent });
      if (!isCurrent()) return;
      const opened = await workspace.activate(imported);
      if (opened && isCurrent()) setProjectsOpen(false);
    });
    if (sceneFile.current) sceneFile.current.value = ""; setPopup(null); focusMap();
  }
  function exportProject() {
    try {
      const document = controller.current?.getDocument() ?? workspace.state.document; if (!document) return;
      const json = profiler.measure("export", () => serializeProjectDocument(document));
      const url = URL.createObjectURL(new Blob([json], { type: "application/json" })), anchor = window.document.createElement("a");
      const fileName = [...document.name.normalize("NFC").replace(/[\\/:*?"<>|\u202a-\u202e\u2066-\u2069]/g, "_").trim()].slice(0, 64).join("").replace(/[. ]+$/g, "") || "project";
      anchor.href = url; anchor.download = `engine-${fileName}.json`;
      window.document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0); setError(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Не удалось скачать проект. Текущая сцена остаётся открытой."); }
  }
  function openProjects() {
    if (fileBusy.current || workspace.busy) return;
    (window.document.activeElement as HTMLElement | null)?.blur(); controller.current?.cancelSettingsEdit(); controller.current?.setMode("select");
    setPopup(null); setMobileDockOpen(false); setProjectsOpen(true);
  }
  async function navigateBack() {
    try { await workspace.flush(); if (onBack) onBack(); else if (backLink) window.location.assign(backLink.href); }
    catch (cause) { setError(`Не удалось сохранить проект перед выходом: ${cause instanceof Error ? cause.message : String(cause)}. Скачай JSON или повтори сохранение.`); }
  }

  return <main className={styles.page} data-forest-editor tabIndex={-1} onKeyDownCapture={event => {
    if (projectsOpen) {
      if (event.key === "Escape" && !workspace.busy && !fileBusy.current) { event.preventDefault(); setProjectsOpen(false); focusMap(); }
      if (event.key === "Tab") {
        const dialog = event.currentTarget.querySelector<HTMLElement>("[data-project-dialog]"), targets = Array.from(dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? []);
        const first = targets[0], last = targets[targets.length - 1];
        if (event.shiftKey && window.document.activeElement === first) { event.preventDefault(); last?.focus(); }
        if (!event.shiftKey && window.document.activeElement === last) { event.preventDefault(); first?.focus(); }
      }
      event.stopPropagation(); return;
    }
    if (event.key !== "Escape" || !popup && !mobileDockOpen || (event.target as Element).closest("[data-editor-number-field], [data-editor-color-field]")) return;
    event.preventDefault(); event.stopPropagation(); setPopup(null); setMobileDockOpen(false); focusMap();
  }} onPointerDownCapture={event => { if (popup && !(event.target as Element).closest("[data-workspace-popover], [data-popup-trigger]")) setPopup(null); }}>
    <header className={styles.header} inert={projectsOpen}>
      {onBack ? <EditorButton type="button" className={styles.back} aria-label={backLink?.label ?? "Назад"} title={backLink?.label ?? "Назад"} onClick={() => { void navigateBack(); }}><ArrowLeft size={17} /></EditorButton>
        : backLink && <a href={backLink.href} onClick={event => { event.preventDefault(); void navigateBack(); }} className={styles.back} aria-label={backLink.label} title={backLink.label}><ArrowLeft size={17} /></a>}
      <div className={styles.brand}><Leaf size={20} /><strong>ENGINE</strong><span>МАСТЕРСКАЯ МИРА</span></div>
      <div className={styles.headerDocument}>
        <EditorButton type="button" className={styles.documentTrigger} data-popup-trigger aria-label="Документ" aria-expanded={popup === "document"} onClick={() => setPopup(popup === "document" ? null : "document")}><FileJson size={16} /><span>Документ</span><ChevronDown size={14} /></EditorButton>
        {popup === "document" && <div className={styles.documentMenu} data-workspace-popover aria-label="Действия со сценой">
          <div className={styles.menuHeading}><strong>{status.projectName ?? activeDocument?.name ?? documentTitle}</strong><span>{status.width} × {height} · SEED {status.seed}</span></div>
          <EditorButton type="button" disabled={!ready || !!busy} onClick={() => action(() => exportProject())}><FileJson size={16} /> Скачать сцену</EditorButton>
          <EditorButton type="button" disabled={!ready || !!busy} onClick={() => { setPopup(null); sceneFile.current?.click(); }}><Upload size={16} /> Открыть сцену</EditorButton>
          <EditorButton type="button" disabled={!ready || !!busy} onClick={() => { setPopup(null); void fileOperation("Готовим PNG…", target => target.exportPng()); }}><Download size={16} /> Скачать PNG</EditorButton>
          <div className={styles.menuDivider} />
          <EditorButton type="button" disabled={!ready || !!busy || !!workspace.busy || status.width >= MAX_SCENE_DIMENSION} onClick={() => action(() => controller.current?.expand())}><ArrowRight size={16} /> {status.presetId === "empty-v1" ? "Расширить карту вправо" : "Продолжить лес вправо"}</EditorButton>
          <EditorButton type="button" disabled={!ready || !!busy || !!workspace.busy} aria-pressed={status.trees} onClick={() => controller.current?.setLayer("trees", !status.trees)}><Trees size={16} /> Растительность <span className={styles.menuCheck}>{status.trees ? "Вкл" : "Выкл"}</span></EditorButton>
          <EditorButton type="button" disabled={!ready || !!busy || !!workspace.busy} aria-pressed={status.grid} onClick={() => controller.current?.setLayer("grid", !status.grid)}><Grid2X2 size={16} /> Границы участков <span className={styles.menuCheck}>{status.grid ? "Вкл" : "Выкл"}</span></EditorButton>
          <div className={styles.menuDivider} />
          <EditorButton type="button" disabled={!ready || !!busy || !!workspace.busy} onClick={() => action(() => controller.current?.regenerate())}><Shuffle size={16} /> {status.presetId === "empty-v1" ? "Пересоздать основу" : "Другой лес"}</EditorButton>
          <EditorButton type="button" disabled={!ready || !!busy || !!workspace.busy || !status.edited} onClick={() => action(() => controller.current?.resetEdits())}><RotateCcw size={16} /> Сбросить предметы</EditorButton>
          <p className={styles.small}>JSON хранит имя, размеры, предметы, землю, свет и исходные PNG. Импорт создаёт отдельный проект. Сброс и смену леса можно отменить; библиотека PNG, слои и папки сохранятся.</p>
        </div>}
      </div>
      <EditorButton type="button" className={styles.projectsTrigger} aria-label="Проекты" title="Проекты: открыть или создать сцену" disabled={workspace.loading || !!busy || !!workspace.busy} onClick={openProjects}><FolderOpen size={17} /><span>Проекты</span></EditorButton>
      <span className={styles.documentSize}>{status.width} × {height}</span>
      <EditorButton type="button" className={styles.saveIndicator} data-save-state={workspace.state.saveState} aria-label="Сохранить проект" disabled={workspace.loading || !!workspace.busy || !!busy} title={workspace.state.error?.message ?? "Сохранить последние правки в этом браузере"} onClick={() => { void workspace.save(); }}><i data-saved={workspace.state.saveState === "saved"} />{saveMessage}</EditorButton>
      <EditorButton type="button" className={styles.headerIcon} aria-label="Диагностика" title="Диагностика производительности" aria-pressed={diagnosticsOpen} onClick={() => { setDiagnosticsOpen(open => !open); setPopup(null); }}><Activity size={19} /></EditorButton>
      <EditorButton type="button" className={styles.headerIcon} data-popup-trigger aria-label="Клавиши и мышь" title="Клавиши и мышь" aria-expanded={popup === "help"} onClick={() => setPopup(popup === "help" ? null : "help")}><CircleHelp size={19} /></EditorButton>
      <EditorButton type="button" className={styles.panelToggle} aria-label={panelVisible ? "Скрыть панель" : "Открыть панель"} title="Панель предметов и слоёв (L)" aria-expanded={panelVisible} onClick={togglePanel}>{panelVisible ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}<span>Панель</span></EditorButton>
    </header>
    <div className={styles.workspace + (dockOpen ? " " + styles.withDock : "")} inert={projectsOpen || !!busy || !!workspace.busy || workspace.loading || !ready}>
      <section className={styles.mapPanel} aria-label="Тестовая карта леса">
        <canvas ref={canvas} tabIndex={0} className={styles.canvas} aria-label="Лесная карта" aria-describedby="forest-keyboard-help">Для карты требуется Canvas 2D.</canvas>
        <div className={styles.toolRail} role="group" aria-label="Инструмент карты">{modes.map(({ id, label, shortcut, icon: Icon }) => <EditorButton key={id} type="button" disabled={!ready} aria-label={label} aria-keyshortcuts={shortcut} title={label + " (" + shortcut + ")"} aria-pressed={activeMode === id} data-popup-trigger={id === "terrain" ? "" : undefined} onClick={() => { controller.current?.setMode(id); if (id === "terrain") { setTab(current => current === "terrain" ? "object" : current); setMobileDockOpen(false); setPopup(popup === "terrain" ? null : "terrain"); } else if (popup === "terrain") setPopup(null); }}><Icon size={19} /><kbd aria-hidden="true">{shortcut}</kbd></EditorButton>)}<span className={styles.railDivider} /><EditorButton type="button" disabled={!ready} data-popup-trigger aria-label="Палитра предметов" title="Добавить предмет или PNG" aria-expanded={popup === "palette"} onClick={() => setPopup(popup === "palette" ? null : "palette")}><Plus size={21} /></EditorButton></div>
        <div className={styles.historyTools} role="group" aria-label="История правок"><EditorButton type="button" aria-label="Отменить" title="Отменить (Ctrl/⌘ Z)" disabled={!status.canUndo} onClick={() => controller.current?.undo()}><Undo2 size={17} /></EditorButton><EditorButton type="button" aria-label="Повторить" title="Повторить (Ctrl/⌘ Shift Z)" disabled={!status.canRedo} onClick={() => controller.current?.redo()}><Redo2 size={17} /></EditorButton></div>
        {popup === "palette" && <div className={styles.palettePopover} data-workspace-popover aria-label="Добавить на карту"><div className={styles.popoverHeading}><strong>Добавить на карту</strong><EditorButton type="button" aria-label="Закрыть палитру" onClick={closePopup}><X size={16} /></EditorButton></div><div className={styles.palette} role="group" aria-label="Предмет для добавления">{kinds.map(({ kind, name }, index) => <EditorButton type="button" key={kind} disabled={!ready} aria-label={name} title={name + (index < 6 ? " (" + (index + 1) + ")" : "")} aria-pressed={mode === "plant" && status.brush === kind} onClick={() => chooseKind(kind)}><span>{name}</span>{index < 6 && <kbd aria-hidden="true">{index + 1}</kbd>}</EditorButton>)}</div><div className={styles.pngActions} aria-busy={!!busy}><EditorButton type="button" disabled={!ready || !!busy} aria-label="Загрузить PNG" aria-keyshortcuts="7" onClick={() => { setPopup(null); pngFile.current?.click(); }}><ImagePlus size={17} /><span>Загрузить PNG</span><kbd>7</kbd></EditorButton>{sampleImage && <EditorButton type="button" disabled={!ready || !!busy} onClick={() => { void importSampleImage(); }}><House size={17} /> {sampleImage.label}</EditorButton>}</div><p className={styles.small}>PNG до 5 МБ / 4096 px. Прозрачность и пропорции сохраняются.</p>{status.assets.length > 0 && <div className={styles.assetList} role="group" aria-label="Загруженные PNG"><span className={styles.minorHeading}>БИБЛИОТЕКА PNG</span>{status.assets.map(asset => <EditorButton type="button" key={asset.id} disabled={!ready || !!busy} aria-label={"Добавить " + asset.name} title={asset.name} aria-pressed={mode === "plant" && status.brush === "image" && status.brushAssetId === asset.id} onClick={() => action(() => controller.current?.setImageBrush(asset.id))}><ImagePlus size={15} /><span>{asset.name}</span></EditorButton>)}</div>}</div>}
        {popup === "terrain" && <div className={styles.palettePopover} data-workspace-popover aria-label="Кисти земли"><div className={styles.popoverHeading}><strong>Земля · кисть</strong><EditorButton type="button" aria-label="Закрыть кисти земли" onClick={closePopup}><X size={16} /></EditorButton></div><WorkspaceTerrain status={status} controller={editor} compact /></div>}
        {(mode === "plant" || mode === "erase") && !status.temporaryPan && <span className={styles.crosshair} aria-hidden>+</span>}
        {status.temporaryPan && <span className={styles.panHint}>Перемещение карты</span>}
        {!ready && <div className={styles.loading} role={error ? "alert" : "status"}>{error ?? "Открываем карту…"}</div>}
        <div className={styles.mapTools} aria-label="Управление масштабом"><EditorButton type="button" disabled={!ready} onClick={() => controller.current?.zoom(.8)} aria-label="Отдалить" title="Отдалить (−)"><Minus size={18} /></EditorButton><span>{Math.round(status.zoom * 100)}%</span><EditorButton type="button" disabled={!ready} onClick={() => controller.current?.zoom(1.25)} aria-label="Приблизить" title="Приблизить (+)"><Plus size={18} /></EditorButton><EditorButton type="button" disabled={!ready} onClick={() => controller.current?.fit()} aria-label="Показать весь лес" title="Вся карта (0)"><Expand size={17} /></EditorButton></div>
        <div className={styles.mapStatus}><span className={styles.modeName}>{activeMode === "area" ? "Выделить группу" : modes.find(tool => tool.id === activeMode)?.label}{mode === "plant" && !status.temporaryPan ? ": " + editorObjectName(status, status.brush) : ""}</span><span>{activeLayer?.name ?? "Мир"}</span><span className={styles.statusCount}>{status.objects} предметов</span></div>
        <p className={styles.status} role="status">{busy ?? workspace.busy ?? error ?? workspace.state.error?.message ?? workspace.error ?? status.message}</p>
        <p id="forest-keyboard-help" className={styles.srOnly}>V — выбор, H — камера, B — добавить, E — убрать, 7 — загрузить PNG, T — рисовать землю, R — группа по области, L — слои, F — найти выбранный. Тяни углы рамки для размера. Пробел и средняя кнопка двигают карту. Ctrl или Command Z — отменить.</p>
      </section>
      {<><EditorButton type="button" className={styles.drawerBackdrop + (mobileDockOpen ? " " + styles.drawerOpen : "")} aria-label="Закрыть панель" tabIndex={mobileDockOpen ? 0 : -1} onClick={() => setMobileDockOpen(false)} /><aside className={styles.dock + (mobileDockOpen ? " " + styles.drawerOpen : "")} aria-label="Панель редактора" data-desktop-open={dockOpen}><div className={styles.dockHeading}><span>РАБОЧАЯ СЦЕНА</span><EditorButton type="button" aria-label="Закрыть панель" title="Закрыть панель" onClick={() => { if (isMobile) setMobileDockOpen(false); else setDockOpen(false); }}><X size={16} /></EditorButton></div><div className={styles.dockTabs} role="tablist" aria-label="Панель редактора" onKeyDownCapture={event => { if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) return; event.preventDefault(); event.stopPropagation(); const tabs = ["object", "layers", "terrain", "lighting"] as const; const next = event.key === "Home" ? "object" : event.key === "End" ? "lighting" : tabs[(tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? 3 : 2)) % 4]; activateTab(next); document.getElementById("forest-" + next + "-tab")?.focus(); }}><EditorButton type="button" role="tab" id="forest-object-tab" aria-controls="forest-object-panel" aria-selected={tab === "object"} tabIndex={tab === "object" ? 0 : -1} onClick={() => activateTab("object")}><MousePointer2 size={15} /> Предмет</EditorButton><EditorButton type="button" role="tab" id="forest-layers-tab" aria-controls="forest-layers-panel" aria-selected={tab === "layers"} tabIndex={tab === "layers" ? 0 : -1} onClick={() => activateTab("layers")}><Layers size={15} /> Слои</EditorButton><EditorButton type="button" role="tab" id="forest-terrain-tab" aria-controls="forest-terrain-panel" aria-selected={tab === "terrain"} tabIndex={tab === "terrain" ? 0 : -1} onClick={() => activateTab("terrain")}><Paintbrush size={15} /> Земля</EditorButton><EditorButton type="button" role="tab" id="forest-lighting-tab" aria-controls="forest-lighting-panel" aria-selected={tab === "lighting"} tabIndex={tab === "lighting" ? 0 : -1} onClick={() => activateTab("lighting")}><Sun size={15} /> Свет</EditorButton></div><div className={styles.dockBody} role="tabpanel" id="forest-object-panel" aria-labelledby="forest-object-tab" hidden={tab !== "object"}><WorkspaceInspector key={status.selected?.id ?? "empty"} status={status} controller={editor} /></div><div className={styles.dockBody + " " + styles.layersDockBody} role="tabpanel" id="forest-layers-panel" aria-labelledby="forest-layers-tab" hidden={tab !== "layers"}><WorkspaceLayers status={status} controller={editor} onInspect={inspectSelection} onAreaGroup={areaGroup} /></div><div className={styles.dockBody} role="tabpanel" id="forest-terrain-panel" aria-labelledby="forest-terrain-tab" hidden={tab !== "terrain"}><WorkspaceTerrain status={status} controller={editor} /></div><div className={styles.dockBody} role="tabpanel" id="forest-lighting-panel" aria-labelledby="forest-lighting-tab" hidden={tab !== "lighting"}><WorkspaceLighting status={status} controller={editor} /></div></aside></>}
    </div>
    {projectsOpen && <ProjectManager workspace={workspace} externalBusy={!!busy} externalError={error} close={() => { setProjectsOpen(false); focusMap(); }} exportProject={exportProject} importProject={() => sceneFile.current?.click()} renameActive={name => controller.current?.renameProject(name) ?? false} />}
    {diagnosticsOpen && <div inert={projectsOpen}><EngineDiagnosticsPanel controller={editor} profiler={profiler} close={() => setDiagnosticsOpen(false)} /></div>}
    {popup === "help" && <div className={styles.helpPopover} data-workspace-popover aria-label="Клавиши и мышь"><div className={styles.popoverHeading}><strong>Клавиши и мышь</strong><EditorButton type="button" aria-label="Закрыть подсказки" onClick={closePopup}><X size={16} /></EditorButton></div><dl>{[["V / H", "Выбрать предмет / двигать карту"], ["B / E", "Добавить / убрать"], ["T", "Рисовать землю, тропы, песок и воду"], ["R", "Собрать предметы в папку: в рамку должно попасть основание предмета"], ["1–6 / 7", "Предмет из палитры / свой PNG"], ["L / F", "Панель слоёв / найти выбранный"], ["Углы рамки", "Менять размер с сохранением пропорций"], ["Пробел", "Удерживать и тянуть — двигать карту"], ["Shift", "Перенос по одной оси; стрелки — шаг 10"], ["Ctrl/⌘ D", "Дублировать выбранный"], ["Ctrl/⌘ Z", "Отменить; с Shift — повторить"], ["Ctrl/⌘ [ / ]", "Порядок: назад / вперёд; с Shift — в край"], ["Delete / Esc", "Удалить / отменить жест"], ["0 / + / −", "Вся карта / приближение / отдаление"]].map(([key, description]) => <div key={key}><dt><kbd>{key}</kbd></dt><dd>{description}</dd></div>)}</dl><p className={styles.small}>Буквенные клавиши работают и в русской раскладке. Горячие клавиши не мешают вводу текста.</p></div>}
    <input ref={pngFile} type="file" accept="image/png,.png" aria-label="PNG для карты" className={styles.fileInput} onChange={event => { void importPng(event.target.files?.[0]); }} />
    <input ref={sceneFile} type="file" accept="application/json,.json" aria-label="Файл сцены" className={styles.fileInput} onChange={event => { void importScene(event.target.files?.[0]); }} />
  </main>;
}
