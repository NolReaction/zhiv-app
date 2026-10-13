import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { Focus, Hand, Lightbulb, Move, MousePointer2, Pentagon, Redo2, Search, Sun, Undo2, X, ArrowUpDown } from "lucide-react";
import { TILED_WORLD } from "@/features/world/scene/presentation";
import type { WorldLight } from "@/features/world/tiled/types";
import { worldDevStore, type WorldDevState } from "./world-dev-store";
import { WORLD_LIGHTING_EDITOR_CANCEL_EVENT, WORLD_LIGHTING_EDITOR_LIMITS, worldLightingEditorStore } from "./world-lighting-editor-store";
import { requestWorldLightingEditorFocus } from "./world-lighting-editor-map";
import { requestWorldLightingStudioHandoff } from "./world-lighting-studio-session";
import { LightingNumberField, WorldLightingEditor, lightingCasterName } from "./world-lighting-editor";
import editorStyles from "./world-lighting-editor.module.css";
import styles from "./world-lighting-studio.module.css";

type StudioProps = {
  state: WorldDevState; change: (patch: Partial<WorldDevState>) => void;
  levels?: Readonly<Record<string, number>>;
  worldView?: boolean; onOpenWorld?: () => void; onClose: () => void;
};
type StudioPane = "objects" | "inspector" | "preview";
type ObjectFilter = "all" | "casters" | "lights" | "changed";
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
  worldLightingEditorStore.setOverlay("all");
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

export function WorldLightingSourceInspector({ light }: { light: WorldLight }) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe,
    worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const baseline = TILED_WORLD.lights?.some(item => item.id === light.id);
  const projection = snapshot.lightProjections.find(item => item.id === light.id);
  const position = light.manualPosition ? light.position : projection?.position ?? light.position;
  const height = light.height ?? projection?.height;
  return <section className={editorStyles.editor} aria-label="Свойства источника" data-world-lighting-editor>
    <h3>{lightingSourceName(light)}</h3>
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
        <button type="button" disabled={baseline && light.enabled === false} onClick={() => worldLightingEditorStore.removeLight()}>{baseline ? "Выключить" : "Удалить"}</button>
        <button type="button" disabled={!snapshot.dirtyLightIds.includes(light.id)} onClick={() => worldLightingEditorStore.resetSelected()}>Сбросить источник</button>
      </div>
    </fieldset>
  </section>;
}

function StudioSave() {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe,
    worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const fileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const dirty = snapshot.dirtyIds.length + snapshot.dirtyLightIds.length;
  return <details className={styles.save}><summary>Сохранить · изменений {dirty}</summary><div className={styles.saveBody}>
    <p>Черновик хранится в этом браузере. Экспорт сохранит объекты и источники одним файлом.</p>
    <div className={editorStyles.actions}>
      <button type="button" disabled={!dirty} onClick={() => {
        try {
          worldLightingEditorStore.commitGesture();
          const url = URL.createObjectURL(new Blob([worldLightingEditorStore.exportPatch()], { type: "application/json" }));
          const anchor = document.createElement("a"); anchor.href = url; anchor.download = "lighting-patch.json";
          document.body.appendChild(anchor); anchor.click(); anchor.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 0);
          setError(""); setNotice("Файл lighting-patch.json скачан.");
        } catch { setError("Не удалось экспортировать правки. Попробуйте ещё раз."); }
      }}>Экспортировать</button>
      <button type="button" onClick={() => fileInput.current?.click()}>Импортировать</button>
      <button type="button" disabled={!dirty && !snapshot.error} onClick={() => worldLightingEditorStore.resetAll()}>Сбросить все</button>
    </div>
    <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = ""; if (!file) return;
      setNotice(""); setError("");
      if (file.size > 1024 * 1024) { setError("Выберите файл правок размером до 1 МБ."); return; }
      try { if (worldLightingEditorStore.importPatch(await file.text())) setNotice("Правки импортированы. Проверьте результат на карте."); }
      catch { setError("Не удалось прочитать файл правок."); }
    }} />
    {error && <p className={styles.error} role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    <p>Чтобы перенести правки в проект, сохраните и закройте карту в Tiled. Подставьте путь к скачанному файлу:</p>
    <code>npm run world:lighting:apply -- ./lighting-patch.json</code><code>npm run world:export</code><code>npm run world:check</code>
    <p>Затем откройте карту в Tiled заново и обновите игру.</p>
  </div></details>;
}

