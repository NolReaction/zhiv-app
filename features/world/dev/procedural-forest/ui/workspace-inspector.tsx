"use client";

import { memo } from "react";
import { ArrowDown, ArrowDownToLine, ArrowUp, ArrowUpToLine, Eye, EyeOff, Focus, LockKeyhole, UnlockKeyhole } from "lucide-react";
import type { ForestStatus } from "@/features/world/dev/procedural-forest/input/controller";
import { EditorButton } from "./editor-button";
import { EditorInspector, objectNames } from "./editor-inspector";
import { isFolderLocked } from "@/features/world/dev/procedural-forest/scene/folders";
import { WorkspaceFolderInspector } from "./workspace-folder-inspector";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof import("@/features/world/dev/procedural-forest/input/controller")["createForestController"]>;

export const WorkspaceInspector = memo(function WorkspaceInspector({ status, controller }: { status: ForestStatus; controller: Controller | null }) {
  if (status.selectedFolder) return <WorkspaceFolderInspector key={status.selectedFolder.folder.id} status={status} controller={controller} />;
  const object = status.selected;
  if (!object) return <div className={styles.emptySelection}><span className={styles.emptyIcon}><Focus size={28} strokeWidth={1.25} /></span><strong>Выбери предмет</strong><p>Нажми на карте или найди его во вкладке «Слои». Тяни за углы рамки, чтобы менять размер.</p></div>;
  const imageName = status.assets.find(asset => asset.id === object.assetId)?.name;
  const fallbackName = imageName ?? objectNames[object.kind];
  const name = object.name ?? fallbackName;
  const orders = [{ id: "front", label: "На передний план", icon: ArrowUpToLine }, { id: "forward", label: "На шаг вперёд", icon: ArrowUp }, { id: "backward", label: "На шаг назад", icon: ArrowDown }, { id: "back", label: "На задний план", icon: ArrowDownToLine }] as const;
  return <div className={styles.inspectorContent}>
    <label className={styles.field}><span>Название</span><input key={object.id + name} aria-label="Название предмета" defaultValue={name} maxLength={100} onBlur={event => { const next = event.currentTarget.value.trim(); if (next !== name) controller?.renameSelected(next); event.currentTarget.value = next || fallbackName; }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
    <div className={styles.objectControls}>
      <EditorButton type="button" title="Показать выбранный предмет (F)" aria-label="Показать выбранный предмет" onClick={() => controller?.focusSelected()}><Focus size={16} /> Найти</EditorButton>
      <EditorButton type="button" title={object.hidden ? "Показать предмет" : "Скрыть предмет"} aria-label={object.hidden ? "Показать предмет" : "Скрыть предмет"} aria-pressed={!!object.hidden} onClick={() => controller?.setObjectHidden(object.id, !object.hidden)}>{object.hidden ? <EyeOff size={16} /> : <Eye size={16} />}</EditorButton>
      <EditorButton type="button" title={object.locked ? "Разблокировать предмет" : "Заблокировать предмет"} aria-label={object.locked ? "Разблокировать предмет" : "Заблокировать предмет"} aria-pressed={!!object.locked} onClick={() => controller?.setObjectLocked(object.id, !object.locked)}>{object.locked ? <LockKeyhole size={16} /> : <UnlockKeyhole size={16} />}</EditorButton>
    </div>
    {status.selectedHidden && <p className={styles.notice}>Предмет скрыт{!object.hidden ? " папкой, слоем или растительностью" : ""}. Его можно выбрать и показать через список.</p>}
    {status.selectedLocked && <p className={styles.notice}>Предмет заблокирован{!object.locked ? " вместе с папкой или слоем" : ""}. Сними замок, чтобы менять его.</p>}
    <fieldset className={styles.editableFields} disabled={status.selectedLocked}>
      <label className={styles.field}><span>Слой</span><select aria-label="Слой предмета" value={object.layerId ?? "world"} onChange={event => controller?.setSelectedLayer(event.target.value)}>{[...status.layers].reverse().map(layer => <option key={layer.id} value={layer.id} disabled={layer.locked && layer.id !== (object.layerId ?? "world")}>{layer.name}</option>)}</select></label>
      <label className={styles.folderMembership}><span>Папка</span><select aria-label="Папка предмета" value={object.folderId === undefined ? "auto" : object.folderId === null ? "root" : "id:" + object.folderId} onChange={event => { const value = event.target.value; if (value === "auto") controller?.moveObjectToFolder(object.id, undefined); else controller?.moveObjectToFolder(object.id, value === "root" ? null : value.slice(3)); }}><option value="auto">По виду предмета</option><option value="root">Корень сцены</option>{status.folders.map(folder => <option key={folder.id} value={"id:" + folder.id} disabled={isFolderLocked(folder.id, status.folders)}>{folder.name}</option>)}</select></label>
      <div className={styles.orderControls} role="group" aria-label="Порядок предмета">{orders.map(({ id, label, icon: Icon }) => <EditorButton key={id} type="button" title={label} aria-label={label} onClick={() => controller?.setSelectedOrder(id)}><Icon size={16} /></EditorButton>)}<EditorButton type="button" title="Автоматический порядок по положению на карте" aria-label="Автоматический порядок" onClick={() => controller?.setSelectedOrder("auto")}>Авто</EditorButton></div>
      <EditorInspector object={object} width={status.width} imageName={imageName} update={patch => controller?.updateSelected(patch)} duplicate={() => controller?.duplicateSelected()} remove={() => controller?.deleteSelected()} />
    </fieldset>
    <p className={styles.objectId}>{object.id}</p>
  </div>;
}, (previous, next) => previous.controller === next.controller && previous.status.width === next.status.width && previous.status.layers === next.status.layers && previous.status.folders === next.status.folders && previous.status.assets === next.status.assets && previous.status.selectedHidden === next.status.selectedHidden && previous.status.selectedLocked === next.status.selectedLocked && JSON.stringify(previous.status.selected) === JSON.stringify(next.status.selected) && JSON.stringify(previous.status.selectedFolder) === JSON.stringify(next.status.selectedFolder));
