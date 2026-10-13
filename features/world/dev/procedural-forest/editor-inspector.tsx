"use client";
import { Copy, Trash2 } from "lucide-react";
import type { ForestObject, ObjectKind } from "./objects";
import styles from "./procedural-forest-preview.module.css";

export const objectNames: Record<ObjectKind, string> = { tree: "Дерево", shrub: "Куст", rock: "Камень", ruins: "Руины", bridge: "Мост", jetty: "Причал" };

function NumberField({ label, value, min, max, step = 1, change }: { label: string; value: number; min: number; max: number; step?: number; change: (value: number) => void }) {
  const formatted = String(Math.round(value * 100) / 100);
  function commit(input: HTMLInputElement) {
    const parsed = input.value.trim() ? Number(input.value) : NaN;
    if (Number.isFinite(parsed)) { const next = Math.max(min, Math.min(max, parsed)); input.value = String(next); change(next); }
    else input.value = formatted;
  }
  return <label className={styles.field}><span>{label}</span><input key={formatted} aria-label={label} type="number" inputMode="decimal" min={min} max={max} step={step} defaultValue={formatted} onBlur={event => commit(event.currentTarget)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

export function EditorInspector({ object, width, update, duplicate, remove }: {
  object: ForestObject | null; width: number;
  update: (patch: Partial<Pick<ForestObject, "x" | "y" | "scale" | "rotation" | "variant">>) => void;
  duplicate: () => void; remove: () => void;
}) {
  if (!object) return <div className={styles.emptySelection}><strong>Выбери предмет на карте</strong><p>Дерево, куст, камень, руины, мост или причал. Затем перетащи его или измени параметры здесь.</p></div>;
  return <div className={styles.inspector}>
    <div className={styles.selectionHeading}><strong>{objectNames[object.kind]}</strong><span>ВЫБРАН</span></div>
    <div className={styles.fields}>
      <NumberField label="X" value={object.x} min={0} max={width} change={x => update({ x })} />
      <NumberField label="Y" value={object.y} min={0} max={1600} change={y => update({ y })} />
      <NumberField label="Размер" value={object.scale * 100} min={40} max={240} step={5} change={value => update({ scale: value / 100 })} />
      <NumberField label="Поворот" value={object.rotation ?? 0} min={-180} max={180} step={5} change={rotation => update({ rotation })} />
    </div>
    <p className={styles.small}>Размер в процентах, поворот в градусах. Enter применяет введённое число.</p>
    {["tree", "shrub", "rock"].includes(object.kind) && <label className={styles.variant}><span>Внешний вид</span><select aria-label="Внешний вид" value={object.variant} onChange={event => update({ variant: Number(event.target.value) })}>{Array.from({ length: 24 }, (_, index) => <option key={index} value={index}>Вариант {index + 1}</option>)}</select></label>}
    <div className={styles.selectionActions}><button type="button" onClick={duplicate}><Copy size={15} /> Дублировать</button><button type="button" onClick={remove}><Trash2 size={15} /> Удалить объект</button></div>
  </div>;
}
