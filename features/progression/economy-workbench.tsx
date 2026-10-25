"use client";

import { useId, useMemo, useState, type KeyboardEvent } from "react";
import { ArrowDownUp, Download, GitBranch, ListChecks, Search, Table2 } from "lucide-react";
import { economyCatalog } from "@/features/economy/domain/model";
import { buildEconomyAnalysis } from "./economy-analysis";
import { EconomyProductionGraph } from "./economy-production-graph";
import { EconomyProductionPlanner } from "./economy-production-planner";
import { downloadEconomyFile, economyCsv, economyDuration, economyNumber, economySearch } from "./economy-workbench-common";
import styles from "./economy-workbench.module.css";

const analysis = buildEconomyAnalysis();
const categoryLabels: Record<string, string> = { produce: "Урожай", material: "Материалы", crafted: "Переработка", provisions: "Еда и запасы", raw: "Рыба", fishing: "Наживка", special: "Реликвии" };
const tabs = [{ id: "chains", name: "Цепочки", icon: GitBranch }, { id: "balance", name: "Баланс", icon: Table2 }, { id: "plan", name: "План", icon: ListChecks }] as const;
type Tab = typeof tabs[number]["id"];
type Item = typeof analysis.items[number];
type SortKey = "name" | "npcPrice" | "ownSeconds" | "fullWorkSeconds" | "addedCoinsPerMinute" | "recurringUses";

export function sortEconomyRows(items: readonly Item[], key: SortKey, descending: boolean) {
  return [...items].sort((a, b) => {
    const left = a[key], right = b[key];
    if (left === null) return right === null ? a.name.localeCompare(b.name, "ru") : 1;
    if (right === null) return -1;
    const comparison = typeof left === "string" && typeof right === "string" ? left.localeCompare(right, "ru") : Number(left) - Number(right);
    return comparison * (descending ? -1 : 1) || a.name.localeCompare(b.name, "ru");
  });
}

