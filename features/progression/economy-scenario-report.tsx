"use client";

import { useRef, useState } from "react";
import { Download } from "lucide-react";
import { buildingLabels } from "./graph";
import { progressionScenarioReport, scenarioCsvRows, scenarioGoalNames, scenarioHighlights, scenarioReportState, scenarioResidentNames, scenarioSchedule, type ProgressionScenarioReport } from "./economy-scenarios";
import { downloadEconomyFile, economyCsv, economyNumber } from "./economy-workbench-common";
import styles from "./economy-scenario-report.module.css";

const days = (value: number | null) => value === null ? "—" : `${economyNumber(value)} дн.`;

export function EconomyScenarioReport({ report = progressionScenarioReport }: { report?: ProgressionScenarioReport }) {
  const [funding, setFunding] = useState("all"), [goal, setGoal] = useState("all"), [selectedId, setSelectedId] = useState("");
  const [exportError, setExportError] = useState("");
  const detailRef = useRef<HTMLElement>(null);
  const state = scenarioReportState(report), available = state === "validated" || state === "review";
  const rows = available ? report.scenarios.filter(row => (goal === "all" || row.goal === goal)
    && (funding === "all" || (funding === "free" ? row.externalPearls === 0 : row.externalPearls > 0))) : [];
  const selected = rows.find(row => row.id === selectedId) ?? rows[0];
  function exportReport(format: "csv" | "json") {
    try {
      downloadEconomyFile(format === "csv" ? economyCsv(scenarioCsvRows(report)) : JSON.stringify(report, null, 2), format, `economy-v${report.economyVersion}-playthroughs`);
      setExportError("");
    } catch { setExportError("Не удалось сохранить отчёт. Попробуйте ещё раз."); }
  }
  return <section className={styles.report} aria-label="Сроки прохождения" data-scenario-state={state}>
    <header className={styles.heading}><div><h3>Сколько занимает развитие</h3><p>Результаты прохождений с настоящими игровыми командами. Сравнивайте одинаковые цели и режимы игры.</p></div></header>
    <dl className={styles.goals}>
      <div><dt>Дом 5</dt><dd>Получение последнего уровня дома — текущий финал основной главы.</dd></div>
      <div><dt>Полное хозяйство</dt><dd>Максимумы всех построек, включая кладовую 10. Рецепты отмечены отдельно.</dd></div>
      <div><dt>Репутация</dt><dd>Постоянный ранг у каждого жителя. Действующие бонусы также зависят от недавней помощи.</dd></div>
    </dl>
    {!available ? <p className={styles.warning} role="status">{state === "stale" ? "Каталог изменился после расчёта. Прежние сроки скрыты до повторного прогона." : "Итоговые прогоны ещё не опубликованы. Промежуточные расчёты не используются как прогноз."}</p> : <>
      {state === "review" && <p className={styles.warning} role="status">Прогоны завершены; общая проверка выпуска ещё не подтверждена.</p>}
      <dl className={styles.highlights}>{scenarioHighlights(report).map(item => <div key={item.title}><dt>{item.title}</dt><dd>{economyNumber(item.minimum)}{item.maximum !== item.minimum && `–${economyNumber(item.maximum)}`} <span>дн.</span></dd><small>Прогонов: {item.count} · без внешнего жемчуга</small></div>)}</dl>
      <p className={styles.note}>Все три цели — максимальные постройки, все действующие рецепты и постоянные ранги пяти жителей. Покупка всех производственных и торговых мест — отдельная цель. Диапазон показывает только перечисленные прогоны.</p>
      <div className={styles.controls}>
        <label>Цель прогона<select aria-label="Цель в сценариях" value={goal} onChange={event => setGoal(event.target.value)}><option value="all">Все цели</option>{[...new Set(report.scenarios.map(row => row.goal))].map(id => <option key={id} value={id}>{scenarioGoalNames[id] ?? id}</option>)}</select></label>
        <label>Бюджет мест<select aria-label="Бюджет в сценариях" value={funding} onChange={event => setFunding(event.target.value)}><option value="all">Все сценарии</option><option value="free">Без внешнего жемчуга</option><option value="external">С внешним бюджетом</option></select></label>
        <div className={styles.actions}><button type="button" onClick={() => exportReport("csv")}><Download size={15} aria-hidden="true" />CSV прогонов</button><button type="button" onClick={() => exportReport("json")}><Download size={15} aria-hidden="true" />JSON прогонов</button></div>
      </div>
      {exportError && <p className={styles.warning} role="alert">{exportError}</p>}
      <p className={styles.note}>Дни — прошедшее календарное время от старта. «—» означает, что цель не достигнута к концу данного прогона; это не оценка невозможности её достичь. Seed задаёт повторяемый вариант случайных находок.</p>
      <div className={styles.tableViewport} tabIndex={0} role="region" aria-label="Сравнение прохождений, горизонтальная прокрутка"><table>
        <caption>Каталог v{report.economyVersion} · семейство стратегий {report.policyVersion} · {rows.length} прогонов</caption>
        <thead><tr><th scope="col">Режим и цель</th><th scope="col">Дом 5</th><th scope="col">Производства</th><th scope="col">Все постройки</th><th scope="col">Все рецепты</th><th scope="col">Ранги</th><th scope="col">Все места</th><th scope="col">Время в игре</th></tr></thead>
        <tbody>{rows.map(row => <tr key={row.id} data-scenario={row.id}>
          <th scope="row"><button type="button" onClick={() => { setSelectedId(row.id); detailRef.current?.scrollIntoView({ block: "start" }); detailRef.current?.focus({ preventScroll: true }); }} aria-label={`Подробности: ${row.id}`}>{scenarioSchedule(row)}</button><small>{scenarioGoalNames[row.goal] ?? row.goal} · seed {row.seed}</small><small>{row.id}</small><small>{row.externalPearls ? `+${economyNumber(row.externalPearls)} жемчужин извне` : "Без внешнего жемчуга"} · {row.manualSeconds} с/действие</small><small>{row.goal === "observation" ? "Наблюдение" : row.completed ? "Цель достигнута" : "Цель не достигнута"} · наблюдение {days(row.elapsedDays)}</small></th>
          <td>{days(row.home5Days)}</td><td>{days(row.allProductionDays)}</td><td>{days(row.allBuildingsDays)}</td><td>{days(row.allRecipesDays)}</td><td>{days(row.reputationMaxDays)}</td><td>{days(row.allCapacityDays)}</td>
          <td>{economyNumber(row.activeHours)} ч<small>из них действия {economyNumber(row.manualHours)} ч</small></td>
        </tr>)}</tbody>
      </table></div>
      {!rows.length && <p className={styles.note}>Нет прогонов с выбранной целью и бюджетом.</p>}
      {selected && <section ref={detailRef} tabIndex={-1} className={styles.detail} aria-label="Подробности прохождения">
        <label className={styles.scenarioSelect}>Подробности прогона<select aria-label="Выбрать прогон" value={selected.id} onChange={event => setSelectedId(event.target.value)}>{rows.map(row => <option key={row.id} value={row.id}>{scenarioSchedule(row)} · {scenarioGoalNames[row.goal] ?? row.goal} · seed {row.seed} · {row.externalPearls ? "внешний бюджет" : "бесплатно"} · {row.manualSeconds} с</option>)}</select></label>
        <dl className={styles.metrics}><div><dt>Первый заход</dt><dd>{selected.firstMinutes} мин</dd></div><div><dt>Ручные команды</dt><dd>{economyNumber(selected.commandCount)}</dd></div><div><dt>Осталось жемчуга</dt><dd>{economyNumber(selected.pearlsRemaining)}</dd></div><div><dt>Осталось монет</dt><dd>{economyNumber(selected.coinsRemaining)}</dd></div></dl>
        <p className={styles.note}>Время в игре включает ожидание производства внутри заходов. Время действий — число команд × {selected.manualSeconds} секунды; скорость кликов является допущением, а не измерением поведения людей.</p>
        <p className={styles.note}>{selected.slotPolicy === "second-only" ? "Покупаются только вторые места." : selected.slotPolicy === "none" ? "Места не покупаются." : "Места покупаются по мере доступности и накопления жемчуга."} {selected.speedupPolicy === "earned" ? "Стройка ускоряется за доступный жемчуг." : "Ускорение строек за жемчуг выключено."} {selected.useMeals ? "Используется доступная еда." : "Без бонусов еды."} {selected.buySupplies ? "Открытые припасы можно покупать в лавках." : "Без закупки припасов."} {selected.opportunisticRoutes ? "Походы используются для нужных материалов." : "Без дополнительных материальных походов."} {selected.socialMode === "reputation" ? "Приоритет — ранги жителей и поддержание действующих бонусов." : selected.socialMode === "balanced" ? "Просьбы выполняются вместе с развитием хозяйства." : "Обычные просьбы используются для заработка."}</p>
        <p className={styles.note}>{selected.relicPolicy === "earned" ? "Недостающие редкости для текущей стройки покупаются за заработанный жемчуг из доступной личной поставки." : "Редкости за жемчуг не покупаются."} {selected.goal === "all-capacity" ? "После производственных мест покупаются все торговые места; недельные поручения продолжают приносить жемчуг после максимальных рангов." : "Достижение целей этого прогона не требует покупки всех мест."}</p>
        <p className={styles.note}>{selected.neighborPolicy === "auto" ? `Берест купил ${selected.neighborSales} партий: выручка после комиссии ${economyNumber(selected.neighborProceeds)} монет. Товары произведены в этом прохождении; соблюдены ожидание и дневной бюджет. Конкуренция других игроков за общий бюджет не моделируется.` : "Автоматический выкуп Берестом в этом сценарии не используется."}</p>
        <h4>Места в конце прохождения</h4><dl className={styles.snapshot}>{Object.entries(selected.productionSlots).map(([id, count]) => <div key={id}><dt>{buildingLabels[id] ?? id}</dt><dd>{count}</dd></div>)}<div><dt>Торговые места</dt><dd>{selected.marketSlots}</dd></div></dl>
        {selected.calendarSnapshots.length > 0 && <><h4>Бюджет по календарным дням</h4><div className={styles.tableViewport} tabIndex={0} role="region" aria-label="Бюджет развития"><table><thead><tr><th scope="col">День</th><th scope="col">Монет получено</th><th scope="col">Монет потрачено</th><th scope="col">Монет осталось</th><th scope="col">Жемчуга получено</th><th scope="col">Жемчуга потрачено</th><th scope="col">Жемчуга осталось</th></tr></thead><tbody>{selected.calendarSnapshots.map(snapshot => <tr key={snapshot.day}><th scope="row">{snapshot.day}</th><td>{economyNumber(snapshot.coinIncome)}</td><td>{economyNumber(snapshot.coinSpending)}</td><td>{economyNumber(snapshot.coins)}</td><td>{economyNumber(snapshot.pearlIncome)}</td><td>{economyNumber(snapshot.pearlSpending)}</td><td>{economyNumber(snapshot.pearls)}</td></tr>)}</tbody></table></div><p className={styles.note}>Накопленные поступления и расходы к концу 1, 7, 14 и 30 суток. Стартовый баланс входит в остаток; прогоны, завершившиеся раньше, не продолжаются ради таблицы.</p></>}
        <h4>Состояние хозяйства в конце</h4><dl className={styles.snapshot}>{Object.entries(selected.buildings).map(([id, level]) => <div key={id}><dt>{buildingLabels[id] ?? id}</dt><dd>{level}</dd></div>)}</dl>
        {selected.social && <><h4>Репутация в этом прохождении</h4><dl className={styles.snapshot}>{Object.entries(selected.social.reputation).map(([id, xp]) => <div key={id}><dt>{scenarioResidentNames[id] ?? id}</dt><dd>{economyNumber(xp)} / {economyNumber(selected.social!.maximumXp)}<small>бонус {economyNumber(selected.social!.bonusPercent[id] ?? 0)}% · тепло отношений {economyNumber(selected.social!.activityPercent[id] ?? 0)}%</small></dd></div>)}</dl><p className={styles.note}>Выполнено обычных просьб: {selected.social.ordinaryOrdersCompleted}. Завершено недельных договоров: {selected.social.completedWeekly}. Просрочено: {selected.social.expiredWeeklyCount}. {selected.social.funded ? "Материалы получены в игре и списаны настоящими командами." : "Этот прогон не подтверждает самостоятельное получение материалов."}</p></>}
      </section>}
      <details className={styles.assumptions}><summary>Как читать результаты и воспроизвести расчёт</summary><div>
        <p>Это воспроизводимые стратегии с указанными приоритетами, а не гарантия срока для каждого человека и не доказательство самого быстрого прохождения. Рынок с другими игроками, ручная помощь администратора и социальные награды могут изменить результат.</p>
        <p>Режим «с внешним бюджетом» отдельно добавляет указанный жемчуг, затем тратит его обычными командами с действующими ограничениями. Использование ускорений указано в подробностях прогона. Это проверка чувствительности, а не бесплатный подарок или включённая оплата.</p>
        <p>Разные seed показывают отдельные варианты случайности, а не доверительный интервал. Неполные прогоны не заменяются расчётом по средней находке.</p>
        <p>Полные журналы: <code>{report.evidencePath}</code>. Повтор: <code>node scripts/audit-progression-scenarios.mjs</code>; проверка публикации: <code>node scripts/build-progression-report.mjs --check</code>.</p>
        <p>CSV и JSON содержат все опубликованные прогоны независимо от фильтра. Пустая ячейка CSV и null в JSON означают недостигнутую цель.</p>
      </div></details>
    </>}
  </section>;
}
