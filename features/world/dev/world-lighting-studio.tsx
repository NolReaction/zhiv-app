import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Focus, Hand, Lightbulb, Move, MousePointer2, Pentagon, Redo2, Sun, Undo2, X, ArrowUpDown } from "lucide-react";
import { TILED_WORLD } from "@/features/world/scene/presentation";
import type { WorldLight } from "@/features/world/tiled/types";
import { worldDevStore, type WorldDevState } from "./world-dev-store";
import { WORLD_LIGHTING_EDITOR_CANCEL_EVENT, WORLD_LIGHTING_EDITOR_LIMITS, worldLightingEditorStore } from "./world-lighting-editor-store";
import { requestWorldLightingEditorFocus } from "./world-lighting-editor-map";
import { requestWorldLightingStudioHandoff } from "./world-lighting-studio-session";
import { LightingNumberField, WorldLightingEditor, WorldLightingReceiverInspector } from "./world-lighting-editor";
import { WorldStudioObjects } from "./world-studio-objects";
import { WORLD_STUDIO_TEXT_CANCEL_EVENT, WorldStudioMetadata } from "./world-studio-metadata";
import { WorldStudioSave } from "./world-studio-save";
import editorStyles from "./world-lighting-editor.module.css";
import styles from "./world-lighting-studio.module.css";

type StudioProps = {
  state: WorldDevState; change: (patch: Partial<WorldDevState>) => void;
  levels?: Readonly<Record<string, number>>;
  worldView?: boolean; onOpenWorld?: () => void; onClose: () => void;
};
type StudioPane = "objects" | "inspector" | "preview";
const lightKinds: [WorldLight["kind"], string][] = [["lantern", "Фонарь"], ["torch", "Факел"], ["glow", "Свечение"]];
const tools = [
  { id: "select", label: "Выбрать", key: "V", Icon: MousePointer2 },
  { id: "move", label: "Двигать", key: "G", Icon: Move },
  { id: "vertex", label: "Контур", key: "P", Icon: Pentagon },
  { id: "height", label: "Высота", key: "H", Icon: ArrowUpDown },
  { id: "light", label: "Источник", key: "L", Icon: Lightbulb },
  { id: "pan", label: "Камера", key: "", Icon: Hand },
] as const;
const toolHints = {
  select: "Нажмите на объект или источник, чтобы выбрать его.", move: "Перетаскивайте выбранный объект или источник целиком.",
  vertex: "Перетаскивайте точки. Нажмите на ребро выбранного контура, чтобы добавить точку.", height: "Потяните верхнюю ручку вверх или вниз, чтобы изменить высоту.",
  light: "Нажмите на карту, чтобы поставить источник света.", pan: "Перетаскивайте карту. Колесо или два пальца меняют масштаб.",
};

/** A direct entry from either world view; only local preview settings change. */
export function activateWorldLightingStudio(worldView = false, onOpenWorld?: () => void) {
  worldLightingEditorStore.hydrate();
  worldLightingEditorStore.setEnabled(true);
  worldLightingEditorStore.setTool("select");
  worldLightingEditorStore.setOverlay("selected");
  worldLightingEditorStore.setPreviewDraft(true);
  worldDevStore.patch({ lightShadows: true, lightDebug: false, lightTestLamp: false, timeOfDay: "night" });
  if (!worldView && onOpenWorld) { requestWorldLightingStudioHandoff(); onOpenWorld(); }
}

export function lightingSourceName(light: WorldLight) {
  const names: Record<string, string> = { "home-lantern": "Фонарь дома", "clearing-torch": "Факел на поляне",
    "quarry-torch-1": "Факел у шахты", "north-fork-torch": "Северная развилка", "river-path-torch": "Дорожка у реки",
    "bridge-torch-right": "Факел у моста", "plesk-torch-1": "Факел у Плёски" };
  return names[light.id] ?? `${lightKinds.find(([kind]) => kind === light.kind)?.[1] ?? "Источник"} · ${light.id}`;
}

