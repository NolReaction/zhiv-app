"use client";

import { useRef } from "react";
import { Eye, EyeOff, Focus, FolderPlus, LockKeyhole, Trash2, UnlockKeyhole } from "lucide-react";
import type { ForestStatus } from "@/apps/engine/src/editor/input/controller";
import { folderContains, isFolderLocked } from "@/apps/engine/examples/forest/scene/folders";
import { EditorButton } from "./editor-button";
import styles from "./procedural-forest-preview.module.css";

type Controller = ReturnType<typeof import("@/apps/engine/src/editor/input/controller")["createForestController"]>;

export function WorkspaceFolderInspector({ status, controller }: { status: ForestStatus; controller: Controller | null }) {
  const deltaX = useRef<HTMLInputElement>(null), deltaY = useRef<HTMLInputElement>(null);
  const selected = status.selectedFolder; if (!selected) return null;
  const folder = selected.folder;
  return <div className={styles.inspectorContent}>
    <div className={styles.selectionHeading}><strong>Папка · {selected.count} предметов</strong><span>ВЫБРАНА</span></div>
    <label className={styles.field}><span>Название</span><input key={folder.id + folder.name} aria-label="Название папки" defaultValue={folder.name} maxLength={100} onBlur={event => { const next = event.currentTarget.value.trim(); if (next && next !== folder.name) controller?.renameFolder(folder.id, next); else event.currentTarget.value = folder.name; }} onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }} /></label>
    <div className={styles.objectControls}><EditorButton type="button" aria-label="Показать выбранную папку" title="Найти предметы папки (F)" onClick={() => controller?.focusSelected()}><Focus size={16} /> Найти</EditorButton><EditorButton type="button" aria-label={folder.visible ? "Скрыть выбранную папку" : "Показать выбранную папку"} title={folder.visible ? "Скрыть папку" : "Показать папку"} onClick={() => controller?.setFolderVisibility(folder.id, !folder.visible)}>{selected.hidden ? <EyeOff size={16} /> : <Eye size={16} />}</EditorButton><EditorButton type="button" aria-label={folder.locked ? "Разблокировать выбранную папку" : "Заблокировать выбранную папку"} title={folder.locked ? "Разблокировать папку" : selected.locked ? "Родительская папка заблокирована" : "Заблокировать папку"} onClick={() => controller?.setFolderLocked(folder.id, !folder.locked)}>{selected.locked ? <LockKeyhole size={16} /> : <UnlockKeyhole size={16} />}</EditorButton></div>
    {selected.hidden && <p className={styles.notice}>Папка скрыта{folder.visible ? " родительской папкой" : ""}. Её предметы остаются в сцене.</p>}
    {selected.locked && <p className={styles.notice}>Папка заблокирована. Разблокируй её и родительские папки для перемещения.</p>}
    <label className={styles.field}><span>Родительская папка</span><select aria-label="Родительская папка" disabled={selected.locked} value={folder.parentId ?? ""} onChange={event => controller?.reparentFolder(folder.id, event.target.value || null)}><option value="">Корень сцены</option>{status.folders.map(parent => <option key={parent.id} value={parent.id} disabled={folderContains(folder.id, parent.id, status.folders) || isFolderLocked(parent.id, status.folders)}>{parent.name}</option>)}</select></label>
    <EditorButton type="button" className={styles.folderAction} disabled={selected.locked} aria-label="Добавить вложенную папку" onClick={() => { const id = controller?.addFolder(folder.id); if (id) controller?.selectFolder(id); }}><FolderPlus size={16} /> Вложенная папка</EditorButton>
    <p className={styles.small}>Папки объединяют предметы, не меняя их слой или перекрытие. Выбери папку и перетащи любой её предмет — вся группа сдвинется вместе.</p>
    <form className={styles.folderMove} onSubmit={event => { event.preventDefault(); const x = Number(deltaX.current?.value ?? 0), y = Number(deltaY.current?.value ?? 0); if (Number.isFinite(x) && Number.isFinite(y)) controller?.translateSelectedFolder(x, y); }}>
      <fieldset className={styles.editableFields} disabled={selected.locked}><div className={styles.fields}><label className={styles.field}><span>Сдвиг X</span><input ref={deltaX} aria-label="Сдвиг папки X" type="number" step="any" min={-status.width} max={status.width} defaultValue={0} /></label><label className={styles.field}><span>Сдвиг Y</span><input ref={deltaY} aria-label="Сдвиг папки Y" type="number" step="any" min={-1600} max={1600} defaultValue={0} /></label></div><EditorButton type="submit" className={styles.folderAction}>Сдвинуть папку</EditorButton></fieldset>
    </form>
    <p className={styles.small}>Перенос целиком отменяется одним действием. Если хотя бы один предмет или его слой заблокирован, перемещение не начнётся.</p>
    <div className={styles.folderDelete}><EditorButton type="button" disabled={selected.locked} aria-label="Удалить выбранную папку" onClick={() => controller?.deleteFolder(folder.id)}><Trash2 size={15} /> Удалить папку</EditorButton><p className={styles.small}>Предметы и вложенные папки сохранятся у её родителя.</p><EditorButton type="button" disabled={selected.locked || !selected.count} aria-label="Удалить предметы выбранной папки" onClick={() => controller?.deleteFolderObjects(folder.id)}><Trash2 size={15} /> Удалить все предметы</EditorButton></div>
  </div>;
}
