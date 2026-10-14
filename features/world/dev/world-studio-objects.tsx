import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, Eye, EyeOff, Folder, Lightbulb, Lock, LockOpen, Pentagon, RotateCcw, Search, Square } from "lucide-react";
import { worldLightingEditorStore, type WorldLightingEditorSnapshot, type WorldLightingElementSelection } from "./world-lighting-editor-store";
import { requestWorldLightingEditorFocus, requestWorldStudioCreate } from "./world-lighting-editor-map";
import { WORLD_STUDIO_UI_EVENT } from "./world-studio-keyboard";
import { buildWorldStudioOutliner, filterWorldStudioOutliner, studioDefaultFolders, studioFolderAncestors, studioFolderOptions, studioSelectionRange, studioVisibleObjects, type StudioNode, type StudioObject, type StudioObjectFilter } from "./world-studio-outliner";
import styles from "./world-lighting-studio.module.css";

function folderIds(nodes: readonly StudioNode[]): string[] { return nodes.flatMap(node => node.type === "folder" ? [node.id, ...folderIds(node.children)] : []); }
function countObjects(nodes: readonly StudioNode[]): number { return nodes.reduce((sum, node) => sum + (node.type === "folder" ? countObjects(node.children) : 1), 0); }
const studioDragType = "application/x-zhiv-studio-object";
type SelectionModifiers = { ctrlKey?: boolean; metaKey?: boolean; shiftKey?: boolean };
type StudioTreeProps = {
  nodes: readonly StudioNode[]; expanded: ReadonlySet<string>; searching: boolean; snapshot: WorldLightingEditorSnapshot;
  toggle: (id: string) => void; select: (node: StudioObject, modifiers?: SelectionModifiers) => void; focus: (node: StudioObject) => void;
  dragged: StudioObject | null; dropTarget: string | null; setDragged: (node: StudioObject | null) => void;
  setDropTarget: (id: string | null) => void; move: (node: StudioObject, folderId: string) => void;
};
function StudioTree(props: StudioTreeProps) {
  const { nodes, expanded, searching, snapshot, toggle, select, focus, dragged, dropTarget, setDragged, setDropTarget, move } = props;
  const editing = snapshot.enabled && snapshot.previewDraft;
  return <ul className={styles.objectList}>{nodes.map(node => {
    if (node.type === "folder") {
      const open = searching || expanded.has(node.id), acceptsDrop = editing && node.id !== "removed" && dragged !== null;
      return <li key={node.id} data-studio-folder={node.id}><button className={styles.folderButton} type="button" aria-expanded={open} data-drop-target={dropTarget === node.id || undefined} onClick={() => toggle(node.id)}
        onDragOver={event => { if (!acceptsDrop) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setDropTarget(node.id); }}
        onDragLeave={event => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) setDropTarget(null); }}
        onDrop={event => {
          if (!acceptsDrop || !dragged) return;
          event.preventDefault(); event.stopPropagation();
          if (event.dataTransfer.getData(studioDragType) === `${dragged.kind}:${dragged.id}`) move(dragged, node.id);
          setDragged(null); setDropTarget(null);
        }}>
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}<Folder size={14} aria-hidden /><span>{node.label}</span><small>{countObjects(node.children)}</small>
      </button>{open && <StudioTree {...props} nodes={node.children} />}</li>;
    }
    const Icon = node.kind === "light" ? Lightbulb : node.kind === "receiver" ? Square : Pentagon;
    const key = `${node.kind}:${node.id}`, flags = snapshot.editorFlags[key] ?? {}, chosen = snapshot.selectedElements.some(item => item.kind === node.kind && item.id === node.id);
    const canDrag = editing && !node.removed && !flags.locked && !(chosen && snapshot.selectedElements.some(item => snapshot.editorFlags[`${item.kind}:${item.id}`]?.locked));
    return <li key={key} data-studio-object={key}><div className={styles.objectRow} draggable={canDrag} data-hidden={flags.hidden || undefined} data-locked={flags.locked || undefined} data-dragging={dragged?.kind === node.kind && dragged.id === node.id || undefined}
      onDragStart={event => {
        if (!canDrag) { event.preventDefault(); return; }
        if (!chosen) worldLightingEditorStore.selectElement(node.kind, node.id);
        event.dataTransfer.setData(studioDragType, key); event.dataTransfer.effectAllowed = "move"; setDragged(node);
      }} onDragEnd={() => { setDragged(null); setDropTarget(null); }}>
      {!node.removed && <input className={styles.selectionBox} type="checkbox" aria-label={`Выбрать ${node.label}`} checked={chosen} onChange={() => select(node, { ctrlKey: true })} />}
      <button type="button" data-kind={node.kind} aria-pressed={chosen} disabled={node.removed && node.kind !== "light"} title={`${node.label} · ${node.detail}${flags.locked ? " · заблокирован" : ""}. Двойной щелчок находит на карте.`} onClick={event => select(node, event)} onDoubleClick={() => focus(node)}>
        <Icon size={15} aria-hidden /><span>{node.label}<small>{node.detail}{node.dirty ? " · изменён" : ""}{flags.locked ? " · заблокирован" : ""}</small></span>
      </button>{node.removed ? <><button className={styles.rowControl} type="button" disabled={!snapshot.previewDraft || flags.locked} aria-label={`Восстановить ${node.label}`} title="Восстановить" onClick={() => worldLightingEditorStore.restoreElement(node.kind, node.id)}><RotateCcw size={14} aria-hidden /></button>{flags.locked && <button className={styles.rowControl} type="button" aria-label={`Разблокировать ${node.label}`} title="Разблокировать удалённую разметку" onClick={() => worldLightingEditorStore.setElementFlags(node.kind, node.id, { locked: false })}><Lock size={14} aria-hidden /></button>}</> : <>
        <button className={styles.rowControl} type="button" aria-label={`${flags.hidden ? "Показать" : "Скрыть"} разметку ${node.label}`} title={flags.hidden ? "Показать разметку" : "Скрыть разметку"} aria-pressed={Boolean(flags.hidden)} onClick={() => worldLightingEditorStore.setElementFlags(node.kind, node.id, { hidden: !flags.hidden })}>{flags.hidden ? <EyeOff size={14} aria-hidden /> : <Eye size={14} aria-hidden />}</button>
        <button className={styles.rowControl} type="button" aria-label={`${flags.locked ? "Разблокировать" : "Заблокировать"} ${node.label}`} title={flags.locked ? "Разблокировать" : "Заблокировать"} aria-pressed={Boolean(flags.locked)} onClick={() => worldLightingEditorStore.setElementFlags(node.kind, node.id, { locked: !flags.locked })}>{flags.locked ? <Lock size={14} aria-hidden /> : <LockOpen size={14} aria-hidden />}</button>
      </>}
    </div></li>;
  })}</ul>;
}

