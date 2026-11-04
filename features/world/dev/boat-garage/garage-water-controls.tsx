"use client";

import { Pause, Play, Waves } from "lucide-react";
import { useState } from "react";
import { GarageNumber } from "./garage-inspector";
import { eligibleGarageWaterParts } from "./garage-water-assembly.mjs";
import type { GarageScene, GarageWaterPreviewConfig } from "./garage-scene-types";
import styles from "./garage-editor.module.css";

export function GarageWaterControls({ scene, config, running, hasArtwork, onChange, onRunningChange, onAttachParts }: {
  scene: GarageScene; config: GarageWaterPreviewConfig; running: boolean; hasArtwork: boolean;
  onChange: (next: GarageWaterPreviewConfig) => void; onRunningChange: (running: boolean) => void;
  onAttachParts: (partIds: string[]) => void;
}) {
  const [parts, setParts] = useState<string[]>([]);
  const eligible = eligibleGarageWaterParts(scene, config.rootId);
  const selectedParts = parts.filter(id => eligible.some(part => part.id === id));
  return <div className={styles.waterControls} aria-label="Настройки воды">
    <div className={styles.waterMain}>
      <Waves size={17} aria-hidden />
      <label className={styles.field}><span>Плавающая сборка</span><select aria-label="Плавающая сборка" value={config.rootId}
        onChange={event => onChange({ ...config, rootId: event.target.value })}>
        {scene.nodes.filter(node => !node.locked || node.id === config.rootId).map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
      </select></label>
      <button type="button" disabled={!hasArtwork} aria-pressed={running} onClick={() => onRunningChange(!running)}>
        {running ? <Pause size={14} /> : <Play size={14} />}{running ? "Пауза и редактировать" : "Проверить плавучесть"}
      </button>
    </div>
    <details><summary>Посадка на воду</summary><div className={styles.waterFields}>
      <GarageNumber label="Уровень воды Y" value={config.waterlineY} min={-200000} max={200000} onChange={waterlineY => onChange({ ...config, waterlineY })} />
      <GarageNumber label="Ширина плавучей части" value={config.beam} min={1} max={40000} onChange={beam => onChange({ ...config, beam })} />
      <GarageNumber label="Сила волн" value={config.amplitude} min={0} max={30} onChange={amplitude => onChange({ ...config, amplitude })} />
    </div></details>
    {eligible.length > 0 && <details><summary>Добавить отдельные детали в сборку</summary>
      <p>Отметьте предметы, которые должны плавать вместе. Их положение и размер сохранятся.</p>
      <div className={styles.waterParts}>{eligible.map(part => <label key={part.id} className={styles.waterPart}>
        <input type="checkbox" checked={selectedParts.includes(part.id)} onChange={event => setParts(current => event.target.checked ? [...current, part.id] : current.filter(id => id !== part.id))} />
        <span>{part.name}</span>
      </label>)}</div>
      <button type="button" disabled={!selectedParts.length} onClick={() => { onAttachParts(selectedParts); setParts([]); }}>Добавить в плавающую сборку</button>
    </details>}
    <p>{hasArtwork ? running ? "Лодка движется целиком. Пауза возвращает её в положение для редактирования." : "Редактируйте детали на воде; запустите плавучесть, чтобы проверить сборку."
      : "В этой группе пока нет изображения. Выберите корпус или добавьте отдельные детали в сборку."}</p>
  </div>;
}
