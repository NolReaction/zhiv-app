import { useMemo, useRef, useState, useSyncExternalStore } from "react";
import { ChevronDown, ChevronRight, Folder, Lightbulb, Pentagon, RotateCcw, Search, Square } from "lucide-react";
import { worldLightingEditorStore, type WorldLightingEditorSnapshot } from "./world-lighting-editor-store";
import { requestWorldStudioCreate } from "./world-lighting-editor-map";
import { buildWorldStudioOutliner, filterWorldStudioOutliner, studioDefaultFolders, studioFolderAncestors, type StudioNode, type StudioObject, type StudioObjectFilter } from "./world-studio-outliner";
import styles from "./world-lighting-studio.module.css";

function folderIds(nodes: readonly StudioNode[]): string[] { return nodes.flatMap(node => node.type === "folder" ? [node.id, ...folderIds(node.children)] : []); }
function countObjects(nodes: readonly StudioNode[]): number { return nodes.reduce((sum, node) => sum + (node.type === "folder" ? countObjects(node.children) : 1), 0); }
function StudioTree({ nodes, expanded, searching, snapshot, toggle, select }: { nodes: readonly StudioNode[]; expanded: ReadonlySet<string>; searching: boolean; snapshot: WorldLightingEditorSnapshot; toggle: (id: string) => void; select: (node: StudioObject) => void }) {
  return <ul className={styles.objectList}>{nodes.map(node => {
    if (node.type === "folder") {
      const open = searching || expanded.has(node.id);
      return <li key={node.id} data-studio-folder={node.id}><button className={styles.folderButton} type="button" aria-expanded={open} onClick={() => toggle(node.id)}>
        {open ? <ChevronDown size={13} aria-hidden /> : <ChevronRight size={13} aria-hidden />}<Folder size={14} aria-hidden /><span>{node.label}</span><small>{countObjects(node.children)}</small>
      </button>{open && <StudioTree nodes={node.children} expanded={expanded} searching={searching} snapshot={snapshot} toggle={toggle} select={select} />}</li>;
    }
    const Icon = node.kind === "light" ? Lightbulb : node.kind === "receiver" ? Square : Pentagon;
    return <li key={`${node.kind}:${node.id}`} data-studio-object={`${node.kind}:${node.id}`}><div className={styles.objectRow}>
      <button type="button" data-kind={node.kind} aria-pressed={snapshot.selectedKind === node.kind && snapshot.selectedId === node.id} disabled={node.removed && node.kind !== "light"} onClick={() => select(node)}>
        <Icon size={15} aria-hidden /><span>{node.label}<small>{node.detail}{node.dirty ? " · изменён" : ""}</small></span>
      </button>{node.removed && <button className={styles.restore} type="button" disabled={!snapshot.previewDraft} aria-label={`Восстановить ${node.label}`} title="Восстановить" onClick={() => worldLightingEditorStore.restoreElement(node.kind, node.id)}><RotateCcw size={14} aria-hidden /></button>}
    </div></li>;
  })}</ul>;
}

export function WorldStudioObjects({ levels, onSelect }: { levels: Readonly<Record<string, number>>; onSelect: () => void }) {
  const snapshot = useSyncExternalStore(worldLightingEditorStore.subscribe, worldLightingEditorStore.getSnapshot, worldLightingEditorStore.getServerSnapshot);
  const { casters, receivers, lights, dirtyIds, dirtyLightIds, dirtyReceiverIds, deletedCasters, deletedReceivers } = snapshot;
  const roots = useMemo(() => buildWorldStudioOutliner({ casters, receivers, lights, dirtyIds, dirtyLightIds, dirtyReceiverIds, deletedCasters, deletedReceivers }, levels), [casters, receivers, lights, dirtyIds, dirtyLightIds, dirtyReceiverIds, deletedCasters, deletedReceivers, levels]);
  const [query, setQuery] = useState(""), [filter, setFilter] = useState<StudioObjectFilter>("all");
  const [expanded, setExpanded] = useState(() => new Set(studioDefaultFolders(roots)));
  const list = useRef<HTMLDivElement>(null), addMenu = useRef<HTMLDetailsElement>(null);
  const filtered = useMemo(() => filterWorldStudioOutliner(roots, query, filter), [roots, query, filter]);
  const revealSelection = () => {
    if (!snapshot.selectedId) return;
    setQuery(""); setFilter("all");
    setExpanded(previous => new Set([...previous, ...studioFolderAncestors(roots, snapshot.selectedKind, snapshot.selectedId!)]));
    requestAnimationFrame(() => {
      const row = Array.from(list.current?.querySelectorAll<HTMLElement>("[data-studio-object]") ?? []).find(item => item.dataset.studioObject === `${snapshot.selectedKind}:${snapshot.selectedId}`);
      row?.scrollIntoView({ block: "nearest" });
    });
  };
  const select = (node: StudioObject) => {
    if (node.kind === "light") worldLightingEditorStore.selectLight(node.id);
    else if (node.kind === "receiver") worldLightingEditorStore.selectReceiver(node.id);
    else worldLightingEditorStore.select(node.id);
    onSelect();
  };
  return <div className={styles.outlinerContent}>
    <div className={styles.outlinerControls}>
      <label className={styles.search}><Search size={15} aria-hidden /><input type="search" aria-label="Найти объект или источник" placeholder="Поиск по имени, папке или ID" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className={styles.filters}>{([["all", "Все"], ["casters", "Объёмы"], ["lights", "Свет"], ["receivers", "Земля"], ["changed", "Правки"]] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>)}</div>
      <div className={styles.folderActions}><button type="button" disabled={!snapshot.selectedId} onClick={revealSelection}>Показать выбранное</button><button type="button" onClick={() => setExpanded(new Set(folderIds(roots)))}>Раскрыть всё</button><button type="button" onClick={() => setExpanded(new Set())}>Свернуть всё</button></div>
    </div>
    <div ref={list} className={styles.outlinerScroll} data-studio-outliner-scroll><StudioTree nodes={filtered} expanded={expanded} searching={Boolean(query.trim())} snapshot={snapshot} toggle={id => setExpanded(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next; })} select={select} />{!filtered.length && <p className={styles.notice}>Ничего не найдено.</p>}</div>
    <details ref={addMenu} className={styles.presets}><summary>Добавить элемент</summary><div>
      <button type="button" disabled={!snapshot.previewDraft} onClick={() => { requestWorldStudioCreate("caster"); if (addMenu.current) addMenu.current.open = false; }}>Объём тени</button>
      <button type="button" disabled={!snapshot.previewDraft} onClick={() => { requestWorldStudioCreate("receiver"); if (addMenu.current) addMenu.current.open = false; }}>Поверхность земли</button>
      {([["lantern", "Фонарь"], ["torch", "Факел"], ["glow", "Свечение"]] as const).map(([kind, label]) => <button type="button" key={kind} disabled={!snapshot.previewDraft} aria-pressed={snapshot.tool === "light" && snapshot.lightKind === kind} onClick={() => { worldLightingEditorStore.setLightKind(kind); worldLightingEditorStore.setTool("light"); if (addMenu.current) addMenu.current.open = false; }}>{label}</button>)}
      <p>Объём и земля появляются в центре свободной части карты. Для света выберите тип и нажмите на карту.</p>
    </div></details>
  </div>;
}
