"use client";

import { Copy, Trash2 } from "lucide-react";
import { useId, useRef, useState, type KeyboardEvent } from "react";
import { alignGarageNodeToPoints, alignGarageNodeToSocket, garageNodeContactPoint, getGarageNodeMatrix, reparentGarageNode, transformGaragePoint } from "./garage-scene-model.mjs";
import type { GarageNode, GarageScene } from "./garage-scene-types";
import { GarageOcclusionControls } from "./garage-occlusion-controls";
import styles from "./garage-editor.module.css";
import panel from "./garage-inspector.module.css";

export function GarageNumber({ label, value, onChange, step = 1, min, max }: {
  label: string; value: number; onChange: (value: number) => void; step?: number; min?: number; max?: number;
}) {
  return <label className={styles.field}><span>{label}</span><input type="number" value={Math.round(value * 1000) / 1000}
    min={min} max={max} step={step} onChange={event => {
      const next = event.target.valueAsNumber;
      if (Number.isFinite(next)) onChange(Math.max(min ?? -100000, Math.min(max ?? 100000, next)));
    }} /></label>;
}

export type GarageInspectorTab = "object" | "attachments" | "occlusion";
const INSPECTOR_TABS: { id: GarageInspectorTab; label: string }[] = [
  { id: "object", label: "Объект" }, { id: "attachments", label: "Крепления" }, { id: "occlusion", label: "Борт" },
];

