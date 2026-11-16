"use client";

import { useState } from "react";
import { GarageNumber } from "./garage-inspector";
import { eligibleGarageWaterParts } from "./garage-water-assembly.mjs";
import { garageWaterEffects } from "./garage-water-setup.mjs";
import type { GarageScene, GarageWaterPreviewConfig } from "./garage-scene-types";
import editor from "./garage-editor.module.css";
import styles from "./garage-water-controls.module.css";

export function GarageWaterControls({ scene, config, hasArtwork, onChange, onAttachParts }: {
  scene: GarageScene; config: GarageWaterPreviewConfig; hasArtwork: boolean;
  onChange: (next: GarageWaterPreviewConfig) => void; onAttachParts: (partIds: string[]) => void;
}) {
  const [parts, setParts] = useState<string[]>([]);
  if (!config.rootId) return <p className={styles.empty}>Добавьте изображение корпуса на сцену, чтобы настроить плавучесть.</p>;

  const eligible = eligibleGarageWaterParts(scene, config.rootId);
  const selectedParts = parts.filter(id => eligible.some(part => part.id === id));
  const effects = garageWaterEffects(config);
  return <section className={styles.controls} aria-label="Настройки воды">
    <div className={styles.root}>
      <label className={editor.field}><span>Плавающая сборка</span>
        <select value={config.rootId} onChange={event => onChange({ ...config, rootId: event.target.value })}>
          {scene.nodes.filter(node => !node.locked || node.id === config.rootId).map(node => <option key={node.id} value={node.id}>{node.name}</option>)}
        </select>
      </label>
      {!hasArtwork && <p>Для проверки плавучести выберите видимый корпус или добавьте его в эту группу.</p>}
    </div>
    <details open><summary>Посадка на воду</summary>
      <div className={styles.fields}>
        <GarageNumber label="Уровень воды Y" value={config.waterlineY} min={-200000} max={200000} onChange={waterlineY => onChange({ ...config, waterlineY })} />
        <GarageNumber label="Ширина плавучей части" value={config.beam} min={1} max={40000} onChange={beam => onChange({ ...config, beam })} />
        <GarageNumber label="Сила волн" value={config.amplitude} min={0} max={30} onChange={amplitude => onChange({ ...config, amplitude })} />
      </div>
    </details>
    <details data-testid="garage-water-effects-controls"><summary>Эффекты у корпуса</summary>
      <div className={styles.sectionBody}>
        <label className={styles.check}><input type="checkbox" aria-label="Рябь, пена и тень у корпуса" checked={effects.effectsEnabled}
          onChange={event => onChange({ ...config, effectsEnabled: event.target.checked })} />Рябь, пена и тень</label>
        <label className={styles.check}><input type="checkbox" aria-label="Полупрозрачное погружение корпуса" checked={effects.immersionEnabled}
          onChange={event => onChange({ ...config, immersionEnabled: event.target.checked })} />Погружение корпуса</label>
        {effects.effectsEnabled && <div className={styles.fields}>
          <GarageNumber label="Интенсивность %" value={effects.effectOpacity * 100} min={0} max={100} step={5}
            onChange={value => onChange({ ...config, effectOpacity: value / 100 })} />
          <GarageNumber label="Смещение эффекта Y" value={effects.effectOffsetY} min={-2000} max={2000} step={5}
            onChange={effectOffsetY => onChange({ ...config, effectOffsetY })} />
        </div>}
      </div>
    </details>
    {eligible.length > 0 && <details><summary>Добавить детали в сборку</summary>
      <div className={styles.sectionBody}>
        <p>Выбранные слои будут плавать вместе с корпусом.</p>
        {eligible.map(part => <label key={part.id} className={styles.check}>
          <input type="checkbox" checked={selectedParts.includes(part.id)} onChange={event => setParts(current => event.target.checked ? [...current, part.id] : current.filter(id => id !== part.id))} />
          <span>{part.name}</span>
        </label>)}
        <button type="button" disabled={!selectedParts.length} onClick={() => { onAttachParts(selectedParts); setParts([]); }}>Добавить в плавающую сборку</button>
      </div>
    </details>}
  </section>;
}