export function EconomyBalanceTable({ onSelect }: { onSelect: (id: string) => void }) {
  const [query, setQuery] = useState(""), [category, setCategory] = useState("all"), [problemsOnly, setProblemsOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>("name"), [descending, setDescending] = useState(false), [exportError, setExportError] = useState("");
  const rows = useMemo(() => sortEconomyRows(analysis.items.filter(item => (!query.trim() || economySearch(`${item.name} ${item.id}`).includes(economySearch(query)))
    && (category === "all" || item.category === category) && (!problemsOnly || item.warnings.length > 0)), sort, descending), [query, category, problemsOnly, sort, descending]);
  const sortRows = (key: SortKey) => { setSort(key); setDescending(key === sort ? !descending : key !== "name"); };
  function header(label: string, key: SortKey) {
    return <th scope="col" aria-sort={sort === key ? descending ? "descending" : "ascending" : "none"}><button type="button" onClick={() => sortRows(key)}>{label}<ArrowDownUp size={12} aria-hidden="true" /></button></th>;
  }
  function exportBalance(format: "csv" | "json") {
    try {
      const content = format === "json" ? JSON.stringify({ schemaVersion: 1, catalogVersion: economyCatalog.version, generatedAt: new Date().toISOString(), analysis }, null, 2) : economyCsv([
        ["catalog_version", "item_id", "name", "category", "base_price", "npc_price", "input_value", "own_seconds", "full_work_seconds", "launches", "added_value", "added_coins_per_minute", "recurring_uses", "source_id", "warnings"],
        ...analysis.items.map(item => [economyCatalog.version, item.id, item.name, item.category, item.baseSellPrice, item.npcPrice, item.inputValue, item.ownSeconds,
          item.fullWorkSeconds, item.launches, item.addedValue, item.addedCoinsPerMinute, item.recurringUses, item.sourceId, item.warnings.join(" | ")]),
      ]);
      downloadEconomyFile(content, format, `economy-v${economyCatalog.version}-${format === "csv" ? "balance" : "analysis"}`); setExportError("");
    } catch { setExportError("Не удалось сохранить расчёт. Попробуйте ещё раз."); }
  }
  const number = (value: number | null) => value === null ? "—" : economyNumber(value);
  return <div className={styles.balance}>
    <div className={styles.balanceTools}>
      <label className={styles.search}><Search size={17} aria-hidden="true" /><input type="search" aria-label="Поиск в таблице баланса" placeholder="Найти товар…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <select aria-label="Категория в таблице баланса" value={category} onChange={event => setCategory(event.target.value)}><option value="all">Все категории</option>{[...new Set(analysis.items.map(item => item.category))].map(key => <option key={key} value={key}>{categoryLabels[key] ?? key}</option>)}</select>
      <label className={styles.checkbox}><input type="checkbox" checked={problemsOnly} onChange={event => setProblemsOnly(event.target.checked)} />С замечаниями</label>
      <div className={styles.actions}><button type="button" onClick={() => exportBalance("csv")}><Download size={15} />CSV всех товаров</button><button type="button" onClick={() => exportBalance("json")}><Download size={15} />JSON всей схемы</button></div>
    </div>
    <p className={styles.note}>Добавленная стоимость — продажа результата за вычетом ингредиентов и прямых монетных затрат. Ставка минуты относится к собственному таймеру; полная работа включает предыдущие стадии и сбор. Повторяемые применения — число вариантов, а не прогноз спроса.</p>
    {exportError && <p className={styles.error} role="alert">{exportError}</p>}
    <div className={styles.tableViewport} tabIndex={0} role="region" aria-label="Таблица баланса, горизонтальная прокрутка"><table className={styles.balanceTable}>
      <caption>{rows.length} из {analysis.items.length} товаров · нажмите на товар для его цепочки</caption>
      <thead><tr>{header("Товар", "name")}{header("Продажа", "npcPrice")}<th scope="col">Ингредиенты</th>{header("Своя операция", "ownSeconds")}{header("Вся работа", "fullWorkSeconds")}<th scope="col">Запуски</th>{header("Монет / мин", "addedCoinsPerMinute")}{header("Повторяемый спрос", "recurringUses")}<th scope="col">Замечания</th></tr></thead>
      <tbody>{rows.map(item => <tr key={item.id} data-balance-item={item.id}><th scope="row"><button type="button" onClick={() => onSelect(item.id)}>{item.name}<small>{categoryLabels[item.category] ?? item.category}</small></button></th><td>{number(item.npcPrice)}</td><td>{number(item.inputValue)}</td><td>{item.ownSeconds === null ? "—" : economyDuration(item.ownSeconds)}</td><td>{item.fullWorkSeconds === null ? "—" : economyDuration(item.fullWorkSeconds)}</td><td>{number(item.launches)}</td><td data-below-rate={item.addedCoinsPerMinute !== null && analysis.coinsPerMinute !== null && item.addedCoinsPerMinute < analysis.coinsPerMinute - 0.01 || undefined}>{number(item.addedCoinsPerMinute)}</td><td>{item.recurringUses}</td><td className={styles.tableWarnings}>{item.warnings.length ? item.warnings.join(" ") : "—"}</td></tr>)}</tbody>
    </table></div>
    {!rows.length && <p className={styles.empty}>Нет товаров с такими условиями. Измените поиск или фильтры.</p>}
    <p className={styles.note}>CSV и JSON всегда содержат весь каталог независимо от поиска. «—» означает, что величина не определена для выбранной технологии или внешнего источника.</p>
  </div>;
}

export function EconomyWorkbench({ onInspectItem }: { onInspectItem: (id: string) => void }) {
  const id = useId(), [tab, setTab] = useState<Tab>("chains"), [selectedId, setSelectedId] = useState("berries");
  const [targets, setTargets] = useState<Record<string, number>>({ dried_berries: 1 });
  function select(id: string) { setSelectedId(id); setTab("chains"); }
  function plan(id: string) { setTargets(current => ({ ...current, [id]: Math.min(999, (current[id] ?? 0) + 1) })); setTab("plan"); }
  function tabsKeyboard(event: KeyboardEvent<HTMLElement>) {
    const index = tabs.findIndex(value => value.id === tab);
    const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : null;
    if (next === null) return;
    event.preventDefault(); setTab(tabs[next].id);
    event.currentTarget.querySelector<HTMLButtonElement>(`[data-economy-tab="${tabs[next].id}"]`)?.focus();
  }
  return <section id="economy-analysis" className={styles.workbench} aria-label="Анализ производства и баланса">
    <div className={styles.heading}><div><span className={styles.eyebrow}>Рабочий стол экономики</span><h2>Вся цепочка — перед глазами</h2><p>Стоимость минуты, связи товаров и общий план с учётом запасов.</p></div>{analysis.coinsPerMinute !== null && <div className={styles.rate}><strong>{economyNumber(analysis.coinsPerMinute)}</strong><span>монет за базовую<br />минуту работы</span></div>}</div>
    <div className={styles.workbenchNav}><nav className={styles.tabs} role="tablist" aria-label="Инструмент анализа" onKeyDown={tabsKeyboard}>{tabs.map(({ id: key, name, icon: Icon }) => <button type="button" key={key} role="tab" id={`${id}-${key}-tab`} aria-controls={`${id}-${key}-panel`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} data-economy-tab={key} onClick={() => setTab(key)}><Icon size={17} aria-hidden="true" />{name}</button>)}</nav>
      {tab === "chains" && <label className={styles.productSelect}>Товар<select aria-label="Товар на производственной схеме" value={selectedId} onChange={event => setSelectedId(event.target.value)}>{analysis.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    </div>
    <div id={`${id}-chains-panel`} role="tabpanel" aria-labelledby={`${id}-chains-tab`} hidden={tab !== "chains"}><EconomyProductionGraph analysis={analysis} selectedId={selectedId} onSelect={select} onPlan={plan} onInspect={onInspectItem} /></div>
    <div id={`${id}-balance-panel`} role="tabpanel" aria-labelledby={`${id}-balance-tab`} hidden={tab !== "balance"}><EconomyBalanceTable onSelect={select} /></div>
    <div id={`${id}-plan-panel`} role="tabpanel" aria-labelledby={`${id}-plan-tab`} hidden={tab !== "plan"}><EconomyProductionPlanner analysis={analysis} targets={targets} onTargets={setTargets} onSelect={select} /></div>
  </section>;
}
