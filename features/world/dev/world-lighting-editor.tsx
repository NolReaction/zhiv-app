import { useId, useState, useSyncExternalStore } from "react";
import { TILED_WORLD } from "@/features/world/scene/presentation";
import type { WorldShadowCaster } from "@/features/world/tiled/types";
import type { WorldDevState } from "./world-dev-store";
import { WORLD_LIGHTING_EDITOR_LIMITS, worldLightingEditorStore } from "./world-lighting-editor-store";
import { studioReceiverName } from "./world-studio-outliner";
import styles from "./world-lighting-editor.module.css";

type EditorProps = { state: WorldDevState; change: (patch: Partial<WorldDevState>) => void; levels?: Readonly<Record<string, number>> };
type NumberFieldProps = {
  label: string; value: number; min: number; max: number; step?: number; range?: boolean;
  onChange: (value: number) => void;
};
export const displayLightingNumber = (value: number) => String(Math.round(value * 1000) / 1000);
const rangeKeys = new Set(["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"]);

/** Keep partial keyboard input local; publish only valid values for the live preview. */
export function LightingNumberField({ label, value, min, max, step = .1, range = true, onChange }: NumberFieldProps) {
  const id = useId();
  const [entry, setEntry] = useState<string | null>(null);
  const numeric = entry === null || entry.trim() === "" ? NaN : Number(entry);
  const invalid = entry !== null && (!Number.isFinite(numeric) || numeric < min || numeric > max);
  const finish = () => { worldLightingEditorStore.commitGesture(); setEntry(null); };
  return <div className={styles.numberField}>
    <label htmlFor={id}>{label}</label>
    <input id={id} type="number" min={min} max={max} step={step}
      value={entry ?? displayLightingNumber(value)} aria-invalid={invalid || undefined}
      aria-describedby={invalid ? `${id}-bounds` : undefined}
      onFocus={() => { setEntry(displayLightingNumber(value)); worldLightingEditorStore.beginGesture(); }}
      onChange={event => {
        const text = event.target.value; setEntry(text);
        const next = text.trim() === "" ? NaN : Number(text);
        if (Number.isFinite(next) && next >= min && next <= max) {
          worldLightingEditorStore.beginGesture(); onChange(next);
        }
      }} onBlur={finish}
      onKeyDown={event => {
        if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); }
        if (event.key === "Escape") {
          event.preventDefault(); event.stopPropagation(); worldLightingEditorStore.cancelGesture();
          setEntry(null); event.currentTarget.blur();
        }
      }} />
    {range && <input type="range" aria-label={`${label} — ползунок`} min={min} max={max} step={step}
      value={value} onPointerDown={() => worldLightingEditorStore.beginGesture()}
      onChange={event => { worldLightingEditorStore.beginGesture(); onChange(Number(event.target.value)); }}
      onPointerUp={() => worldLightingEditorStore.commitGesture()} onPointerCancel={() => worldLightingEditorStore.cancelGesture()}
      onBlur={() => worldLightingEditorStore.commitGesture()}
      onKeyDown={event => { if (rangeKeys.has(event.key)) worldLightingEditorStore.beginGesture(); }}
      onKeyUp={event => { if (rangeKeys.has(event.key)) worldLightingEditorStore.commitGesture(); }} />}
    {invalid && <small id={`${id}-bounds`} role="status">От {displayLightingNumber(min)} до {displayLightingNumber(max)}. На карте остаётся последнее допустимое значение.</small>}
  </div>;
}

export function lightingCasterName(caster: WorldShadowCaster) {
  if (caster.when) {
    const site = TILED_WORLD.sites.find(item => item.id === caster.when!.siteId);
    return `${site?.label ?? caster.when.siteId} · уровень ${caster.when.level}`;
  }
  const names: Record<string, string> = {
    "clearing-north-trunk": "Северное дерево · ствол", "clearing-north-crown": "Северное дерево · крона",
    "clearing-west-trunk": "Западное дерево · ствол", "clearing-west-crown": "Западное дерево · крона",
    "clearing-boulder": "Камень на поляне",
  };
  return names[caster.id] ?? caster.id;
}

export function previewLightingCasterLevel(caster: WorldShadowCaster, levels: Readonly<Record<string, number>>,
  change: (patch: Partial<WorldDevState>) => void) {
  if (caster.when) change({ previewBuildings: true, levels: { ...levels, [caster.when.siteId]: caster.when.level } });
}

