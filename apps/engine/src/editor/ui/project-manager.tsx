"use client";

import { useEffect, useRef, useState } from "react";
import { Copy, Download, FolderOpen, Plus, RefreshCw, Search, Trash2, Upload, X } from "lucide-react";
import { EDITOR_PRESETS, getEditorPreset } from "@/apps/engine/src/editor/scene/editor-presets";
import { MAX_SCENE_DIMENSION } from "@/packages/engine/src/scene/contracts";
import type { ProjectSummary } from "@/apps/engine/src/editor/projects/project-repository";
import type { EngineProjects } from "./use-engine-projects";
import { EditorButton } from "./editor-button";
import styles from "./procedural-forest-preview.module.css";

export function ProjectManager({ workspace, externalBusy, externalError, close, exportProject, importProject, renameActive }: {
  workspace: EngineProjects; externalBusy: boolean; close: () => void; exportProject: () => void; importProject: () => void;
  externalError?: string | null;
  renameActive: (name: string) => boolean;
}) {
  const dialog = useRef<HTMLDivElement>(null), nameInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState(""), [presetId, setPresetId] = useState("forest-v5"), [name, setName] = useState("Новый проект");
  const first = getEditorPreset(presetId)!;
  const [width, setWidth] = useState(String(first.defaultSize.width)), [height, setHeight] = useState(String(first.defaultSize.height));
  const [renameId, setRenameId] = useState<string | null>(null), [newName, setNewName] = useState(""), [removal, setRemoval] = useState<ProjectSummary | null>(null);
  const [confirmReopen, setConfirmReopen] = useState(false);
  const disabled = Boolean(workspace.busy || externalBusy || workspace.loading || workspace.state.busy);
  const document = workspace.state.document, error = externalError ?? workspace.error ?? workspace.state.error?.message, refresh = workspace.refresh;
  const current = document && !workspace.projects.some(project => project.id === document.id) ? [{ id: document.id, name: document.name, presetId: document.presetId, presetVersion: document.presetVersion, width: document.width, height: document.height, assetCount: document.assets.length, updatedAt: 0, revision: 0 }] : [];
  const rows = [...current, ...workspace.projects].filter(project => (project.id === document?.id ? document.name : project.name).toLocaleLowerCase("ru").includes(query.trim().toLocaleLowerCase("ru")));
  useEffect(() => {
    const previous = window.document.activeElement as HTMLElement | null;
    nameInput.current?.focus(); void refresh();
    return () => { if (previous?.isConnected) previous.focus({ preventScroll: true }); };
  }, [refresh]);
  useEffect(() => {
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const node = dialog.current, targets = Array.from(node?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href]') ?? []);
      const first = targets[0], last = targets[targets.length - 1], active = window.document.activeElement;
      if (!node?.contains(active) || event.shiftKey && active === first || !event.shiftKey && active === last) {
        event.preventDefault(); event.stopImmediatePropagation(); (event.shiftKey ? last : first)?.focus();
      }
    };
    window.addEventListener("keydown", trap, true);
    return () => window.removeEventListener("keydown", trap, true);
  }, []);
  return <div className={styles.projectOverlay} data-workspace-popover onPointerDown={event => { if (event.target === event.currentTarget && !disabled) close(); }}>
    <div ref={dialog} className={styles.projectDialog} role="dialog" aria-modal="true" aria-labelledby="engine-projects-title" data-project-dialog aria-busy={disabled}>
      <div className={styles.projectHeading}><div><h2 id="engine-projects-title">Проекты</h2><p>Каждая сцена сохраняется отдельно в этом браузере.</p></div><EditorButton type="button" aria-label="Закрыть проекты" disabled={disabled} onClick={close}><X size={20} /></EditorButton></div>
      {workspace.notice && <p className={styles.projectNotice} role="status">{workspace.notice}</p>}
      {error && <div className={styles.projectError} role="alert"><p>{error}</p><p>Текущая сцена остаётся открытой. Если сохранение недоступно, скачай JSON с исходными PNG. При конфликте сначала сохрани резервную копию, затем открой сохранённую версию или обнови редактор.</p><div className={styles.projectActionRow}><EditorButton type="button" disabled={disabled || !document} onClick={exportProject}><Download size={15} />Скачать текущий JSON</EditorButton><EditorButton type="button" disabled={disabled || !document} onClick={() => { void workspace.save(); }}><RefreshCw size={15} />Повторить сохранение</EditorButton>{document && workspace.projects.some(project => project.id === document.id) && <EditorButton type="button" disabled={disabled} onClick={() => setConfirmReopen(true)}>Открыть сохранённую версию</EditorButton>}</div></div>}
      <div className={styles.projectBody}>
        <section className={styles.projectCreate} aria-label="Создать проект"><h3>Новый проект</h3><form onSubmit={event => {
          event.preventDefault();
          void workspace.create({ name, presetId, width: Number(width), height: Number(height) }).then(created => { if (created) close(); });
        }}>
          <label className={styles.field}><span>Название проекта</span><input ref={nameInput} required maxLength={100} value={name} disabled={disabled} onChange={event => setName(event.target.value)} /></label>
          <label className={styles.field}><span>Тип сцены</span><select value={presetId} disabled={disabled} onChange={event => {
            const preset = getEditorPreset(event.target.value)!; setPresetId(preset.id); setWidth(String(preset.defaultSize.width)); setHeight(String(preset.defaultSize.height));
          }}>{EDITOR_PRESETS.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></label>
          <p className={styles.small}>{getEditorPreset(presetId)?.description}</p>
          <div className={styles.fields}><label className={styles.field}><span>Ширина сцены</span><input type="number" min={1} max={MAX_SCENE_DIMENSION} step={1} required value={width} disabled={disabled} onChange={event => setWidth(event.target.value)} /></label><label className={styles.field}><span>Высота сцены</span><input type="number" min={1} max={MAX_SCENE_DIMENSION} step={1} required value={height} disabled={disabled} onChange={event => setHeight(event.target.value)} /></label></div>
          <p className={styles.small}>От 1 до {MAX_SCENE_DIMENSION} по стороне, до 64 млн пикселей. Исходные предметы проекта фиксируются при создании.</p>
          <EditorButton type="submit" disabled={disabled}><Plus size={16} />Создать проект</EditorButton>
        </form><div className={styles.projectActionRow}><EditorButton type="button" disabled={disabled} onClick={importProject}><Upload size={15} />Импортировать JSON как новый</EditorButton><EditorButton type="button" disabled={disabled || !document} onClick={exportProject}><Download size={15} />Скачать текущий JSON</EditorButton></div></section>
        <section className={styles.projectListSection} aria-label="Список проектов"><div className={styles.projectListHeading}><h3>Сохранённые проекты</h3><EditorButton type="button" aria-label="Обновить список проектов" disabled={disabled} onClick={() => { void workspace.refresh(); }}><RefreshCw size={16} /></EditorButton></div>
          <label className={styles.searchField}><Search size={15} /><input type="search" aria-label="Найти проект" placeholder="Название проекта…" value={query} onChange={event => setQuery(event.target.value)} /></label>
          {!rows.length && <p className={styles.small}>{workspace.loading ? "Читаем проекты…" : "Проектов пока нет или поиск ничего не нашёл."}</p>}
          <ul className={styles.projectList}>{rows.map(project => {
            const active = project.id === document?.id, shownName = active ? document!.name : project.name;
            return <li key={project.id} data-project-id={project.id} data-active={active}>
              <div className={styles.projectRowHeading}><strong>{shownName}</strong>{active && <small>Открыт · {workspace.state.saveState === "saved" ? "сохранён" : "есть несохранённые правки"}</small>}</div>
              <p>{project.width} × {project.height} · {getEditorPreset(project.presetId, project.presetVersion)?.name ?? project.presetId} · PNG: {project.assetCount}</p>
              {renameId === project.id ? <form className={styles.projectRename} onSubmit={event => { event.preventDefault(); void workspace.rename(project.id, newName, renameActive).then(done => { if (done) setRenameId(null); }); }}><input aria-label="Новое название проекта" autoFocus required maxLength={100} value={newName} disabled={disabled} onChange={event => setNewName(event.target.value)} /><EditorButton type="submit" disabled={disabled}>Применить</EditorButton><EditorButton type="button" disabled={disabled} onClick={() => setRenameId(null)}>Отмена</EditorButton></form> : <div className={styles.projectActionRow}>
                <EditorButton type="button" disabled={disabled || active} onClick={() => { void workspace.open(project.id).then(opened => { if (opened) close(); }); }}><FolderOpen size={14} />Открыть</EditorButton>
                <EditorButton type="button" disabled={disabled} onClick={() => { setRenameId(project.id); setNewName(shownName); }}>Название</EditorButton>
                <EditorButton type="button" disabled={disabled} onClick={() => { void workspace.duplicate(project.id).then(copy => { if (copy) close(); }); }}><Copy size={14} />Копия</EditorButton>
                <EditorButton type="button" disabled={disabled} aria-label={`Удалить проект ${shownName}`} onClick={() => setRemoval({ ...project, name: shownName })}><Trash2 size={14} /></EditorButton>
              </div>}
            </li>;
          })}</ul>
        </section>
      </div>
      {removal && <div className={styles.projectConfirm} role="alert"><p>Удалить проект «{removal.name}» из этого браузера? Его сцену и неиспользуемые PNG нельзя будет вернуть через Undo. Скачай JSON, если нужна копия.</p><div className={styles.projectActionRow}><EditorButton type="button" disabled={disabled} onClick={() => { void workspace.remove(removal.id, removal.revision).then(done => { if (done) setRemoval(null); }); }}>Удалить проект</EditorButton><EditorButton type="button" disabled={disabled} onClick={() => setRemoval(null)}>Оставить проект</EditorButton></div></div>}
      {confirmReopen && <div className={styles.projectConfirm} role="alert"><p>Открыть сохранённую версию? Несохранённые правки текущей сцены и её история будут заменены. Сначала скачай JSON с нужными правками.</p><div className={styles.projectActionRow}><EditorButton type="button" disabled={disabled} onClick={exportProject}>Скачать резервную копию JSON</EditorButton><EditorButton type="button" disabled={disabled} onClick={() => { void workspace.reopenSaved().then(opened => { if (opened) { setConfirmReopen(false); close(); } }); }}>Заменить текущую сцену</EditorButton><EditorButton type="button" disabled={disabled} onClick={() => setConfirmReopen(false)}>Оставить правки</EditorButton></div></div>}
      <p className={styles.projectFooter} role="status">{workspace.busy ?? (workspace.state.saveState === "saving" ? "Сохраняем последние правки…" : "При открытии другого проекта текущие правки сначала сохраняются.")}</p>
    </div>
  </div>;
}
