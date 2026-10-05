"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { Anchor, Apple, ArrowLeft, ArrowRight, Binoculars, Bird, BookOpen, Box, CalendarDays, Check, CircleCheck, Clock3, Compass, CookingPot, Droplets, Expand, Fence, Fish, FishingHook, FishingRod, Flame, Gift, Hammer, Hand, Heart, Home, Info, Leaf, MapPinned, Medal, Minus, Mountain, Package, Pickaxe, Plus, Sailboat, ScrollText, Search, Ship, Shirt, Sprout, Star, Store, TentTree, TowerControl, TreePine, Trees, Trophy, Warehouse, Waves, X, Zap, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { CollectionIcon, ItemIcon } from "@/features/items/item-icon";
import { getPrerequisiteIds, getProgressionResourceSource, progressionGraph, progressionItemNames, type ProgressionNode } from "./graph";
import { buildProgressionLayout, COLUMN_WIDTH, NODE_HEIGHT, NODE_WIDTH, phaseTitles } from "./layout";
import styles from "./branch-page.module.css";

type Point = { x: number; y: number };
type Camera = Point & { scale: number };
type Gesture = { start: Point; camera: Camera; distance?: number; moved: boolean };

const MIN_SCALE = 0.04;
const MAX_SCALE = 1.8;
const kindNames: Record<string, string> = { location: "Место на карте", building: "Улучшение хозяйства", recipe: "Производство", exploration: "Вылазка", acquisition: "Реликвии", world: "Мир", collection: "Коллекция", equipment: "Снаряжение", milestone: "Прогресс", market: "Торговля", project: "Будущее мира" };
const buildingIcons: Record<string, LucideIcon> = { home: Home, garden: Sprout, woodlot: Trees, quarry: Pickaxe, workshop: Hammer, dryer: CookingPot, kiln: Flame, warehouse: Warehouse };
const worldIcons: Record<string, LucideIcon> = {
  daily_rewards: Gift, pearl_trader: Store,
  start: Sprout, trader: Store, claimed: CircleCheck, market: Store, "place:home": Home, "place:workshop": Hammer, "place:woodlot": Trees, "place:quarry": Pickaxe, living: Leaf, bush: Droplets, campfire: TentTree, wildlife: Bird, bridge_ruin: Fence, lighthouse_ruin: TowerControl, album: BookOpen, travel_book: Leaf, quarry_book: Pickaxe, wardrobe: Shirt, life_marks: Heart, day_streak: CalendarDays, calendar_gifts: Gift, taps: Hand, player_level: Star, tap_streak: Zap, leaderboard: Trophy, achievements: Medal, pleska: FishingRod, fishing_catches: Fish, public_profiles: Star, pleska_home: Home, mine_interior: Pickaxe, bridge: Fence, far_bank: MapPinned, regional_trips: Compass, new_finds: Binoculars, shore_site: Waves, boat: Sailboat, port: Anchor, lighthouse: TowerControl, ships: Ship, sea_trips: Waves, orders: ScrollText, new_fruits: Apple, tackle: FishingHook,
};
const explorationIcons: Record<string, LucideIcon> = { forest: TreePine, shore: Fish, forest_camp: Trees, shore_camp: FishingRod, cave: Pickaxe, deep_cave: Mountain, old_woodland: Trees, coastal_deposits: Waves, uplands: Mountain, abandoned_quarry: Pickaxe };

function NodeIcon({ node, size = 32 }: { node: ProgressionNode; size?: number }) {
  if (node.rareDrops) return <ItemIcon itemId={node.rareDrops.itemIds[0]} size={size} />;
  if (node.id === "coins" || node.id === "pearls" || node.id === "explorer_cap" || node.id === "willow_rod") return <ItemIcon itemId={node.id} size={size} />;
  if (node.id === "forest_set" || node.id === "river_set") return <CollectionIcon findId={node.id === "forest_set" ? "acorn" : "river_shell"} size={size} />;
  let Icon = worldIcons[node.id] ?? Box;
  if (node.kind === "building") Icon = buildingIcons[node.buildingId ?? ""] ?? Box;
  else if (node.kind === "recipe") {
    const outputs = Object.keys(node.rewards ?? {});
    if (outputs.length === 1) return <ItemIcon itemId={outputs[0]} size={size} />;
    Icon = Package;
  } else if (node.kind === "exploration") Icon = explorationIcons[node.id.replace(/^e:/, "")] ?? Compass;
  return <Icon size={size} strokeWidth={1.65} aria-hidden="true" />;
}
const number = (value: number) => value.toLocaleString("ru-RU");
const duration = (seconds: number) => {
  if (!seconds) return "Мгновенно";
  if (seconds >= 86400 && seconds % 86400 === 0) return `${number(seconds / 86400)} дн.`;
  if (seconds >= 3600 && seconds % 3600 === 0) return `${number(seconds / 3600)} ч`;
  return `${number(Math.ceil(seconds / 60))} мин`;
};

