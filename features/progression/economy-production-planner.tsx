"use client";

import { useMemo, useState } from "react";
import { Download, Plus, Trash2 } from "lucide-react";
import { economyCatalog } from "@/features/economy/domain/model";
import { buildEconomyAnalysis } from "./economy-analysis";
import { buildingsAtHomeLevel, planEconomyProduction } from "./economy-plan";
import { EconomyItemButton, downloadEconomyFile, economyCsv, economyDuration, economyNumber, stationName } from "./economy-workbench-common";
import styles from "./economy-workbench.module.css";

type Analysis = ReturnType<typeof buildEconomyAnalysis>;
type Counts = Record<string, number>;
const clampQuantity = (value: string) => Math.min(999, Math.max(1, Math.trunc(Number(value)) || 1));

function QuantityEditor({ title, label, items, value, onChange, maximum = 20 }: {
  title: string; label: string; items: Analysis["items"]; value: Counts; onChange: (value: Counts) => void; maximum?: number;
}) {
  const [nextId, setNextId] = useState(items[0]?.id ?? "");
  const names = new Map(items.map(item => [item.id, item.name]));
  const entries = Object.entries(value);
  return <div className={styles.quantityEditor}>
    <h4>{title}</h4>
    <div className={styles.addRow}><select aria-label={`Добавить ${label}`} value={nextId} onChange={event => setNextId(event.target.value)}>{items.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
      <button type="button" aria-label={`Добавить ${label} в список`} disabled={!nextId || (entries.length >= maximum && !value[nextId])} onClick={() => onChange({ ...value, [nextId]: Math.min(999, (value[nextId] ?? 0) + 1) })}><Plus size={17} /></button></div>
    {entries.length ? <ul className={styles.quantityList}>{entries.map(([id, quantity]) => <li key={id}>
      <span>{names.get(id) ?? id}</span><input type="number" inputMode="numeric" min={1} max={999} aria-label={`${label}: ${names.get(id) ?? id}`} value={quantity} onChange={event => onChange({ ...value, [id]: clampQuantity(event.target.value) })} />
      <button type="button" aria-label={`Удалить ${label}: ${names.get(id) ?? id}`} onClick={() => onChange(Object.fromEntries(entries.filter(([key]) => key !== id)))}><Trash2 size={15} /></button>
    </li>)}</ul> : <p className={styles.note}>Список пуст.</p>}
  </div>;
}

export function EconomyProductionPlanner({ analysis, targets, onTargets, onSelect }: {
  analysis: Analysis; targets: Counts; onTargets: (targets: Counts) => void; onSelect: (id: string) => void;
}) {
  const [inventory, setInventory] = useState<Counts>({}), [home, setHome] = useState(0), [slots, setSlots] = useState(1);
  const [sources, setSources] = useState<Record<string, string>>({}), [shown, setShown] = useState(40), [exportError, setExportError] = useState("");
  const options = useMemo(() => ({ targets, inventory,
    ...(home ? { buildings: buildingsAtHomeLevel(home) } : {}),
    slots: Object.fromEntries(["garden", "woodlot", "workshop", "kiln", "dryer"].map(id => [id, slots])), sourceByItem: sources }), [targets, inventory, home, slots, sources]);
  const result = useMemo(() => {
    try { return { plan: planEconomyProduction(options), error: "" }; }
    catch (error) { return { plan: null, error: error instanceof Error ? error.message : "Не удалось рассчитать план." }; }
  }, [options]);
  const plan = result.plan, names = new Map(analysis.items.map(item => [item.id, item.name]));
  const relevant = new Set([...Object.keys(targets), ...Object.keys(plan?.rawInputs ?? {}), ...(plan?.operations ?? []).flatMap(operation => Object.keys(operation.outputs))]);
  const alternatives = analysis.items.filter(item => relevant.has(item.id) && item.sourceIds.length > 1);
  const targetCount = Object.values(targets).reduce((total, count) => total + count, 0);
  function exportPlan(format: "csv" | "json") {
    if (!plan) return;
    try {
      const metadata = { schemaVersion: 1, catalogVersion: economyCatalog.version, generatedAt: new Date().toISOString(), assumptions: options, plan };
      const content = format === "json" ? JSON.stringify(metadata, null, 2) : economyCsv([
        ["catalog_version", "complete", "operation_id", "source_id", "operation", "station", "slot", "own_seconds", "collection_seconds", "start_seconds", "end_seconds", "inputs_json", "outputs_json", "dependencies_json"],
        ...plan.operations.map(operation => [economyCatalog.version, String(plan.complete), operation.id, operation.sourceId, operation.name, operation.stationId, operation.slot,
          operation.seconds, operation.collectionSeconds, operation.startSeconds, operation.endSeconds, JSON.stringify(operation.inputs), JSON.stringify(operation.outputs), JSON.stringify(operation.dependencies)]),
      ]);
      downloadEconomyFile(content, format, `economy-v${economyCatalog.version}-production-plan`); setExportError("");
    } catch { setExportError("Не удалось сохранить план. Попробуйте ещё раз."); }
  }
  return <div className={styles.planner}>
    <div className={styles.plannerInputs}>
      <QuantityEditor title="Что хотим получить" label="цель" items={analysis.items} value={targets} onChange={onTargets} />
      <QuantityEditor title="Что уже есть на складе" label="запас" items={analysis.items} value={inventory} onChange={setInventory} maximum={100} />
    </div>
    <div className={styles.planSettings}>
      <label>Доступные здания<select aria-label="Хозяйство для плана" value={home} onChange={event => setHome(Number(event.target.value))}><option value={0}>Все технологии открыты</option>{[1, 2, 3, 4, 5].map(level => <option key={level} value={level}>Максимальные здания при доме {level}</option>)}</select></label>
      <label>Мест в каждом производстве<select aria-label="Места производства для плана" value={slots} onChange={event => setSlots(Number(event.target.value))}>{[1, 2, 3].map(count => <option key={count} value={count}>{count}</option>)}</select></label>
      <p>У Мохлика и шахтёра по одному месту. Выбор дома моделирует завершённые доступные здания; открытия через освоение рецептов отдельно не предполагаются.</p>
    </div>
    {alternatives.length > 0 && <details className={styles.disclosure}><summary>Выбрать способы получения · {alternatives.length}</summary><div className={styles.alternatives}>{alternatives.map(item => <label key={item.id}>{item.name}<select aria-label={`Источник для ${item.name}`} value={sources[item.id] ?? ""} onChange={event => {
      const next = { ...sources }; if (event.target.value) next[item.id] = event.target.value; else delete next[item.id]; setSources(next);
    }}><option value="">Базовый доступный способ</option>{item.sourceIds.map(id => analysis.sources.find(source => source.id === id)).filter(source => !!source).map(source => <option key={source.id} value={source.id}>{source.name} · {economyDuration(source.seconds)} · дом {source.homeLevel}</option>)}</select></label>)}</div></details>}
    {result.error && <p className={styles.error} role="alert">{result.error}</p>}
    {plan && <>
      <div className={styles.planHeading}><div><span className={styles.eyebrow}>Общий план · {Object.keys(targets).length} видов · {targetCount} предметов</span><h3>{plan.complete ? "Последовательность рассчитана" : "Нужны дополнительные источники"}</h3></div><div className={styles.actions}><button type="button" onClick={() => exportPlan("csv")}><Download size={15} />CSV операций</button><button type="button" onClick={() => exportPlan("json")}><Download size={15} />JSON плана</button></div></div>
      {exportError && <p role="alert" className={styles.error}>{exportError}</p>}
      <dl className={styles.metrics} data-production-plan>
        <div><dt>Суммарная работа</dt><dd data-plan-work>{economyDuration(plan.workSeconds)}</dd></div>
        <div><dt>Готовность при перезапусках</dt><dd data-plan-elapsed>{economyDuration(plan.elapsedSeconds)}</dd></div>
        <div><dt>Запусков производства</dt><dd data-plan-launches>{economyNumber(plan.launches)}</dd></div>
        <div><dt>Прямые расходы монет</dt><dd>{economyNumber(plan.coins)}</dd></div>
      </dl>
      <p className={styles.note}>Модель предполагает немедленный сбор и запуск следующей работы. Не учитывает время ходьбы, текущие задания и вместимость склада. Это допустимый план очередей, а не прогноз прохождения или доказанный самый быстрый путь.</p>
      {plan.warnings.length > 0 && <ul className={styles.warnings} aria-label="Ограничения плана">{plan.warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>}
      {Object.keys(plan.missingItems).length > 0 && <div className={styles.missing}><h4>Нужно получить другим способом</h4><div className={styles.chips}>{Object.entries(plan.missingItems).map(([id, count]) => <EconomyItemButton key={id} id={id} name={names.get(id) ?? id} quantity={count} onSelect={onSelect} />)}</div><p>Покупки, случайный улов и подарки не включаются в срок автоматически. Добавьте уже полученные предметы в запас для полного расчёта.</p></div>}
      <div className={styles.planColumns}>
        <section><h4>Загрузка производств</h4><ul className={styles.queueList}>{plan.queues.map(queue => <li key={queue.stationId}><div><strong>{stationName(queue.stationId)}</strong><span>{queue.launches} запусков · мест {queue.slots}</span></div><b>{economyDuration(queue.workSeconds)}</b></li>)}</ul>{!plan.queues.length && <p className={styles.note}>Производство не требуется.</p>}</section>
        <section><h4>Расход из имеющихся запасов</h4><div className={styles.chips}>{Object.entries(plan.inventoryUsed).map(([id, count]) => <EconomyItemButton key={id} id={id} name={names.get(id) ?? id} quantity={count} onSelect={onSelect} />)}</div>{!Object.keys(plan.inventoryUsed).length && <p className={styles.note}>Исходные запасы не расходуются.</p>}
          {Object.keys(plan.leftovers).length > 0 && <><h4>Останется после выполнения целей</h4><div className={styles.chips}>{Object.entries(plan.leftovers).map(([id, count]) => <EconomyItemButton key={id} id={id} name={names.get(id) ?? id} quantity={count} onSelect={onSelect} />)}</div></>}
        </section>
      </div>
      {plan.operations.length > 0 && <details className={styles.disclosure}><summary>Все операции и зависимости · {plan.operations.length}</summary><ol className={styles.operationList}>{plan.operations.slice(0, shown).map(operation => <li key={operation.id} data-plan-operation={operation.id}><div><strong>{operation.name}</strong><span>{stationName(operation.stationId)}{operation.slot ? ` · место ${operation.slot}` : ""}</span></div><div><b>{operation.blocked ? "Нужен ингредиент" : `${economyDuration(operation.startSeconds)} → ${economyDuration(operation.endSeconds)}`}</b><span>{Object.entries(operation.outputs).map(([id, count]) => `${names.get(id) ?? id} × ${count}`).join(", ")}</span></div></li>)}</ol>{shown < plan.operations.length && <button type="button" className={styles.more} onClick={() => setShown(value => value + 80)}>Ещё операции ({plan.operations.length - shown})</button>}</details>}
    </>}
  </div>;
}
