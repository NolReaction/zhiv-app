"use client";

import { lazy, Suspense, useId, type KeyboardEvent } from "react";
import { CalendarDays, Compass, GitBranch, ListChecks, Table2 } from "lucide-react";

import { analysis } from "./analysis-model";
import { economyNumber } from "./economy-workbench-common";
import styles from "./economy-workbench.module.css";

import { useBranchState } from "@/features/progression/ui/shell/branch-session";
const EconomyProductionGraph = lazy(() => import("./economy-production-graph").then(module => ({ default: module.EconomyProductionGraph })));
const EconomyBalanceTable = lazy(() => import("./economy-balance-table").then(module => ({ default: module.EconomyBalanceTable })));
const EconomyExpeditionAnalysis = lazy(() => import("./economy-expedition-analysis").then(module => ({ default: module.EconomyExpeditionAnalysis })));
const EconomyProductionPlanner = lazy(() => import("./economy-production-planner").then(module => ({ default: module.EconomyProductionPlanner })));
const ScenarioReportLoader = lazy(() => import("./scenario-report-loader").then(module => ({ default: module.ScenarioReportLoader })));
const tabs = [{ id: "chains", name: "Цепочки", icon: GitBranch }, { id: "balance", name: "Баланс", icon: Table2 }, { id: "plan", name: "План", icon: ListChecks }, { id: "expeditions", name: "Вылазки", icon: Compass }, { id: "scenarios", name: "Прохождение", icon: CalendarDays }] as const;
type Tab = typeof tabs[number]["id"];
export function EconomyWorkbench({ onInspectItem }: { onInspectItem: (id: string) => void }) {
  const id = useId(), [tab, setTab] = useBranchState<Tab>("analysis.tab", "chains"), [selectedId, setSelectedId] = useBranchState("analysis.item", "berries");
  const [targets, setTargets] = useBranchState<Record<string, number>>("analysis.targets", { dried_berries: 1 });
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
    <div className={styles.heading}><div><span className={styles.eyebrow}>Рабочий стол экономики</span><h2>Цепочки производства</h2><p>Стоимость минуты, связи товаров и общий план с учётом запасов.</p></div>{analysis.coinsPerMinute !== null && <div className={styles.rate}><strong>{economyNumber(analysis.coinsPerMinute)}</strong><span>монет за базовую<br />минуту работы</span></div>}</div>
    <div className={styles.workbenchNav}><nav className={styles.tabs} role="tablist" aria-label="Инструмент анализа" onKeyDown={tabsKeyboard}>{tabs.map(({ id: key, name, icon: Icon }) => <button type="button" key={key} role="tab" id={`${id}-${key}-tab`} aria-controls={`${id}-${key}-panel`} aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} data-economy-tab={key} onClick={() => setTab(key)}><Icon size={17} aria-hidden="true" />{name}</button>)}</nav>
      {tab === "chains" && <label className={styles.productSelect}>Товар<select aria-label="Товар на производственной схеме" value={selectedId} onChange={event => setSelectedId(event.target.value)}>{analysis.items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}
    </div>
    <div id={`${id}-${tab}-panel`} role="tabpanel" aria-labelledby={`${id}-${tab}-tab`} tabIndex={0}>
      <Suspense fallback={<p role="status" className={styles.note}>Открываем инструмент…</p>}>
        {tab === "chains" && <EconomyProductionGraph analysis={analysis} selectedId={selectedId} onSelect={select} onPlan={plan} onInspect={onInspectItem} />}
        {tab === "balance" && <EconomyBalanceTable onSelect={select} />}
        {tab === "expeditions" && <EconomyExpeditionAnalysis onSelect={select} />}
        {tab === "scenarios" && <ScenarioReportLoader />}
        {tab === "plan" && <EconomyProductionPlanner analysis={analysis} targets={targets} onTargets={setTargets} onSelect={select} />}
      </Suspense>
    </div>
  </section>;
}
