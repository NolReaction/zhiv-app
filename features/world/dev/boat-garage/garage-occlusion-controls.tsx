"use client";

import { EyeOff, Pencil, RotateCcw, Scissors, Trash2 } from "lucide-react";
import { defaultGarageOcclusion, garageOcclusionTargetIds } from "./garage-occlusion.mjs";
import type { GarageNode, GarageScene } from "./garage-scene-types";
import styles from "./garage-occlusion-controls.module.css";

type Props = {
  scene: GarageScene;
  node: GarageNode;
  onChange: (scene: GarageScene) => void;
  onEdit: () => void;
  onRedraw: () => void;
};

/** The hull owns the contour; full-sized target artwork remains untouched. */
export function GarageOcclusionControls({ scene, node, onChange, onEdit, onRedraw }: Props) {
  const occlusion = node.occlusion;
  if (!node.assetId && !occlusion) return null;

  const eligible = new Set(garageOcclusionTargetIds(scene, node.id));
  const targets = [...scene.nodes].filter(item => eligible.has(item.id)).sort((a, b) => b.zIndex - a.zIndex);
  const targetBranches = new Set(occlusion?.targetIds ?? []);
  for (let previous = -1; previous !== targetBranches.size;) {
    previous = targetBranches.size;
    for (const item of scene.nodes) if (item.parentId && targetBranches.has(item.parentId)) targetBranches.add(item.id);
  }
  const foregroundZ = Math.min(10000, node.zIndex + 1);
  const behindTargets = scene.nodes.filter(item => targetBranches.has(item.id) && !item.locked && item.zIndex < foregroundZ);
  const lockedBehind = scene.nodes.some(item => targetBranches.has(item.id) && item.locked && item.zIndex <= node.zIndex);

  function setOcclusion(next: GarageNode["occlusion"]) {
    onChange({ ...scene, nodes: scene.nodes.map(item => {
      if (item.id !== node.id) return item;
      if (next) return { ...item, occlusion: next };
      const changed = { ...item };
      delete changed.occlusion;
      return changed;
    }) });
  }

  function createContour() {
    setOcclusion(defaultGarageOcclusion());
    onEdit();
  }

  function raiseTargets() {
    if (!behindTargets.length || node.zIndex >= 10000) return;
    const ids = new Set(behindTargets.map(item => item.id));
    onChange({ ...scene, nodes: scene.nodes.map(item => ids.has(item.id) ? { ...item, zIndex: Math.max(item.zIndex, foregroundZ) } : item) });
  }

  return <section className={styles.controls} aria-label="Маска переднего борта" data-testid="garage-occlusion-controls">
    <h3><Scissors size={15} aria-hidden />Борт перед предметами</h3>
    <p>Обведите передний борт на корпусе и отметьте детали внутри лодки. Борт скроет их нижнюю часть, а сами изображения останутся целыми.</p>
    {node.locked && <p className={styles.notice}>Слой закреплён. Снимите закрепление, чтобы менять маску.</p>}
    <fieldset disabled={node.locked} className={styles.fieldset}>
      {!occlusion ? <div className={styles.actions}>
        <button type="button" onClick={createContour} data-testid="garage-occlusion-create"><Scissors size={14} aria-hidden />Создать контур борта</button>
      </div> : <>
        <div className={styles.state}>
          <label><input type="checkbox" checked={occlusion.enabled} aria-label="Включить маску борта"
            onChange={event => setOcclusion({ ...occlusion, enabled: event.target.checked })} />Маска включена</label>
          <span>{occlusion.points.length} точек</span>
        </div>
        <div className={styles.actions}>
          <button type="button" onClick={onEdit} data-testid="garage-occlusion-edit"><Pencil size={14} aria-hidden />Править контур</button>
          <button type="button" onClick={onRedraw} data-testid="garage-occlusion-redraw"><RotateCcw size={14} aria-hidden />Нарисовать заново</button>
        </div>
        <p className={styles.tip}>Тяните точки контура. Нажатие на ребро добавляет точку; Delete удаляет выбранную, пока их больше трёх. Enter завершает рисунок, Escape отменяет.</p>
        <details className={styles.targets} open>
          <summary>Прятать за бортом <span>{occlusion.targetIds.length}</span></summary>
          {targets.length ? <div className={styles.targetList}>{targets.map(target => <label key={target.id} className={styles.target}>
            <input type="checkbox" aria-label={`Прятать за бортом: ${target.name}`} data-testid={`garage-occlusion-target-${target.id}`}
              checked={occlusion.targetIds.includes(target.id)} onChange={event => setOcclusion({ ...occlusion,
                targetIds: event.target.checked ? [...occlusion.targetIds, target.id] : occlusion.targetIds.filter(id => id !== target.id) })} />
            <span>{target.name}{!target.assetId && <small>Группа со всеми деталями</small>}</span>
            {!target.visible && <EyeOff size={13} aria-label="Слой скрыт" />}
          </label>)}</div> : <p>Добавьте в сцену бак, ящик или другую деталь.</p>}
        </details>
        {!occlusion.targetIds.length && targets.length > 0 && <p className={styles.notice}>Пока детали не отмечены, маска ничего не скрывает.</p>}
        {occlusion.targetIds.length > 0 && <>
          <p className={styles.tip}>Бак и ящик должны быть выше корпуса по слою. Маска скроет только участок за бортом.</p>
          <div className={styles.actions}><button type="button" disabled={!behindTargets.length || node.zIndex >= 10000}
            onClick={raiseTargets} data-testid="garage-occlusion-raise">Поднять детали над корпусом</button></div>
          {lockedBehind && <p className={styles.notice}>Закреплённые слои не поднимаются. Снимите закрепление, если они должны быть видны внутри лодки.</p>}
          {node.zIndex >= 10000 && <p className={styles.notice}>Сначала уменьшите слой корпуса: 10000 — верхняя граница.</p>}
        </>}
        <div className={styles.actions}>
          <button type="button" onClick={() => setOcclusion(undefined)} data-testid="garage-occlusion-remove"><Trash2 size={14} aria-hidden />Удалить маску</button>
        </div>
      </>}
    </fieldset>
  </section>;
}
