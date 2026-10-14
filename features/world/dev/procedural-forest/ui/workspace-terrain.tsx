"use client";

import { Droplets, Eraser, Leaf, Route, Sun } from "lucide-react";
import type { ForestStatus } from "@/features/world/dev/procedural-forest/input/controller";
import { EditorButton } from "./editor-button";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof import("@/features/world/dev/procedural-forest/input/controller")["createForestController"]>;
const brushes = [{ id: "grass", name: "Трава", icon: Leaf }, { id: "path", name: "Тропа", icon: Route }, { id: "sand", name: "Песок", icon: Sun }, { id: "water", name: "Вода", icon: Droplets }, { id: "restore", name: "Восстановить", icon: Eraser }] as const;

export function WorkspaceTerrain({ status, controller, compact = false }: { status: ForestStatus; controller: Controller | null; compact?: boolean }) {
  return <div className={compact ? styles.terrainCompact : styles.terrainContent}>
    <div className={styles.terrainMaterials} role="group" aria-label="Материал земли">{brushes.map(({ id, name, icon: Icon }) => <EditorButton type="button" key={id} aria-label={name} aria-pressed={status.terrainBrush === id} onClick={() => { controller?.setTerrainBrush(id); controller?.setMode("terrain"); }}><Icon size={17} /><span>{name}</span></EditorButton>)}</div>
    <label className={styles.brushSize}><span>Размер кисти <strong>{status.terrainSize}</strong></span><input type="range" aria-label="Размер кисти" min={24} max={320} step={4} value={status.terrainSize} onChange={event => controller?.setTerrainSize(Number(event.target.value))} /></label>
    <label className={styles.terrainToggle}><input type="checkbox" checked={status.clearVegetation} disabled={status.terrainBrush === "restore"} onChange={event => controller?.setClearVegetation(event.target.checked)} /><span>Убирать растительность</span></label>
    <p className={styles.small}>Убирает видимые незаблокированные деревья и кусты. Восстановление не удаляет предметы.</p>
    <label className={styles.terrainToggle}><input type="checkbox" checked={status.terrainBaseTrails} onChange={event => controller?.setBaseTrails(event.target.checked)} /><span>Исходные тропы</span></label>
    <p className={styles.small}>Выключи, чтобы убрать прежние тропы. «Восстановить» стирает только нарисованные кистью участки.</p>
    {!compact && <div className={styles.terrainInstructions}><strong>Рисуй прямо на карте</strong><p>Удерживай мышь или веди пальцем. Размер кисти задан в единицах карты и меняется на экране вместе с приближением.</p><p>Один штрих — одно действие отмены. Escape отменяет незавершённый штрих. Пробел или средняя кнопка двигают карту.</p></div>}
  </div>;
}
