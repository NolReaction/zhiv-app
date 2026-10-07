"use client";

import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, BarChart3, ChevronLeft, ChevronRight, CircleAlert, Download, ListFilter, RefreshCw, Search, Users } from "lucide-react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ApiError } from "@/lib/check-in-api";
import { AdminEconomyPanel, economyTime, type AdminEconomyTarget } from "./admin-economy-panel";
import { loadAdminAnalytics, loadAdminAnalyticsEvents, type AdminAnalytics, type AdminAnalyticsEvents,
  type AdminAnalyticsFilters, type AdminAnalyticsEventFilters } from "./admin-analytics-api";
import { analyticsAction, analyticsActions, analyticsAmount, analyticsCategory, analyticsCount, analyticsDate,
  analyticsPeriod, analyticsPeriodError, analyticsResource, analyticsResources, analyticsTarget, downloadAnalyticsCsv } from "./admin-analytics-utils";
import styles from "./admin-analytics.module.css";

type View = "analytics" | "players" | "events";
type EventOptions = Pick<AdminAnalyticsEventFilters, "kind" | "resource" | "direction" | "offset" | "limit" | "at">;
type Draft = AdminAnalyticsFilters & Pick<EventOptions, "kind" | "resource" | "direction">;
export type AdminHistoryRequest = { target: AdminEconomyTarget; version: number };
const initialEvents: EventOptions = { kind: "", resource: "", direction: "all", offset: 0, limit: 25, at: null };
const chartStyle = { background: "#20251f", border: "1px solid #46513e", borderRadius: 12, color: "#f1f4eb", fontSize: 14 };
const csvAmount = (resource: string, amount: number) => resource === "pearls" ? amount / 2 : amount;

function Heading({ title, children }: { title: string; children?: React.ReactNode }) {
  return <div className={styles.heading}><h3>{title}</h3>{children && <p>{children}</p>}</div>;
}
function Metric({ title, value, note }: { title: string; value: number; note: string }) {
  return <div className={styles.metric}><span>{title}</span><strong>{analyticsCount(value)}</strong><small>{note}</small></div>;
}
function ExportButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className={styles.button} onClick={onClick}><Download size={16} aria-hidden="true" />{label}</button>;
}
function Empty({ children }: { children: React.ReactNode }) { return <p className={styles.empty}>{children}</p>; }
function Truncated({ visible }: { visible: boolean }) {
  return visible ? <p className={styles.warning}>Ответ ограничен 1 000 группами. Сузьте период или выберите игрока, чтобы увидеть полную разбивку.</p> : null;
}