export function focusLightingSelection() {
  if (worldLightingEditorStore.getSnapshot().selectedId) requestWorldLightingEditorFocus();
}

export function WorldLightingSourceInspector({ light, levels }: { light: WorldLight; levels?: Readonly<Record<string, number>> }) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe,
    worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const baseline = worldLightingEditorStore.getSceneBaseline().lights?.some(item => item.id === light.id);
  const projection = snapshot.lightProjections.find(item => item.id === light.id);
  const position = light.manualPosition ? light.position : projection?.position ?? light.position;
  const height = light.height ?? projection?.height;
  return <section className={editorStyles.editor} aria-label="Свойства источника" data-world-lighting-editor>
    <h3>{light.studioName ?? lightingSourceName(light)}</h3>
    <WorldStudioMetadata key={`light:${light.id}`} kind="light" element={light} automaticName={lightingSourceName(light)} levels={levels} />
    <fieldset className={editorStyles.controls} disabled={!snapshot.previewDraft}>
      <legend className={editorStyles.srOnly}>Параметры света</legend>
      <label className={styles.toggle}><input type="checkbox" checked={light.enabled !== false}
        onChange={event => worldLightingEditorStore.patchLight({ enabled: event.target.checked })} />Источник включён</label>
      <LightingNumberField key={`${light.id}-intensity`} label="Яркость" value={light.intensity} min={0} max={WORLD_LIGHTING_EDITOR_LIMITS.maxLightIntensity} step={.01}
        onChange={value => worldLightingEditorStore.patchLight({ intensity: value })} />
      <LightingNumberField key={`${light.id}-radius`} label="Радиус" value={light.radius} min={1} max={WORLD_LIGHTING_EDITOR_LIMITS.maxLightRadius}
        onChange={value => worldLightingEditorStore.patchLight({ radius: value })} />
      <div className={styles.colorField}><label htmlFor={`light-color-${light.id}`}>Цвет света</label>
        <input id={`light-color-${light.id}`} type="color" value={light.color}
          onFocus={() => worldLightingEditorStore.beginGesture()} onBlur={() => worldLightingEditorStore.commitGesture()}
          onChange={event => worldLightingEditorStore.patchLight({ color: event.target.value })} /><span>{light.color}</span></div>
      {height !== undefined ? <LightingNumberField key={`${light.id}-height`} label="Высота источника" value={height} min={1} max={WORLD_LIGHTING_EDITOR_LIMITS.maxLightHeight}
        onChange={value => worldLightingEditorStore.patchLight({ height: value })} /> : <p className={editorStyles.hint}>Высота источника: авто. Значение появится после загрузки карты.</p>}
      <details className={editorStyles.details}><summary>Положение и мерцание</summary><div className={editorStyles.detailsBody}>
        <div className={editorStyles.heightFields}>
          <LightingNumberField key={`${light.id}-x`} label="X источника" value={position.x} min={0} max={TILED_WORLD.width} range={false}
            onChange={value => worldLightingEditorStore.patchLight({ position: { x: value, y: position.y } })} />
          <LightingNumberField key={`${light.id}-y`} label="Y источника" value={position.y} min={0} max={TILED_WORLD.height} range={false}
            onChange={value => worldLightingEditorStore.patchLight({ position: { x: position.x, y: value } })} />
        </div>
        <LightingNumberField key={`${light.id}-flicker`} label="Мерцание" value={light.flicker} min={0} max={WORLD_LIGHTING_EDITOR_LIMITS.maxLightFlicker} step={.01}
          onChange={value => worldLightingEditorStore.patchLight({ flicker: value })} />
      </div></details>
      <div className={editorStyles.actions}>
        <button type="button" onClick={() => worldLightingEditorStore.duplicateLight()}>Дублировать</button>
        <button type="button" disabled={baseline && light.enabled === false} onClick={() => worldLightingEditorStore.removeLight()}>{baseline ? "Убрать источник" : "Удалить источник"}</button>
        <button type="button" disabled={!snapshot.dirtyLightIds.includes(light.id)} onClick={() => worldLightingEditorStore.resetSelected()}>Сбросить источник</button>
      </div>
    </fieldset>
    <p className={editorStyles.hint}>{baseline ? "Убрать источник выключает его в проекте. Автоматический фонарь здания не появится вместо него. Вернуть можно в папке удалённых." : "Удаление убирает добавленный источник. Ctrl/Cmd+Z отменяет действие."}</p>
  </section>;
}

