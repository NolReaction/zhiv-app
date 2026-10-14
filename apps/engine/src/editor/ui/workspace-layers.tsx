"use client";

import { memo, useMemo, useState, type DragEvent } from "react";
import { ArrowDown, ArrowUp, Eye, EyeOff, FolderPlus, LockKeyhole, Plus, Scan, Search, Settings2, Trash2, UnlockKeyhole } from "lucide-react";
import type { ForestStatus } from "@/apps/engine/src/editor/input/controller";
import { EditorButton } from "./editor-button";
import { WorkspaceFolders } from "./workspace-folders";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof import("@/apps/engine/src/editor/input/controller")["createForestController"]>;
const dragType = "application/x-forest-object";

export const WorkspaceLayers = memo(function WorkspaceLayers({ status, controller, onInspect, onAreaGroup }: { status: ForestStatus; controller: Controller | null; onInspect: () => void; onAreaGroup: () => void }) {
  const [search, setSearch] = useState("");
  const [layerFilter, setLayerFilter] = useState("all");
  const layers = useMemo(() => new Map(status.layers.map(layer => [layer.id, layer])), [status.layers]);
  const occupiedLayers = useMemo(() => new Set(status.objectList.map(object => object.layerId ?? "world")), [status.objectList]);
  const effectiveFilter = layerFilter === "all" || layers.has(layerFilter) ? layerFilter : "all";
  function source(event: DragEvent) { return event.dataTransfer.getData(dragType); }
  function addFolder() { const id = controller?.addFolder(null); if (id) { controller?.selectFolder(id); onInspect(); } }
  return <div className={styles.layersContent}>
    <details className={styles.layerDetails}>
      <summary>Слои перекрытия <span>{status.layers.length}</span></summary>
      <div className={styles.panelSectionHeading}><strong>Верхние слои ближе</strong><EditorButton type="button" aria-label="Добавить слой" title="Добавить слой" onClick={() => controller?.addLayer()}><Plus size={16} /></EditorButton></div>
      <div className={styles.layerList} role="list" aria-label="Слои от переднего к заднему">{[...status.layers].reverse().map((layer, index) => <div key={layer.id} role="listitem" className={styles.layerRow} data-active={layer.id === status.activeLayerId} onDragOver={event => { if (event.dataTransfer.types.includes(dragType) && !layer.locked) { event.preventDefault(); event.dataTransfer.dropEffect = "move"; } }} onDrop={event => { event.preventDefault(); const id = source(event); if (id && !layer.locked && controller?.selectById(id)) controller.setSelectedLayer(layer.id); }}>
        <EditorButton type="button" className={styles.layerSelect} aria-label={"Выбрать слой " + layer.name} aria-pressed={layer.id === status.activeLayerId} title="Новые предметы появятся в этом слое" onClick={() => controller?.setActiveLayer(layer.id)}><span className={styles.layerDot} /></EditorButton>
        <input aria-label={"Название слоя " + layer.name} title="Переименовать слой" key={layer.id + layer.name} defaultValue={layer.name} maxLength={100} onFocus={() => controller?.setActiveLayer(layer.id)} onBlur={event => { const name = event.currentTarget.value.trim(); if (name && name !== layer.name) controller?.renameLayer(layer.id, name); else event.currentTarget.value = layer.name; }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} />
        <EditorButton type="button" aria-label={(layer.visible ? "Скрыть слой " : "Показать слой ") + layer.name} title={layer.visible ? "Скрыть слой" : "Показать слой"} onClick={() => controller?.setLayerVisibility(layer.id, !layer.visible)}>{layer.visible ? <Eye size={15} /> : <EyeOff size={15} />}</EditorButton>
        <EditorButton type="button" aria-label={(layer.locked ? "Разблокировать слой " : "Заблокировать слой ") + layer.name} title={layer.locked ? "Разблокировать слой" : "Заблокировать слой"} onClick={() => controller?.setLayerLocked(layer.id, !layer.locked)}>{layer.locked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</EditorButton>
        <div className={styles.layerOrder}><EditorButton type="button" aria-label={"Слой вперёд: " + layer.name} title="На слой вперёд" disabled={index === 0} onClick={() => controller?.moveLayer(layer.id, "forward")}><ArrowUp size={13} /></EditorButton><EditorButton type="button" aria-label={"Слой назад: " + layer.name} title="На слой назад" disabled={index === status.layers.length - 1} onClick={() => controller?.moveLayer(layer.id, "backward")}><ArrowDown size={13} /></EditorButton></div>
        <EditorButton type="button" aria-label={"Удалить слой " + layer.name} title={layer.id === "world" ? "Основной слой нельзя удалить" : layer.locked ? "Сначала разблокируй слой" : layers.get("world")?.locked && occupiedLayers.has(layer.id) ? "Основной слой заблокирован" : "Удалить слой; предметы перейдут в основной"} disabled={layer.id === "world" || layer.locked || !!layers.get("world")?.locked && occupiedLayers.has(layer.id)} onClick={() => controller?.deleteLayer(layer.id)}><Trash2 size={14} /></EditorButton>
      </div>)}</div>
    </details>
    <div className={styles.panelSectionHeading}><strong>Папки <span>{status.objectList.length} предметов</span></strong><div className={styles.folderCreateControls}><EditorButton type="button" className={styles.areaGroupButton} aria-label="Группа по области" title="Группа по области (R): в рамку должно попасть основание предмета" onClick={onAreaGroup}><Scan size={15} /><span>Рамка</span><kbd>R</kbd></EditorButton><EditorButton type="button" aria-label="Добавить папку" title="Добавить папку" onClick={addFolder}><FolderPlus size={17} /></EditorButton></div></div>
    <label className={styles.searchField}><Search size={15} /><input aria-label="Найти предмет" placeholder="Имя, папка, тип или ID…" value={search} onChange={event => setSearch(event.target.value)} /></label>
    <select className={styles.layerFilter} aria-label="Фильтр слоя" value={effectiveFilter} onChange={event => setLayerFilter(event.target.value)}><option value="all">Все слои</option>{[...status.layers].reverse().map(layer => <option key={layer.id} value={layer.id}>{layer.name}</option>)}</select>
    <WorkspaceFolders status={status} controller={controller} query={search} layerFilter={effectiveFilter} />
    {status.selectedFolder && <div className={styles.listOrderControls}><EditorButton type="button" onClick={onInspect}><Settings2 size={14} /> Настроить папку</EditorButton><EditorButton type="button" aria-label="Вывести папку в корень" disabled={status.selectedFolder.locked} onClick={() => controller?.reparentFolder(status.selectedFolder!.folder.id, null)}>В корень</EditorButton></div>}
    {status.selected && <div className={styles.listOrderControls}><EditorButton type="button" onClick={onInspect}><Settings2 size={14} /> Предмет</EditorButton><EditorButton type="button" disabled={status.selectedLocked} aria-label="Выбранный предмет на шаг вперёд" onClick={() => controller?.setSelectedOrder("forward")}><ArrowUp size={14} /></EditorButton><EditorButton type="button" disabled={status.selectedLocked} aria-label="Выбранный предмет на шаг назад" onClick={() => controller?.setSelectedOrder("backward")}><ArrowDown size={14} /></EditorButton></div>}
    <p className={styles.small}>Папки объединяют предметы, слои задают перекрытие. Перетащи предмет в папку; строки предметов — для порядка.</p>
  </div>;
}, (previous, next) => previous.controller === next.controller && previous.status.objectList === next.status.objectList && previous.status.layers === next.status.layers && previous.status.folders === next.status.folders && previous.status.assets === next.status.assets && previous.status.trees === next.status.trees && previous.status.activeLayerId === next.status.activeLayerId && previous.status.selected?.id === next.status.selected?.id && previous.status.selectedLocked === next.status.selectedLocked && previous.status.selectedFolder?.folder === next.status.selectedFolder?.folder && previous.status.selectedFolder?.locked === next.status.selectedFolder?.locked);
