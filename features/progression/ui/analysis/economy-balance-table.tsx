"use client";

import { useMemo, useState } from "react";
import { ArrowDownUp, Download, Search } from "lucide-react";
import { economyCatalog } from "@/features/economy/domain/model";
import { analysis } from "./analysis-model";
import { expeditionExpectedReturns } from "@/features/progression/domain/economy-expeditions";
import { downloadEconomyFile, economyCsv, economyDuration, economyNumber, economySearch } from "./economy-workbench-common";
import styles from "./economy-workbench.module.css";

import { useBranchState } from "@/features/progression/ui/shell/branch-session";
const searchIndex = new Map(analysis.items.map(item => [item.id, economySearch(`${item.name} ${item.id}`)]));
const categoryLabels: Record<string, string> = { produce: "Урожай", material: "Материалы", crafted: "Переработка", provisions: "Еда и запасы", raw: "Рыба", fishing: "Наживка", special: "Реликвии" };
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
  const [query, setQuery] = useBranchState("balance.query", ""), [category, setCategory] = useBranchState("balance.category", "all"), [problemsOnly, setProblemsOnly] = useBranchState("balance.problemsOnly", false);
  const [sort, setSort] = useBranchState<SortKey>("balance.sort", "name"), [descending, setDescending] = useBranchState("balance.descending", false), [exportError, setExportError] = useState("");
  const [page, setPage] = useBranchState("balance.page", 0);
  const rows = useMemo(() => sortEconomyRows(analysis.items.filter(item => (!query.trim() || searchIndex.get(item.id)!.includes(economySearch(query)))
    && (category === "all" || item.category === category) && (!problemsOnly || item.warnings.length > 0)), sort, descending), [query, category, problemsOnly, sort, descending]);
  const lastPage = Math.max(0, Math.ceil(rows.length / 30) - 1);
  const currentPage = Math.min(page, lastPage);
  const sortRows = (key: SortKey) => { setSort(key); setDescending(key === sort ? !descending : key !== "name"); };
  function header(label: string, key: SortKey) {
    return <th scope="col" aria-sort={sort === key ? descending ? "descending" : "ascending" : "none"}><button type="button" onClick={() => sortRows(key)}>{label}<ArrowDownUp size={12} aria-hidden="true" /></button></th>;
  }
  function exportBalance(format: "csv" | "json") {
    try {
      const content = format === "json" ? JSON.stringify({ schemaVersion: 1, catalogVersion: economyCatalog.version, generatedAt: new Date().toISOString(), analysis, expeditionExpectations: expeditionExpectedReturns() }, null, 2) : economyCsv([
        ["catalog_version", "item_id", "name", "category", "base_price", "npc_price", "input_value", "own_seconds", "full_work_seconds", "launches", "added_value", "added_coins_per_minute", "recurring_uses", "source_id", "warnings"],
        ...analysis.items.map(item => [economyCatalog.version, item.id, item.name, item.category, item.baseSellPrice, item.npcPrice, item.inputValue, item.ownSeconds,
          item.fullWorkSeconds, item.launches, item.addedValue, item.addedCoinsPerMinute, item.recurringUses, item.sourceId, item.warnings.join(" | ")]),
      ]);
      downloadEconomyFile(content, format, `economy-v${economyCatalog.version}-${format === "csv" ? "balance" : "analysis"}`); setExportError("");
    } catch { setExportError("Не удалось сохранить расчёт. Попробуйте ещё раз."); }
  }
  const number = (value: number | null) => value === null ? "-" : economyNumber(value);
  return <div className={styles.balance}>
    <div className={styles.balanceTools}>
      <label className={styles.search}><Search size={17} aria-hidden="true" /><input type="search" aria-label="Поиск в таблице баланса" placeholder="Найти товар…" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label>
      <select aria-label="Категория в таблице баланса" value={category} onChange={event => setCategory(event.target.value)}><option value="all">Все категории</option>{[...new Set(analysis.items.map(item => item.category))].map(key => <option key={key} value={key}>{categoryLabels[key] ?? key}</option>)}</select>
      <label className={styles.checkbox}><input type="checkbox" checked={problemsOnly} onChange={event => setProblemsOnly(event.target.checked)} />С замечаниями</label>
      <div className={styles.actions}><button type="button" onClick={() => exportBalance("csv")}><Download size={15} />CSV всех товаров</button><button type="button" onClick={() => exportBalance("json")}><Download size={15} />JSON всей схемы</button></div>
    </div>
    <p className={styles.note}>Добавленная стоимость: продажа результата за вычетом ингредиентов и прямых монетных затрат. Ставка минуты относится к собственному таймеру; полная работа включает предыдущие стадии и сбор. Повторяемые применения: число вариантов, а не прогноз спроса.</p>
    {exportError && <p className={styles.error} role="alert">{exportError}</p>}
    <div className={styles.tableViewport} tabIndex={0} role="region" aria-label="Таблица баланса, горизонтальная прокрутка"><table className={styles.balanceTable}>
      <caption>{rows.length} из {analysis.items.length} товаров · нажмите на товар для его цепочки</caption>
      <thead><tr>{header("Товар", "name")}{header("Продажа", "npcPrice")}<th scope="col">Ингредиенты</th>{header("Своя операция", "ownSeconds")}{header("Вся работа", "fullWorkSeconds")}<th scope="col">Запуски</th>{header("Монет / мин", "addedCoinsPerMinute")}{header("Повторяемый спрос", "recurringUses")}<th scope="col">Замечания</th></tr></thead>
      <tbody>{rows.slice(currentPage * 30, (currentPage + 1) * 30).map(item => <tr key={item.id} data-balance-item={item.id}><th scope="row"><button type="button" onClick={() => onSelect(item.id)}>{item.name}<small>{categoryLabels[item.category] ?? item.category}</small></button></th><td>{number(item.npcPrice)}</td><td>{number(item.inputValue)}</td><td>{item.ownSeconds === null ? "-" : economyDuration(item.ownSeconds)}</td><td>{item.fullWorkSeconds === null ? "-" : economyDuration(item.fullWorkSeconds)}</td><td>{number(item.launches)}</td><td data-below-rate={item.addedCoinsPerMinute !== null && analysis.coinsPerMinute !== null && item.addedCoinsPerMinute < analysis.coinsPerMinute - 0.01 || undefined}>{number(item.addedCoinsPerMinute)}</td><td>{item.recurringUses}</td><td className={styles.tableWarnings}>{item.warnings.length ? item.warnings.join(" ") : "-"}</td></tr>)}</tbody>
    </table></div>
    {rows.length > 30 && <nav className={styles.pagination} aria-label="Страницы баланса"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Назад</button><span role="status">{currentPage + 1} / {lastPage + 1}</span><button type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Далее</button></nav>}
    {!rows.length && <p className={styles.empty}>Нет товаров с такими условиями. Измените поиск или фильтры.</p>}
    <p className={styles.note}>CSV и JSON всегда содержат весь каталог независимо от поиска. «-» означает, что величина не определена для выбранной технологии или внешнего источника.</p>
  </div>;
}
