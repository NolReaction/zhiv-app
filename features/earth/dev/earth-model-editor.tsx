"use client";

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore, type ChangeEvent } from "react";
import type { Map as LibreMap } from "maplibre-gl";
import { EARTH_LANDMARKS } from "../landmark-catalog";
import { getEarthModelDefinition } from "../landmark-model-registry";
import { exportEarthModelPlacements, getEarthModelPlacements, hydrateEarthModelPlacementDraft, importEarthModelPlacements,
  persistEarthModelPlacementDraft, resetEarthModelPlacements, subscribeEarthModelPlacements, updateEarthModelPlacement, type EarthModelPlacement } from "../model-placement";
import { createEarthModelEditorMap, earthModelEditorCamera } from "./earth-model-editor-map";
import { createEarthModelEditorHistory } from "./earth-model-editor-history";
import { classifyEarthModelEditorShortcut, earthModelEditorShortcutPatch, isEarthModelEditorTextTarget } from "./earth-model-editor-shortcuts";
import { persistEarthModelEditorOpen } from "./earth-model-editor-session";
import styles from "./earth-model-editor.module.css";

const API = "/api/dev/earth-models";
const MAX_IMPORT_BYTES = 64 * 1024;
type NumericField = Exclude<keyof EarthModelPlacement, "id" | "excludeBuildings">;
type Message = { error?: boolean; text: string } | null;

function NumberField({ label, value, min, max, step = 1, onChange, onEditStart, onEditEnd }: {
  label: string; value: number; min: number; max: number; step?: number; onChange: (value: number) => void;
  onEditStart: () => void; onEditEnd: () => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const [lastValue, setLastValue] = useState(value);
  // Keep partial entries ("-", "2.") editable while external reset/import updates
  // the field immediately. Effects must not briefly render the old placement.
  if (value !== lastValue) {
    setLastValue(value);
    if (!draft.trim() || Number(draft) !== value) setDraft(String(value));
  }
  return <label className={styles.field}><span>{label}</span><input type="number" inputMode="decimal" min={min} max={max} step={step} title={`От ${min} до ${max}`}
    value={draft} onFocus={onEditStart} onChange={event => {
      const text = event.currentTarget.value;
      setDraft(text);
      const number = Number(text);
      if (text.trim() && Number.isFinite(number) && number >= min && number <= max) onChange(number);
    }} onBlur={() => { setDraft(String(value)); onEditEnd(); }} onKeyDown={event => {
      if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === "Escape") { event.stopPropagation(); setDraft(String(value)); event.currentTarget.blur(); }
    }} /></label>;
}

function placementName(id: string) { return EARTH_LANDMARKS.find(item => item.id === id)?.nameRussian ?? id; }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : "Не удалось выполнить действие."; }
async function projectResponse(response: Response) {
  let result;
  try { result = await response.json(); } catch { /* A stopped/restarting dev server can return HTML. */ }
  if (!response.ok || !result || typeof result.revision !== "string") {
    if (response.status === 403) throw new Error("Открой карту по localhost или локальному IP компьютера. Через публичный адрес запись в проект недоступна.");
    throw new Error(typeof result?.message === "string" ? result.message : "Не удалось подключиться к сохранению проекта. Перезапусти dev-сервер и нажми сохранить снова.");
  }
  return result as { revision: string };
}