/** Inspector only: selection, navigation, preview and saving belong to the studio. */
export function WorldLightingEditor({ state, change, levels = state.levels }: EditorProps) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe,
    worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const selected = snapshot.selectedKind === "caster" ? snapshot.casters.find(caster => caster.id === snapshot.selectedId) : undefined;
  const index = snapshot.selectedVertex;
  const vertex = selected && index !== null ? selected.points[index] : null;
  if (!selected) return <p className={styles.hint}>Выберите объект на карте или в списке.</p>;
  const activeLevel = selected.when ? levels[selected.when.siteId] : undefined;
  return <section className={styles.editor} aria-label="Свойства объекта" data-world-lighting-editor>
    <h3>{lightingCasterName(selected)}</h3>
    <p className={styles.kindLabel}>Объём, отбрасывающий тень</p>
    <p className={styles.hint}>Фиолетовый контур — форма объёма для расчёта тени. Контур и высота меняют тень; PNG здания или дерева редактируются отдельно.</p>
    {selected.when && <div className={styles.levelHint}>
      <p>Показывается при уровне здания {selected.when.level}.{activeLevel === selected.when.level ? " Этот уровень активен." : ""}</p>
      {activeLevel !== selected.when.level && <button type="button"
        onClick={() => previewLightingCasterLevel(selected, levels, change)}>Показать уровень {selected.when.level}</button>}
    </div>}
    <fieldset className={styles.controls} disabled={!snapshot.enabled || !snapshot.previewDraft}>
      <legend className={styles.srOnly}>Высота и контур</legend>
      <LightingNumberField key={`${selected.id}-height`} label="Высота" value={selected.height} min={.1}
        max={Math.min(WORLD_LIGHTING_EDITOR_LIMITS.maxHeight, WORLD_LIGHTING_EDITOR_LIMITS.maxTop - selected.baseHeight)}
        onChange={value => worldLightingEditorStore.patchSelected({ height: value })} />
      <div className={styles.heightFields}>
        <LightingNumberField key={`${selected.id}-base`} label="Основание" value={selected.baseHeight} min={0}
          max={WORLD_LIGHTING_EDITOR_LIMITS.maxTop - selected.height}
          onChange={value => worldLightingEditorStore.patchSelected({ baseHeight: value })} />
        <LightingNumberField key={`${selected.id}-top`} label="Верх" value={selected.baseHeight + selected.height}
          min={selected.baseHeight + .1} max={Math.min(WORLD_LIGHTING_EDITOR_LIMITS.maxTop, selected.baseHeight + WORLD_LIGHTING_EDITOR_LIMITS.maxHeight)}
          onChange={value => worldLightingEditorStore.patchSelected({ height: value - selected.baseHeight })} />
      </div>
      <p className={styles.hint}>Основание 0 — на земле. Поднимите основание для кроны. Рисунок объекта сохраняет свой размер.</p>
      <details className={styles.details} open={snapshot.tool === "vertex" || undefined}>
        <summary>Контур · {selected.points.length} точек</summary>
        <div className={styles.detailsBody}>
          <label className={styles.field}><span>Выбранная точка</span><select value={index ?? ""}
            onChange={event => worldLightingEditorStore.select(selected.id, event.target.value === "" ? null : Number(event.target.value))}>
            <option value="">Выберите точку</option>
            {selected.points.map((point, at) => <option key={at} value={at}>{at + 1} · {displayLightingNumber(point.x)}, {displayLightingNumber(point.y)}</option>)}
          </select></label>
          {vertex && index !== null && <div className={styles.heightFields}>
            <LightingNumberField key={`${selected.id}-${index}-x`} label="X точки" value={vertex.x} min={0} max={TILED_WORLD.width} range={false}
              onChange={value => worldLightingEditorStore.moveVertex(index, { x: value, y: vertex.y })} />
            <LightingNumberField key={`${selected.id}-${index}-y`} label="Y точки" value={vertex.y} min={0} max={TILED_WORLD.height} range={false}
              onChange={value => worldLightingEditorStore.moveVertex(index, { x: vertex.x, y: value })} />
          </div>}
          <div className={styles.actions}>
            <button type="button" disabled={index === null || selected.points.length >= WORLD_LIGHTING_EDITOR_LIMITS.vertices} onClick={() => {
              if (index === null) return;
              const a = selected.points[index], b = selected.points[(index + 1) % selected.points.length];
              worldLightingEditorStore.addVertex(index, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
            }}>Добавить точку</button>
            <button type="button" disabled={index === null || selected.points.length <= 3}
              onClick={() => { if (index !== null) worldLightingEditorStore.deleteVertex(index); }}>Удалить точку</button>
          </div>
          <p className={styles.hint}>Добавление делит следующее ребро пополам. Точки можно перетаскивать инструментом «Контур».</p>
        </div>
      </details>
      <details className={styles.details}><summary>Тень</summary><div className={styles.detailsBody}>
        <LightingNumberField key={`${selected.id}-opacity`} label="Плотность тени" value={selected.opacity} min={0} max={1} step={.01}
          onChange={value => worldLightingEditorStore.patchSelected({ opacity: value })} />
        <LightingNumberField key={`${selected.id}-softness`} label="Мягкость края" value={selected.softness} min={0} max={WORLD_LIGHTING_EDITOR_LIMITS.maxSoftness}
          onChange={value => worldLightingEditorStore.patchSelected({ softness: value })} />
      </div></details>
      <div className={styles.actions}>
        <button type="button" disabled={!snapshot.dirtyIds.includes(selected.id)} onClick={() => worldLightingEditorStore.resetSelected()}>Сбросить объём</button>
        <button className={styles.danger} type="button" onClick={() => worldLightingEditorStore.removeSelected()}>Удалить объём тени</button>
      </div>
      <p className={styles.hint}>Удаление убирает только объём тени. Рисунок остаётся на карте. Можно отменить через Ctrl/Cmd+Z.</p>
    </fieldset>
  </section>;
}

