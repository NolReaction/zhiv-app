"use client";

import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from "react";
import { ArrowDown, ArrowRight, Expand, Minus, Plus } from "lucide-react";
import { PlayerItemIcon } from "@/features/economy/ui/fishing/fish-discovery";
import { buildEconomyAnalysis } from "./economy-analysis";
import { EconomyItemButton, economyDuration, economyNumber, stationName } from "./economy-workbench-common";
import styles from "./economy-workbench.module.css";

type Analysis = ReturnType<typeof buildEconomyAnalysis>;
type Node = Analysis["graph"]["nodes"][number];
type Edge = Analysis["graph"]["edges"][number];

/** Follow every alternative upstream, then include the selected item's immediate uses. */
export function productionGraphSelection(graph: Analysis["graph"], itemId: string, all: boolean, includeUses = true) {
  if (all) return graph;
  const selected = `item:${itemId}`, ids = new Set([selected]), pending = [selected];
  while (pending.length) {
    const target = pending.pop()!;
    for (const edge of graph.edges) if (edge.to === target && !ids.has(edge.from)) { ids.add(edge.from); pending.push(edge.from); }
  }
  for (const edge of graph.edges.filter(edge => includeUses && edge.from === selected)) {
    ids.add(edge.to);
    for (const related of graph.edges.filter(value => value.from === edge.to || value.to === edge.to)) { ids.add(related.from); ids.add(related.to); }
  }
  return { nodes: graph.nodes.filter(node => ids.has(node.id)), edges: graph.edges.filter(edge => ids.has(edge.from) && ids.has(edge.to)) };
}

export function productionGraphLayout(nodes: readonly Node[], edges: readonly Edge[]) {
  const ids = new Set(nodes.map(node => node.id)), depth = new Map<string, number>(), visiting = new Set<string>();
  function level(id: string): number {
    if (depth.has(id)) return depth.get(id)!;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const parents = edges.filter(edge => edge.to === id && ids.has(edge.from));
    const result = Math.min(nodes.length, parents.length ? 1 + Math.max(...parents.map(edge => level(edge.from))) : 0);
    visiting.delete(id); depth.set(id, result); return result;
  }
  nodes.forEach(node => level(node.id));
  const columns = new Map<number, Node[]>();
  for (const node of nodes) { const index = depth.get(node.id) ?? 0; columns.set(index, [...(columns.get(index) ?? []), node]); }
  const positions = new Map<string, { x: number; y: number }>();
  const tallest = Math.max(1, ...[...columns.values()].map(column => column.length));
  for (const [column, items] of columns) items.sort((a, b) => a.label.localeCompare(b.label, "ru")).forEach((node, index) => {
    positions.set(node.id, { x: 24 + column * 270, y: 26 + index * 104 + (tallest - items.length) * 52 });
  });
  return { positions, width: 48 + (Math.max(0, ...columns.keys()) + 1) * 270 - 44, height: Math.max(180, 52 + tallest * 104) };
}

