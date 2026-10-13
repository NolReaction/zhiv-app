"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, GripVertical, LockKeyhole, Plus, Search, Trash2, UnlockKeyhole } from "lucide-react";
import type { ForestStatus } from "./controller";
import type { ForestObject } from "./objects";
import { EditorButton } from "./editor-button";
import { objectNames } from "./editor-inspector";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof import("./controller")["createForestController"]>;
const dragType = "application/x-forest-object";
const rowHeight = 44;

export function WorkspaceLayers({ status, controller }: { status: ForestStatus; controller: Controller | null }) {
  const [search, setSearch] = useState("");
  const [layerFilter, setLayerFilter] = useState("all");
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(264);
  const [drop, setDrop] = useState<{ id: string; position: "before" | "after" } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const dragging = useRef<string | null>(null);
  const names = useMemo(() => new Map(status.assets.map(asset => [asset.id, asset.name])), [status.assets]);
  const layers = useMemo(() => new Map(status.layers.map(layer => [layer.id, layer])), [status.layers]);
  const occupiedLayers = useMemo(() => new Set(status.objectList.map(object => object.layerId ?? "world")), [status.objectList]);
  const effectiveFilter = layerFilter === "all" || layers.has(layerFilter) ? layerFilter : "all";
  const objectName = (object: ForestObject) => object.name ?? (object.assetId ? names.get(object.assetId) : undefined) ?? objectNames[object.kind];
  const filtered = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("ru");
    return status.objectList.filter(object => (effectiveFilter === "all" || (object.layerId ?? "world") === effectiveFilter)
      && (!query || [object.name, object.kind, objectNames[object.kind], object.id, object.assetId && names.get(object.assetId)].filter(Boolean).join(" ").toLocaleLowerCase("ru").includes(query)));
  }, [status.objectList, search, effectiveFilter, names]);
  useEffect(() => {
    const node = scroll.current; if (!node) return;
    const measure = () => setViewportHeight(Math.max(rowHeight, node.clientHeight));
    const observer = new ResizeObserver(measure); observer.observe(node); measure();
    return () => observer.disconnect();
  }, []);
  function updateSearch(value: string) { setSearch(value); setScrollTop(0); if (scroll.current) scroll.current.scrollTop = 0; }
  function source(event: DragEvent) { return dragging.current ?? event.dataTransfer.getData(dragType); }
  function endDrag() { dragging.current = null; setDrop(null); }
  const start = Math.max(0, Math.min(filtered.length - 1, Math.floor(scrollTop / rowHeight) - 4));
  const end = Math.min(filtered.length, start + Math.ceil(viewportHeight / rowHeight) + 8);
  return <div className={styles.layersContent}>
    <div className={styles.panelSectionHeading}><strong>Слои</strong><EditorButton type="button" aria-label="Добавить слой" title="Добавить слой" onClick={() => controller?.addLayer()}><Plus size={16} /></EditorButton></div>
    <div className={styles.layerList} role="list" aria-label="Слои от переднего к заднему">{[...status.layers].reverse().map((layer, index) => <div key={layer.id} role="listitem" className={styles.layerRow} data-active={layer.id === status.activeLayerId} onDragOver={event => { if (dragging.current && !layer.locked) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={event => { event.preventDefault(); const id = source(event); if (id && !layer.locked && controller?.selectById(id)) controller.setSelectedLayer(layer.id); endDrag(); }}>
      <EditorButton type="button" className={styles.layerSelect} aria-label={"Выбрать слой " + layer.name} aria-pressed={layer.id === status.activeLayerId} title="Новые предметы появятся в этом слое" onClick={() => controller?.setActiveLayer(layer.id)}><span className={styles.layerDot} /></EditorButton>
      <input aria-label={"Название слоя " + layer.name} title="Переименовать слой" key={layer.id + layer.name} defaultValue={layer.name} maxLength={100} onFocus={() => controller?.setActiveLayer(layer.id)} onBlur={event => { const name = event.currentTarget.value.trim(); if (name && name !== layer.name) controller?.renameLayer(layer.id, name); else event.currentTarget.value = layer.name; }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
      <EditorButton type="button" aria-label={(layer.visible ? "Скрыть слой " : "Показать слой ") + layer.name} title={layer.visible ? "Скрыть слой" : "Показать слой"} onClick={() => controller?.setLayerVisibility(layer.id, !layer.visible)}>{layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</EditorButton>
      <EditorButton type="button" aria-label={(layer.locked ? "Разблокировать слой " : "Заблокировать слой ") + layer.name} title={layer.locked ? "Разблокировать слой" : "Заблокировать слой"} onClick={() => controller?.setLayerLocked(layer.id, !layer.locked)}>{layer.locked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</EditorButton>
      <div className={styles.layerOrder}><EditorButton type="button" aria-label={"Слой вперёд: " + layer.name} title="На слой вперёд" disabled={index === 0} onClick={() => controller?.moveLayer(layer.id, "forward")}><ArrowUp size={13} /></EditorButton><EditorButton type="button" aria-label={"Слой назад: " + layer.name} title="На слой назад" disabled={index === status.layers.length - 1} onClick={() => controller?.moveLayer(layer.id, "backward")}><ArrowDown size={13} /></EditorButton></div>
      <EditorButton type="button" aria-label={"Удалить слой " + layer.name} title={layer.id === "world" ? "Основной слой нельзя удалить" : layer.locked ? "Сначала разблокируй слой" : layers.get("world")?.locked && occupiedLayers.has(layer.id) ? "Основной слой заблокирован" : "Удалить слой; предметы перейдут в основной"} disabled={layer.id === "world" || layer.locked || !!layers.get("world")?.locked && occupiedLayers.has(layer.id)} onClick={() => controller?.deleteLayer(layer.id)}><Trash2 size={14} /></EditorButton>
    </div>)}</div>
    <div className={styles.panelSectionHeading}><strong>Предметы <span>{filtered.length}</span></strong><span className={styles.stackHint}>Верхние ближе</span></div>
    <label className={styles.searchField}><Search size={15} /><input aria-label="Найти предмет" placeholder="Имя, тип или ID…" value={search} onChange={event => updateSearch(event.target.value)} /></label>
    <select className={styles.layerFilter} aria-label="Фильтр слоя" value={effectiveFilter} onChange={event => { setLayerFilter(event.target.value); setScrollTop(0); if (scroll.current) scroll.current.scrollTop = 0; }}><option value="all">Все слои</option>{[...status.layers].reverse().map(layer => <option key={layer.id} value={layer.id}>{layer.name}</option>)}</select>
    <div ref={scroll} className={styles.objectList} role="list" aria-label="Предметы от переднего к заднему" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
      <div className={styles.virtualRows} style={{ height: filtered.length * rowHeight }}>
        {filtered.slice(start, end).map((object, offset) => {
          const name = objectName(object), layer = layers.get(object.layerId ?? "world"), locked = !!object.locked || !!layer?.locked;
          const hidden = !!object.hidden || layer?.visible === false || !status.trees && (object.kind === "tree" || object.kind === "shrub");
          return <div key={object.id} role="listitem" aria-posinset={start + offset + 1} aria-setsize={filtered.length} data-object-id={object.id} data-selected={status.selected?.id === object.id} data-hidden={hidden} data-drop={drop?.id === object.id ? drop.position : undefined} className={styles.objectRow} style={{ top: (start + offset) * rowHeight }} draggable={!locked} onDragStart={event => { dragging.current = object.id; event.dataTransfer.setData(dragType, object.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={endDrag} onDragOver={event => { if (!dragging.current || dragging.current === object.id || layer?.locked) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; const bounds = event.currentTarget.getBoundingClientRect(); setDrop({ id: object.id, position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" }); }} onDrop={event => { event.preventDefault(); const id = source(event); const position = drop?.id === object.id ? drop.position : "before"; if (id && id !== object.id && !layer?.locked) controller?.reorderObject(id, object.id, position); endDrag(); }}>
            <GripVertical size={13} className={styles.grip} aria-hidden="true" />
            <EditorButton type="button" className={styles.objectSelect} aria-label={"Выбрать " + name + ": " + object.id} title={name + " · " + object.id} aria-pressed={status.selected?.id === object.id} onClick={() => controller?.selectById(object.id)}><span>{name}</span><small>{layer?.name ?? "Мир"} · {object.id}</small></EditorButton>
            <EditorButton type="button" aria-label={(object.hidden ? "Показать " : "Скрыть ") + name + ": " + object.id} title={object.hidden ? "Показать предмет" : "Скрыть предмет"} onClick={() => controller?.setObjectHidden(object.id, !object.hidden)}>{hidden ? <EyeOff size={14} /> : <Eye size={14} />}</EditorButton>
            <EditorButton type="button" aria-label={(object.locked ? "Разблокировать " : "Заблокировать ") + name + ": " + object.id} title={object.locked ? "Разблокировать предмет" : layer?.locked ? "Слой заблокирован" : "Заблокировать предмет"} onClick={() => controller?.setObjectLocked(object.id, !object.locked)}>{locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}</EditorButton>
          </div>;
        })}
      </div>
      {!filtered.length && <p className={styles.emptyList}>Ничего не найдено. Измени запрос или слой.</p>}
    </div>
    {status.selected && <div className={styles.listOrderControls}><EditorButton type="button" disabled={status.selectedLocked} aria-label="Выбранный предмет на шаг вперёд" onClick={() => controller?.setSelectedOrder("forward")}><ArrowUp size={14} /> Выше</EditorButton><EditorButton type="button" disabled={status.selectedLocked} aria-label="Выбранный предмет на шаг назад" onClick={() => controller?.setSelectedOrder("backward")}><ArrowDown size={14} /> Ниже</EditorButton></div>}
    <p className={styles.small}>Тяни строку выше или ниже, либо на другой слой. На телефоне выбери предмет и используй «Выше» / «Ниже» или вкладку «Предмет».</p>
  </div>;
}