export function AdminAnalyticsContent({ data, resource, building, onResource, onBuilding, onEvents }: {
  data: AdminAnalytics; resource: string; building: string; onResource: (id: string) => void;
  onBuilding: (id: string) => void; onEvents: (options: { kind?: string; resource?: string; direction?: "all" | "in" | "out" }) => void;
}) {
  const resources = [...new Set(["coins", "pearls", resource, ...data.resources.map(row => row.resourceId)])];
  const chosen = data.resources.find(row => row.resourceId === resource);
  const flows = data.flows.filter(row => row.resourceId === resource).sort((a, b) => b.spent - a.spent || b.received - a.received);
  const spending = flows.filter(row => row.category !== "escrow" && row.spent > 0);
  const maxSpent = Math.max(1, ...spending.map(row => row.spent));
  const firstTotal = data.firstConstructions.reduce((sum, row) => sum + row.players, 0);
  const buildings = [...new Set(data.buildingLevels.map(row => row.buildingId))];
  const selectedBuilding = buildings.includes(building) ? building : buildings.includes("home") ? "home" : buildings[0] ?? "home";
  const levels = data.buildingLevels.filter(row => row.buildingId === selectedBuilding).sort((a, b) => a.level - b.level);
  const levelTotal = levels.reduce((sum, row) => sum + row.players, 0);
  return <div className={styles.stack}>
    <section className={styles.metrics} aria-label="Показатели выбранного периода">
      <Metric title="Игроки с действиями" value={data.summary.activePlayers} note="Совершили подтверждённое действие в хозяйстве" />
      <Metric title="Операции" value={data.summary.events} note="Включая торговые поступления и резервы" />
      <Metric title="Игроки с расходами" value={data.summary.spendingPlayers} note="Потратили валюту или припасы" />
      <Metric title="Игроки со стройкой" value={data.summary.constructionPlayers} note={`${analyticsCount(data.summary.constructionStarts)} начато · ${analyticsCount(data.summary.constructionClaims)} завершено`} />
    </section>
    <section className={styles.panel}>
      <div className={styles.sectionRow}><Heading title="Действия по дням">Подтверждённые операции хозяйства. Посещения и время в приложении здесь не измеряются.</Heading>
        <ExportButton label="CSV по дням" onClick={() => downloadAnalyticsCsv(`activity-${data.from}-${data.to}.csv`, [
          ["Дата UTC", "Игроки", "Операции", "Начато строек"], ...data.daily.map(row => [row.date, row.players, row.events, row.constructionStarts])])} /></div>
      {data.summary.events === 0 ? <Empty>За этот период подтверждённых операций нет. Попробуйте расширить даты или изменить поиск.</Empty> : <>
        <div className={styles.chart} role="img" aria-label="Динамика игроков, операций и начатых строек по дням; точные значения доступны в таблице ниже.">
          <ResponsiveContainer width="100%" height="100%"><LineChart data={data.daily} accessibilityLayer margin={{ top: 10, right: 12, bottom: 4, left: -15 }}>
            <CartesianGrid stroke="#354032" strokeDasharray="3 5" vertical={false} />
            <XAxis dataKey="date" tickFormatter={analyticsDate} tick={{ fontSize: 12 }} stroke="#b1bdab" minTickGap={36} />
            <YAxis allowDecimals={false} tick={{ fontSize: 12 }} stroke="#b1bdab" />
            <Tooltip contentStyle={chartStyle} labelFormatter={value => `${analyticsDate(String(value))} UTC`} /><Legend />
            <Line dataKey="players" name="Игроки" stroke="#bedc9f" dot={false} strokeWidth={2} isAnimationActive={false} />
            <Line dataKey="events" name="Операции" stroke="#87bdec" dot={false} strokeWidth={2} isAnimationActive={false} />
            <Line dataKey="constructionStarts" name="Начато строек" stroke="#e9bb7e" dot={false} strokeWidth={2} isAnimationActive={false} />
          </LineChart></ResponsiveContainer>
        </div>
        <details className={styles.details}><summary>Точные значения по дням</summary><div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Таблица активности по дням"><table>
          <thead><tr><th>Дата, UTC</th><th>Игроки</th><th>Операции</th><th>Начато строек</th></tr></thead>
          <tbody>{data.daily.map(row => <tr key={row.date}><th scope="row">{row.date}</th><td>{analyticsCount(row.players)}</td><td>{analyticsCount(row.events)}</td><td>{analyticsCount(row.constructionStarts)}</td></tr>)}</tbody>
        </table></div></details>
      </>}
    </section>
    <section className={styles.panel}>
      <div className={styles.sectionRow}><Heading title="Откуда приходят и куда уходят ресурсы">Поступления и расходы за выбранный период. Разные ресурсы не складываются в одну сумму.</Heading>
        <label className={styles.field}>Ресурс<select value={resource} onChange={event => onResource(event.target.value)}>{resources.map(id => <option value={id} key={id}>{analyticsResource(id)}</option>)}</select></label></div>
      <div className={styles.resourceMetrics}>
        <div><span><ArrowDownRight size={16} aria-hidden="true" />Получено</span><strong>{analyticsAmount(resource, chosen?.received ?? 0)}</strong></div>
        <div><span><ArrowUpRight size={16} aria-hidden="true" />Потрачено</span><strong>{analyticsAmount(resource, chosen?.spent ?? 0)}</strong></div>
        <div><span>Чистое изменение</span><strong>{analyticsAmount(resource, chosen?.net ?? 0, true)}</strong></div>
      </div>
      <p className={styles.note}>В резерв передано: <strong>{analyticsAmount(resource, chosen?.reserved ?? 0)}</strong> · из резерва возвращено: <strong>{analyticsAmount(resource, chosen?.returned ?? 0)}</strong>. Резерв рынка и обмена показан отдельно от расходов. Чистое изменение учитывает все четыре потока.</p>
      <div className={styles.sectionRow}><h4>На что тратят · {analyticsResource(resource)}</h4><button type="button" className={styles.button} onClick={() => onEvents({ resource, direction: "out" })}>Открыть списания</button></div>
      {!spending.length ? <Empty>Расходов этого ресурса за период нет.</Empty> : <ol className={styles.bars}>{spending.slice(0, 8).map((row, index) => <li key={`${row.kind}:${row.targetId}:${index}`}>
        <button type="button" onClick={() => onEvents({ kind: row.kind, resource, direction: "out" })}>
          <span>{analyticsAction(row.kind)}{row.targetId && <small>{analyticsTarget(row.targetId)}</small>}</span><strong>{analyticsAmount(resource, row.spent)}</strong>
          <span className={styles.barTrack} aria-hidden="true"><span style={{ width: `${row.spent / maxSpent * 100}%` }} /></span>
        </button>
      </li>)}</ol>}
      <details className={styles.details}><summary>Все потоки выбранного ресурса · {analyticsCount(flows.length)}</summary>
        <div className={styles.sectionRow}><p className={styles.note}>«Игра» и «Торговля» меняют доступный запас, «Резерв / возврат» показывает перемещение в объявления.</p>
          <ExportButton label="CSV потоков" onClick={() => downloadAnalyticsCsv(`flows-${resource}-${data.from}-${data.to}.csv`, [
            ["Ресурс", "Операция", "Объект", "Категория", "Получено", "Списано", "Игроки", "Операции", "С", "По UTC"],
            ...flows.map(row => [analyticsResource(resource), analyticsAction(row.kind), analyticsTarget(row.targetId), analyticsCategory[row.category],
              csvAmount(resource, row.received), csvAmount(resource, row.spent), row.players, row.events, data.from, data.to])])} /></div>
        {!flows.length ? <Empty>Потоков пока нет.</Empty> : <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Все потоки выбранного ресурса"><table><thead><tr><th>Операция</th><th>Категория</th><th>Получено</th><th>Списано</th><th>Игроки</th><th>Операции</th></tr></thead><tbody>
          {flows.map((row, index) => <tr key={`${row.kind}:${row.targetId}:${row.category}:${index}`}><th scope="row"><button type="button" className={styles.textButton} onClick={() => onEvents({ kind: row.kind, resource })}>{analyticsAction(row.kind)}</button>{row.targetId && <small>{analyticsTarget(row.targetId)}</small>}</th><td>{analyticsCategory[row.category]}</td><td>{analyticsAmount(resource, row.received)}</td><td>{analyticsAmount(resource, row.spent)}</td><td>{analyticsCount(row.players)}</td><td>{analyticsCount(row.events)}</td></tr>)}
        </tbody></table></div>}
      </details><Truncated visible={data.coverage.flowsTruncated} />
    </section>
    <div className={styles.twoColumns}>
      <section className={styles.panel}><Heading title="Что строят и улучшают">Начало — оплата заказа. Завершено — игрок получил постройку или сразу завершил её ускорением; заказ мог начаться до выбранного периода.</Heading>
        {!data.construction.length ? <Empty>Строек с известным объектом за период нет.</Empty> : <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Строительство за период"><table><thead><tr><th>Постройка</th><th>Начато</th><th>Завершено</th><th>Игроки</th></tr></thead><tbody>
          {data.construction.map(row => <tr key={row.buildingId}><th scope="row">{analyticsTarget(row.buildingId)}</th><td>{analyticsCount(row.starts)}</td><td>{analyticsCount(row.claims)}</td><td>{analyticsCount(row.players)}</td></tr>)}
        </tbody></table></div>}
        <button type="button" className={styles.button} onClick={() => onEvents({ kind: "start_construction" })}>Журнал начатых строек</button>
      </section>
      <section className={styles.panel}><Heading title="Первое наблюдённое строительство">Первый заказ каждого игрока во всей сохранившейся истории, если он начат в выбранный период. Это не обязательно первое улучшение за жизнь аккаунта.</Heading>
        {!firstTotal ? <Empty>Первых наблюдённых строек за период нет.</Empty> : <><p className={styles.note}>Всего игроков: {analyticsCount(firstTotal)}. Записи без объекта включены в доли.</p><ol className={styles.bars}>{data.firstConstructions.map((row, index) => <li key={row.buildingId ?? `unknown-${index}`}><div className={styles.staticBar}>
          <span>{analyticsTarget(row.buildingId)}</span><strong>{analyticsCount(row.players)} · {Math.round(row.players / firstTotal * 100)}%</strong>
          <span className={styles.barTrack} aria-hidden="true"><span style={{ width: `${row.players / firstTotal * 100}%` }} /></span>
        </div></li>)}</ol></>}
      </section>
    </div>
    <section className={styles.panel}><div className={styles.sectionRow}><Heading title="Текущие уровни построек">Состояние сейчас, независимо от периода. Поиск и выбор аудитории учитываются. Хозяйство заведено у {analyticsCount(data.coverage.initializedPlayers)} из {analyticsCount(data.coverage.matchingPlayers)} выбранных игроков.</Heading>
      {!!buildings.length && <label className={styles.field}>Постройка<select value={selectedBuilding} onChange={event => onBuilding(event.target.value)}>{buildings.map(id => <option key={id} value={id}>{analyticsTarget(id)}</option>)}</select></label>}</div>
      {!levels.length ? <Empty>Сохранённых хозяйств с данными о постройках нет.</Empty> : <ul className={styles.levels}>{levels.map(row => <li key={row.level}><span>{row.level ? `Уровень ${row.level}` : "Не построено"}</span><strong>{analyticsCount(row.players)}</strong><small>{levelTotal ? Math.round(row.players / levelTotal * 100) : 0}% игроков</small></li>)}</ul>}
    </section>
    <section className={styles.panel}><div className={styles.sectionRow}><Heading title="Популярные действия">Частота подтверждённых операций. Один игрок может встречаться в нескольких строках.</Heading><ExportButton label="CSV действий" onClick={() => downloadAnalyticsCsv(`actions-${data.from}-${data.to}.csv`, [
      ["Операция", "Объект", "Операции", "Игроки", "С", "По UTC"], ...data.actions.map(row => [analyticsAction(row.kind), analyticsTarget(row.targetId), row.events, row.players, data.from, data.to])])} /></div>
      {!data.actions.length ? <Empty>Действий пока нет.</Empty> : <><ActionTable rows={data.actions.slice(0, 12)} onEvents={onEvents} />{data.actions.length > 12 && <details className={styles.details}><summary>Остальные действия · {analyticsCount(data.actions.length - 12)}</summary><ActionTable rows={data.actions.slice(12)} onEvents={onEvents} /></details>}</>}
      <Truncated visible={data.coverage.actionsTruncated} />
    </section>
    <aside className={styles.coverage}><strong>Как читать эти данные</strong><p>Самая ранняя сохранённая операция выбранной аудитории: {data.coverage.firstRecordedAt ? economyTime(data.coverage.firstRecordedAt) : "пока нет"}. Удалённая история не восстанавливается. Пассивное получение продажи или обмена не считается действием активного игрока. Технические переносы и DEV-выдачи исключены.</p>
      {data.coverage.unattributedEvents > 0 && <p className={styles.warning}>У {analyticsCount(data.coverage.unattributedEvents)} операций за период не сохранён контекст объекта. Суммы учитываются, объект и порядок развития не угадываются.</p>}</aside>
  </div>;
}