function StudioView({ state, change }: Pick<StudioProps, "state" | "change">) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe, worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  return <div className={styles.preview}>
    <h3>Освещение и разметка</h3>
    <div className={styles.legend}><p><i data-kind="caster" />Фиолетовый · объём, отбрасывающий тень</p><p><i data-kind="receiver" />Синий · земля, принимающая тень</p><p><i data-kind="light" />Золотой · источник света</p></div>
    <p>Объём задаёт форму и высоту тени. Земля принимает тень внутри своего контура. Рисунки PNG остаются отдельными от разметки.</p>
    <p>День, ночь, солнце и качество меняют только предпросмотр. В файлы проекта сохраняются источники света, объёмы и поверхности.</p>
    <div className={styles.compare}><button type="button" aria-pressed={state.timeOfDay === "day"} onClick={() => change({ timeOfDay: "day" })}>День</button><button type="button" aria-pressed={state.timeOfDay === "night"} onClick={() => change({ timeOfDay: "night" })}>Ночь</button></div>
    <label className={styles.field}><span>Направление · {state.lightAzimuth}°</span><input type="range" aria-label="Направление солнца" min={0} max={360} value={state.lightAzimuth} onChange={event => change({ lightAzimuth: Number(event.target.value) })} /></label>
    <label className={styles.field}><span>Высота солнца · {state.lightElevation}°</span><input type="range" aria-label="Высота солнца" min={10} max={80} value={state.lightElevation} onChange={event => change({ lightElevation: Number(event.target.value) })} /></label>
    <label className={styles.field}><span>Качество</span><select value={state.lightQuality} onChange={event => change({ lightQuality: event.target.value as "low" | "high" })}><option value="low">Бережный</option><option value="high">Детальный</option></select></label>
    <label className={styles.field}><span>Разметка на карте</span><select value={snapshot.overlay} onChange={event => worldLightingEditorStore.setOverlay(event.target.value as "all" | "selected" | "off")}><option value="selected">Только выбранное</option><option value="all">Все включённые типы</option><option value="off">Скрыть контуры</option></select></label>
    <label className={styles.toggle}><input type="checkbox" checked={snapshot.showCasters} onChange={event => worldLightingEditorStore.setShowCasters(event.target.checked)} />Объёмы, отбрасывающие тень</label>
    <label className={styles.toggle}><input type="checkbox" checked={snapshot.showReceivers} onChange={event => worldLightingEditorStore.setShowReceivers(event.target.checked)} />Поверхности, принимающие тень</label>
    <label className={styles.toggle}><input type="checkbox" checked={snapshot.showWireframe} onChange={event => worldLightingEditorStore.setShowWireframe(event.target.checked)} />Объём в высоту · 3D-каркас</label>
    <label className={styles.toggle}><input type="checkbox" checked={state.lightShadows} onChange={event => change({ lightShadows: event.target.checked })} />Показывать рассчитанные тени</label>
    <p>Контур выбранного элемента виден отдельно. Синие поверхности по умолчанию скрыты, пока вы их не выберете.</p>
  </div>;
}