const nodeById = new Map(progressionGraph.nodes.map(node => [node.id, node]));
const graphLayout = buildProgressionLayout(progressionGraph);

function connectionPath(sourceId: string, targetId: string, index: number) {
  const source = graphLayout.positions.get(sourceId);
  const target = graphLayout.positions.get(targetId);
  if (!source || !target) return "";
  const sameColumn = Math.abs(source.x - target.x) < COLUMN_WIDTH - 190;
  if (sameColumn && source.y < target.y) {
    const start = { x: source.x + NODE_WIDTH / 2, y: source.y + NODE_HEIGHT };
    const end = { x: target.x + NODE_WIDTH / 2, y: target.y };
    const bend = Math.max(30, Math.abs(end.y - start.y) * 0.45);
    return `M${start.x},${start.y} C${start.x},${start.y + bend} ${end.x},${end.y - bend} ${end.x},${end.y}`;
  }
  const forward = target.x >= source.x;
  const start = { x: source.x + (forward ? NODE_WIDTH : 0), y: source.y + NODE_HEIGHT / 2 };
  const end = { x: target.x + (forward ? 0 : NODE_WIDTH), y: target.y + NODE_HEIGHT / 2 };
  const direction = forward ? 1 : -1;
  const bend = Math.min(140, Math.max(54, Math.abs(end.x - start.x) / 3)) + index % 3 * 7;
  return `M${start.x},${start.y} C${start.x + direction * bend},${start.y} ${end.x - direction * bend},${end.y} ${end.x},${end.y}`;
}

const itemSources = new Map(Object.keys(progressionItemNames).map(itemId => [itemId, getProgressionResourceSource(progressionGraph, itemId)?.id]));