function ActionTable({ rows, onEvents }: { rows: AdminAnalytics["actions"]; onEvents: (options: { kind: string }) => void }) {
  return <div className={styles.tableScroll} tabIndex={0} role="region" aria-label="Популярные действия"><table><thead><tr><th>Операция / объект</th><th>Операции</th><th>Игроки</th></tr></thead><tbody>{rows.map((row, index) => <tr key={`${row.kind}:${row.targetId}:${index}`}><th scope="row"><button className={styles.textButton} type="button" onClick={() => onEvents({ kind: row.kind })}>{analyticsAction(row.kind)}</button>{row.targetId && <small>{analyticsTarget(row.targetId)}</small>}</th><td>{analyticsCount(row.events)}</td><td>{analyticsCount(row.players)}</td></tr>)}</tbody></table></div>;
}

export function AdminAnalyticsEventList({ data, loading, onPage, onOpen, onPlayer }: {
  data: AdminAnalyticsEvents; loading: boolean; onPage: (offset: number) => void;
  onOpen: (target: AdminEconomyTarget) => void; onPlayer: (target: AdminEconomyTarget) => void;
}) {
  return <section className={styles.panel} aria-busy={loading}><div className={styles.sectionRow}><Heading title="Журнал операций">Подтверждённые изменения валют и припасов. Страницы зафиксированы до {economyTime(data.endAt)}; «Обновить» загрузит новые записи.</Heading>
    <ExportButton label="CSV этой страницы" onClick={() => downloadAnalyticsCsv(`events-${data.from}-${data.to}-page-${Math.floor(data.offset / data.limit) + 1}.csv`, [
      ["ID операции", "Время UTC", "ID игрока", "Игрок", "Операция", "Объект", "Контекст известен", "Количество", "Категория", "Монеты", "Жемчуг", "Изменения припасов"],
      ...data.events.map(row => [row.id, row.createdAt, row.publicId, row.displayName, analyticsAction(row.kind), row.targetId ?? "", row.contextKnown ? "Да" : "Нет", row.quantity,
        analyticsCategory[row.category], row.coins, csvAmount("pearls", row.pearls), Object.entries(row.items).map(([id, amount]) => `${analyticsResource(id)}: ${amount}`).join("; ")])])} /></div>
    {!data.events.length ? <Empty>Операций с такими фильтрами нет. Уберите часть условий или расширьте период.</Empty> : <div className={styles.events}>{data.events.map(event => <article className={styles.event} key={event.id}>
      <div className={styles.eventIdentity}><button type="button" className={styles.textButton} onClick={() => onOpen(event)} aria-label={`Открыть хозяйство игрока ${event.displayName}`}>{event.displayName}</button><code>{event.publicId}</code><button type="button" className={styles.subtleButton} onClick={() => onPlayer(event)}>Все операции игрока</button></div>
      <div className={styles.eventAction}><strong>{analyticsAction(event.kind)}</strong><span>{event.targetId ? analyticsTarget(event.targetId) : event.contextKnown ? "Без отдельного объекта" : "Объект не записан"}{event.quantity != null && ` · количество: ${analyticsCount(event.quantity)}`}</span><small>{analyticsCategory[event.category]} · <time dateTime={event.createdAt}>{economyTime(event.createdAt)}</time></small><details className={styles.eventId}><summary>ID операции</summary><code>{event.id}</code></details></div>
      <ul className={styles.deltas} aria-label="Изменения ресурсов">{[["coins", event.coins], ["pearls", event.pearls], ...Object.entries(event.items)].filter(([, amount]) => amount !== 0).map(([resource, amount]) => <li key={String(resource)} data-sign={Number(amount) > 0 ? "positive" : "negative"}><span>{analyticsResource(String(resource))}</span><strong>{analyticsAmount(String(resource), Number(amount), true)}</strong></li>)}
        {event.coins === 0 && event.pearls === 0 && Object.values(event.items).every(amount => amount === 0) && <li>Без изменения ресурсов</li>}</ul>
    </article>)}</div>}
    <div className={styles.pagination}><span>{data.total ? `${analyticsCount(data.offset + 1)}–${analyticsCount(Math.min(data.offset + data.events.length, data.total))} из ${analyticsCount(data.total)}` : "Нет записей"}</span><div>
      <button className={styles.button} type="button" disabled={loading || data.offset === 0} onClick={() => { if (!loading && data.offset > 0) onPage(Math.max(0, data.offset - data.limit)); }}><ChevronLeft size={17} aria-hidden="true" />Назад</button>
      <button className={styles.button} type="button" disabled={loading || data.offset + data.limit >= data.total || data.offset + data.limit > 100000} onClick={() => { if (!loading && data.offset + data.limit < data.total && data.offset + data.limit <= 100000) onPage(data.offset + data.limit); }}>Далее<ChevronRight size={17} aria-hidden="true" /></button>
    </div></div>{data.offset + data.limit > 100000 && <p className={styles.note}>Для более глубокой истории сузьте период или выберите игрока.</p>}
  </section>;
}