export function WorldLightingStudio({ state, change, levels = state.levels, worldView, onOpenWorld, onClose }: StudioProps) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe, worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const selectionKey = `${snapshot.selectedKind}:${snapshot.selectedId}`;
  const [mobilePane, setMobilePane] = useState<StudioPane>("objects"), [viewOpen, setViewOpen] = useState(false), [collapsed, setCollapsed] = useState(false);
  const inspector = useRef<HTMLDivElement>(null), closeCallback = useRef(onClose);
  useEffect(() => { closeCallback.current = onClose; }, [onClose]);
  useEffect(() => { if (inspector.current) inspector.current.scrollTop = 0; }, [selectionKey]);
  useEffect(() => {
    worldLightingEditorStore.hydrate();
    const save = () => { worldLightingEditorStore.commitGesture(); worldLightingEditorStore.saveDraft(); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !worldLightingEditorStore.getSnapshot().enabled) return;
      if (event.target instanceof Element && event.target.matches("[data-studio-text-field]")) {
        window.dispatchEvent(new CustomEvent(WORLD_STUDIO_TEXT_CANCEL_EVENT, { detail: event.target }));
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      const placing = worldLightingEditorStore.getSnapshot().tool === "light", gesturing = worldLightingEditorStore.isGesturing();
      if (gesturing || placing) {
        window.dispatchEvent(new CustomEvent(WORLD_LIGHTING_EDITOR_CANCEL_EVENT, { detail: event })); worldLightingEditorStore.cancelGesture();
        if (placing) worldLightingEditorStore.setTool("select");
        if (event.target instanceof HTMLInputElement) event.target.blur();
      } else {
        if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) { event.stopImmediatePropagation(); return; }
        closeCallback.current();
      }
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener("pagehide", save); window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("pagehide", save); window.removeEventListener("keydown", escape, true); save(); };
  }, []);
  const selectedLight = snapshot.selectedKind === "light" ? snapshot.lights.find(item => item.id === snapshot.selectedId) : undefined;
  const dirty = snapshot.dirtyIds.length + snapshot.dirtyLightIds.length + snapshot.dirtyReceiverIds.length;
  return <section className={styles.studio} data-world-studio-mode data-mobile-pane={mobilePane} data-collapsed={collapsed || undefined} data-view-open={viewOpen || undefined} aria-label="Студия" onKeyDown={event => {
    if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z") { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) worldLightingEditorStore.redo(); else worldLightingEditorStore.undo(); return; }
    if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
    if ((event.key === "Delete" || event.key === "Backspace") && snapshot.selectedId && snapshot.previewDraft) {
      event.preventDefault(); event.stopPropagation(); worldLightingEditorStore.cancelGesture();
      if (snapshot.tool === "vertex" && snapshot.selectedKind !== "light" && snapshot.selectedVertex !== null) worldLightingEditorStore.deleteVertex(snapshot.selectedVertex); else worldLightingEditorStore.removeSelected();
      return;
    }
    const tool = tools.find(item => item.key && item.key.toLowerCase() === event.key.toLowerCase());
    if (tool) { event.preventDefault(); worldLightingEditorStore.setTool(tool.id); }
    else if (event.key.toLowerCase() === "f" && snapshot.selectedId) { event.preventDefault(); focusLightingSelection(); }
  }}>
    <header className={styles.topbar} data-world-lighting-studio-panel>
      <div className={styles.title}><h2><Sun size={16} aria-hidden />Студия</h2><small>Свет, тени и поверхности · {dirty} правок</small></div>
      <div className={styles.tools} role="toolbar" aria-label="Инструменты студии">{tools.map(({ id: tool, label, key, Icon }) => <button key={tool} type="button" aria-pressed={snapshot.tool === tool} title={`${label}${key ? ` (${key})` : ""}`} onClick={() => worldLightingEditorStore.setTool(tool)}><Icon size={15} aria-hidden /><span>{label}</span>{key && <kbd>{key}</kbd>}</button>)}</div>
      <div className={styles.topActions}><button className={styles.collapse} type="button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? "Развернуть" : "Свернуть"}</button><button type="button" className={styles.iconButton} aria-label="Закрыть студию" onClick={onClose}><X size={18} aria-hidden /></button></div>
      <div className={styles.utility}>
        <button type="button" className={styles.iconButton} aria-label="Отменить изменение" title="Отменить · Ctrl/Cmd+Z" disabled={!snapshot.canUndo} onClick={() => worldLightingEditorStore.undo()}><Undo2 size={16} aria-hidden /></button>
        <button type="button" className={styles.iconButton} aria-label="Повторить изменение" title="Повторить · Ctrl/Cmd+Shift+Z" disabled={!snapshot.canRedo} onClick={() => worldLightingEditorStore.redo()}><Redo2 size={16} aria-hidden /></button>
        <button type="button" disabled={!snapshot.selectedId} onClick={focusLightingSelection}><Focus size={15} aria-hidden />Найти · F</button>
        <label className={styles.snap}><span>Шаг</span><select aria-label="Шаг привязки" value={snapshot.snap} onChange={event => worldLightingEditorStore.setSnap(Number(event.target.value) as 0 | 1 | 5 | 10)}><option value={0}>Нет</option><option value={1}>1</option><option value={5}>5</option><option value={10}>10</option></select></label>
        <div className={styles.compare} aria-label="Сравнение разметки"><button type="button" aria-pressed={snapshot.previewDraft} onClick={() => worldLightingEditorStore.setPreviewDraft(true)}>Черновик</button><button type="button" title="Последняя сохранённая разметка проекта; при недоступном проекте — загруженный экспорт" aria-pressed={!snapshot.previewDraft} onClick={() => worldLightingEditorStore.setPreviewDraft(false)}>Сохранённое</button></div>
        <button type="button" className={styles.desktopView} aria-pressed={viewOpen} onClick={() => setViewOpen(value => !value)}>Вид и легенда</button>
        {!worldView && onOpenWorld && <button type="button" onClick={onOpenWorld}>Большая карта</button>}
      </div>
      <p className={styles.toolHint}>{snapshot.previewDraft ? toolHints[snapshot.tool] : "Показана последняя сохранённая разметка проекта. Верните черновик для редактирования."}</p>
    </header>
    <nav className={styles.mobileNav} aria-label="Панели студии">{([["objects", "Объекты"], ["inspector", "Свойства"], ["preview", "Вид"]] as const).map(([value, label]) => <button key={value} type="button" aria-pressed={mobilePane === value} onClick={() => setMobilePane(value)}>{label}</button>)}</nav>
    <section className={`${styles.panel} ${styles.outliner}`} data-world-lighting-studio-panel aria-label="Объекты студии"><h3 className={styles.panelTitle}>Объекты и папки</h3><WorldStudioObjects levels={levels} onSelect={() => setMobilePane("inspector")} /></section>
    <section className={`${styles.panel} ${styles.inspector}`} data-world-lighting-studio-panel aria-label="Инспектор студии"><h3 className={styles.panelTitle}>Свойства выбранного</h3><div ref={inspector} className={styles.inspectorScroll} data-studio-inspector-scroll>
      {selectedLight ? <WorldLightingSourceInspector key={selectedLight.id} light={selectedLight} levels={levels} /> : snapshot.selectedId ? snapshot.selectedKind === "receiver" ? <WorldLightingReceiverInspector key={snapshot.selectedId} levels={levels} /> : <WorldLightingEditor key={snapshot.selectedId} state={state} change={change} levels={levels} /> : <div className={styles.welcome}><h3>Выберите элемент</h3><p>Список объектов слева остаётся на месте, пока вы меняете свойства справа.</p><p>Объём отбрасывает тень. Поверхность земли принимает её. Источник освещает карту.</p><p>Добавьте элемент внизу списка или выберите существующий на карте.</p></div>}
      {snapshot.error && <p className={styles.error} role="alert">{snapshot.error}</p>}
    </div></section>
    <section className={`${styles.panel} ${styles.viewPanel}`} data-world-lighting-studio-panel aria-label="Вид студии"><div className={styles.panelTitle}><span>Вид и легенда</span><button type="button" className={styles.iconButton} aria-label="Закрыть вид и легенду" onClick={() => setViewOpen(false)}><X size={14} aria-hidden /></button></div><div className={styles.inspectorScroll}><StudioView state={state} change={change} /></div></section>
    <WorldStudioSave />
  </section>;
}
