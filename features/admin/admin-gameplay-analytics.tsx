"use client";

import type { AdminAnalytics } from "./admin-analytics-api";
import type { AdminEconomyTarget } from "./admin-economy-panel";
import { economyTime } from "./admin-economy-panel";
import { analyticsAmount, analyticsCount, analyticsDuration, analyticsResource, analyticsTarget, downloadAnalyticsCsv } from "./admin-analytics-utils";
import styles from "./admin-analytics.module.css";

type Events = (options: { kind?: string; resource?: string; direction?: "all" | "in" | "out" }) => void;
export function AdminGameplayAnalytics({ data, onEvents }: { data: AdminAnalytics; onEvents: Events }) {
  const g = data.gameplay;
  return <section className={styles.panel}>
    <div className={styles.heading}><h3>Еда и заказы жителей</h3><p>Фактические списания и награды за выбранный период. Условия старых заказов не пересчитываются по нынешнему каталогу.</p></div>
    <div className={styles.metrics}>
      <div className={styles.metric}><span>Съедено порций</span><strong>{analyticsCount(g.mealsConsumed)}</strong><small>{analyticsCount(g.foodPlayers)} игроков использовали еду</small></div>
      <div className={styles.metric}><span>Сдано заказов</span><strong>{analyticsCount(g.ordersCompleted)}</strong><small>{analyticsCount(g.orderPlayers)} игроков · {analyticsAmount("coins", g.orderCoinsEarned)} монет выдано</small></div>
      <div className={styles.metric}><span>Бесплатные замены</span><strong>{analyticsCount(g.orderReplacements - g.paidOrderReplacements)}</strong><small>Принятые замены без списания жемчуга</small></div>
      <div className={styles.metric}><span>Платные замены</span><strong>{analyticsCount(g.paidOrderReplacements)}</strong><small>{analyticsAmount("pearls", g.orderPearlsSpent)} жемчуга списано</small></div>
    </div>
    <div className={styles.twoColumns}>
      <div><h4>Кого кормят и чем</h4><p className={styles.note}>Порции расходуются при кормлении. Эффект может сохраняться до следующего задания; это не число ускоренных заданий.</p>
        {!data.meals.length ? <p className={styles.empty}>Еду за этот период не использовали.</p> : <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Расход еды"><table>
          <thead><tr><th>Блюдо</th><th>Мохлик</th><th>Строитель</th><th>Игроки</th></tr></thead><tbody>{data.meals.map(row => <tr key={row.itemId}>
            <th scope="row"><button type="button" className={styles.textButton} onClick={() => onEvents({ resource: row.itemId, direction: "out" })}>{analyticsResource(row.itemId)}</button></th>
            <td>{analyticsCount(row.heroPortions)}</td><td>{analyticsCount(row.builderPortions)}</td><td>{analyticsCount(row.players)}</td>
          </tr>)}</tbody></table></div>}
        <div className={styles.filterFooter}><button type="button" className={styles.button} onClick={() => onEvents({ kind: "eat_food" })}>Кормление Мохлика</button><button type="button" className={styles.button} onClick={() => onEvents({ kind: "feed_builder" })}>Кормление строителя</button></div>
      </div>
      <div><h4>Какие заказы выполняют и заменяют</h4><p className={styles.note}>Замена относится к убранной карточке. Автоматическое обновление доски и отклонённые запросы не считаются заменами. Игроки могут встречаться в нескольких строках.</p>
        {!data.orders.length ? <p className={styles.empty}>Сдач и замен заказов за этот период нет.</p> : <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Выполнение заказов"><table>
          <thead><tr><th>Заказ</th><th>Сдано</th><th>Заменено</th><th>Из них платно</th><th>Выдано монет</th><th>Списано жемчуга</th><th>Игроки</th></tr></thead><tbody>{data.orders.map((row, index) => <tr key={row.templateId ?? `unknown-${index}`}>
            <th scope="row">{analyticsTarget(row.templateId)}</th><td>{analyticsCount(row.completed)}</td><td>{analyticsCount(row.replacements)}</td><td>{analyticsCount(row.paidReplacements)}</td>
            <td>{analyticsAmount("coins", row.coinsEarned)}</td><td>{analyticsAmount("pearls", row.pearlsSpent)}</td><td>{analyticsCount(row.players)}</td>
          </tr>)}</tbody></table></div>}
        {data.coverage.ordersTruncated && <p className={styles.warning}>Показаны первые 1 000 видов заказов. Сузьте период или выберите игрока; общие показатели полные.</p>}
        <div className={styles.filterFooter}><button type="button" className={styles.button} onClick={() => onEvents({ kind: "complete_resident_order" })}>Сданные заказы</button><button type="button" className={styles.button} onClick={() => onEvents({ kind: "replace_resident_order" })}>Замены заказов</button></div>
      </div>
    </div>
  </section>;
}