export function BranchPage() {
  const canvasRef = useRef<HTMLDivElement>(null);
  const detailRef = useRef<HTMLElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [camera, setCamera] = useState<Camera>({ x: 24, y: 24, scale: 1 });
  const cameraRef = useRef(camera);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);
  const suppressClickUntil = useRef(0);
  const inputMode = useRef("pointer");
  const [dragging, setDragging] = useState(false);
  const [selectedId, setSelectedId] = useState("start");
  const [activePhase, setActivePhase] = useState(0);
  const [query, setQuery] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const detailHeadingId = useId();
  const markerId = useId().replace(/:/g, "");
  const selected = nodeById.get(selectedId) ?? progressionGraph.nodes[0];
  const prerequisites = useMemo(() => getPrerequisiteIds(progressionGraph, selected.id), [selected.id]);
  const searchResults = useMemo(() => query.trim() ? progressionGraph.nodes.filter(node => `${node.title} ${node.label} ${kindNames[node.kind] ?? ""} ${node.locationId ? nodeById.get(node.locationId)?.title ?? "" : ""} ${node.buildingId === "quarry" ? "каменоломня" : ""} ${node.rareDrops?.itemIds.map(id => progressionItemNames[id] ?? id).join(" ") ?? ""}`.toLocaleLowerCase("ru-RU").includes(query.trim().toLocaleLowerCase("ru-RU"))).slice(0, 18) : [], [query]);
  const activeCount = progressionGraph.nodes.filter(node => node.status === "active").length;
  const outgoing = progressionGraph.edges.filter(edge => edge.source === selected.id && edge.kind !== "cost" && edge.kind !== "contains").map(edge => nodeById.get(edge.target)).filter((node): node is ProgressionNode => !!node);
  const containedNodes = selected.kind === "location" ? selected.children.map(id => nodeById.get(id)).filter((node): node is ProgressionNode => !!node) : [];
  const openedNodes = [...new Map([...(selected.kind === "location" ? [] : selected.children.map(id => nodeById.get(id))), ...outgoing].filter((node): node is ProgressionNode => !!node).map(node => [node.id, node])).values()];
  const incoming = progressionGraph.edges.filter(edge => edge.target === selected.id && edge.kind !== "cost" && edge.kind !== "contains" && (selected.status === "plan" || (edge.kind !== "plan" && nodeById.get(edge.source)?.status === "active"))).map(edge => nodeById.get(edge.source)).filter((node): node is ProgressionNode => !!node);
  const location = selected.locationId ? nodeById.get(selected.locationId) : undefined;

  useEffect(() => { if (detailRef.current) detailRef.current.scrollTop = 0; }, [selected.id]);

  const updateCamera = useCallback((next: Camera) => {
    cameraRef.current = next;
    setCamera(next);
  }, []);

  const centerNode = useCallback((id: string, minimumScale = 0.75) => {
    const point = graphLayout.positions.get(id);
    const viewport = canvasRef.current;
    if (!point || !viewport) return;
    const scale = Math.max(minimumScale, cameraRef.current.scale);
    updateCamera({ x: viewport.clientWidth / 2 - (point.x + NODE_WIDTH / 2) * scale, y: viewport.clientHeight / 2 - (point.y + NODE_HEIGHT / 2) * scale, scale });
  }, [updateCamera]);

  const selectNode = useCallback((id: string, center = false) => {
    if (!nodeById.has(id)) return;
    setSelectedId(id);
    setActivePhase(nodeById.get(id)!.phase);
    setDetailOpen(true);
    if (center) centerNode(id);
  }, [centerNode]);

  const zoom = useCallback((factor: number, anchor?: Point) => {
    const viewport = canvasRef.current;
    if (!viewport) return;
    const current = cameraRef.current;
    const point = anchor ?? { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 };
    const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.scale * factor));
    updateCamera({ x: point.x - (point.x - current.x) * scale / current.scale, y: point.y - (point.y - current.y) * scale / current.scale, scale });
  }, [updateCamera]);

  function fitGraph() {
    const viewport = canvasRef.current;
    if (!viewport) return;
    const scale = Math.max(MIN_SCALE, Math.min(1, (viewport.clientWidth - 48) / graphLayout.width, (viewport.clientHeight - 48) / graphLayout.height));
    updateCamera({ x: (viewport.clientWidth - graphLayout.width * scale) / 2, y: (viewport.clientHeight - graphLayout.height * scale) / 2, scale });
  }

  function jumpPhase(phase: number) {
    const section = graphLayout.sections[phase];
    const viewport = canvasRef.current;
    if (!viewport || !section) return;
    setActivePhase(phase);
    const scale = Math.min(1, Math.max(0.75, (viewport.clientWidth - 48) / section.width));
    updateCamera({ x: viewport.clientWidth / 2 - (section.x + section.width / 2) * scale, y: 32 - section.y * scale, scale });
  }

  useEffect(() => {
    centerNode("start", 1);
    const viewport = canvasRef.current;
    if (!viewport) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoom(Math.exp(-Math.max(-150, Math.min(150, event.deltaY)) * 0.002), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    let previousWidth = viewport.clientWidth;
    let previousHeight = viewport.clientHeight;
    const observer = new ResizeObserver(() => {
      const width = viewport.clientWidth;
      const height = viewport.clientHeight;
      if (width === previousWidth && height === previousHeight) return;
      const current = cameraRef.current;
      updateCamera({ ...current, x: current.x + (width - previousWidth) / 2, y: current.y + (height - previousHeight) / 2 });
      previousWidth = width;
      previousHeight = height;
    });
    observer.observe(viewport);
    return () => { viewport.removeEventListener("wheel", wheel); observer.disconnect(); };
  }, [centerNode, updateCamera, zoom]);

  function localPoint(event: PointerEvent<HTMLDivElement>): Point {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function startGesture(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    const points = [...pointers.current.values()];
    if (points.length > 1) {
      const start = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      gesture.current = { start, camera: cameraRef.current, distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y), moved: true };
      for (const pointerId of pointers.current.keys()) event.currentTarget.setPointerCapture(pointerId);
    } else gesture.current = { start: point, camera: cameraRef.current, moved: false };
  }

  function moveGesture(event: PointerEvent<HTMLDivElement>) {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return;
    pointers.current.set(event.pointerId, localPoint(event));
    const points = [...pointers.current.values()];
    const current = gesture.current;
    if (points.length > 1 && current.distance) {
      const middle = { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 };
      const distance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, current.camera.scale * distance / Math.max(1, current.distance)));
      updateCamera({ x: middle.x - (current.start.x - current.camera.x) * scale / current.camera.scale, y: middle.y - (current.start.y - current.camera.y) * scale / current.camera.scale, scale });
      setDragging(true);
      return;
    }
    const point = points[0];
    const delta = { x: point.x - current.start.x, y: point.y - current.start.y };
    if (!current.moved && Math.hypot(delta.x, delta.y) < 6) return;
    current.moved = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
    updateCamera({ ...current.camera, x: current.camera.x + delta.x, y: current.camera.y + delta.y });
  }

  function endGesture(event: PointerEvent<HTMLDivElement>) {
    if (gesture.current?.moved) suppressClickUntil.current = performance.now() + 350;
    pointers.current.delete(event.pointerId);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    const remaining = [...pointers.current.values()][0];
    gesture.current = remaining ? { start: remaining, camera: cameraRef.current, moved: false } : null;
    setDragging(false);
  }

  function canvasKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const current = cameraRef.current;
    const distance = event.shiftKey ? 180 : 70;
    const movement: Record<string, Point> = { ArrowLeft: { x: distance, y: 0 }, ArrowRight: { x: -distance, y: 0 }, ArrowUp: { x: 0, y: distance }, ArrowDown: { x: 0, y: -distance } };
    if (movement[event.key]) {
      event.preventDefault();
      updateCamera({ ...current, x: current.x + movement[event.key].x, y: current.y + movement[event.key].y });
    } else if (event.key === "+" || event.key === "=") { event.preventDefault(); zoom(1.2); }
    else if (event.key === "-") { event.preventDefault(); zoom(1 / 1.2); }
    else if (event.key === "0") { event.preventDefault(); fitGraph(); }
  }

  const relatedButton = (node: ProgressionNode) => <button type="button" className={styles.relatedButton} onClick={() => selectNode(node.id, true)}><span aria-hidden="true"><NodeIcon node={node} size={21} /></span><span>{node.title}{node.status === "plan" && <small>План</small>}</span><ArrowRight size={14} aria-hidden="true" /></button>;
  const requirementNodes = Object.entries(selected.requirements).map(([buildingId, level]) => ({ node: nodeById.get(`b:${buildingId}:${level}`) ?? (buildingId === "completedExplorations" ? nodeById.get("claimed") : undefined), buildingId, level }));

  return <main className={styles.page} onPointerDownCapture={() => { inputMode.current = "pointer"; }} onKeyDownCapture={event => {
    if (event.key === "Tab") inputMode.current = "keyboard";
    if (event.key === "Escape") {
      setQuery("");
      setDetailOpen(false);
      if (detailRef.current?.contains(event.target as Node)) canvasRef.current?.focus();
    }
  }}>
    <header className={styles.header}>
      <Link href="/" className={styles.back} aria-label="Вернуться в Я живой"><ArrowLeft size={18} aria-hidden="true" /></Link>
      <div className={styles.heading}><span>Схема правил и возможностей</span><h1>Ветка развития мира</h1></div>
      <div className={styles.search}>
        <Search size={17} aria-hidden="true" />
        <input ref={searchRef} type="search" value={query} placeholder="Мост, верстак, доски…" aria-label="Найти в ветке развития" aria-controls={query.trim() ? "branch-search-results" : undefined} onChange={event => setQuery(event.target.value)} onKeyDown={event => {
          if (event.key === "Enter" && searchResults[0]) { event.preventDefault(); selectNode(searchResults[0].id, true); setQuery(""); }
        }} />
        {query && <button type="button" aria-label="Очистить поиск" onClick={() => { setQuery(""); searchRef.current?.focus(); }}><X size={16} aria-hidden="true" /></button>}
        {query.trim() && <div className={styles.searchResults} id="branch-search-results"><p>{searchResults.length ? "Перейти к узлу" : "Ничего не найдено"}</p><ul>{searchResults.map(node => <li key={node.id}><button type="button" onClick={() => { selectNode(node.id, true); setQuery(""); searchRef.current?.focus(); }}><span aria-hidden="true"><NodeIcon node={node} size={24} /></span><span>{node.title}<small>{kindNames[node.kind]}{node.status === "plan" ? " · План" : ""}</small></span><ArrowRight size={15} aria-hidden="true" /></button></li>)}</ul></div>}
      </div>
      <button type="button" className={styles.mobileDetails} aria-label="Подробности выбранного узла" aria-expanded={detailOpen} onClick={() => setDetailOpen(value => !value)}><Info size={18} aria-hidden="true" /></button>
    </header>
    <div className={styles.workspace}>
      <section className={styles.board} aria-label="Связанное дерево развития">
        <div className={styles.toolbar}>
          <label className={styles.stageSelect}><span>Этап</span><select aria-label="Перейти к этапу мира" value={activePhase} onChange={event => jumpPhase(Number(event.target.value))}>{phaseTitles.map((title, phase) => <option key={phase} value={phase}>{title}</option>)}</select></label>
          <div className={styles.zoomControls}>
            <button type="button" aria-label="Уменьшить" onClick={() => zoom(1 / 1.2)} disabled={camera.scale <= MIN_SCALE}><Minus size={17} aria-hidden="true" /></button>
            <button type="button" className={styles.zoomValue} title="Масштаб 100% вокруг выбранного узла" aria-label={`Масштаб ${Math.round(camera.scale * 100)} процентов. Вернуть 100 процентов`} onClick={() => { const current = cameraRef.current; updateCamera({ ...current, scale: 1 }); centerNode(selected.id, 1); }}>{Math.round(camera.scale * 100)}%</button>
            <button type="button" aria-label="Увеличить" onClick={() => zoom(1.2)} disabled={camera.scale >= MAX_SCALE}><Plus size={17} aria-hidden="true" /></button>
            <button type="button" aria-label="Показать всю ветку" title="Вся ветка" onClick={fitGraph}><Expand size={17} aria-hidden="true" /></button>
          </div>
        </div>
        <div ref={canvasRef} className={styles.viewport} data-dragging={dragging || undefined} tabIndex={0} role="region" aria-label="Карта развития. Перетаскивайте для перемещения, колесо для масштаба. Клавиатура: стрелки, плюс, минус, ноль — вся ветка." onPointerDown={startGesture} onPointerMove={moveGesture} onPointerUp={endGesture} onPointerCancel={endGesture} onKeyDown={canvasKeys}>
          <div className={styles.graph} style={{ width: graphLayout.width, height: graphLayout.height, transform: `translate(${camera.x}px, ${camera.y}px) scale(${camera.scale})` }}>
            {graphLayout.sections.map(section => <div key={section.phase} className={styles.phase} style={{ left: section.x, top: section.y, width: section.width, height: section.height }}><span className={styles.phaseNumber}>{section.phase === 0 ? "СТАРТ" : section.phase < 6 ? `УРОВЕНЬ ${section.phase}` : section.phase === 6 ? "ЖИЗНЬ МИРА" : "БУДУЩЕЕ"}</span><h2>{phaseTitles[section.phase]}</h2></div>)}
            {graphLayout.groups.map(group => <div key={`${group.phase}:${group.locationId}`} className={styles.locationGroup} style={{ left: group.x, top: group.y, width: group.width, height: group.height }}><span>{group.title} · хозяйство</span></div>)}
            <svg className={styles.connections} viewBox={`0 0 ${graphLayout.width} ${graphLayout.height}`} aria-hidden="true"><defs><marker id={markerId} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0,0 L8,4 L0,8 z" fill="context-stroke" /></marker></defs>{progressionGraph.edges.map((edge, index) => {
              const inPath = prerequisites.has(edge.source) && prerequisites.has(edge.target);
              const adjacent = edge.source === selected.id || edge.target === selected.id;
              if (edge.kind === "cost" && !inPath) return null;
              return <path key={edge.id} d={connectionPath(edge.source, edge.target, index)} className={styles.connection} data-kind={edge.kind} data-highlight={inPath ? "path" : adjacent ? "next" : undefined} markerEnd={inPath || adjacent ? `url(#${markerId})` : undefined} />;
            })}</svg>
            {progressionGraph.nodes.map(node => {
              const point = graphLayout.positions.get(node.id);
              if (!point) return null;
              const isSelected = node.id === selected.id;
              return <button key={node.id} type="button" className={styles.node} style={{ left: point.x, top: point.y }} data-node-id={node.id} data-kind={node.kind} data-status={node.status} data-selected={isSelected || undefined} data-prerequisite={!isSelected && prerequisites.has(node.id) || undefined} aria-pressed={isSelected} title={node.title} aria-label={`${node.title}${node.status === "plan" ? ". План развития" : ""}`} onFocus={() => { if (inputMode.current === "keyboard") centerNode(node.id); }} onClick={() => { if (performance.now() >= suppressClickUntil.current) selectNode(node.id); }}>
                <span className={styles.nodeIcon} aria-hidden="true"><NodeIcon node={node} /></span>
                <span className={styles.nodeLabel}>{node.label}</span>
                {node.status === "plan" ? <span className={styles.nodeBadge}>ПЛАН</span> : node.kind === "location" ? <span className={styles.nodeBadge}>МЕСТО</span> : node.kind === "building" ? <span className={styles.nodeBadge}>{node.level}</span> : null}
                {isSelected && <Check className={styles.selectedCheck} size={14} aria-hidden="true" />}
              </button>;
            })}
          </div>
        </div>
        <footer className={styles.boardFooter}><span className={styles.legend}><i />Условия<span className={styles.locationKey}><i />Внутри места</span><span className={styles.costKey}><i />Ресурсы</span><span className={styles.planKey}><i />План</span></span><span className={styles.navigationHint}>Перетаскивай · колесо / два пальца — масштаб</span><span>{activeCount} действующих · {progressionGraph.nodes.length - activeCount} планов</span></footer>
      </section>
      <aside ref={detailRef} className={styles.details} data-open={detailOpen || undefined} aria-labelledby={detailHeadingId}>
        <div className={styles.detailHeader}><span className={styles.detailIcon} aria-hidden="true"><NodeIcon node={selected} size={30} /></span><div><span>{kindNames[selected.kind] ?? "Мир"}{selected.status === "plan" ? " · План" : ""}</span><h2 id={detailHeadingId}>{selected.title}</h2></div><button type="button" className={styles.closeDetails} aria-label="Закрыть подробности" onClick={() => { setDetailOpen(false); canvasRef.current?.focus(); }}><X size={19} aria-hidden="true" /></button></div>
        <div className={styles.detailContent} key={selected.id}>
          {selected.status === "plan" && <p className={styles.planNotice}>План развития. Игровые требования, цена и таймер ещё не заданы.</p>}
          {selected.description && <p className={styles.description}>{selected.description}</p>}
          {location && <section><h3>Место на карте</h3><ul className={styles.relatedList}><li>{relatedButton(location)}</li></ul></section>}
          {containedNodes.length > 0 && <section><h3>{selected.id === "place:home" || selected.id === "place:workshop" ? "Внутри" : "Хозяйство этого места"}</h3><p className={styles.sectionHint}>Это одно место на карте. Каждая возможность улучшается отдельно; наличие места само по себе не открывает все уровни и рецепты.</p><ul className={styles.relatedList}>{containedNodes.map(node => <li key={node.id}>{relatedButton(node)}</li>)}</ul></section>}
          {(requirementNodes.length > 0 || incoming.length > 0) && <section><h3>{selected.status === "plan" ? "Предлагаемые связи" : requirementNodes.length ? "Условия открытия" : "Связи ветки"}</h3>{requirementNodes.length > 0 ? <><p className={styles.sectionHint}>Нужно выполнить все условия</p><ul className={styles.relatedList}>{requirementNodes.map(({ node, buildingId, level }) => <li key={buildingId}>{node ? relatedButton(node) : <span>{buildingId} · {level}</span>}</li>)}</ul></> : <>{selected.id === "claimed" && <p className={styles.sectionHint}>Подходит любой из маршрутов</p>}<ul className={styles.relatedList}>{[...new Map(incoming.map(node => [node.id, node])).values()].map(node => <li key={node.id}>{relatedButton(node)}</li>)}</ul></>}</section>}
          {selected.cost && <section><h3>{selected.kind === "building" ? "Стоимость обустройства" : "Расход за один цикл"}</h3><ul className={styles.itemList}>{!!selected.cost.coins && <li><ItemIcon itemId="coins" size={18} /><button type="button" onClick={() => selectNode("coins", true)}>Монеты</button><strong>{number(selected.cost.coins)}</strong></li>}{Object.entries(selected.cost.items).map(([id, count]) => <li key={id}>{itemSources.get(id) ? <button type="button" onClick={() => selectNode(itemSources.get(id)!, true)} title="Показать, где получить"><ItemIcon itemId={id} size={18} />{progressionItemNames[id] ?? id}<ArrowRight size={12} aria-hidden="true" /></button> : <span><ItemIcon itemId={id} size={18} />{progressionItemNames[id] ?? id}</span>}<strong>×{number(count)}</strong></li>)}</ul>{!selected.cost.coins && !Object.keys(selected.cost.items).length && <p className={styles.sectionHint}>Без затрат</p>}</section>}
          {selected.seconds !== undefined && <p className={styles.duration}><Clock3 size={16} aria-hidden="true" /><span>{selected.kind === "building" ? "Обустройство" : "Один цикл"}</span><strong>{duration(selected.seconds)}</strong></p>}
          {selected.warehouseCapacity && <section><h3>Вместимость кладовой</h3><p className={styles.capacity}>{number(selected.warehouseCapacity)} <span>предметов</span></p></section>}
          {selected.rewards && Object.keys(selected.rewards).length > 0 && <section><h3>Получишь</h3><ul className={styles.itemList}>{Object.entries(selected.rewards).map(([id, count]) => <li key={id}><span><ItemIcon itemId={id} size={18} />{progressionItemNames[id] ?? id}</span><strong>×{number(count)}</strong></li>)}</ul></section>}
          {selected.rareDrops && <><section><h3>Может выпасть один из типов</h3><ul className={styles.itemList}>{selected.rareDrops.itemIds.map(id => <li key={id}><span><ItemIcon itemId={id} size={18} />{progressionItemNames[id] ?? id}</span><strong>1/{selected.rareDrops!.itemIds.length}</strong></li>)}</ul><p className={styles.sectionHint}>Доли относятся к типу очередной находки, а не к шансу каждой поездки. Отдельного производственного таймера нет.</p></section><section><h3>Подходит любой маршрут</h3><ul className={styles.relatedList}>{incoming.filter(node => node.kind === "exploration").map(node => <li key={node.id}>{relatedButton(node)}</li>)}</ul></section></>}
          {openedNodes.length > 0 && <section><h3>{selected.kind === "building" ? "Открывает и помогает открыть" : "Продолжение ветки"}</h3>{selected.kind === "building" && <p className={styles.sectionHint}>Для связанных улучшений могут понадобиться другие уровни хозяйства. Рецепты прошлых уровней остаются доступны.</p>}<ul className={styles.relatedList}>{openedNodes.map(node => <li key={node.id}>{relatedButton(node)}</li>)}</ul></section>}
          {(selected.rewards || selected.rareDrops) && <section><h3>Где нужны эти ресурсы</h3><ul className={styles.relatedList}>{progressionGraph.nodes.filter(node => node.id !== selected.id && Object.keys(node.cost?.items ?? {}).some(id => selected.rewards?.[id] || selected.rareDrops?.itemIds.includes(id))).map(node => <li key={node.id}>{relatedButton(node)}</li>)}</ul></section>}
          <button type="button" className={styles.centerButton} onClick={() => { centerNode(selected.id, 1); setDetailOpen(false); canvasRef.current?.focus(); }}><Expand size={16} aria-hidden="true" />Показать этот узел на схеме</button>
        </div>
      </aside>
    </div>
  </main>;
}
