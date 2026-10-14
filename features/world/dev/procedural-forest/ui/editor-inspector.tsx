"use client";
import { Copy, Trash2 } from "lucide-react";
import type { ForestObject, ObjectKind } from "@/features/world/dev/procedural-forest/scene/objects";
import { EditorButton } from "./editor-button";
import styles from "./procedural-forest-preview.module.css";

export const objectNames: Record<ObjectKind, string> = { tree: "Дерево", shrub: "Куст", rock: "Камень", ruins: "Руины", bridge: "Мост", jetty: "Причал", image: "PNG-картинка" };

function NumberField({ label, value, min, max, step = 1, change }: { label: string; value: number; min: number; max: number; step?: number; change: (value: number) => void }) {
  const formatted = String(Math.round(value * 100) / 100);
  function commit(input: HTMLInputElement) {
    if (input.value === formatted) return;
    const parsed = input.value.trim() ? Number(input.value) : NaN;
    if (Number.isFinite(parsed)) { const next = Math.max(min, Math.min(max, parsed)); input.value = String(next); change(next); }
    else input.value = formatted;
  }
  return <label className={styles.field}><span>{label}</span><input key={formatted} aria-label={label} type="number" inputMode="decimal" min={min} max={max} step={step} defaultValue={formatted} onBlur={event => commit(event.currentTarget)} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>;
}

export function EditorInspector({ object, width, imageName, update, duplicate, remove }: {
  object: ForestObject | null; width: number; imageName?: string;
  update: (patch: Partial<Pick<ForestObject, "x" | "y" | "scale" | "rotation" | "variant">>) => void;
  duplicate: () => void; remove: () => void;
}) {
  if (!object) return <div className={styles.emptySelection}><strong>Выбери предмет на карте</strong><p>Затем перетащи его или потяни за угол рамки, чтобы изменить размер.</p></div>;
  return <div className={styles.inspector}>
    <div className={styles.selectionHeading}><strong>{objectNames[object.kind]}</strong><span>ВЫБРАН</span></div>
    {object.kind === "image" && imageName && <p className={styles.imageName} title={imageName}>{imageName}</p>}
    <div className={styles.fields}>
      <NumberField label="X" value={object.x} min={0} max={width} change={x => update({ x })} />
      <NumberField label="Y" value={object.y} min={0} max={1600} change={y => update({ y })} />
      <NumberField label="Размер" value={object.scale * 100} min={10} max={800} step={5} change={value => update({ scale: value / 100 })} />
      <NumberField label="Поворот" value={object.rotation ?? 0} min={-180} max={180} step={5} change={rotation => update({ rotation })} />
    </div>
    <p className={styles.small}>Тяни за угол рамки, чтобы изменить размер с сохранением пропорций. Противоположный угол остаётся на месте. Размер в процентах, поворот в градусах; Enter применяет число.</p>
    {["tree", "shrub", "rock"].includes(object.kind) && <label className={styles.variant}><span>Внешний вид</span><select aria-label="Внешний вид" value={object.variant} onChange={event => update({ variant: Number(event.target.value) })}>{Array.from({ length: 24 }, (_, index) => <option key={index} value={index}>Вариант {index + 1}</option>)}</select></label>}
    <div className={styles.selectionActions}><EditorButton type="button" onClick={duplicate}><Copy size={15} /> Дублировать</EditorButton><EditorButton type="button" onClick={remove}><Trash2 size={15} /> Удалить объект</EditorButton></div>
  </div>;
}