export function GarageInspector({ scene, node, onChange, onDuplicate, onRemove, onError, onEditOcclusion, onRedrawOcclusion, activeTab, onTabChange }: {
  scene: GarageScene; node: GarageNode | undefined; onChange: (scene: GarageScene) => void;
  onDuplicate: () => void; onRemove: () => void; onError: (message: string) => void;
  onEditOcclusion: () => void; onRedrawOcclusion: () => void;
  activeTab: GarageInspectorTab; onTabChange: (tab: GarageInspectorTab) => void;
}) {
  const id = useId();
  const tabButtons = useRef<(HTMLButtonElement | null)[]>([]);
  if (!node) return <aside className={`${styles.inspector} ${panel.panel}`} aria-label="Свойства детали">
    <div className={panel.empty}><h2>Свойства детали</h2><p>Выберите деталь на сцене или в списке слоёв.</p></div>
  </aside>;
  const patch = (changes: Partial<GarageNode>) => onChange({ ...scene, nodes: scene.nodes.map(item => item.id === node.id ? { ...item, ...changes } : item) });
  const parent = scene.nodes.find(item => item.id === node.parentId);
  const number = (key: "x" | "y" | "scale" | "rotation" | "zIndex", label: string, step = 1, min?: number, max?: number) =>
    <GarageNumber key={key} label={label} value={node[key]} step={step} min={min} max={max} onChange={value => patch({ [key]: value })} />;
  function attach(parentId: string | null, socketId: string | null) {
    try { onChange(reparentGarageNode(scene, node!.id, parentId, socketId)); }
    catch (error) { onError(error instanceof Error ? error.message : "Не удалось изменить крепление."); }
  }
  function navigateTabs(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % INSPECTOR_TABS.length
      : event.key === "ArrowLeft" ? (index + INSPECTOR_TABS.length - 1) % INSPECTOR_TABS.length
      : event.key === "Home" ? 0 : event.key === "End" ? INSPECTOR_TABS.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); event.stopPropagation();
    onTabChange(INSPECTOR_TABS[next].id); tabButtons.current[next]?.focus();
  }
  return <aside className={`${styles.inspector} ${panel.panel}`} aria-label="Свойства детали">
    <div className={panel.header}>
    <div className={styles.sectionHead}><h2>Свойства детали</h2><small>{node.assetId ? "PNG / IMAGE" : "ГРУППА"}</small></div>
    <label className={styles.field}><span>Название</span><input value={node.name} maxLength={100} onChange={event => patch({ name: event.target.value })} /></label>
    <div className={styles.checks}>
      <label><input type="checkbox" checked={node.visible} onChange={event => patch({ visible: event.target.checked })} />Видимость</label>
      <label><input type="checkbox" checked={node.locked} onChange={event => patch({ locked: event.target.checked })} />Закрепить</label>
    </div>
    <div role="tablist" aria-label="Разделы свойств детали" className={panel.tabs}>
      {INSPECTOR_TABS.map((tab, index) => <button key={tab.id} ref={element => { tabButtons.current[index] = element; }}
        type="button" role="tab" id={`${id}-tab-${tab.id}`} aria-controls={`${id}-panel-${tab.id}`}
        aria-selected={activeTab === tab.id} tabIndex={activeTab === tab.id ? 0 : -1}
        data-testid={`garage-inspector-tab-${tab.id}`} onClick={() => onTabChange(tab.id)} onKeyDown={event => navigateTabs(event, index)}>{tab.label}</button>)}
    </div>
    </div>
    <section role="tabpanel" id={`${id}-panel-object`} aria-labelledby={`${id}-tab-object`} hidden={activeTab !== "object"}
      className={panel.body} data-testid="garage-inspector-panel-object">
    <fieldset disabled={node.locked} className={styles.fieldset}>
      <h3 className={panel.sectionTitle}>Положение и размер</h3>
      <div className={styles.fields}>{number("x", "X")}{number("y", "Y")}{number("scale", "Масштаб", .01, .001, 100)}
        {number("rotation", "Поворот °", 1, -3600, 3600)}{number("zIndex", "Слой", 1, -10000, 10000)}</div>
      <p className={panel.tip}>Положение относительно родителя. Масштаб сохраняет пропорции.</p>
      <details className={panel.fold}><summary>Форма и отражение</summary>
        <div className={panel.foldBody}>
        <div className={styles.fields}>
          <GarageNumber label="Ширина %" value={(node.scaleX ?? 1) * 100} step={1} min={.1} max={100000} onChange={value => patch({ scaleX: value / 100 })} />
          <GarageNumber label="Высота %" value={(node.scaleY ?? 1) * 100} step={1} min={.1} max={100000} onChange={value => patch({ scaleY: value / 100 })} />
          <GarageNumber label="Скос °" value={node.skewX ?? 0} step={1} min={-89} max={89} onChange={value => patch({ skewX: value })} />
        </div>
        <div className={styles.checks}>
          <label><input type="checkbox" checked={node.flipX ?? false} onChange={event => patch({ flipX: event.target.checked })} />Отразить X</label>
          <label><input type="checkbox" checked={node.flipY ?? false} onChange={event => patch({ flipY: event.target.checked })} />Отразить Y</label>
        </div>
        <button type="button" onClick={() => patch({ scaleX: 1, scaleY: 1, flipX: false, flipY: false, skewX: 0 })}>Сбросить форму</button>
        <p className={panel.tip}>Ширина и высота независимы. Сильный скос не исправляет ракурс изображения.</p>
        </div>
      </details>
      <label className={`${styles.field} ${panel.imageField}`}><span>Изображение</span><select aria-label="Изображение" value={node.assetId ?? ""} onChange={event => {
        const asset = scene.assets.find(item => item.id === event.target.value);
        patch(asset ? { assetId: asset.id, width: asset.width, height: asset.height, scale: node.width * node.scale / asset.width } : { assetId: null, occlusion: undefined });
      }}><option value="">Группа без изображения</option>{scene.assets.map(asset => <option key={asset.id} value={asset.id}>{asset.name}</option>)}</select></label>
      {node.assetId && <p className={panel.tip}>Исходный холст: {node.width} × {node.height}</p>}
    </fieldset>
    </section>
    <section role="tabpanel" id={`${id}-panel-attachments`} aria-labelledby={`${id}-tab-attachments`} hidden={activeTab !== "attachments"}
      className={panel.body} data-testid="garage-inspector-panel-attachments">
    <fieldset disabled={node.locked} className={styles.fieldset}>
      <h3 className={panel.sectionTitle}>Связь с другой деталью</h3>
      <label className={styles.field}><span>Родитель</span><select aria-label="Родитель" value={node.parentId ?? ""} onChange={event => attach(event.target.value || null, null)}>
        <option value="">Сцена гаража</option>{scene.nodes.filter(item => item.id !== node.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      <label className={styles.field}><span>Точка родителя</span><select aria-label="Точка родителя" value={node.socketId ?? ""} disabled={!parent} onChange={event => attach(node.parentId, event.target.value || null)}>
        <option value="">Начало координат родителя</option>{parent?.sockets.map(socket => <option key={socket.id} value={socket.id}>{socket.name}</option>)}
      </select></label>
      <button type="button" disabled={!node.socketId} onClick={() => patch({ x: 0, y: 0 })}>Совместить с креплением</button>
      <p className={styles.hint}>Смена родителя сохраняет положение. «Совместить» ставит жёлтую опорную точку детали на бирюзовое крепление.</p>
      <GarageContactFit key={node.id} scene={scene} node={node} onChange={onChange} onError={onError} />
      <h3 className={panel.sectionTitle}>Точки на этой детали <small>{node.sockets.length}</small></h3>
      <p className={panel.tip}>«Крепление» добавляет точку на рисунок. «Опора» задаёт точку, которой деталь крепится.</p>
      {!node.sockets.length && <p className={panel.tip}>Точек пока нет. Выберите инструмент «Крепление» и нажмите на деталь.</p>}
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
    </section>
    <section role="tabpanel" id={`${id}-panel-occlusion`} aria-labelledby={`${id}-tab-occlusion`} hidden={activeTab !== "occlusion"}
      className={panel.body} data-testid="garage-inspector-panel-occlusion">
      {node.assetId ? <GarageOcclusionControls scene={scene} node={node} onChange={onChange} onEdit={onEditOcclusion} onRedraw={onRedrawOcclusion} />
        : <div className={panel.emptyMask}><h3>Выберите изображение корпуса</h3><p>Контур борта использует прозрачность изображения. У группы нет своего рисунка; выберите её корпус в списке слоёв.</p></div>}
    </section>
    <div className={panel.footer}><div className={styles.row}><button type="button" onClick={onDuplicate}><Copy size={15} />Дубликат</button>
      <button type="button" disabled={node.locked} onClick={onRemove}><Trash2 size={15} />Удалить</button></div>
      <p>G — двигать · R — поворот · S — масштаб<br />Ctrl/⌘ Z — отменить</p>
    </div>
  </aside>;
}

/** One-shot contact alignment deliberately leaves fixtures out of the boat group. */
function GarageContactFit({ scene, node, onChange, onError }: {
  scene: GarageScene; node: GarageNode; onChange: (scene: GarageScene) => void; onError: (message: string) => void;
}) {
  const targets = scene.nodes.filter(item => {
    let ancestor: GarageNode | undefined = item;
    while (ancestor) {
      if (ancestor.id === node.id) return false;
      const parentId: string | null = ancestor.parentId;
      ancestor = scene.nodes.find(candidate => candidate.id === parentId);
    }
    return true;
  });
  const [targetId, setTargetId] = useState(() => targets.find(item => item.sockets.length)?.id ?? "");
  const [sourceId, setSourceId] = useState(node.sockets[0]?.id ?? "");
  const [targetSocketId, setTargetSocketId] = useState("");
  const [sourceSecondId, setSourceSecondId] = useState(node.sockets[1]?.id ?? "");
  const [targetSecondId, setTargetSecondId] = useState("");
  const [twoPoints, setTwoPoints] = useState(false);
  const target = targets.find(item => item.id === targetId);
  function fit() {
    if (!target) return;
    try {
      if (twoPoints) {
        const world = getGarageNodeMatrix(scene, target.id);
        onChange(alignGarageNodeToPoints(scene, node.id,
          [garageNodeContactPoint(node, sourceId || null), garageNodeContactPoint(node, sourceSecondId || null)],
          [transformGaragePoint(world, garageNodeContactPoint(target, targetSocketId || null)),
            transformGaragePoint(world, garageNodeContactPoint(target, targetSecondId || null))]));
      } else onChange(alignGarageNodeToSocket(scene, node.id, sourceId || null, target.id, targetSocketId || null));
    } catch (error) { onError(error instanceof Error ? error.message : "Не удалось совместить точки."); }
  }
  const pointSelect = (label: string, value: string, setValue: (value: string) => void, item: GarageNode | undefined) =>
    <label className={styles.field}><span>{label}</span><select aria-label={label} value={value} onChange={event => setValue(event.target.value)} disabled={!item}>
      <option value="">Опорная точка</option>{item?.sockets.map(socket => <option key={socket.id} value={socket.id}>{socket.name}</option>)}
    </select></label>;
  return <details><summary>Подгонка контакта</summary>
    <p className={styles.hint}>Перенесите точку стойки к точке корпуса, сохранив стойку независимой. По двум точкам также подгоняются размер и поворот.</p>
    <label className={styles.field}><span>Слой назначения</span><select aria-label="Слой назначения" value={targetId} onChange={event => {
      setTargetId(event.target.value); setTargetSocketId(""); setTargetSecondId("");
    }}><option value="">Выберите слой</option>{targets.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
    {pointSelect("Точка детали", sourceId, setSourceId, node)}
    {pointSelect("Точка назначения", targetSocketId, setTargetSocketId, target)}
    <label className={styles.field}><span><input type="checkbox" checked={twoPoints} onChange={event => setTwoPoints(event.target.checked)} /> По двум точкам</span></label>
    {twoPoints && <>{pointSelect("Вторая точка детали", sourceSecondId, setSourceSecondId, node)}
      {pointSelect("Вторая точка назначения", targetSecondId, setTargetSecondId, target)}</>}
    <button type="button" disabled={!target} onClick={fit}>{twoPoints ? "Подогнать по двум точкам" : "Совместить точки"}</button>
  </details>;
}
