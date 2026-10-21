"use client";

import { Droplets, Eraser, Leaf, Route, Sun } from "lucide-react";
import type { ForestStatus } from "@/apps/engine/src/editor/input/controller";
import { EditorButton } from "./editor-button";
import { SettingsRange } from "./settings-range";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof import("@/apps/engine/src/editor/input/controller")["createForestController"]>;
const brushes = [{ id: "grass", name: "Трава", icon: Leaf }, { id: "path", name: "Тропа", icon: Route }, { id: "sand", name: "Песок", icon: Sun }, { id: "water", name: "Вода", icon: Droplets }, { id: "restore", name: "Восстановить", icon: Eraser }] as const;

export function WorkspaceTerrain({ status, controller, compact = false }: { status: ForestStatus; controller: Controller | null; compact?: boolean }) {
  return <div className={compact ? styles.terrainCompact : styles.terrainContent}>
    <div className={styles.terrainMaterials} role="group" aria-label="Материал земли">{brushes.map(({ id, name, icon: Icon }) => <EditorButton type="button" key={id} aria-label={name} aria-pressed={status.terrainBrush === id} onClick={() => { controller?.setTerrainBrush(id); controller?.setMode("terrain"); }}><Icon size={17} /><span>{name}</span></EditorButton>)}</div>
    <label className={styles.brushSize}><span>Размер кисти <strong>{status.terrainSize}</strong></span><input type="range" aria-label="Размер кисти" min={24} max={320} step={4} value={status.terrainSize} onChange={event => controller?.setTerrainSize(Number(event.target.value))} /></label>
    <label className={styles.terrainToggle}><input type="checkbox" checked={status.clearVegetation} disabled={status.terrainBrush === "restore"} onChange={event => controller?.setClearVegetation(event.target.checked)} /><span>Убирать растительность</span></label>
    <p className={styles.small}>Убирает видимые незаблокированные деревья и кусты. Восстановление не удаляет предметы.</p>
    <label className={styles.terrainToggle}><input type="checkbox" checked={status.terrainBaseTrails} onChange={event => controller?.setBaseTrails(event.target.checked)} /><span>Исходные тропы</span></label>
    <p className={styles.small}>Выключи, чтобы убрать прежние тропы. «Восстановить» стирает только нарисованные кистью участки.</p>
    {!compact && <div className={styles.terrainAppearance}><h3>Берег и переходы</h3><label className={styles.field}><span>Стиль берега</span><select aria-label="Стиль берега" value={status.terrainAppearance.shoreStyle} onChange={event => controller?.setTerrainAppearance({ shoreStyle: event.target.value as "stone" | "natural" | "none" })}><option value="stone">Каменный</option><option value="natural">Земляной</option><option value="none">Без обрыва</option></select></label><SettingsRange label="Высота берега" value={status.terrainAppearance.shoreHeight} min={0} max={24} controller={controller} change={shoreHeight => controller?.setTerrainAppearance({ shoreHeight })} /><SettingsRange label="Мягкость границ" value={status.terrainAppearance.blendWidth} min={8} max={64} controller={controller} change={blendWidth => controller?.setTerrainAppearance({ blendWidth })} /><SettingsRange label="Россыпь деталей" value={status.terrainAppearance.scatter * 100} min={0} max={100} unit="%" controller={controller} change={value => controller?.setTerrainAppearance({ scatter: value / 100 })} /><p className={styles.small}>Высота создаёт обрыв у воды; ноль делает берег плоским. Мягкость и россыпь смешивают траву, тропы и песок. Берег воды задаётся отдельным контуром.</p></div>}
    {!compact && <div className={styles.terrainInstructions}><strong>Рисуй прямо на карте</strong><p>Удерживай мышь или веди пальцем. Размер кисти задан в единицах карты и меняется на экране вместе с приближением.</p><p>Один штрих — одно действие отмены. Escape отменяет незавершённый штрих. Пробел или средняя кнопка двигают карту.</p></div>}
  </div>;
}