export function EconomyProductionGraph({ analysis, selectedId, onSelect, onPlan, onInspect }: {
  analysis: Analysis; selectedId: string; onSelect: (id: string) => void; onPlan: (id: string) => void; onInspect: (id: string) => void;
}) {
  const [all, setAll] = useState(false), [includeUses, setIncludeUses] = useState(false), [zoom, setZoom] = useState(0.85);
  const viewport = useRef<HTMLDivElement>(null), drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);
  const marker = useId().replaceAll(":", "");
  const graph = useMemo(() => productionGraphSelection(analysis.graph, selectedId, all, includeUses), [analysis, selectedId, all, includeUses]);
  const layout = useMemo(() => productionGraphLayout(graph.nodes, graph.edges), [graph]);
  const items = new Map(analysis.items.map(item => [item.id, item]));
  const sources = new Map(analysis.sources.map(source => [source.id, source]));
  const selected = items.get(selectedId);
  useEffect(() => {
    const point = layout.positions.get(`item:${selectedId}`), element = viewport.current;
    if (!point || !element) return;
    element.scrollLeft = Math.max(0, (point.x + 108) * zoom - element.clientWidth / 2);
    element.scrollTop = Math.max(0, (point.y + 38) * zoom - element.clientHeight / 2);
  }, [layout, selectedId, zoom]);
  function pointerDown(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType !== "mouse" || event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    const element = event.currentTarget;
    drag.current = { x: event.clientX, y: event.clientY, left: element.scrollLeft, top: element.scrollTop };
    element.setPointerCapture(event.pointerId);
  }
  return <div className={styles.graphSection}>
    <div className={styles.graphToolbar}>
      <div className={styles.segmented} aria-label="Область схемы">
        <button type="button" aria-pressed={!all} onClick={() => setAll(false)}>Цепочка товара</button>
        <button type="button" aria-pressed={all} onClick={() => setAll(true)}><Expand size={14} aria-hidden="true" />Весь каталог</button>
      </div>
      <div className={styles.zoom}><button type="button" aria-label="Уменьшить схему" disabled={zoom <= 0.45} onClick={() => setZoom(value => Math.max(0.45, value - 0.15))}><Minus size={16} /></button><output aria-label="Масштаб схемы">{Math.round(zoom * 100)}%</output><button type="button" aria-label="Увеличить схему" disabled={zoom >= 1.3} onClick={() => setZoom(value => Math.min(1.3, value + 0.15))}><Plus size={16} /></button></div>
    </div>
    <div className={styles.graphLegend}>{!all && <label className={styles.checkbox}><input type="checkbox" checked={includeUses} onChange={event => setIncludeUses(event.target.checked)} />Показать применения</label>}<span><i />Товар</span><span><i data-operation />Операция</span><span><ArrowRight size={14} />Число на связи — количество за запуск</span></div>
    <div ref={viewport} className={styles.graphViewport} style={{ maxHeight: Math.max(180, layout.height * zoom + 16) }} tabIndex={0} role="region" aria-label="Схема производства: прокрутка или перетаскивание, товары открываются нажатием" data-production-graph onPointerDown={pointerDown} onPointerMove={event => {
      if (!drag.current) return;
      event.currentTarget.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
      event.currentTarget.scrollTop = drag.current.top - (event.clientY - drag.current.y);
    }} onPointerUp={() => { drag.current = null; }} onPointerCancel={() => { drag.current = null; }}>
      <div style={{ width: layout.width * zoom, height: layout.height * zoom, position: "relative" }}>
        <div className={styles.graphCanvas} style={{ width: layout.width, height: layout.height, transform: `scale(${zoom})` }}>
          <svg className={styles.graphConnections} width={layout.width} height={layout.height} aria-hidden="true">
            <defs><marker id={marker} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M0 0 L8 4 L0 8z" fill="#839d68" /></marker></defs>
            {graph.edges.map(edge => {
              const from = layout.positions.get(edge.from), to = layout.positions.get(edge.to);
              if (!from || !to) return null;
              const x = from.x + 216, y = from.y + 38, tx = to.x, ty = to.y + 38, mx = (x + tx) / 2;
              return <g key={edge.id}><path d={`M${x},${y} C${mx},${y} ${mx},${ty} ${tx - 3},${ty}`} markerEnd={`url(#${marker})`} /><text x={mx} y={(y + ty) / 2 - 5}>×{economyNumber(edge.quantity)}</text></g>;
            })}
          </svg>
          {graph.nodes.map(node => {
            const point = layout.positions.get(node.id)!;
            const source = node.sourceId ? sources.get(node.sourceId) : undefined;
            const item = node.itemId ? items.get(node.itemId) : undefined;
            const target = node.itemId ?? Object.keys(source?.rewards ?? {})[0];
            return <button type="button" key={node.id} className={styles.graphNode} style={{ left: point.x, top: point.y }} data-kind={node.kind} data-production-node={node.id} data-selected={node.itemId === selectedId || undefined} aria-pressed={node.kind === "item" ? node.itemId === selectedId : undefined} aria-label={`${node.kind === "item" ? "Товар" : "Операция"}: ${node.label}`} onClick={() => { if (target) onSelect(target); }}>
              {node.itemId ? <PlayerItemIcon itemId={node.itemId} size={28} /> : <ArrowRight size={21} aria-hidden="true" />}
              <span><strong>{node.label}</strong><small>{source ? `${economyDuration(source.seconds)} · ${stationName(source.stationId)}` : item?.npcPrice !== null && item?.npcPrice !== undefined ? `${economyNumber(item.npcPrice)} монет` : "Внешний источник"}</small></span>
            </button>;
          })}
        </div>
      </div>
    </div>
    <p className={styles.note}>{all ? "Все действующие рецепты и маршруты. Круговые связи возможны у вылазок с припасами; план выбирает конкретные способы получения." : includeUses ? "Все предшествующие операции и ближайшие применения выбранного товара. Альтернативные рецепты показаны отдельно." : "Полная цепочка получения выбранного товара. Включите применения, чтобы увидеть, куда он расходуется дальше."}</p>
    {selected && <div className={styles.productCard}>
      <div className={styles.productHeading}><PlayerItemIcon itemId={selected.id} size={43} /><div><span className={styles.eyebrow}>Выбранный товар</span><h3>{selected.name}</h3></div><div className={styles.actions}><button type="button" onClick={() => onPlan(selected.id)}>В план <Plus size={15} /></button><button type="button" onClick={() => onInspect(selected.id)}>Все применения <ArrowDown size={15} /></button></div></div>
      <dl className={styles.metrics}>
        <div><dt>Базовая продажа</dt><dd>{selected.npcPrice === null ? "—" : economyNumber(selected.npcPrice)} <small>монет</small></dd></div>
        <div><dt>Полная работа</dt><dd>{economyDuration(selected.fullWorkSeconds)}</dd></div>
        <div><dt>Запусков с нуля</dt><dd>{selected.launches === null ? "—" : selected.launches}</dd></div>
        <div><dt>Повторяемых применений</dt><dd>{selected.recurringUses}</dd></div>
      </dl>
      <div className={styles.sourceGrid}>{selected.sourceIds.map(id => sources.get(id)).filter(source => !!source).map(source => <article className={styles.sourceCard} key={source.id}>
        <strong>{source.name}</strong><p>{stationName(source.stationId)} · {economyDuration(source.seconds)} · дом {source.homeLevel}{source.cost.coins > 0 && ` · ${economyNumber(source.cost.coins)} монет за запуск`}</p>
        <small>Затраты</small>
        <div className={styles.chips}>{Object.entries(source.cost.items).map(([id, count]) => <EconomyItemButton key={id} id={id} name={items.get(id)?.name ?? id} quantity={count} onSelect={onSelect} />)}{!Object.keys(source.cost.items).length && <span className={styles.note}>Без ингредиентов</span>}</div>
        <small>Результат</small><div className={styles.chips}>{Object.entries(source.rewards).map(([id, count]) => <EconomyItemButton key={id} id={id} name={items.get(id)?.name ?? id} quantity={count} onSelect={onSelect} />)}</div>
        <small>{Object.entries(source.requiredBuildings).map(([id, level]) => `${stationName(id)} ${level}`).join(" · ")}{Object.keys(source.requiredRecipes).length > 0 && ` · Освоение: ${Object.entries(source.requiredRecipes).map(([id, count]) => `${sources.get(`recipe:${id}`)?.name ?? id} ×${count}`).join(", ")}`}{source.collectionSeconds > 0 && ` · Сбор ${economyDuration(source.collectionSeconds)}`}</small>
      </article>)}</div>
      {selected.warnings.length > 0 && <ul className={styles.warnings}>{selected.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
    </div>}
  </div>;
}
