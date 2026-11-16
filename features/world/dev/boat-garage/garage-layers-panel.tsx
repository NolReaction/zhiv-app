import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowDown, ArrowUp, CornerDownRight, EyeOff, Folder, FolderPlus, GripVertical, ImagePlus, Images, Layers, LockKeyhole, Upload } from "lucide-react";
import type { GarageAsset, GarageNode, GarageScene } from "./garage-scene-types";
import { canMoveGarageLayer, garageLayerStack, garageMovingLayerIds, moveGarageLayer } from "./garage-layer-order.mjs";
import styles from "./garage-layers-panel.module.css";

type Props = {
  scene: GarageScene;
  assets: GarageAsset[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onChange: (scene: GarageScene) => void;
  onAdd: (asset?: GarageAsset) => void;
  onUpload: (file: File) => void;
  onImport: (file: File) => void;
};

function AssetImage({ src }: { src: string }) {
  // The editor previews local originals, including images uploaded during this session.
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" draggable={false} loading="lazy" />;
}

type Drop = { id: string; edge: "above" | "below" };
type Gesture = {
  pointerId: number; source: string; scene: GarageScene; moving: Set<string>;
  startX: number; startY: number; x: number; y: number; dragging: boolean;
};

/** Pointer capture keeps drag events on the source; hit test the scrollable stack independently. */
function dropAt(list: HTMLElement, gesture: Gesture): Drop | null {
  const { x, y, moving } = gesture;
  const bounds = list.getBoundingClientRect();
  if (x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom) return null;
  const rows = list.querySelectorAll<HTMLElement>("[data-layer-id]");
  for (const row of rows) {
    const box = row.getBoundingClientRect();
    if (y > box.bottom && row !== rows[rows.length - 1]) continue;
    const id = row.dataset.layerId!;
    if (moving.has(id)) return null;
    return { id, edge: y < (box.top + box.bottom) / 2 ? "above" : "below" };
  }
  return null;
}

function LayerStack({ scene, selectedId, onSelect, onChange, onAdd }: Pick<Props, "scene" | "selectedId" | "onSelect" | "onChange" | "onAdd">) {
  const list = useRef<HTMLUListElement>(null);
  const gesture = useRef<Gesture | null>(null);
  const frame = useRef(0);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [marker, setMarker] = useState<Drop | null>(null);
  const [announcement, announce] = useState("");
  const layers: GarageNode[] = garageLayerStack(scene);
  const index = layers.findIndex(node => node.id === selectedId);
  const selected = layers[index];

  useEffect(() => {
    const container = list.current;
    const row = container?.children[index];
    if (!container || !row || !selectedId) return;
    const reveal = () => {
      const bounds = container.getBoundingClientRect(), item = row.getBoundingClientRect();
      if (item.top < bounds.top) container.scrollTop += item.top - bounds.top;
      else if (item.bottom > bounds.bottom) container.scrollTop += item.bottom - bounds.bottom;
    };
    if (container.clientHeight) { reveal(); return; }
    // A selection on the mobile canvas can change while the layer drawer is closed.
    const observer = new ResizeObserver(() => {
      if (container.clientHeight) { reveal(); observer.disconnect(); }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, [selectedId, index]);

  function neighbor(id: string, edge: Drop["edge"]) {
    if (!canMoveGarageLayer(scene, id)) return;
    const sourceIndex = layers.findIndex(node => node.id === id);
    const moving = garageMovingLayerIds(scene, id);
    const candidates = edge === "above" ? layers.slice(0, sourceIndex).reverse() : layers.slice(sourceIndex + 1);
    return candidates.find(node => !moving.has(node.id));
  }

  function move(id: string, target: Drop) {
    const next = moveGarageLayer(scene, id, target.id, target.edge);
    if (next === scene) return;
    onChange(next);
    onSelect(id);
    const moved = layers.find(node => node.id === id);
    const adjacent = layers.find(node => node.id === target.id);
    announce(`«${moved?.name}» ${target.edge === "above" ? "выше" : "ниже"} слоя «${adjacent?.name}».`);
  }

  function step(id: string, edge: Drop["edge"]) {
    const adjacent = neighbor(id, edge);
    if (adjacent) move(id, { id: adjacent.id, edge });
  }

  function cancel() {
    gesture.current = null;
    cancelAnimationFrame(frame.current);
    setDraggingId(null);
    setMarker(null);
  }

  useEffect(() => {
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape" && gesture.current) {
        event.preventDefault();
        cancel();
      }
    }
    window.addEventListener("keydown", escape, true);
    window.addEventListener("blur", cancel);
    return () => {
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("blur", cancel);
      cancelAnimationFrame(frame.current);
    };
  }, []);

  function showTarget() {
    const active = gesture.current, container = list.current;
    if (!active?.dragging || !container) return;
    const target = dropAt(container, active);
    setMarker(old => old?.id === target?.id && old?.edge === target?.edge ? old : target);
    const bounds = container.getBoundingClientRect();
    if (active.x < bounds.left || active.x > bounds.right || active.y < bounds.top || active.y > bounds.bottom) return;
    const top = active.y - bounds.top, bottom = bounds.bottom - active.y;
    const edge = 30;
    const scroll = top < edge ? -Math.ceil((edge - top) / 3) : bottom < edge ? Math.ceil((edge - bottom) / 3) : 0;
    if (!scroll) return;
    const before = container.scrollTop;
    container.scrollTop += scroll;
    if (container.scrollTop !== before) frame.current = requestAnimationFrame(showTarget);
  }

  function start(event: ReactPointerEvent<HTMLButtonElement>, node: GarageNode) {
    if (event.button !== 0 || !event.isPrimary || !canMoveGarageLayer(scene, node.id)) return;
    // On touch, the body of a row scrolls the list and the dotted handle moves it.
    if (event.pointerType === "touch" && !(event.target as Element).closest("[data-layer-grip]")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = { pointerId: event.pointerId, source: node.id, scene, moving: garageMovingLayerIds(scene, node.id),
      startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY, dragging: false };
  }

  function track(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = gesture.current;
    if (active?.pointerId !== event.pointerId) return;
    active.x = event.clientX;
    active.y = event.clientY;
    if (!active.dragging) {
      if (Math.hypot(active.x - active.startX, active.y - active.startY) < 5) return;
      active.dragging = true;
      setDraggingId(active.source);
      onSelect(active.source);
    }
    cancelAnimationFrame(frame.current);
    showTarget();
  }

  function finish(event: ReactPointerEvent<HTMLButtonElement>) {
    const active = gesture.current;
    if (active?.pointerId !== event.pointerId) return;
    if (active.dragging && list.current && active.scene === scene) {
      active.x = event.clientX;
      active.y = event.clientY;
      const target = dropAt(list.current, active);
      if (target) move(active.source, target);
    }
    cancel();
  }

  return <>
    <div className={styles.commands}>
      <span>{layers.length} в сцене</span>
      <button type="button" aria-label="Поднять слой" title="Поднять слой · Alt + ↑" disabled={!selected || !neighbor(selected.id, "above")} onClick={() => step(selected.id, "above")}><ArrowUp size={16} /></button>
      <button type="button" aria-label="Опустить слой" title="Опустить слой · Alt + ↓" disabled={!selected || !neighbor(selected.id, "below")} onClick={() => step(selected.id, "below")}><ArrowDown size={16} /></button>
      <button type="button" aria-label="Добавить группу" title="Добавить группу" onClick={() => onAdd()}><FolderPlus size={17} /></button>
    </div>
    <ul className={styles.stack} ref={list} aria-label="Порядок слоёв" data-dragging={Boolean(draggingId)}>
      {layers.map(node => {
        const asset = scene.assets.find(entry => entry.id === node.assetId);
        const parent = scene.nodes.find(entry => entry.id === node.parentId);
        const movable = canMoveGarageLayer(scene, node.id);
        const lockReason = node.locked ? "Слой закреплён" : !movable ? "В группе есть закреплённый слой" : "";
        const description = [node.name, parent && `Крепление к «${parent.name}»`, lockReason].filter(Boolean).join(" · ");
        return <li key={node.id} data-layer-id={node.id} data-drop={marker?.id === node.id ? marker.edge : undefined}>
          <button type="button" className={styles.layer} aria-pressed={node.id === selectedId}
            aria-keyshortcuts={movable ? "Alt+ArrowUp Alt+ArrowDown" : undefined} data-moving={draggingId === node.id} data-movable={movable}
            title={description}
            onClick={() => onSelect(node.id)} onPointerDown={event => start(event, node)} onPointerMove={track} onPointerUp={finish}
            onPointerCancel={cancel} onLostPointerCapture={cancel}
            onKeyDown={event => {
              if (!event.altKey || !["ArrowUp", "ArrowDown"].includes(event.key)) return;
              event.preventDefault();
              step(node.id, event.key === "ArrowUp" ? "above" : "below");
            }}>
            <span className={styles.handle} data-layer-grip={movable || undefined} aria-hidden="true">{movable ? <GripVertical size={15} /> : <LockKeyhole size={14} />}</span>
            <span className={styles.thumb} data-hidden={!node.visible}>
              {asset ? <AssetImage src={asset.src} /> : <Folder size={17} aria-hidden="true" />}
            </span>
            <span className={styles.name}>{parent && <CornerDownRight size={12} aria-hidden="true" />}{node.name}</span>
            {!node.visible && <EyeOff size={14} aria-label="Скрыт" />}
            {lockReason && <span className={styles.srOnly}>{lockReason}</span>}
          </button>
        </li>;
      })}
    </ul>
    <p className={styles.hint}>Тяните слой за точки. Чем выше строка, тем ближе слой к вам.</p>
    <span role="status" className={styles.srOnly}>{announcement}</span>
  </>;
}

export function GarageLayersPanel({ scene, assets, selectedId, onChange, onSelect, onAdd, onUpload, onImport }: Props) {
  const [page, setPage] = useState<"layers" | "assets">("layers");
  const imageInput = useRef<HTMLInputElement>(null), jsonInput = useRef<HTMLInputElement>(null);
  return <div className={styles.panel}>
    <div className={styles.switcher} aria-label="Панель сцены">
      <button type="button" aria-pressed={page === "layers"} onClick={() => setPage("layers")}><Layers size={15} />Слои</button>
      <button type="button" aria-pressed={page === "assets"} onClick={() => setPage("assets")}><Images size={15} />Изображения</button>
    </div>
    {page === "layers" ? <LayerStack {...{ scene, selectedId, onChange, onSelect, onAdd }} /> : <>
      <div className={styles.assetCommands}>
        <button type="button" title="Загрузить PNG, WebP или JPEG" onClick={() => imageInput.current?.click()}><ImagePlus size={16} />Загрузить</button>
        <button type="button" title="Импортировать сборку JSON" aria-label="Импортировать сборку JSON" onClick={() => jsonInput.current?.click()}><Upload size={15} />JSON</button>
      </div>
      <ul className={styles.assetList} aria-label="Изображения для добавления">
        {assets.map(asset => <li key={asset.id}><button type="button" title={`Добавить на сцену: ${asset.name}`} onClick={() => onAdd(asset)}>
          <span className={styles.assetThumb}><AssetImage src={asset.src} /></span>
          <span><strong>{asset.name}</strong><small>{asset.width} × {asset.height}</small></span>
        </button></li>)}
      </ul>
      <p className={styles.hint}>Нажмите на изображение, чтобы добавить его на сцену.</p>
    </>}
    <input ref={imageInput} hidden type="file" accept="image/png,image/webp,image/jpeg" onChange={event => { const file = event.target.files?.[0]; if (file) onUpload(file); event.target.value = ""; }} />
    <input ref={jsonInput} hidden type="file" accept="application/json,.json" onChange={event => { const file = event.target.files?.[0]; if (file) onImport(file); event.target.value = ""; }} />
  </div>;
}