function StudioBatchActions({ snapshot, roots }: { snapshot: WorldLightingEditorSnapshot; roots: readonly StudioNode[] }) {
  const selected = snapshot.selectedElements, count = selected.length;
  if (count < 2) return null;
  const locked = selected.filter(item => snapshot.editorFlags[`${item.kind}:${item.id}`]?.locked).length;
  const hidden = selected.every(item => snapshot.editorFlags[`${item.kind}:${item.id}`]?.hidden);
  return <section className={styles.batchActions} aria-label="Действия с выбранными элементами">
    <div><strong>Выбрано {count}</strong><button type="button" onClick={() => worldLightingEditorStore.clearSelection()}>Снять выбор</button></div>
    <details className={styles.batchDetails}><summary>Действия с группой</summary><div>
    <label className={styles.field}><span>Перенести выбранные в папку</span><select value="" disabled={!snapshot.previewDraft || locked > 0} onChange={event => {
      if (!event.target.value) return;
      worldLightingEditorStore.setElementsMetadata(selected, { studioFolder: event.target.value === "__automatic" ? null : event.target.value });
    }}><option value="">Выберите папку · {count} элементов</option><option value="__automatic">Автоматические папки</option>{studioFolderOptions(roots).map(option => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
    <div className={styles.batchButtons}>
      <button type="button" onClick={() => worldLightingEditorStore.setElementsFlags(selected, { hidden: !hidden })}>{hidden ? "Показать" : "Скрыть"} разметку</button>
      <button type="button" onClick={() => worldLightingEditorStore.setElementsFlags(selected, { locked: locked === 0 })}>{locked ? "Разблокировать" : "Заблокировать"}</button>
      <button type="button" disabled={!snapshot.previewDraft || locked > 0} onClick={() => worldLightingEditorStore.duplicateElements(selected)}>Дублировать {count}</button>
      <button type="button" disabled={!snapshot.previewDraft || locked > 0} onClick={() => worldLightingEditorStore.removeElements(selected)}>Удалить разметку · {count}</button>
    </div>
    <p>{locked ? `${locked} заблокировано. Сначала разблокируйте группу для правок. ` : ""}Перенос папки сохраняет положение и условия уровней зданий. Групповая правка отменяется за один шаг.</p>
    </div></details>
  </section>;
}

export function WorldStudioObjects({ levels, onSelect }: { levels: Readonly<Record<string, number>>; onSelect: () => void }) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe, worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const { casters, receivers, lights, dirtyIds, dirtyLightIds, dirtyReceiverIds, deletedCasters, deletedReceivers } = snapshot;
  const roots = useMemo(() => buildWorldStudioOutliner({ casters, receivers, lights, dirtyIds, dirtyLightIds, dirtyReceiverIds, deletedCasters, deletedReceivers }, levels), [casters, receivers, lights, dirtyIds, dirtyLightIds, dirtyReceiverIds, deletedCasters, deletedReceivers, levels]);
  const [query, setQuery] = useState(""), [filter, setFilter] = useState<StudioObjectFilter>("all");
  const [expanded, setExpanded] = useState(() => new Set(studioDefaultFolders(roots)));
  const [dragged, setDragged] = useState<StudioObject | null>(null), [dropTarget, setDropTarget] = useState<string | null>(null);
  const list = useRef<HTMLDivElement>(null), addMenu = useRef<HTMLDetailsElement>(null), rangeAnchor = useRef<WorldLightingElementSelection | null>(null);
  const filtered = useMemo(() => filterWorldStudioOutliner(roots, query, filter), [roots, query, filter]);
  const visible = useMemo(() => studioVisibleObjects(filtered, expanded, Boolean(query.trim())), [filtered, expanded, query]);
  useEffect(() => {
    const selectionMetadata = (state: WorldLightingEditorSnapshot) => {
      const element = (state.selectedKind === "light" ? state.lights : state.selectedKind === "receiver" ? state.receivers : state.casters).find(item => item.id === state.selectedId);
      return { key: `${state.selectedKind}:${state.selectedId}`, metadata: `${element?.studioName ?? ""}\n${element?.studioFolder ?? ""}` };
    };
    let previous = selectionMetadata(worldLightingEditorStore.getSnapshot());
    return worldLightingEditorStore.subscribe(() => {
      const state = worldLightingEditorStore.getSnapshot(), current = selectionMetadata(state);
      if (state.selectedId && previous.key === current.key && previous.metadata !== current.metadata) {
        const updated = buildWorldStudioOutliner(state, levels);
        setQuery(""); setFilter("all");
        setExpanded(old => new Set([...old, ...state.selectedElements.flatMap(item => studioFolderAncestors(updated, item.kind, item.id))]));
      }
      previous = current;
    });
  }, [levels]);
  useEffect(() => {
    const command = (event: Event) => {
      if ((event as CustomEvent).detail?.action === "select-all") worldLightingEditorStore.selectElements(visible);
    };
    window.addEventListener(WORLD_STUDIO_UI_EVENT, command);
    return () => window.removeEventListener(WORLD_STUDIO_UI_EVENT, command);
  }, [visible]);
  const revealSelection = () => {
    if (!snapshot.selectedId) return;
    setQuery(""); setFilter("all");
    setExpanded(previous => new Set([...previous, ...snapshot.selectedElements.flatMap(item => studioFolderAncestors(roots, item.kind, item.id))]));
    requestAnimationFrame(() => {
      const row = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-studio-object]") ?? []).find(item => item.dataset.studioObject === `${snapshot.selectedKind}:${snapshot.selectedId}`);
      row?.scrollIntoView({ block: "nearest" });
    });
  };
  const select = (node: StudioObject, modifiers: SelectionModifiers = {}) => {
    if (node.removed) { if (node.kind === "light") worldLightingEditorStore.selectLight(node.id); return; }
    if (modifiers.shiftKey) {
      const range = studioSelectionRange(visible, rangeAnchor.current, node);
      worldLightingEditorStore.selectElements(modifiers.ctrlKey || modifiers.metaKey ? [...snapshot.selectedElements, ...range] : range, node);
    } else {
      worldLightingEditorStore.selectElement(node.kind, node.id, { additive: modifiers.ctrlKey || modifiers.metaKey, toggle: modifiers.ctrlKey || modifiers.metaKey });
      rangeAnchor.current = { kind: node.kind, id: node.id };
    }
    if (!(modifiers.ctrlKey || modifiers.metaKey || modifiers.shiftKey)) onSelect();
  };
  const focus = (node: StudioObject) => {
    if (node.removed) return;
    worldLightingEditorStore.selectElement(node.kind, node.id); requestWorldLightingEditorFocus(); onSelect();
  };
  const move = (node: StudioObject, folderId: string) => {
    if (!snapshot.previewDraft || node.removed || folderId === "removed") return;
    const current = worldLightingEditorStore.getSnapshot(), chosen = current.selectedElements.some(item => item.kind === node.kind && item.id === node.id);
    const moved = chosen ? current.selectedElements : [node];
    if (!worldLightingEditorStore.setElementsMetadata(moved, { studioFolder: folderId })) return;
    const movedRoots = buildWorldStudioOutliner(worldLightingEditorStore.getSnapshot(), levels);
    setQuery(""); setFilter("all");
    setExpanded(previous => new Set([...previous, ...moved.flatMap(item => studioFolderAncestors(movedRoots, item.kind, item.id))]));
    onSelect();
  };
  return <div className={styles.outlinerContent}>
    <div className={styles.outlinerControls}>
      <label className={styles.search}><Search size={15} aria-hidden /><input type="search" aria-label="Найти объект или источник" placeholder="Поиск по имени, папке или ID" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className={styles.filters}>{([["all", "Все"], ["casters", "Объёмы"], ["lights", "Свет"], ["receivers", "Земля"], ["changed", "Правки"]] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
      <div className={styles.folderActions}><button type="button" disabled={!snapshot.selectedId} onClick={revealSelection}>Показать выбранное</button><button type="button" onClick={() => setExpanded(new Set(folderIds(roots)))}>Раскрыть всё</button><button type="button" onClick={() => setExpanded(new Set())}>Свернуть всё</button><button type="button" disabled={!visible.length} onClick={() => worldLightingEditorStore.selectElements(visible)}>Выделить видимые</button></div>
      <details className={styles.selectionHelp}><summary>Выбор и перенос</summary><p>Ctrl/Cmd добавляет элемент, Shift выбирает диапазон. На телефоне используйте флажки. Ctrl/Cmd+A выбирает видимые строки. Двойной щелчок находит элемент на карте. Перетащите выбранное на папку.</p><p>Глаз скрывает только разметку, замок защищает от правок. Свет и рисунки на карте сохраняются. Эти настройки запоминаются в браузере.</p></details>
    </div>
    <StudioBatchActions snapshot={snapshot} roots={roots} />
    <div ref={list} className={styles.outlinerScroll} data-studio-outliner-scroll><StudioTree nodes={filtered} expanded={expanded} searching={Boolean(query.trim())} snapshot={snapshot} toggle={id => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })} select={select} focus={focus} dragged={dragged} dropTarget={dropTarget} setDragged={setDragged} setDropTarget={setDropTarget} move={move} />{!filtered.length && <p className={styles.notice}>Ничего не найдено.</p>}</div>
    <details ref={addMenu} className={styles.presets}><summary>Добавить элемент</summary><div>
      <button type="button" disabled={!snapshot.previewDraft} onClick={() => { requestWorldStudioCreate("caster"); if (addMenu.current) addMenu.current.open = false; }}>Объём тени</button>
      <button type="button" disabled={!snapshot.previewDraft} onClick={() => { requestWorldStudioCreate("receiver"); if (addMenu.current) addMenu.current.open = false; }}>Поверхность земли</button>
      {([["lantern", "Фонарь"], ["torch", "Факел"], ["glow", "Свечение"]] as const).map(([kind, label]) => <button type="button" key={kind} disabled={!snapshot.previewDraft} aria-pressed={snapshot.tool === "light" && snapshot.lightKind === kind} onClick={() => { worldLightingEditorStore.setLightKind(kind); worldLightingEditorStore.setTool("light"); if (addMenu.current) addMenu.current.open = false; }}>{label}</button>)}
      <p>Объём и земля появляются в центре свободной части карты. Для света выберите тип и нажмите на карту.</p>
    </div></details>
  </div>;
}