/** The parent imports and mounts this editor only in development. */
export function EarthModelEditor({ map, visible, open, onOpenChange }: {
  map: LibreMap; visible: boolean; open: boolean; onOpenChange: (open: boolean) => void;
}) {
  const placements = useSyncExternalStore(subscribeEarthModelPlacements, getEarthModelPlacements, getEarthModelPlacements);
  const [history] = useState(createEarthModelEditorHistory);
  const historyState = useSyncExternalStore(history.subscribe, history.getSnapshot, history.getSnapshot);
  const [selectedId, setSelectedId] = useState(() => placements[0]?.id ?? "");
  const selected = placements.find(item => item.id === selectedId) ?? placements[0] ?? null;
  const baseHeightMeters = selected ? getEarthModelDefinition(selected.id)?.heightMeters ?? selected.heightMeters : 1;
  const [placing, setPlacing] = useState(false);
  const [message, setMessage] = useState<Message>(null);
  const [revision, setRevision] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [conflicted, setConflicted] = useState(false);
  const initialRequest = useRef<AbortController | null>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const panel = useRef<HTMLElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const activeId = useRef<string | null>(null);
  const rangeGesture = useRef<{ input: HTMLInputElement; cancelled: boolean } | null>(null);
  const preview = useRef<ReturnType<typeof createEarthModelEditorMap> | null>(null);
  const panelId = useId();

  const applyPatch = useCallback((id: string, patch: Partial<EarthModelPlacement>) => {
    try { updateEarthModelPlacement(id, patch); return true; }
    catch (error) { setMessage({ error: true, text: errorMessage(error) }); return false; }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    initialRequest.current = controller;
    let mounted = true;
    let disconnectHistory = () => {};
    async function initialize() {
      try { hydrateEarthModelPlacementDraft(window.localStorage); }
      catch { if (mounted) setMessage({ error: true, text: "Черновик браузера не удалось прочитать. Можно импортировать JSON или сбросить настройки." }); }
      disconnectHistory = history.connect();
      try {
        const response = await fetch(API, { cache: "no-store", signal: controller.signal });
        const result = await projectResponse(response);
        if (mounted && !controller.signal.aborted) { setRevision(result.revision); setProjectError(null); }
      } catch (error) {
        if (mounted && !controller.signal.aborted) setProjectError(errorMessage(error));
      }
    }
    void initialize();
    const unsubscribe = subscribeEarthModelPlacements(() => {
      try { persistEarthModelPlacementDraft(window.localStorage); }
      catch { setMessage({ error: true, text: "Браузер не сохранил черновик. Скачай JSON, чтобы сохранить правки." }); }
    });
    return () => { mounted = false; controller.abort(); initialRequest.current = null; unsubscribe(); disconnectHistory(); };
  }, [history]);

  useEffect(() => {
    if (!open || !visible) return;
    heading.current?.focus({ preventScroll: true });
    const controller = createEarthModelEditorMap(map, {
      onMoveStart: history.beginTransaction,
      onMoveEnd: history.endTransaction,
      onMove(longitude, latitude) { if (activeId.current) applyPatch(activeId.current, { longitude, latitude }); },
      onPlace(longitude, latitude) {
        const applied = activeId.current && applyPatch(activeId.current, { longitude, latitude });
        setPlacing(false);
        if (applied) setMessage({ text: "Положение обновлено. Потяни зелёную точку для точной настройки." });
      },
    });
    preview.current = controller;
    return () => { preview.current = null; controller.dispose(); };
  }, [map, open, visible, applyPatch, history]);

  useEffect(() => {
    activeId.current = selected?.id ?? null;
    preview.current?.update(selected, placing);
  }, [selected, placing, open, visible]);

  const setEditorOpen = useCallback((value: boolean) => {
    onOpenChange(value);
    // Writing the source JSON can trigger a full development reload. Remember
    // only this panel preference within the tab so the workshop stays open.
    persistEarthModelEditorOpen(value);
  }, [onOpenChange]);
  const close = useCallback(() => { history.endTransaction(); setEditorOpen(false); setPlacing(false); trigger.current?.focus({ preventScroll: true }); }, [setEditorOpen, history]);
  const undo = useCallback(() => {
    preview.current?.finishDrag();
    if (rangeGesture.current) rangeGesture.current.cancelled = true;
    history.undo(); setPlacing(false); setMessage(null);
  }, [history]);
  const redo = useCallback(() => {
    preview.current?.finishDrag();
    if (rangeGesture.current) rangeGesture.current.cancelled = true;
    history.redo(); setPlacing(false); setMessage(null);
  }, [history]);
  const focusObject = useCallback(() => {
    preview.current?.finishDrag();
    const selected = getEarthModelPlacements().find(item => item.id === activeId.current);
    if (!selected) return;
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const container = map.getContainer();
    const rect = container.getBoundingClientRect();
    const editorRect = panel.current?.getBoundingClientRect();
    const width = container.clientWidth;
    const height = container.clientHeight;
    const available = width <= 600
      ? { left: 20, top: 24, right: width - 20, bottom: editorRect ? editorRect.top - rect.top - 16 : height * .48 }
      : { left: editorRect ? editorRect.right - rect.left + 20 : 380, top: 32, right: width - 76, bottom: height - 112 };
    map.flyTo({ ...earthModelEditorCamera(selected, { width, height, available, verticalFieldOfView: map.getVerticalFieldOfView() }),
      duration: reduced ? 0 : 650, essential: false });
  }, [map]);
  useEffect(() => {
    if (!visible || !open) return;
    const finishRangeGesture = () => { if (rangeGesture.current) { rangeGesture.current = null; history.endTransaction(); } };
    window.addEventListener("pointerup", finishRangeGesture);
    window.addEventListener("pointercancel", finishRangeGesture);
    window.addEventListener("blur", finishRangeGesture);
    return () => {
      window.removeEventListener("pointerup", finishRangeGesture); window.removeEventListener("pointercancel", finishRangeGesture);
      window.removeEventListener("blur", finishRangeGesture);
      finishRangeGesture();
    };
  }, [history, open, visible]);
  useEffect(() => {
    if (!visible || !open) return;
    let gestureKey: string | null = null;
    const finishGesture = () => { gestureKey = null; history.endTransaction(); };
    const keydown = (event: KeyboardEvent) => {
      const target = event.target;
      if (!(target instanceof Node) || !(root.current?.contains(target) || map.getContainer().contains(target))) return;
      // Text fields keep native editing, including their own Escape and undo.
      if (event.key === "Escape" && !event.defaultPrevented && !event.isComposing && !isEarthModelEditorTextTarget(target)) {
        event.preventDefault(); event.stopPropagation(); finishGesture();
        if (placing) setPlacing(false); else close();
        return;
      }
      const action = classifyEarthModelEditorShortcut(event);
      if (!action) return;
      event.preventDefault(); event.stopPropagation();
      if (action.type === "undo") { finishGesture(); undo(); return; }
      if (action.type === "redo") { finishGesture(); redo(); return; }
      if (action.type === "focus") { finishGesture(); focusObject(); return; }
      const placement = getEarthModelPlacements().find(item => item.id === activeId.current);
      if (!placement) return;
      const patch = earthModelEditorShortcutPatch(placement, action, getEarthModelDefinition(placement.id)?.heightMeters ?? placement.heightMeters);
      if (!patch) return;
      if (!event.repeat) finishGesture();
      gestureKey = event.code || event.key;
      history.beginTransaction();
      applyPatch(placement.id, patch);
    };
    const keyup = (event: KeyboardEvent) => { if ((event.code || event.key) === gestureKey) finishGesture(); };
    // Capture before MapLibre handles arrows/+/- as camera controls.
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("keyup", keyup);
    window.addEventListener("blur", finishGesture);
    return () => {
      window.removeEventListener("keydown", keydown, true); window.removeEventListener("keyup", keyup);
      window.removeEventListener("blur", finishGesture);
      finishGesture();
    };
  }, [applyPatch, close, focusObject, history, map, open, placing, redo, undo, visible]);

  function update(field: NumericField, value: number) { if (selected) applyPatch(selected.id, { [field]: value }); }
  const editEvents = { onEditStart: history.beginTransaction, onEditEnd: history.endTransaction };
  const rangeEvents = {
    onFocus: history.beginTransaction,
    onPointerDown: (event: { currentTarget: HTMLInputElement }) => {
      rangeGesture.current = { input: event.currentTarget, cancelled: false }; history.beginTransaction();
    },
    onBlur: history.endTransaction, onKeyDown: history.beginTransaction, onKeyUp: history.endTransaction,
  };
  function updateRange(field: "heightMeters" | "headingDegrees", event: ChangeEvent<HTMLInputElement>, currentValue: number) {
    if (rangeGesture.current?.input === event.currentTarget && rangeGesture.current.cancelled) {
      // An undo during a native slider drag must stay applied until release.
      event.currentTarget.value = String(currentValue);
      return;
    }
    update(field, Number(event.currentTarget.value));
  }
  function resize(percentDelta: number) {
    if (!selected) return;
    const patch = earthModelEditorShortcutPatch(selected, { type: "resize", percentDelta }, baseHeightMeters);
    if (patch) { history.endTransaction(); applyPatch(selected.id, patch); }
  }
  function exportJson() {
    const url = URL.createObjectURL(new Blob([exportEarthModelPlacements()], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url; link.download = "model-placements.json";
    document.body.append(link); link.click(); link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    setMessage({ text: "JSON скачан. Его можно импортировать здесь или заменить features/earth/data/model-placements.json." });
  }
  async function importJson(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    try {
      if (file.size > MAX_IMPORT_BYTES) throw new Error("JSON слишком большой: максимум 64 КБ.");
      history.endTransaction();
      importEarthModelPlacements(JSON.parse(await file.text()));
      setPlacing(false);
      setMessage({ text: "JSON применён к карте и сохранён в черновик браузера." });
    } catch (error) { setMessage({ error: true, text: `Импорт не выполнен: ${errorMessage(error)}` }); }
  }
  async function saveProject() {
    if (saving || conflicted) return;
    initialRequest.current?.abort();
    const documentText = exportEarthModelPlacements();
    setSaving(true);
    setMessage(null);
    try {
      // A failed initial GET must not permanently disable the only save action.
      const currentRevision = revision ?? (await projectResponse(await fetch(API, { cache: "no-store" }))).revision;
      const response = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ document: JSON.parse(documentText), revision: currentRevision }) });
      if (response.status === 409) {
        setRevision(null);
        setConflicted(true);
        throw new Error("Файл изменился в другом окне. Скачай свои правки в JSON и обнови страницу перед записью.");
      }
      const result = await projectResponse(response);
      setRevision(result.revision);
      setProjectError(null);
      setMessage({ text: documentText === exportEarthModelPlacements() ? "Настройки записаны в проект. Их можно коммитить в earth." : "Проект сохранён. Более новые правки ещё в черновике: нажми сохранить снова." });
    } catch (error) { setProjectError(errorMessage(error)); }
    finally { setSaving(false); }
  }

  if (!visible) return null;
  return <div ref={root} className={styles.root}>
    <button ref={trigger} type="button" className={styles.trigger} aria-expanded={open} aria-controls={panelId}
      onClick={() => { if (open) close(); else setEditorOpen(true); }}>DEV 3D</button>
    {open && <section ref={panel} id={panelId} className={styles.panel} aria-label="Редактор 3D-моделей">
      <header><div><span className={styles.eyebrow}>НАСТРОЙКА НА КАРТЕ</span><h2 tabIndex={-1} ref={heading}>3D-модели</h2></div>
        <button type="button" aria-label="Закрыть редактор" onClick={close}>×</button></header>
      {selected ? <>
        <div className={styles.actions} aria-label="История изменений">
          <button type="button" disabled={!historyState.canUndo} aria-keyshortcuts="Control+Z Meta+Z" title="Ctrl/Cmd+Z" onClick={undo}>↶ Отменить</button>
          <button type="button" disabled={!historyState.canRedo} aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y" title="Ctrl/Cmd+Shift+Z или Ctrl+Y" onClick={redo}>↷ Повторить</button>
        </div>
        <label className={styles.objectSelect}>Объект<select value={selected.id} onChange={event => { history.endTransaction(); setSelectedId(event.currentTarget.value); setPlacing(false); }}>
          {placements.map(item => <option value={item.id} key={item.id}>{placementName(item.id)}</option>)}
        </select></label>
        <div className={styles.actions}><button type="button" onClick={focusObject}>К объекту</button>
          <button type="button" aria-pressed={placing} onClick={() => setPlacing(value => !value)}>{placing ? "Отменить установку" : "Поставить на карте"}</button></div>
        {placing && <p role="status" className={styles.placing}>Нажми на нужное место карты. Escape отменяет установку.</p>}
        <div className={styles.grid}>
          <NumberField {...editEvents} label="Долгота" value={selected.longitude} min={-180} max={180} step={.00001} onChange={value => update("longitude", value)} />
          <NumberField {...editEvents} label="Широта" value={selected.latitude} min={-85} max={85} step={.00001} onChange={value => update("latitude", value)} />
          <NumberField {...editEvents} label="Высота модели, м" value={selected.heightMeters} min={1} max={1000} step={.1} onChange={value => update("heightMeters", value)} />
          <NumberField {...editEvents} label="Над землёй, м" value={selected.elevationMeters} min={-100} max={1000} step={.5} onChange={value => update("elevationMeters", value)} />
        </div>
        <div className={styles.size}>
          <label className={styles.rotationSlider}><span>Размер модели <output>{(selected.heightMeters / baseHeightMeters * 100).toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%</output></span>
            <input type="range" min="1" max="1000" step="0.1" aria-label="Размер модели" aria-valuetext={`${(selected.heightMeters / baseHeightMeters * 100).toFixed(1)}%`}
              {...rangeEvents} value={selected.heightMeters} onChange={event => updateRange("heightMeters", event, selected.heightMeters)} /></label>
          <div className={styles.actions}><button type="button" title="Уменьшить на 10% исходного размера" onClick={() => resize(-10)}>Меньше</button>
            <button type="button" title={`Исходный размер: ${baseHeightMeters} м`} onClick={() => update("heightMeters", baseHeightMeters)}>100%</button>
            <button type="button" title="Увеличить на 10% исходного размера" onClick={() => resize(10)}>Больше</button></div>
          <p className={styles.hint}>Размер сохраняет пропорции модели. После увеличения проверь радиус исключения зданий.</p>
        </div>
        <div className={styles.rotation}><NumberField {...editEvents} label="Поворот, °" value={selected.headingDegrees} min={-360} max={360} onChange={value => update("headingDegrees", value)} />
          <button type="button" aria-label="Повернуть на 5 градусов против часовой стрелки" onClick={() => update("headingDegrees", (selected.headingDegrees - 5 + 360) % 360)}>−5°</button>
          <button type="button" aria-label="Повернуть на 5 градусов по часовой стрелке" onClick={() => update("headingDegrees", (selected.headingDegrees + 5 + 360) % 360)}>+5°</button></div>
        <label className={styles.rotationSlider}><span className={styles.srOnly}>Поворот модели на карте</span><input type="range" min="0" max="360" step="1"
          {...rangeEvents} value={(selected.headingDegrees + 360) % 360} onChange={event => updateRange("headingDegrees", event, (selected.headingDegrees + 360) % 360)} /></label>
        <div className={styles.exclusion}>
          <label className={styles.check}><input type="checkbox" checked={selected.excludeBuildings} onChange={event => applyPatch(selected.id, { excludeBuildings: event.currentTarget.checked })} />Убрать здания карты под моделью</label>
          <NumberField {...editEvents} label="Радиус исключения, м" value={selected.exclusionRadiusMeters} min={0} max={300} onChange={value => update("exclusionRadiusMeters", value)} />
          <p>Оранжевый круг показывает зону исключения. Остальной город остаётся объёмным.</p>
        </div>
        <p className={styles.hint}>Зелёную точку можно перетащить мышью. На телефоне используй «Поставить на карте». Линия показывает поворот относительно севера.</p>
        <details className={styles.shortcuts}><summary>Горячие клавиши</summary><dl>
          <dt>Ctrl / Cmd + Z</dt><dd>Отменить</dd><dt>Ctrl / Cmd + Shift + Z, Ctrl + Y</dt><dd>Повторить</dd>
          <dt>← ↑ ↓ →</dt><dd>Сдвиг на 1 м по сторонам света</dd><dt>[ / ]</dt><dd>Поворот на 1°</dd><dt>− / =</dt><dd>Размер ±1% исходного</dd>
          <dt>Shift</dt><dd>Шаг: 10 м, 15° или 10%</dd><dt>F</dt><dd>К объекту</dd><dt>Esc</dt><dd>Отменить установку / закрыть</dd>
        </dl><p className={styles.hint}>Клавиши работают при открытой панели, когда фокус на карте или в редакторе. В числовых полях действует обычная отмена ввода.</p></details>
      </> : <p>В каталоге пока нет моделей.</p>}
      <footer>
        <button className={styles.primary} type="button" disabled={conflicted || saving} aria-busy={saving}
          title={conflicted ? "Скачай свои правки и обнови страницу: файл проекта изменился." : "Записать настройки в features/earth/data/model-placements.json"}
          onClick={() => void saveProject()}>{saving ? "Сохраняем…" : "Сохранить в проект"}</button>
        {projectError && <p className={styles.message} data-error="true" role="alert">{projectError}</p>}
        <div className={styles.actions}><button type="button" onClick={exportJson}>Скачать JSON</button><button type="button" onClick={() => importInput.current?.click()}>Импорт JSON</button>
          <button type="button" onClick={() => { history.endTransaction(); resetEarthModelPlacements(); setPlacing(false); setMessage({ text: "Восстановлены настройки из проекта. Для записи сброса нажми «Сохранить в проект»." }); }}>Сбросить</button></div>
        <input ref={importInput} className={styles.srOnly} type="file" accept="application/json,.json" tabIndex={-1} aria-label="Импортировать настройки моделей" onChange={event => void importJson(event)} />
        <p className={styles.hint}>Правки видны сразу. Черновик хранится в этом браузере; запись в проект выполняется отдельной кнопкой.</p>
        {message && <p className={styles.message} data-error={Boolean(message.error)} role={message.error ? "alert" : "status"}>{message.text}</p>}
      </footer>
    </section>}
  </div>;
}
