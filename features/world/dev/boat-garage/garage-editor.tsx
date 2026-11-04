"use client";

import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import Link from "next/link";
import { ArrowLeft, Crosshair, Download, Eye, FolderPlus, Hand, ImagePlus, Layers, MousePointer2, Redo2, Save, Undo2, Upload } from "lucide-react";
import defaultScene from "./garage-scene-default.json";
import { duplicateGarageNode, removeGarageNode, validateGarageScene } from "./garage-scene-model.mjs";
import type { GarageAsset, GarageNode, GarageScene } from "./garage-scene-types";
import { GarageInspector, GarageNumber } from "./garage-inspector";
import { GARAGE_DEVICES, GarageStage, type GarageTool } from "./garage-stage";
import styles from "./garage-editor.module.css";

const DRAFT_KEY = "zhiv:boat-garage:scene:v1";
const ENDPOINT = "/api/dev/boat-garage";
const initialScene = validateGarageScene(defaultScene);
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
  const preview = useRef<HTMLDivElement>(null), imageInput = useRef<HTMLInputElement>(null), jsonInput = useRef<HTMLInputElement>(null);
  const device = GARAGE_DEVICES.find(item => item.id === deviceId)!;
  const selected = scene.nodes.find(item => item.id === selectedId);
  const cameraMode = device.width > device.height || device.width >= 700 ? "landscape" : "portrait";
  const camera = scene.cameras[cameraMode];
  const dirty = JSON.stringify(scene) !== saved;

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
    const measure = () => setPreviewScale(Math.max(.12, Math.min(1, (element.clientWidth - 32) / device.width, (element.clientHeight - 32) / device.height)));
    const observer = new ResizeObserver(measure); observer.observe(element); measure();
    return () => observer.disconnect();
  }, [device]);

  function change(next: GarageScene, record = true) {
    try {
      const validated = validateGarageScene(next);
      setHistory(current => ({ past: record ? [...current.past, current.scene].slice(-40) : current.past, scene: validated, future: [] }));
    } catch (error) { setNotice(error instanceof Error ? error.message : "Изменение не применено."); }
  }
  function undo() { setHistory(current => current.past.length ? { past: current.past.slice(0, -1), scene: current.past.at(-1)!, future: [current.scene, ...current.future] } : current); }
  function redo() { setHistory(current => current.future.length ? { past: [...current.past, current.scene], scene: current.future[0], future: current.future.slice(1) } : current); }
  function patchNode(changes: Partial<GarageNode>) {
    if (!selected || selected.locked) return;
    change({ ...scene, nodes: scene.nodes.map(item => item.id === selected.id ? { ...item, ...changes } : item) });
  }
  function remove() { if (selected && !selected.locked) { change(removeGarageNode(scene, selected.id)); setSelectedId(null); } }
  function duplicate() {
    if (!selected) return;
    try { const next = duplicateGarageNode(scene, selected.id); change(next); setSelectedId(next.nodes.at(-1)!.id); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Не удалось создать копию."); }
  }
  function add(asset?: GarageAsset) {
    const node: GarageNode = { id: `part-${crypto.randomUUID().slice(0, 8)}`, name: asset?.name ?? "Новая группа", assetId: asset?.id ?? null,
      parentId: null, socketId: null, x: camera.x, y: camera.y, width: asset?.width ?? 1000, height: asset?.height ?? 650,
      scale: asset ? Math.min(350 / asset.width, 220 / asset.height) : 1, rotation: 0, pivotX: .5, pivotY: .5,
      zIndex: 20, visible: true, locked: false, sockets: [] };
    change({ ...scene, nodes: [...scene.nodes, node] }); setSelectedId(node.id);
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
        parentId: null, socketId: null, x: camera.x, y: camera.y, width: asset.width, height: asset.height,
        scale: Math.min(350 / asset.width, 220 / asset.height), rotation: 0, pivotX: .5, pivotY: .5, zIndex: 20, visible: true, locked: false, sockets: [] };
      change({ ...scene, assets: scene.assets.some(item => item.id === asset.id) ? scene.assets : [...scene.assets, asset], nodes: [...scene.nodes, node] });
      setSelectedId(node.id); setNotice("Изображение добавлено. Расставьте деталь и сохраните сборку.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Ошибка загрузки."); }
    finally { setBusy(false); }
  }
  async function save() {
    if (!revision) return;
    setBusy(true);
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
  function keyboard(event: KeyboardEvent) {
    if (busy || !ready) return;
    if (event.target instanceof HTMLElement && event.target.closest("input,select,textarea")) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); if (event.shiftKey) redo(); else undo(); return; }
    if (event.target instanceof HTMLElement && event.target.closest("button,a")) return;
    if (event.key === "Escape") { setTool("move"); return; }
    if (clean) return;
    if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); remove(); return; }
    const step = event.shiftKey ? 10 : 1;
    if (selected && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault(); patchNode({ x: selected.x + (event.key === "ArrowLeft" ? -step : event.key === "ArrowRight" ? step : 0),
        y: selected.y + (event.key === "ArrowUp" ? -step : event.key === "ArrowDown" ? step : 0) });
    }
  }

  return <main className={styles.editor} onKeyDown={keyboard} tabIndex={-1}>
    <header className={styles.header}><Link href="/" aria-label="Вернуться в игру"><ArrowLeft size={19} /></Link>
      <div className={styles.heading}><small>МОХЛИК · ИНСТРУМЕНТЫ РАЗРАБОТКИ</small><h1>Сборщик лодки</h1></div>
      <span className={styles.saveState}>{dirty ? "Есть изменения" : revision ? "Сцена сохранена" : "Шаблон сцены"}</span>
      <div className={styles.row}><button type="button" onClick={undo} disabled={!history.past.length || busy} title="Отменить"><Undo2 size={17} /></button>
        <button type="button" onClick={redo} disabled={!history.future.length || busy} title="Повторить"><Redo2 size={17} /></button>
        <button type="button" onClick={exportScene} disabled={!ready || busy}><Download size={16} />JSON</button>
        <button className={styles.primary} type="button" onClick={save} disabled={!revision || busy || !dirty}><Save size={16} />В проект</button></div>
    </header>
    <div className={styles.status} role="status">{notice}{draftAvailable && <span><button type="button" disabled={busy} onClick={restoreDraft}>Восстановить черновик</button><button type="button" disabled={busy} onClick={() => { try { localStorage.removeItem(DRAFT_KEY); } catch {} setDraftAvailable(false); }}>Пропустить</button></span>}</div>
    <div className={styles.workspace} inert={busy || !ready}>
      <aside className={styles.library}>
        <div className={styles.sectionHead}><h2>Изображения</h2><button title="Импортировать сборку JSON" type="button" disabled={busy} onClick={() => jsonInput.current?.click()}><Upload size={15} /></button></div>
        <button className={styles.upload} type="button" disabled={busy || !ready} onClick={() => imageInput.current?.click()}><ImagePlus size={18} />Загрузить PNG / WebP</button>
        <input ref={imageInput} hidden type="file" accept="image/png,image/webp,image/jpeg" onChange={event => { const file = event.target.files?.[0]; if (file) void uploadImage(file); event.target.value = ""; }} />
        <input ref={jsonInput} hidden type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) void importScene(file); event.target.value = ""; }} />
        <div className={styles.assets}>{scene.assets.map(asset => <button key={asset.id} type="button" disabled={busy} title="Добавить экземпляр на сцену" onClick={() => add(asset)}>
          {/* Raster originals stay independent from the scene layout. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={asset.src} alt="" /><span>{asset.name}</span><small>{asset.width} × {asset.height}</small></button>)}</div>
        <div className={styles.sectionHead}><h2><Layers size={16} />Слои</h2><button type="button" title="Добавить группу" onClick={() => add()} disabled={busy}><FolderPlus size={16} /></button></div>
        <div className={styles.layers}>{[...scene.nodes].sort((a, b) => b.zIndex - a.zIndex).map(node => <button type="button" key={node.id}
          aria-pressed={selectedId === node.id} onClick={() => setSelectedId(node.id)} className={selectedId === node.id ? styles.selected : ""}>
          <span>{node.parentId ? "↳ " : ""}{node.name}</span><small>{node.locked ? "🔒" : node.visible ? node.zIndex : "скрыт"}</small></button>)}</div>
        <p className={styles.hint}>Корпус, мотор и снаряжение загружайте отдельными изображениями. Для Мохлика понадобятся задняя часть корпуса и передний борт.</p>
      </aside>
      <section className={styles.center} aria-label="Предпросмотр устройств">
        <div className={styles.deviceToolbar}>{GARAGE_DEVICES.map(item => <button type="button" key={item.id} aria-pressed={deviceId === item.id} onClick={() => setDeviceId(item.id)}>{item.name}</button>)}</div>
        <div className={styles.tools}>{([
          ["move", MousePointer2, "Двигать"], ["camera", Hand, "Камера"], ["pivot", Crosshair, "Опора"], ["socket", Crosshair, "Крепление"],
        ] as const).map(([value, Icon, label]) => <button key={value} type="button" disabled={busy || clean} aria-pressed={tool === value} onClick={() => setTool(value)}><Icon size={15} />{label}</button>)}
          <button type="button" aria-pressed={clean} onClick={() => setClean(value => !value)}><Eye size={15} />Без разметки</button></div>
        <div className={styles.preview} ref={preview}>
          <div className={styles.deviceFrame} style={{ width: device.width * previewScale, height: device.height * previewScale }}>
            <div style={{ transform: `scale(${previewScale})`, transformOrigin: "top left" }}>
              <GarageStage scene={scene} device={device} selectedId={selectedId} tool={tool} guides={guides} clean={clean} onSelect={setSelectedId}
                onChange={change} onGestureEnd={before => setHistory(current => JSON.stringify(current.scene) === JSON.stringify(before) ? current : { ...current, past: [...current.past, before].slice(-40), future: [] })} />
            </div>
          </div>
        </div>
        <div className={styles.previewFoot}><span>{device.width} × {device.height} · {Math.round(previewScale * 100)}%</span><label><input type="checkbox" checked={guides} onChange={event => setGuides(event.target.checked)} />Безопасная область</label><span>Панель улучшений — отдельный макет UI</span></div>
        <details className={styles.camera}><summary>Кадр {cameraMode === "portrait" ? "телефона / планшета" : "альбомного экрана"}</summary><div className={styles.fields}>
          {(["x", "y", "width"] as const).map(key => <GarageNumber key={key} label={key === "width" ? "Ширина кадра" : key.toUpperCase()} value={camera[key]} step={10} min={key === "width" ? 300 : -10000}
            onChange={value => change({ ...scene, cameras: { ...scene.cameras, [cameraMode]: { ...camera, [key]: value } } })} />)}
          <button type="button" onClick={() => change({ ...scene, cameras: { ...scene.cameras, [cameraMode]: { x: scene.canvas.width / 2, y: scene.canvas.height / 2, width: cameraMode === "portrait" ? 1280 : scene.canvas.width } } })}>Сбросить кадр</button>
        </div></details>
      </section>
      <GarageInspector scene={scene} node={selected} onChange={change} onDuplicate={duplicate} onRemove={remove} onError={setNotice} />
    </div>
  </main>;
}
