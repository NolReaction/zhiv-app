import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { TILED_WORLD } from "@/features/world/scene/presentation";
import type { WorldShadowCaster } from "@/features/world/tiled/types";
import type { WorldDevState } from "./world-dev-store";
import { WORLD_LIGHTING_EDITOR_LIMITS, worldLightingEditorStore } from "./world-lighting-editor-store";
import panelStyles from "./world-dev-panel.module.css";
import styles from "./world-lighting-editor.module.css";

type EditorProps = {
  state: WorldDevState;
  change: (patch: Partial<WorldDevState>) => void;
  worldView?: boolean;
  onOpenWorld?: () => void;
};

type NumberFieldProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  range?: boolean;
  onChange: (value: number) => void;
};

const displayNumber = (value: number) => String(Math.round(value * 1000) / 1000);
const rangeKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** Keep partial keyboard input local; publish only valid values for the live preview. */
function EditorNumberField({ label, value, min, max, step = .1, range = true, onChange }: NumberFieldProps) {
  const id = useId();
  const [entry, setEntry] = useState<string | null>(null);
  const numeric = entry === null || entry.trim() === "" ? NaN : Number(entry);
  const invalid = entry !== null && (!Number.isFinite(numeric) || numeric < min || numeric > max);
  const finish = () => {
    worldLightingEditorStore.commitGesture();
    setEntry(null);
  };
  return <div className={styles.numberField}>
    <label htmlFor={id}>{label}</label>
    <input id={id} type="number" min={min} max={max} step={step}
      value={entry ?? displayNumber(value)} aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${id}-bounds` : undefined}
      onFocus={() => { setEntry(displayNumber(value)); worldLightingEditorStore.beginGesture(); }}
      onChange={event => {
        const text = event.target.value;
        setEntry(text);
        const next = text.trim() === "" ? NaN : Number(text);
        if (Number.isFinite(next) && next >= min && next <= max) {
          worldLightingEditorStore.beginGesture();
          onChange(next);
        }
      }}
      onBlur={finish}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation();
          worldLightingEditorStore.cancelGesture(); setEntry(null); event.currentTarget.blur();
        }
      }} />
    {range && <input type="range" aria-label={`${label} — ползунок`} min={min} max={max} step={step}
      value={value} onPointerDown={() => worldLightingEditorStore.beginGesture()}
      onChange={event => { worldLightingEditorStore.beginGesture(); onChange(Number(event.target.value)); }}
      onPointerUp={() => worldLightingEditorStore.commitGesture()}
      onPointerCancel={() => worldLightingEditorStore.cancelGesture()}
      onBlur={() => worldLightingEditorStore.commitGesture()}
      onKeyDown={event => { if (rangeKeys.has(event.key)) worldLightingEditorStore.beginGesture(); }}
      onKeyUp={event => { if (rangeKeys.has(event.key)) worldLightingEditorStore.commitGesture(); }} />}
    {invalid && <small id={`${id}-bounds`} role="status">Введите число от {displayNumber(min)} до {displayNumber(max)}. Предпросмотр сохраняет последнее допустимое значение.</small>}
  </div>;
}

function casterLabel(caster: WorldShadowCaster) {
  if (!caster.when) return caster.id;
  const site = TILED_WORLD.sites.find(item => item.id === caster.when!.siteId);
  return `${caster.id} · ${site?.label ?? caster.when.siteId}, уровень ${caster.when.level}`;
}

/** Local authoring draft, shared with the map; the export is applied to the Tiled source. */
export function WorldLightingEditor({ state, change, worldView, onOpenWorld }: EditorProps) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe,
    worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const fileInput = useRef<HTMLInputElement>(null);
  const [notice, setNotice] = useState("");
  const [fileError, setFileError] = useState("");
  const selected = snapshot.casters.find(caster => caster.id === snapshot.selectedId);
  const vertexIndex = snapshot.selectedVertex;
  const vertex = selected && vertexIndex !== null ? selected.points[vertexIndex] : null;
  useEffect(() => {
    worldLightingEditorStore.hydrate();
    const saveGesture = () => worldLightingEditorStore.commitGesture();
    window.addEventListener("pagehide", saveGesture);
    return () => { window.removeEventListener("pagehide", saveGesture); saveGesture(); };
  }, []);

  const exportDraft = () => {
    try {
      worldLightingEditorStore.commitGesture();
      const content = worldLightingEditorStore.exportPatch();
      const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
      const anchor = document.createElement("a");
      anchor.href = url; anchor.download = "lighting-patch.json";
      document.body.appendChild(anchor); anchor.click(); anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setFileError(""); setNotice("Экспортирован lighting-patch.json. Примените файл к проекту командой ниже.");
    } catch { setFileError("Не удалось экспортировать правки. Попробуйте ещё раз."); setNotice(""); }
  };

  return <section className={styles.editor} aria-label="Редактор объектов света" data-world-lighting-editor>
    <h4>Редактор объектов</h4>
    <label className={panelStyles.toggle}><input type="checkbox" checked={snapshot.enabled}
      onChange={event => {
        const enabled = event.target.checked;
        worldLightingEditorStore.setEnabled(enabled);
        if (enabled) {
          change({ lightShadows: true, lightDebug: true });
          const first = snapshot.casters.find(caster => !caster.when) ?? snapshot.casters[0];
          if (!snapshot.selectedId && first) worldLightingEditorStore.select(first.id);
        }
      }} /><span>Редактировать контуры и высоты на карте</span></label>
    {worldView !== true && onOpenWorld && <button type="button" onClick={onOpenWorld}>Открыть карту</button>}
    <p className={panelStyles.hint}>Перетаскивайте точки контура. Щёлкните по верхнему контуру, чтобы выбрать объект; пустая карта перемещает камеру. Высота меняет объём тени, размер рисунка остаётся прежним.</p>
    <fieldset className={styles.controls} disabled={!snapshot.enabled}>
      <legend className={styles.srOnly}>Правки выбранного объекта</legend>
      <label className={panelStyles.field}><span>Объект</span>
        <select value={snapshot.selectedId ?? ""} onChange={event => worldLightingEditorStore.select(event.target.value || null)}>
          <option value="">Выберите объект</option>
          {snapshot.casters.map(caster => <option key={caster.id} value={caster.id}>{casterLabel(caster)}{snapshot.dirtyIds.includes(caster.id) ? " · изменён" : ""}</option>)}
        </select>
      </label>
      {selected && <>
        {selected.when && <div className={styles.levelHint}>
          <p className={panelStyles.hint}>Этот объём виден на карте при уровне здания {selected.when.level}.</p>
          <button type="button" onClick={() => change({ levels: { ...state.levels, [selected.when!.siteId]: selected.when!.level } })}>Показать этот уровень здания</button>
        </div>}
        <div className={styles.heightFields}>
          <EditorNumberField key={`${selected.id}-base`} label="Низ объёма" value={selected.baseHeight}
            min={Math.max(0, selected.baseHeight + selected.height - WORLD_LIGHTING_EDITOR_LIMITS.maxHeight)}
            max={selected.baseHeight + selected.height - .1}
            onChange={value => worldLightingEditorStore.patchSelected({ baseHeight: value, height: selected.baseHeight + selected.height - value })} />
          <EditorNumberField key={`${selected.id}-top`} label="Верх объёма" value={selected.baseHeight + selected.height}
            min={selected.baseHeight + .1} max={Math.min(WORLD_LIGHTING_EDITOR_LIMITS.maxTop, selected.baseHeight + WORLD_LIGHTING_EDITOR_LIMITS.maxHeight)}
            onChange={value => worldLightingEditorStore.patchSelected({ height: value - selected.baseHeight })} />
        </div>
        <p className={panelStyles.hint}>Единицы карты. Низ 0 — объект стоит на земле; поднимите низ, чтобы задать крону. Толщина объёма: {displayNumber(selected.height)}.</p>
        <label className={panelStyles.field}><span>Точка контура · {selected.points.length}</span>
          <select value={vertexIndex ?? ""} onChange={event => worldLightingEditorStore.select(selected.id, event.target.value === "" ? null : Number(event.target.value))}>
            <option value="">Выберите точку на карте или здесь</option>
            {selected.points.map((point, index) => <option key={index} value={index}>{index + 1} · X {displayNumber(point.x)}, Y {displayNumber(point.y)}</option>)}
          </select>
        </label>
        {vertex && vertexIndex !== null && <div className={styles.heightFields}>
          <EditorNumberField key={`${selected.id}-${vertexIndex}-x`} label="X точки" value={vertex.x} min={0} max={TILED_WORLD.width} range={false}
            onChange={value => worldLightingEditorStore.moveVertex(vertexIndex, { x: value, y: vertex.y })} />
          <EditorNumberField key={`${selected.id}-${vertexIndex}-y`} label="Y точки" value={vertex.y} min={0} max={TILED_WORLD.height} range={false}
            onChange={value => worldLightingEditorStore.moveVertex(vertexIndex, { x: vertex.x, y: value })} />
        </div>}
        <div className={styles.actions}>
          <button type="button" disabled={vertexIndex === null || selected.points.length >= WORLD_LIGHTING_EDITOR_LIMITS.vertices}
            onClick={() => {
              if (vertexIndex === null) return;
              const from = selected.points[vertexIndex], to = selected.points[(vertexIndex + 1) % selected.points.length];
              worldLightingEditorStore.addVertex(vertexIndex, { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 });
            }}>Добавить точку после выбранной</button>
          <button type="button" disabled={vertexIndex === null || selected.points.length <= 3}
            onClick={() => { if (vertexIndex !== null) worldLightingEditorStore.deleteVertex(vertexIndex); }}>Удалить точку</button>
        </div>
        <p className={panelStyles.hint}>Добавление делит следующее ребро пополам. Контур содержит от 3 до {WORLD_LIGHTING_EDITOR_LIMITS.vertices} точек; пересечения рёбер не допускаются.</p>
        <details className={styles.details}>
          <summary>Прозрачность и мягкость тени</summary>
          <div className={styles.detailsBody}>
            <EditorNumberField key={`${selected.id}-opacity`} label="Плотность тени" value={selected.opacity} min={0} max={1} step={.01}
              onChange={value => worldLightingEditorStore.patchSelected({ opacity: value })} />
            <EditorNumberField key={`${selected.id}-softness`} label="Мягкость края" value={selected.softness} min={0} max={WORLD_LIGHTING_EDITOR_LIMITS.maxSoftness}
              onChange={value => worldLightingEditorStore.patchSelected({ softness: value })} />
          </div>
        </details>
      </>}
    </fieldset>
    <div className={styles.actions}>
      <button type="button" disabled={!snapshot.canUndo} onClick={() => worldLightingEditorStore.undo()}>Отменить</button>
      <button type="button" disabled={!snapshot.canRedo} onClick={() => worldLightingEditorStore.redo()}>Повторить</button>
      <button type="button" disabled={!selected || !snapshot.dirtyIds.includes(selected.id)} onClick={() => worldLightingEditorStore.resetSelected()}>Сбросить объект</button>
      <button type="button" disabled={!snapshot.dirtyIds.length && !snapshot.error} onClick={() => worldLightingEditorStore.resetAll()}>Сбросить все</button>
    </div>
    <p className={panelStyles.hint}>На карте: Ctrl/Cmd+Z — отмена, Ctrl/Cmd+Shift+Z — повтор, Delete — удалить выбранную точку, Esc — отменить перетаскивание.</p>
    <p className={styles.draftStatus} role="status">Изменённых объектов: {snapshot.dirtyIds.length}. Черновик сохраняется в этом браузере. Выключение редактора сохраняет правки.</p>
    {(snapshot.error || fileError) && <p className={panelStyles.error} role="alert">{fileError || snapshot.error}</p>}
    <div className={styles.actions}>
      <button type="button" disabled={!snapshot.dirtyIds.length} onClick={exportDraft}>Экспортировать правки</button>
      <button type="button" onClick={() => fileInput.current?.click()}>Импортировать правки</button>
    </div>
    <input ref={fileInput} type="file" accept=".json,application/json" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file) return;
      setNotice(""); setFileError("");
      if (file.size > 1024 * 1024) { setFileError("Файл слишком большой. Выберите экспорт редактора размером до 1 МБ."); return; }
      try {
        const imported = worldLightingEditorStore.importPatch(await file.text());
        if (imported) setNotice("Правки импортированы. Их можно проверить на карте и отменить.");
      } catch { setFileError("Не удалось прочитать файл. Выберите lighting-patch.json ещё раз."); }
    }} />
    {notice && <p className={panelStyles.hint} role="status">{notice}</p>}
    <details className={styles.details}>
      <summary>Как сохранить разметку в проекте</summary>
      <div className={styles.detailsBody}>
        <p className={panelStyles.hint}>Сохраните карту и закройте её в Tiled. Скачайте файл правок и выполните из папки проекта, указав путь к нему:</p>
        <code className={styles.command}>npm run world:lighting:apply -- ./lighting-patch.json</code>
        <code className={styles.command}>npm run world:export</code>
        <code className={styles.command}>npm run world:check</code>
        <p className={panelStyles.hint}>Команда переносит контуры и высоты в Lighting/ShadowCasters. После применения и обновления страницы браузер покажет данные Tiled.</p>
      </div>
    </details>
  </section>;
}
