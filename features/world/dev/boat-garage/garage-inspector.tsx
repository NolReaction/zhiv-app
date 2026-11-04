"use client";

import { Copy, Trash2 } from "lucide-react";
import { reparentGarageNode } from "./garage-scene-model.mjs";
import type { GarageNode, GarageScene } from "./garage-scene-types";
import styles from "./garage-editor.module.css";

export function GarageNumber({ label, value, onChange, step = 1, min, max }: {
  label: string; value: number; onChange: (value: number) => void; step?: number; min?: number; max?: number;
}) {
  return <label className={styles.field}><span>{label}</span><input type="number" value={Math.round(value * 1000) / 1000}
    min={min} max={max} step={step} onChange={event => {
      const next = event.target.valueAsNumber;
      if (Number.isFinite(next)) onChange(Math.max(min ?? -100000, Math.min(max ?? 100000, next)));
    }} /></label>;
}

export function GarageInspector({ scene, node, onChange, onDuplicate, onRemove, onError }: {
  scene: GarageScene; node: GarageNode | undefined; onChange: (scene: GarageScene) => void;
  onDuplicate: () => void; onRemove: () => void; onError: (message: string) => void;
}) {
  if (!node) return <aside className={styles.inspector}><h2>Свойства детали</h2><p className={styles.hint}>Выберите деталь на сцене или в списке слоёв.</p></aside>;
  const patch = (changes: Partial<GarageNode>) => onChange({ ...scene, nodes: scene.nodes.map(item => item.id === node.id ? { ...item, ...changes } : item) });
  const parent = scene.nodes.find(item => item.id === node.parentId);
  const number = (key: "x" | "y" | "scale" | "rotation" | "zIndex", label: string, step = 1, min?: number, max?: number) =>
    <GarageNumber key={key} label={label} value={node[key]} step={step} min={min} max={max} onChange={value => patch({ [key]: value })} />;
  function attach(parentId: string | null, socketId: string | null) {
    try { onChange(reparentGarageNode(scene, node!.id, parentId, socketId)); }
    catch (error) { onError(error instanceof Error ? error.message : "Не удалось изменить крепление."); }
  }
  return <aside className={styles.inspector} aria-label="Свойства детали">
    <div className={styles.sectionHead}><h2>Свойства детали</h2><small>{node.assetId ? "PNG / IMAGE" : "ГРУППА"}</small></div>
    <label className={styles.field}><span>Название</span><input value={node.name} maxLength={100} onChange={event => patch({ name: event.target.value })} /></label>
    <div className={styles.checks}>
      <label><input type="checkbox" checked={node.visible} onChange={event => patch({ visible: event.target.checked })} />Видимость</label>
      <label><input type="checkbox" checked={node.locked} onChange={event => patch({ locked: event.target.checked })} />Закрепить</label>
    </div>
    <fieldset disabled={node.locked} className={styles.fieldset}>
      <div className={styles.fields}>{number("x", "X")}{number("y", "Y")}{number("scale", "Масштаб", .01, .001, 100)}
        {number("rotation", "Поворот °", 1, -3600, 3600)}{number("zIndex", "Слой", 1, -10000, 10000)}</div>
      <p className={styles.hint}>Позиция задаётся относительно родителя. Масштаб сохраняет пропорции изображения.</p>
      <label className={styles.field}><span>Изображение</span><select value={node.assetId ?? ""} onChange={event => {
        const asset = scene.assets.find(item => item.id === event.target.value);
        patch(asset ? { assetId: asset.id, width: asset.width, height: asset.height, scale: node.width * node.scale / asset.width } : { assetId: null });
      }}><option value="">Группа без изображения</option>{scene.assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
      <h3>Крепление</h3>
      <label className={styles.field}><span>Родитель</span><select value={node.parentId ?? ""} onChange={event => attach(event.target.value || null, null)}>
        <option value="">Сцена гаража</option>{scene.nodes.filter(item => item.id !== node.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label className={styles.field}><span>Точка родителя</span><select value={node.socketId ?? ""} disabled={!parent} onChange={event => attach(node.parentId, event.target.value || null)}>
        <option value="">Начало координат родителя</option>{parent?.sockets.map(socket => <option key={socket.id} value={socket.id}>{socket.name}</option>)}
      </select></label>
      <button type="button" disabled={!node.socketId} onClick={() => patch({ x: 0, y: 0 })}>Совместить с креплением</button>
      <p className={styles.hint}>Смена родителя сохраняет положение. «Совместить» ставит жёлтую опорную точку детали на бирюзовое крепление.</p>
      <h3>Точки на этой детали</h3>
      <p className={styles.hint}>Инструмент «Крепление»: нажмите на деталь. «Опора»: задайте точку, которой она крепится.</p>
      {node.sockets.map(socket => <div key={socket.id} className={styles.socket}>
        <label className={styles.field}><span>Название точки</span><input value={socket.name} maxLength={80} onChange={event => patch({ sockets: node.sockets.map(item => item.id === socket.id ? { ...item, name: event.target.value } : item) })} /></label>
        <div className={styles.fields}>{(["x", "y"] as const).map(key => <GarageNumber key={key} label={`${key.toUpperCase()} %`} value={socket[key] * 100} step={1} min={0} max={100}
          onChange={value => patch({ sockets: node.sockets.map(item => item.id === socket.id ? { ...item, [key]: value / 100 } : item) })} />)}</div>
        <button type="button" onClick={() => {
          let next = scene;
          for (const child of scene.nodes.filter(item => item.parentId === node.id && item.socketId === socket.id)) next = reparentGarageNode(next, child.id, node.id, null);
          onChange({ ...next, nodes: next.nodes.map(item => item.id === node.id ? { ...item, sockets: item.sockets.filter(item => item.id !== socket.id) } : item) });
        }}>Удалить точку</button>
      </div>)}
    </fieldset>
    <div className={styles.row}><button type="button" onClick={onDuplicate}><Copy size={15} />Дубликат</button>
      <button type="button" disabled={node.locked} onClick={onRemove}><Trash2 size={15} />Удалить</button></div>
    <p className={styles.hint}>Стрелки — сдвиг на 1; Shift — на 10. Delete — удалить. Ctrl/Cmd + Z — отменить.</p>
  </aside>;
}