export function AdminEconomyWorkspace({ actorPublicId, refreshVersion, onAccessLost, onOpen, historyRequest }: {
  actorPublicId: string; refreshVersion: number; onAccessLost: (error: ApiError) => void;
  onOpen: (target: AdminEconomyTarget) => void; historyRequest: AdminHistoryRequest | null;
}) {
  const [view, setView] = useState<View>(historyRequest ? "events" : "analytics");
  const [filters, setFilters] = useState<AdminAnalyticsFilters>(() => ({ ...analyticsPeriod(30), q: historyRequest?.target.publicId ?? "", scope: historyRequest ? "all" : "players" }));
  const [eventOptions, setEventOptions] = useState<EventOptions>(initialEvents);
  const [draft, setDraft] = useState<Draft>(() => ({ ...filters, kind: "", resource: "", direction: "all" }));
  const [formError, setFormError] = useState<string | null>(null);
  const [resource, setResource] = useState("coins"), [building, setBuilding] = useState("home");
  const [analytics, setAnalytics] = useState<{ key: string; value: AdminAnalytics } | null>(null);
  const [events, setEvents] = useState<{ key: string; value: AdminAnalyticsEvents } | null>(null);
  const [error, setError] = useState<{ key: string; message: string } | null>(null);
  const [loading, setLoading] = useState(false), [version, setVersion] = useState(0);
  const [lastHistoryRequest, setLastHistoryRequest] = useState(historyRequest);
  // A new explicit drilldown updates the controlled query before rendering any prior snapshot.
  if (historyRequest && historyRequest !== lastHistoryRequest) {
    const next = { ...filters, q: historyRequest.target.publicId, scope: "all" as const };
    setLastHistoryRequest(historyRequest); setView("events"); setFilters(next); setEventOptions(initialEvents);
    setDraft({ ...next, kind: "", resource: "", direction: "all" }); setFormError(null);
  }
  const key = JSON.stringify([actorPublicId, view, filters, view === "events" ? eventOptions : null]);
  const analyticsData = analytics?.key === key ? analytics.value : null;
  const eventsData = events?.key === key ? events.value : null;
  const data = view === "analytics" ? analyticsData : eventsData;
  useEffect(() => {
    if (view === "players") return;
    let active = true, busy = false, loaded = false;
    let controller: AbortController | null = null;
    async function load() {
      if (!active || busy || document.visibilityState !== "visible") return;
      busy = true; controller = new AbortController(); const signal = controller.signal;
      await Promise.resolve(); if (!active || signal.aborted) return;
      setLoading(true);
      try {
        if (view === "analytics") {
          const value = await loadAdminAnalytics(actorPublicId, filters, signal);
          if (active && !signal.aborted) setAnalytics({ key, value });
        } else {
          const value = await loadAdminAnalyticsEvents(actorPublicId, { ...filters, ...eventOptions }, signal);
          if (!active || signal.aborted) return;
          if (value.offset > 0 && value.events.length === 0 && value.total <= value.offset) {
            setEventOptions(current => ({ ...current, offset: Math.max(0, Math.floor((value.total - 1) / current.limit) * current.limit) })); return;
          }
          setEvents({ key, value });
        }
        loaded = true;
        if (active && !signal.aborted) setError(null);
      } catch (cause) {
        if (!active || signal.aborted) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) { setAnalytics(null); setEvents(null); onAccessLost(cause); return; }
        setError({ key, message: cause instanceof ApiError ? cause.message : "Не удалось загрузить аналитику. Повторите запрос." });
      } finally { busy = false; if (active && !signal.aborted) setLoading(false); }
    }
    void load();
    const timer = view === "analytics" ? window.setInterval(() => { void load(); }, 60_000) : null;
    const visible = () => { if (document.visibilityState === "visible" && (view === "analytics" || !loaded)) void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller?.abort(); if (timer) window.clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [actorPublicId, view, filters, eventOptions, key, version, refreshVersion, onAccessLost]);

  function openEvents(options: { kind?: string; resource?: string; direction?: "all" | "in" | "out" }, target?: AdminEconomyTarget) {
    const next = target ? { ...filters, q: target.publicId, scope: "all" as const } : filters;
    const eventFilters = { ...initialEvents, ...options };
    setFilters(next); setEventOptions(eventFilters); setDraft({ ...next, ...eventFilters }); setFormError(null); setView("events");
  }
  function refresh() { if (view === "events") setEventOptions(current => ({ ...current, offset: 0, at: null })); setVersion(current => current + 1); }
  const changed = draft.from !== filters.from || draft.to !== filters.to || draft.q.trim() !== filters.q || draft.scope !== filters.scope
    || view === "events" && (draft.kind !== eventOptions.kind || draft.resource !== eventOptions.resource || draft.direction !== eventOptions.direction);
  return <Tabs value={view} onValueChange={value => { setView(value as View); setFormError(null); }} className={styles.workspace}>
    <TabsList className={styles.tabs} aria-label="Разделы экономики"><TabsTrigger className={styles.tab} value="analytics"><BarChart3 size={17} />Аналитика</TabsTrigger><TabsTrigger className={styles.tab} value="players"><Users size={17} />Хозяйства</TabsTrigger><TabsTrigger className={styles.tab} value="events"><ListFilter size={17} />Операции</TabsTrigger></TabsList>
    {view !== "players" && <>
      <form className={styles.filters} onSubmit={event => { event.preventDefault(); const invalid = analyticsPeriodError(draft.from, draft.to); setFormError(invalid); if (invalid) return;
        setFilters({ from: draft.from, to: draft.to, q: draft.q.trim(), scope: draft.scope });
        setEventOptions({ ...initialEvents, kind: draft.kind, resource: draft.resource, direction: draft.direction }); setVersion(value => value + 1);
      }}>
        <div className={styles.quickPeriods} aria-label="Быстрый выбор периода">{[1, 7, 30, 90].map(days => <button className={styles.chip} type="button" key={days} onClick={() => setDraft(current => ({ ...current, ...analyticsPeriod(days) }))}>{days === 1 ? "Сегодня" : `${days} дней`}</button>)}<span>Даты включительно, UTC</span></div>
        <div className={styles.filterGrid}>
          <label className={styles.field}>С<input type="date" required value={draft.from} max={draft.to || analyticsPeriod(1).to} onChange={event => setDraft(current => ({ ...current, from: event.target.value }))} /></label>
          <label className={styles.field}>По<input type="date" required value={draft.to} min={draft.from} max={analyticsPeriod(1).to} onChange={event => setDraft(current => ({ ...current, to: event.target.value }))} /></label>
          <label className={`${styles.field} ${styles.playerSearch}`}>Игрок · имя или ID<div><Search size={17} aria-hidden="true" /><input type="search" value={draft.q} placeholder="Все игроки" maxLength={100} autoComplete="off" onChange={event => setDraft(current => ({ ...current, q: event.target.value }))} /></div></label>
          <label className={styles.field}>Аудитория<select value={draft.scope} onChange={event => setDraft(current => ({ ...current, scope: event.target.value as Draft["scope"] }))}><option value="players">Без администраторов</option><option value="all">Включая администраторов</option></select></label>
          {view === "events" && <>
            <label className={styles.field}>Операция<select value={draft.kind} onChange={event => setDraft(current => ({ ...current, kind: event.target.value }))}><option value="">Все операции</option>{[...new Set([...Object.keys(analyticsActions), draft.kind].filter(Boolean))].map(id => <option value={id} key={id}>{analyticsAction(id)}</option>)}</select></label>
            <label className={styles.field}>Ресурс<select value={draft.resource} onChange={event => setDraft(current => ({ ...current, resource: event.target.value }))}><option value="">Все ресурсы</option>{analyticsResources.map(item => <option value={item.id} key={item.id}>{item.name}</option>)}{draft.resource && !analyticsResources.some(item => item.id === draft.resource) && <option value={draft.resource}>{analyticsResource(draft.resource)}</option>}</select></label>
            <label className={styles.field}>Направление<select value={draft.direction} onChange={event => setDraft(current => ({ ...current, direction: event.target.value as Draft["direction"] }))}><option value="all">Любое</option><option value="in">Поступление (+)</option><option value="out">Списание (−)</option></select></label>
          </>}
        </div>
        <div className={styles.filterFooter}><button type="submit" className={styles.primaryButton}>Применить фильтры</button><button type="button" className={styles.button} onClick={() => { const next = { ...analyticsPeriod(30), q: "", scope: "players" as const }; setDraft({ ...next, ...initialEvents }); setFilters(next); setEventOptions(initialEvents); setFormError(null); }}>Сбросить</button><span role="status">{formError ?? (changed ? "Фильтры изменены. Нажмите «Применить»." : `${filters.from} — ${filters.to} · ${filters.scope === "players" ? "без администраторов" : "все аккаунты"}${filters.q ? ` · поиск: ${filters.q}` : ""}`)}</span></div>
      </form>
      <div className={styles.refresh}><span>{data ? `Снимок: ${economyTime(data.serverTime)}` : "Ожидаем данные"} · {view === "analytics" ? "обновление раз в минуту" : "обновление вручную"}</span><button className={styles.button} type="button" disabled={loading} onClick={refresh}><RefreshCw size={17} aria-hidden="true" />Обновить</button></div>
      {error?.key === key && <div className={styles.error} role="alert"><CircleAlert size={18} aria-hidden="true" /><span>{error.message}{data ? " Показан последний успешный снимок; данные могли измениться." : ""}</span></div>}
    </>}
    <TabsContent value="analytics" className={styles.content}><div aria-busy={loading}>{analyticsData ? <AdminAnalyticsContent data={analyticsData} resource={resource} building={building} onResource={setResource} onBuilding={setBuilding} onEvents={openEvents} /> : <p className={styles.empty} role="status">{loading ? "Считаем активность и движение ресурсов…" : "Аналитика пока не загружена."}</p>}</div></TabsContent>
    <TabsContent value="players" className={styles.content}>{view === "players" && <AdminEconomyPanel actorPublicId={actorPublicId} refreshVersion={refreshVersion} onAccessLost={onAccessLost} onOpen={onOpen} onHistory={target => openEvents({}, target)} />}</TabsContent>
    <TabsContent value="events" className={styles.content}>{eventsData ? <AdminAnalyticsEventList data={eventsData} loading={loading} onPage={offset => setEventOptions(current => ({ ...current, offset, at: current.at ?? eventsData.endAt }))} onOpen={onOpen} onPlayer={target => openEvents({}, target)} /> : <p className={styles.empty} role="status">{loading ? "Загружаем журнал операций…" : "Журнал пока не загружен."}</p>}</TabsContent>
  </Tabs>;
}