export function AdminPresenceAnalytics({ data, onOpen }: { data: AdminAnalytics; onOpen?: (target: AdminEconomyTarget) => void }) {
  const p = data.presence;
  return <section className={styles.panel}>
    <div className={styles.sectionRow}><div className={styles.heading}><h3>Присутствие и наблюдение</h3><p>Время подтверждает сервер. Вкладки одного игрока не удваивают его; паузы с разрывом связи более 90 секунд и завершённая AFK-сессия не добавляют время.</p></div>
      <button type="button" className={styles.button} onClick={() => downloadAnalyticsCsv(`presence-${data.from}-${data.to}.csv`, [
        ["Дата UTC", "Игроки", "Подтверждённые секунды", "Игроки свыше 20 часов"], ...p.daily.map(row => [row.date, row.players, !p.coverageFrom || row.date < p.coverageFrom.slice(0, 10) ? null : row.onlineSeconds, row.flaggedPlayers])])}>CSV присутствия</button></div>
    <p className={styles.note}>Первый день с сохранившимся измерением: {p.coverageFrom ? economyTime(p.coverageFrom) : "измерений пока нет"}. Для выбранной аудитории более ранних измерений нет; прошлое время не восстанавливается. Это время подтверждённого присутствия в игре, а не доказательство непрерывных действий человека.</p>
    <div className={styles.resourceMetrics}>
      <div><span>Игроки с измерениями</span><strong>{analyticsCount(p.players)}</strong></div>
      <div><span>Общее время игроков</span><strong>{analyticsDuration(p.onlineSeconds)}</strong></div>
      <div><span>Игроки с днями &gt;20 ч</span><strong>{analyticsCount(p.flaggedPlayers)}</strong></div>
    </div>
    <details className={styles.details}><summary>Присутствие по дням UTC</summary><div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Подтверждённое присутствие по дням"><table>
      <thead><tr><th>Дата UTC</th><th>Игроки</th><th>Общее время</th><th>Игроки &gt;20 ч</th></tr></thead><tbody>{p.daily.map(row => <tr key={row.date}>
        <th scope="row">{row.date}</th><td>{analyticsCount(row.players)}</td><td>{!p.coverageFrom || row.date < p.coverageFrom.slice(0, 10) ? "Нет измерений" : analyticsDuration(row.onlineSeconds)}</td><td>{analyticsCount(row.flaggedPlayers)}</td>
      </tr>)}</tbody></table></div></details>
    <h4>Дни с присутствием свыше 20 часов</h4><p className={styles.note}>Такой день автоматически включает наблюдение с причиной, без блокировки. Исторический сигнал сохраняется после ручного снятия наблюдения. Статус наблюдения в таблице — текущий.</p>
    {!p.reviewDays.length ? <p className={styles.empty}>За выбранный период сигналов длительного присутствия нет.</p> : <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Сигналы длительного присутствия"><table>
      <thead><tr><th>Игрок</th><th>Дата UTC</th><th>Время за сутки</th><th>Статус сейчас</th><th>Сигнал получен, UTC</th></tr></thead><tbody>{p.reviewDays.map(row => <tr key={`${row.publicId}:${row.date}`}>
        <th scope="row">{onOpen ? <button type="button" className={styles.textButton} onClick={() => onOpen(row)}>{row.displayName}</button> : row.displayName}<small>{row.publicId}</small></th>
        <td>{row.date}</td><td>{analyticsDuration(row.onlineSeconds)}</td><td>{row.watchlisted ? "Под наблюдением" : "Наблюдение снято"}</td><td>{economyTime(row.flaggedAt)}</td>
      </tr>)}</tbody></table></div>}
    {p.reviewDaysTruncated && <p className={styles.warning}>Показаны 100 последних дней с сигналом. Сузьте период или найдите игрока по ID, чтобы проверить остальные.</p>}
  </section>;
}