/** A non-modal sidebar. The rest of the map keeps its normal pointer surface. */
export function WorldLightingStudio({ state, change, levels, worldView, onOpenWorld, onClose }: StudioProps) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe,
    worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const selectionKey = `${snapshot.selectedKind}:${snapshot.selectedId}`;
  const [paneState, setPaneState] = useState<{ selection: string; value: StudioPane }>({ selection: selectionKey, value: "objects" });
  const pane = paneState.selection === selectionKey ? paneState.value : snapshot.selectedId ? "inspector" : "objects";
  const setPane = (value: StudioPane) => setPaneState({ selection: selectionKey, value });
  const [filter, setFilter] = useState<ObjectFilter>("all");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const id = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const panesRef = useRef<HTMLDivElement>(null);
  const closeCallback = useRef(onClose);
  useEffect(() => { closeCallback.current = onClose; }, [onClose]);
  useEffect(() => {
    if (collapsed) return;
    const content = contentRef.current, body = bodyRef.current;
    if (!content || !body) return;
    body.scrollTop = 0;
    if (window.matchMedia("(max-width: 700px)").matches && pane !== "objects") {
      const top = content.scrollTop + body.getBoundingClientRect().top - content.getBoundingClientRect().top - (panesRef.current?.offsetHeight ?? 0);
      content.scrollTop = Math.max(0, top);
    } else content.scrollTop = 0;
  }, [pane, selectionKey, collapsed]);
  useEffect(() => {
    worldLightingEditorStore.hydrate();
    const save = () => worldLightingEditorStore.commitGesture();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !worldLightingEditorStore.getSnapshot().enabled) return;
      const placing = worldLightingEditorStore.getSnapshot().tool === "light";
      const gesturing = worldLightingEditorStore.isGesturing();
      if (gesturing || placing) {
        window.dispatchEvent(new CustomEvent(WORLD_LIGHTING_EDITOR_CANCEL_EVENT, { detail: event }));
        worldLightingEditorStore.cancelGesture();
        if (placing) worldLightingEditorStore.setTool("select");
        if (event.target instanceof HTMLInputElement) event.target.blur();
      } else {
        if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) {
          event.stopImmediatePropagation(); return;
        }
        closeCallback.current();
      }
      event.preventDefault(); event.stopImmediatePropagation();
    };
    window.addEventListener("pagehide", save); window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("pagehide", save); window.removeEventListener("keydown", escape, true); save(); };
  }, []);
  const needle = query.trim().toLocaleLowerCase("ru-RU");
  const casterItems = snapshot.casters.filter(item => (filter === "all" || filter === "casters" || filter === "changed" && snapshot.dirtyIds.includes(item.id))
    && `${lightingCasterName(item)} ${item.id}`.toLocaleLowerCase("ru-RU").includes(needle));
  const lightItems = snapshot.lights.filter(item => (filter === "all" || filter === "lights" || filter === "changed" && snapshot.dirtyLightIds.includes(item.id))
    && `${lightingSourceName(item)} ${item.id}`.toLocaleLowerCase("ru-RU").includes(needle));
  const selectedLight = snapshot.selectedKind === "light" ? snapshot.lights.find(item => item.id === snapshot.selectedId) : undefined;
  const dirty = snapshot.dirtyIds.length + snapshot.dirtyLightIds.length;
  return <section className={styles.studio} data-world-lighting-studio-panel data-collapsed={collapsed || undefined}
    aria-label="Мастерская света" onKeyDown={event => {
      if (event.target instanceof Element && event.target.closest("input,textarea,select,[contenteditable]")) return;
      if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "z") {
        event.preventDefault(); event.stopPropagation();
        if (event.shiftKey) worldLightingEditorStore.redo(); else worldLightingEditorStore.undo();
        return;
      }
      if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
      const tool = tools.find(item => item.key && item.key.toLowerCase() === event.key.toLowerCase());
      if (tool) { event.preventDefault(); worldLightingEditorStore.setTool(tool.id); }
      else if (event.key.toLowerCase() === "f" && snapshot.selectedId) { event.preventDefault(); focusLightingSelection(); }
    }}>
    <header className={styles.header}><div><h2><Sun size={16} aria-hidden />Свет</h2><span>{dirty ? `${dirty} изменений` : "Черновик без изменений"}</span></div>
      <button className={styles.collapse} type="button" aria-expanded={!collapsed} aria-controls={`${id}-content`}
        onClick={() => setCollapsed(value => !value)}>{collapsed ? "Развернуть" : "Свернуть"}</button>
      <button ref={closeRef} type="button" className={styles.iconButton} aria-label="Закрыть мастерскую света" onClick={onClose}><X size={18} aria-hidden /></button>
    </header>
    <div className={styles.tools} role="toolbar" aria-label="Инструменты света">
      {tools.map(({ id: tool, label, key, Icon }) => <button key={tool} type="button" aria-pressed={snapshot.tool === tool}
        title={`${label}${key ? ` (${key})` : ""}`} onClick={() => worldLightingEditorStore.setTool(tool)}><Icon size={15} aria-hidden /><span>{label}</span>{key && <kbd>{key}</kbd>}</button>)}
    </div>
    <div ref={contentRef} id={`${id}-content`} className={styles.content}>
      <div className={styles.utility}>
        <button type="button" className={styles.iconButton} aria-label="Отменить изменение" title="Отменить · Ctrl/Cmd+Z" disabled={!snapshot.canUndo} onClick={() => worldLightingEditorStore.undo()}><Undo2 size={16} aria-hidden /></button>
        <button type="button" className={styles.iconButton} aria-label="Повторить изменение" title="Повторить · Ctrl/Cmd+Shift+Z" disabled={!snapshot.canRedo} onClick={() => worldLightingEditorStore.redo()}><Redo2 size={16} aria-hidden /></button>
        <button type="button" disabled={!snapshot.selectedId} onClick={focusLightingSelection}><Focus size={15} aria-hidden />Найти · F</button>
        <label className={styles.snap}><span>Шаг</span><select aria-label="Шаг привязки" value={snapshot.snap} onChange={event => worldLightingEditorStore.setSnap(Number(event.target.value) as 0 | 1 | 5 | 10)}>
          <option value={0}>Нет</option><option value={1}>1</option><option value={5}>5</option><option value={10}>10</option>
        </select></label>
      </div>
      <p className={styles.toolHint}>{toolHints[snapshot.tool]}</p>
      <div className={styles.compare} aria-label="Сравнение разметки">
        <button type="button" aria-pressed={snapshot.previewDraft} onClick={() => worldLightingEditorStore.setPreviewDraft(true)}>Черновик</button>
        <button type="button" aria-pressed={!snapshot.previewDraft} onClick={() => worldLightingEditorStore.setPreviewDraft(false)}>Исходное</button>
      </div>
      {!snapshot.previewDraft && <p className={styles.notice}>Показана исходная разметка. Верните черновик, чтобы редактировать.</p>}
      {!worldView && onOpenWorld && <button type="button" onClick={onOpenWorld}>Открыть большую карту</button>}
      <div ref={panesRef} className={styles.panes} role="tablist" aria-label="Разделы мастерской" onKeyDown={event => {
        if (event.ctrlKey || event.metaKey || event.altKey || event.nativeEvent.isComposing) return;
        const panes: StudioPane[] = ["objects", "inspector", "preview"], index = panes.indexOf(pane);
        const next = event.key === "ArrowRight" ? (index + 1) % panes.length : event.key === "ArrowLeft" ? (index + panes.length - 1) % panes.length
          : event.key === "Home" ? 0 : event.key === "End" ? panes.length - 1 : null;
        if (next === null) return;
        event.preventDefault(); event.stopPropagation(); setPane(panes[next]);
        event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus({ preventScroll: true });
      }}>
        {([["objects", "Объекты"], ["inspector", "Свойства"], ["preview", "Вид"]] as const).map(([value, label]) => <button key={value} id={`${id}-tab-${value}`} type="button"
          role="tab" aria-selected={pane === value} tabIndex={pane === value ? 0 : -1} aria-controls={`${id}-pane-${value}`} onClick={() => setPane(value)}>{label}</button>)}
      </div>
      <div ref={bodyRef} className={styles.body}>
        <section role="tabpanel" id={`${id}-pane-objects`} aria-labelledby={`${id}-tab-objects`} hidden={pane !== "objects"}>
          <label className={styles.search}><Search size={14} aria-hidden /><input type="search" aria-label="Найти объект или источник"
            placeholder="Найти объект или источник" value={query} onChange={event => setQuery(event.target.value)} /></label>
          <div className={styles.filters} aria-label="Фильтр списка">{([["all", "Все"], ["casters", "Объекты"], ["lights", "Источники"], ["changed", "Правки"]] as const)
            .map(([value, label]) => <button key={value} type="button" aria-pressed={filter === value} onClick={() => setFilter(value)}>{label}</button>)}</div>
          <ul className={styles.objectList} aria-label="Объекты и источники">
            {casterItems.map(caster => <li key={`caster-${caster.id}`}><button type="button" aria-pressed={snapshot.selectedKind === "caster" && snapshot.selectedId === caster.id}
              onClick={() => { worldLightingEditorStore.select(caster.id); setPane("inspector"); }}><Pentagon size={15} aria-hidden /><span>{lightingCasterName(caster)}
                <small>{caster.when ? `Уровень ${caster.when.level}` : "Объект"}{snapshot.dirtyIds.includes(caster.id) ? " · изменён" : ""}</small></span></button></li>)}
            {lightItems.map(light => <li key={`light-${light.id}`}><button type="button" aria-pressed={snapshot.selectedKind === "light" && snapshot.selectedId === light.id}
              onClick={() => { worldLightingEditorStore.selectLight(light.id); setPane("inspector"); }}><Lightbulb size={15} aria-hidden /><span>{lightingSourceName(light)}
                <small>{light.enabled === false ? "Выключен" : "Источник"}{snapshot.dirtyLightIds.includes(light.id) ? " · изменён" : ""}</small></span></button></li>)}
          </ul>
          {!casterItems.length && !lightItems.length && <p className={styles.notice}>Ничего не найдено. Измените запрос или фильтр.</p>}
          <div className={styles.presets}><h3>Новый источник</h3><div>{lightKinds.map(([kind, label]) => <button key={kind} type="button" disabled={!snapshot.previewDraft}
            aria-pressed={snapshot.tool === "light" && snapshot.lightKind === kind} onClick={() => { worldLightingEditorStore.setLightKind(kind); worldLightingEditorStore.setTool("light"); }}><Lightbulb size={14} aria-hidden />{label}</button>)}</div>
            <p>Выберите тип и нажмите на карту.</p></div>
        </section>
        <section role="tabpanel" id={`${id}-pane-inspector`} aria-labelledby={`${id}-tab-inspector`} hidden={pane !== "inspector"}>
          {selectedLight ? <WorldLightingSourceInspector key={selectedLight.id} light={selectedLight} /> : <WorldLightingEditor state={state} change={change} levels={levels} />}
        </section>
        <section role="tabpanel" id={`${id}-pane-preview`} aria-labelledby={`${id}-tab-preview`} hidden={pane !== "preview"}>
          <div className={styles.preview}>
            <h3>Проверка света</h3><div className={styles.compare}><button type="button" aria-pressed={state.timeOfDay === "day"} onClick={() => change({ timeOfDay: "day" })}>День</button>
              <button type="button" aria-pressed={state.timeOfDay === "night"} onClick={() => change({ timeOfDay: "night" })}>Ночь</button></div>
            <label className={styles.field}><span>Направление · {state.lightAzimuth}°</span><input type="range" aria-label="Направление солнца" min={0} max={360} value={state.lightAzimuth} onChange={event => change({ lightAzimuth: Number(event.target.value) })} /></label>
            <label className={styles.field}><span>Высота солнца · {state.lightElevation}°</span><input type="range" aria-label="Высота солнца" min={10} max={80} value={state.lightElevation} onChange={event => change({ lightElevation: Number(event.target.value) })} /></label>
            <label className={styles.field}><span>Качество</span><select value={state.lightQuality} onChange={event => change({ lightQuality: event.target.value as "low" | "high" })}><option value="low">Бережный</option><option value="high">Детальный</option></select></label>
            <label className={styles.field}><span>Разметка на карте</span><select value={snapshot.overlay} onChange={event => worldLightingEditorStore.setOverlay(event.target.value as "all" | "selected" | "off")}>
              <option value="all">Все объекты и источники</option><option value="selected">Только выбранное</option><option value="off">Скрыть</option></select></label>
            <label className={styles.toggle}><input type="checkbox" checked={state.lightShadows} onChange={event => change({ lightShadows: event.target.checked })} />Показывать тени</label>
            <p>Ночью лучше видно фонари. Низкое солнце делает тени длиннее.</p>
          </div>
        </section>
      </div>
      {snapshot.error && <p className={styles.error} role="alert">{snapshot.error}</p>}
      <StudioSave />
    </div>
  </section>;
}