export function WorldLightingReceiverInspector() {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe,
    worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const selected = snapshot.selectedKind === "receiver" ? snapshot.receivers.find(receiver => receiver.id === snapshot.selectedId) : undefined;
  const index = snapshot.selectedVertex;
  const vertex = selected && index !== null ? selected.points[index] : null;
  if (!selected) return <p className={styles.hint}>Выберите поверхность на карте или в списке.</p>;
  return <section className={styles.editor} aria-label="Свойства поверхности" data-world-lighting-editor>
    <h3>{studioReceiverName(selected.id)}</h3>
    <p className={styles.kindLabel}>Поверхность, принимающая тень</p>
    <p className={styles.hint}>Синий контур ограничивает землю, на которой видны рассчитанные тени. Это не часть дома и не препятствие. Обычно соседние поверхности должны покрывать землю без разрывов.</p>
    <fieldset className={styles.controls} disabled={!snapshot.enabled || !snapshot.previewDraft}>
      <legend className={styles.srOnly}>Параметры поверхности</legend>
      <LightingNumberField key={`${selected.id}-height`} label="Высота поверхности" value={selected.height} min={0} max={WORLD_LIGHTING_EDITOR_LIMITS.maxHeight}
        onChange={value => worldLightingEditorStore.patchReceiver({ height: value })} />
      <p className={styles.hint}>Обычно 0 — земля. Поднятые поверхности пока экспериментальные; они не заменяют освещение стен и крыш.</p>
      <details className={styles.details} open={snapshot.tool === "vertex" || undefined}>
        <summary>Контур поверхности · {selected.points.length} точек</summary><div className={styles.detailsBody}>
          <label className={styles.field}><span>Выбранная точка</span><select value={index ?? ""} onChange={event => worldLightingEditorStore.selectReceiver(selected.id, event.target.value === "" ? null : Number(event.target.value))}>
            <option value="">Выберите точку</option>{selected.points.map((point, at) => <option key={at} value={at}>{at + 1} · {displayLightingNumber(point.x)}, {displayLightingNumber(point.y)}</option>)}
          </select></label>
          {vertex && index !== null && <div className={styles.heightFields}>
            <LightingNumberField key={`${selected.id}-${index}-x`} label="X точки" value={vertex.x} min={0} max={TILED_WORLD.width} range={false} onChange={value => worldLightingEditorStore.moveVertex(index, { x: value, y: vertex.y })} />
            <LightingNumberField key={`${selected.id}-${index}-y`} label="Y точки" value={vertex.y} min={0} max={TILED_WORLD.height} range={false} onChange={value => worldLightingEditorStore.moveVertex(index, { x: vertex.x, y: value })} />
          </div>}
          <div className={styles.actions}>
            <button type="button" disabled={index === null || selected.points.length >= WORLD_LIGHTING_EDITOR_LIMITS.vertices} onClick={() => {
              if (index === null) return;
              const a = selected.points[index], b = selected.points[(index + 1) % selected.points.length];
              worldLightingEditorStore.addVertex(index, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
            }}>Добавить точку</button>
            <button type="button" disabled={index === null || selected.points.length <= 3} onClick={() => { if (index !== null) worldLightingEditorStore.deleteVertex(index); }}>Удалить точку</button>
          </div>
          <p className={styles.hint}>Инструмент «Контур» меняет границы поверхности. «Двигать» переносит её целиком.</p>
        </div>
      </details>
      <div className={styles.actions}>
        <button type="button" disabled={!snapshot.dirtyReceiverIds.includes(selected.id)} onClick={() => worldLightingEditorStore.resetSelected()}>Сбросить поверхность</button>
        <button className={styles.danger} type="button" onClick={() => worldLightingEditorStore.removeSelected()}>Удалить поверхность</button>
      </div>
      <p className={styles.hint}>В удалённой области рассчитанные тени перестанут быть видны. Изображение земли сохраняется.</p>
    </fieldset>
  </section>;
}
