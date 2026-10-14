"use client";

import { memo, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Folder, FolderOpen, GripVertical, LockKeyhole, UnlockKeyhole } from "lucide-react";
import type { ForestStatus } from "@/apps/engine/src/editor/input/controller";
import type { ForestObject } from "@/apps/engine/examples/forest/scene/objects";
import { folderAncestors, isFolderLocked, isFolderVisible, objectFolderId, type SceneFolder } from "@/apps/engine/examples/forest/scene/folders";
import { objectNames } from "./editor-inspector";
import { EditorButton } from "./editor-button";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof import("@/apps/engine/src/editor/input/controller")["createForestController"]>;
type Row = { type: "folder"; folder: SceneFolder; level: number; count: number; open: boolean } | { type: "object"; object: ForestObject; level: number };
const objectDrag = "application/x-forest-object", folderDrag = "application/x-forest-folder", rowHeight = 44;

export const WorkspaceFolders = memo(function WorkspaceFolders({ status, controller, query, layerFilter }: { status: ForestStatus; controller: Controller | null; query: string; layerFilter: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [scrollTop, setScrollTop] = useState(0), [height, setHeight] = useState(264);
  const [drop, setDrop] = useState<{ id: string; position: "before" | "after" | "inside" } | null>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const dragging = useRef<{ type: "object" | "folder"; id: string } | null>(null);
  const names = useMemo(() => new Map(status.assets.map(asset => [asset.id, asset.name])), [status.assets]);
  const layers = useMemo(() => new Map(status.layers.map(layer => [layer.id, layer])), [status.layers]);
  const rows = useMemo(() => {
    const children = new Map<string | null, SceneFolder[]>(), items = new Map<string | null, ForestObject[]>(), counts = new Map<string, number>(), matches = new Set<string>();
    const text = query.trim().toLocaleLowerCase("ru");
    for (const folder of status.folders) { const siblings = children.get(folder.parentId) ?? []; siblings.push(folder); children.set(folder.parentId, siblings); }
    for (const object of status.objectList) {
      if (layerFilter !== "all" && (object.layerId ?? "world") !== layerFilter) continue;
      const folderId = objectFolderId(object, status.folders), ancestors = folderAncestors(folderId, status.folders) ?? [];
      for (const folder of ancestors) counts.set(folder.id, (counts.get(folder.id) ?? 0) + 1);
      const searchable = [object.name, objectNames[object.kind], object.kind, object.id, object.assetId && names.get(object.assetId), ...ancestors.map(folder => folder.name)].filter(Boolean).join(" ").toLocaleLowerCase("ru");
      if (text && !searchable.includes(text)) continue;
      const siblings = items.get(folderId) ?? []; siblings.push(object); items.set(folderId, siblings);
      for (const folder of ancestors) matches.add(folder.id);
    }
    for (const folder of status.folders) if (text && folder.name.toLocaleLowerCase("ru").includes(text)) for (const ancestor of folderAncestors(folder.id, status.folders) ?? []) matches.add(ancestor.id);
    const result: Row[] = [];
    function visit(parentId: string | null, level: number) {
      for (const folder of children.get(parentId) ?? []) {
        if (text && !matches.has(folder.id)) continue;
        const open = !!text || expanded.has(folder.id);
        result.push({ type: "folder", folder, level, open, count: counts.get(folder.id) ?? 0 });
        if (open) visit(folder.id, level + 1);
      }
      for (const object of items.get(parentId) ?? []) result.push({ type: "object", object, level });
    }
    visit(null, 0); return result;
  }, [status.objectList, status.folders, names, expanded, query, layerFilter]);
  useEffect(() => {
    const node = scroll.current; if (!node) return;
    const resize = () => setHeight(Math.max(rowHeight, node.clientHeight)); const observer = new ResizeObserver(resize); observer.observe(node); resize(); return () => observer.disconnect();
  }, []);
  useEffect(() => { const reset = () => { if (scroll.current) scroll.current.scrollTop = 0; setScrollTop(0); }; reset(); }, [query, layerFilter]);
  function toggle(id: string) { setExpanded(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function endDrag() { dragging.current = null; setDrop(null); }
  function payload(event: DragEvent) { return dragging.current ?? (event.dataTransfer.getData(folderDrag) ? { type: "folder" as const, id: event.dataTransfer.getData(folderDrag) } : { type: "object" as const, id: event.dataTransfer.getData(objectDrag) }); }
  const start = Math.max(0, Math.min(rows.length - 1, Math.floor(scrollTop / rowHeight) - 4)), end = Math.min(rows.length, start + Math.ceil(height / rowHeight) + 8);
  return <div ref={scroll} className={styles.objectList} role="list" aria-label="Папки и предметы сцены" onScroll={event => setScrollTop(event.currentTarget.scrollTop)}>
    <div className={styles.virtualRows} style={{ height: rows.length * rowHeight }}>
      {rows.slice(start, end).map((row, offset) => {
        const top = (start + offset) * rowHeight, paddingLeft = 4 + Math.min(row.level, 5) * 10;
        if (row.type === "folder") {
          const folder = row.folder, locked = isFolderLocked(folder.id, status.folders), hidden = !isFolderVisible(folder.id, status.folders);
          return <div role="listitem" key={"folder:" + folder.id} data-folder-id={folder.id} data-selected={status.selectedFolder?.folder.id === folder.id} data-hidden={hidden} data-drop={drop?.id === folder.id ? "inside" : undefined} className={styles.folderRow} style={{ top, paddingLeft }} draggable={!locked} onDragStart={event => { dragging.current = { type: "folder", id: folder.id }; event.dataTransfer.setData(folderDrag, folder.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={endDrag} onDragOver={event => { if (locked || !event.dataTransfer.types.some(type => type === objectDrag || type === folderDrag)) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setDrop({ id: folder.id, position: "inside" }); }} onDrop={event => { event.preventDefault(); const source = payload(event); if (source.id && !locked) { if (source.type === "object") controller?.moveObjectToFolder(source.id, folder.id); else if (source.id !== folder.id) controller?.reparentFolder(source.id, folder.id); } endDrag(); }}>
            <EditorButton type="button" className={styles.folderExpand} aria-label={(row.open ? "Свернуть папку " : "Раскрыть папку ") + folder.name} aria-expanded={row.open} disabled={!!query.trim()} title={query.trim() ? "Папки раскрыты для результатов поиска" : row.open ? "Свернуть папку" : "Раскрыть папку"} onClick={() => toggle(folder.id)}>{row.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</EditorButton>
            <EditorButton type="button" className={styles.folderSelect} aria-label={"Выбрать папку " + folder.name} title={folder.name + ": " + row.count + " предметов"} aria-pressed={status.selectedFolder?.folder.id === folder.id} onClick={() => controller?.selectFolder(folder.id)}>{row.open ? <FolderOpen size={15} /> : <Folder size={15} />}<span>{folder.name}</span><small>{row.count}</small></EditorButton>
            <EditorButton type="button" aria-label={(folder.visible ? "Скрыть папку " : "Показать папку ") + folder.name} title={folder.visible ? hidden ? "Папка скрыта родителем" : "Скрыть папку" : "Показать папку"} onClick={() => controller?.setFolderVisibility(folder.id, !folder.visible)}>{hidden ? <EyeOff size={14} /> : <Eye size={14} />}</EditorButton>
            <EditorButton type="button" aria-label={(folder.locked ? "Разблокировать папку " : "Заблокировать папку ") + folder.name} title={folder.locked ? "Разблокировать папку" : locked ? "Родительская папка заблокирована" : "Заблокировать папку"} onClick={() => controller?.setFolderLocked(folder.id, !folder.locked)}>{locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}</EditorButton>
          </div>;
        }
        const object = row.object, name = object.name ?? (object.assetId ? names.get(object.assetId) : undefined) ?? objectNames[object.kind], layer = layers.get(object.layerId ?? "world"), folderId = objectFolderId(object, status.folders);
        const locked = !!object.locked || !!layer?.locked || isFolderLocked(folderId, status.folders);
        const hidden = !!object.hidden || layer?.visible === false || !isFolderVisible(folderId, status.folders) || !status.trees && (object.kind === "tree" || object.kind === "shrub");
        return <div key={object.id} role="listitem" data-object-id={object.id} data-selected={status.selected?.id === object.id} data-hidden={hidden} data-drop={drop?.id === object.id ? drop.position : undefined} className={styles.objectRow} style={{ top, paddingLeft }} draggable={!locked} onDragStart={event => { dragging.current = { type: "object", id: object.id }; event.dataTransfer.setData(objectDrag, object.id); event.dataTransfer.effectAllowed = "move"; }} onDragEnd={endDrag} onDragOver={event => { if (!event.dataTransfer.types.includes(objectDrag) || layer?.locked || isFolderLocked(folderId, status.folders)) return; event.preventDefault(); const bounds = event.currentTarget.getBoundingClientRect(); setDrop({ id: object.id, position: event.clientY < bounds.top + bounds.height / 2 ? "before" : "after" }); }} onDrop={event => { event.preventDefault(); const source = payload(event); if (source.type === "object" && source.id && source.id !== object.id && !locked) controller?.reorderObject(source.id, object.id, drop?.id === object.id && drop.position === "after" ? "after" : "before"); endDrag(); }}>
          <GripVertical size={13} className={styles.grip} aria-hidden="true" />
          <EditorButton type="button" className={styles.objectSelect} aria-label={"Выбрать " + name + ": " + object.id} aria-pressed={status.selected?.id === object.id} title={name + " · " + object.id} onClick={() => controller?.selectById(object.id)}><span>{name}</span><small>{layer?.name ?? "Мир"} · {object.id}</small></EditorButton>
          <EditorButton type="button" aria-label={(object.hidden ? "Показать " : "Скрыть ") + name + ": " + object.id} title={object.hidden ? "Показать предмет" : hidden ? "Скрыт папкой, слоем или растительностью" : "Скрыть предмет"} onClick={() => controller?.setObjectHidden(object.id, !object.hidden)}>{hidden ? <EyeOff size={14} /> : <Eye size={14} />}</EditorButton>
          <EditorButton type="button" aria-label={(object.locked ? "Разблокировать " : "Заблокировать ") + name + ": " + object.id} title={object.locked ? "Разблокировать предмет" : locked ? "Папка или слой заблокированы" : "Заблокировать предмет"} onClick={() => controller?.setObjectLocked(object.id, !object.locked)}>{locked ? <LockKeyhole size={14} /> : <UnlockKeyhole size={14} />}</EditorButton>
        </div>;
      })}
    </div>
    {!rows.length && <p className={styles.emptyList}>Ничего не найдено. Измени запрос или слой.</p>}
  </div>;
}, (previous, next) => previous.controller === next.controller && previous.query === next.query && previous.layerFilter === next.layerFilter && previous.status.objectList === next.status.objectList && previous.status.folders === next.status.folders && previous.status.layers === next.status.layers && previous.status.assets === next.status.assets && previous.status.trees === next.status.trees && previous.status.selected?.id === next.status.selected?.id && previous.status.selectedFolder?.folder.id === next.status.selectedFolder?.folder.id);
