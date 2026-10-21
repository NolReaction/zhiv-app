"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/check-in-api";
import { loadAdminApiUsage, type AdminApiUsage, type AdminApiUsagePeriod } from "./admin-api-usage-api";
import styles from "./admin-dashboard.module.css";
import usage from "./admin-api-usage-panel.module.css";

const number = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 20 });
const timestamp = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const calendar = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" });
const time = (value: string) => timestamp.format(new Date(value));
const day = (value: string) => calendar.format(new Date(`${value}T00:00:00Z`));
const groupNames = { request: "Запросы", session: "Сессии", export: "Экспорт" } as const;
const groupOrder = ["request", "session", "export"] as const;
const providerErrors: Record<NonNullable<AdminApiUsage["maptiler"]["error"]>, { title: string; message: string }> = {
  MAPTILER_DISABLED: { title: "Аналитика MapTiler не подключена", message: "Для статистики нужен отдельный сервисный токен в настройках сервера. Публичный ключ карты не открывает аналитику. Работа спутниковой карты от этого не зависит." },
  MAPTILER_ACCESS_DENIED: { title: "Нет доступа к аналитике MapTiler", message: "Проверьте сервисный токен и доступ аккаунта на сервере. Ключ спутниковой карты для этого не подходит." },
  MAPTILER_RATE_LIMITED: { title: "MapTiler временно ограничил запросы", message: "Статистика не получена. Подождите несколько минут и обновите данные." },
  MAPTILER_PERIOD_UNAVAILABLE: { title: "Этот период недоступен в MapTiler", message: "Попробуйте другой период. У нового аккаунта может ещё не быть истории за выбранное время." },
  MAPTILER_UNAVAILABLE: { title: "Аналитика MapTiler временно недоступна", message: "Провайдер не вернул проверенные данные. Повторите запрос позже." },
};

function MapTilerUsage({ data }: { data: AdminApiUsage["maptiler"] }) {
  const error = data.error ? providerErrors[data.error] : null;
  const groups = groupOrder.map(id => data.groups.find(item => item.group === id)).filter(item => item !== undefined);
  const dates = [...new Set(groups.flatMap(group => [...group.daily, ...group.estimated].map(item => item.date)))].sort();
  return <section className={styles.panel} aria-label="Статистика MapTiler">
    <div className={styles.sectionHeading}><div><h2>MapTiler</h2><p>Официальная аналитика всего аккаунта</p></div></div>
    {error ? <div className={usage.status} role="status"><strong>{error.title}</strong><p>{error.message}</p></div>
      : data.groups.length === 0 ? <div className={usage.status} role="status"><strong>За выбранный период данных нет</strong><p>MapTiler не вернул группы использования. Это не подтверждение нулевого расхода.</p></div>
        : <>
          <dl className={usage.metrics}>{groupOrder.map(id => {
            const item = groups.find(group => group.group === id);
            return <div className={usage.metric} key={id}><dt>{groupNames[id]}</dt><dd>{item?.total != null ? number.format(item.total) : "—"}</dd><small>{!item ? "Группа не предоставлена" : item.daily.length ? "По завершённым дням" : "Нет завершённых дней"}</small></div>;
          })}</dl>
          {dates.length > 0 && <details className={usage.daily}><summary>По дням · UTC</summary><div className={usage.table}>
            <Table><caption>Факт и предварительная оценка провайдера показаны отдельно. Прочерк означает отсутствие значения.</caption>
              <TableHeader><TableRow><TableHead>День, UTC</TableHead>{groups.map(group => <TableHead key={group.group}>{groupNames[group.group]}</TableHead>)}</TableRow></TableHeader>
              <TableBody>{dates.map(date => <TableRow key={date}><TableCell>{day(date)}</TableCell>{groups.map(group => {
                const actual = group.daily.find(item => item.date === date), estimate = group.estimated.find(item => item.date === date);
                return <TableCell key={group.group}>{actual ? number.format(actual.value) : "—"}{estimate && <small className={usage.estimated}>Оценка: {number.format(estimate.value)}</small>}</TableCell>;
              })}</TableRow>)}</TableBody>
            </Table>
          </div></details>}
        </>}
    {data.available && data.since && data.until && <p className={styles.footnote}>Период провайдера: {day(data.since)} — {day(data.until)} UTC.{data.updatedAt && <> Получено из MapTiler: {time(data.updatedAt)} UTC.</>}</p>}
    <p className={styles.footnote}>Запросы, сессии и экспорт считаются отдельно. Это использование всех сервисов аккаунта MapTiler, включая другие проекты. Значения могут поступать с задержкой; предварительные оценки не входят в итоги завершённых дней. Денежный счёт и лимиты тарифа смотрите в кабинете MapTiler.</p>
    <a className={usage.help} href="https://docs.maptiler.com/cloud/admin-api/analytics/" target="_blank" rel="noopener noreferrer">Документация аналитики MapTiler<ArrowUpRight size={15} /></a>
  </section>;
}

export function AdminApiUsageContent({ data }: { data: AdminApiUsage }) {
  return <div className={styles.stack}>
    <section className={styles.panel} aria-label="Использование API приложения">
      <div className={styles.sectionHeading}><div><h2>API приложения</h2><p>Завершённые ответы этого экземпляра сервера</p></div></div>
      <dl className={usage.metrics}>
        <div className={usage.metric}><dt>Запросы</dt><dd>{number.format(data.api.requests)}</dd></div>
        <div className={usage.metric}><dt>Ошибки 5xx</dt><dd>{number.format(data.api.errors)}</dd></div>
        <div className={usage.metric}><dt>Ответы 429</dt><dd>{number.format(data.api.throttled)}</dd></div>
      </dl>
      <p className={styles.footnote}>Точные счётчики Kotlin API с запуска {time(data.api.startedAt)} UTC. Сбрасываются при перезапуске этого процесса. Файлы приложения, тайлы карты и запросы, не дошедшие до API, сюда не входят. Это не расход MapTiler.</p>
      <p className={styles.footnote}>Снимок: {time(data.serverTime)} UTC.</p>
    </section>
    <MapTilerUsage data={data.maptiler} />
  </div>;
}

type State = { scope: string; data: AdminApiUsage | null; busy: boolean; error: string | null; closed: boolean };

export function AdminApiUsagePanel({ actorPublicId, onAccessLost }: {
  actorPublicId: string; onAccessLost: (error: ApiError) => void;
}) {
  const [period, setPeriod] = useState<AdminApiUsagePeriod>("current_billing_period");
  const [state, setState] = useState<State | null>(null);
  const refresh = useRef<(() => void) | null>(null);
  const accessLost = useRef(onAccessLost);
  useEffect(() => { accessLost.current = onAccessLost; }, [onAccessLost]);
  const scope = JSON.stringify([actorPublicId, period]);

  useEffect(() => {
    let active = true, closed = false;
    let request: AbortController | null = null;
    const load = async () => {
      if (!active || request || closed || document.visibilityState !== "visible") return;
      const controller = new AbortController();
      request = controller;
      const signal = controller.signal;
      await Promise.resolve();
      if (!active || signal.aborted) return;
      setState(previous => ({ scope, data: previous?.scope === scope ? previous.data : null, busy: true, error: null, closed: false }));
      try {
        const data = await loadAdminApiUsage(actorPublicId, period, signal);
        if (active && !signal.aborted) setState({ scope, data, busy: false, error: null, closed: false });
      } catch (error) {
        if (!active || signal.aborted) return;
        const denied = error instanceof ApiError && (error.status === 401 || error.status === 403);
        closed = denied;
        setState({ scope, data: null, busy: false, error: denied ? "Доступ к статистике API закрыт." : "Не удалось получить статистику API. Проверьте соединение и повторите запрос.", closed: denied });
        if (denied) accessLost.current(error);
      } finally { if (request === controller) request = null; }
    };
    refresh.current = () => { void load(); };
    void load();
    const timer = window.setInterval(() => { void load(); }, 60_000);
    const resume = () => {
      if (document.visibilityState === "visible") void load();
      else {
        request?.abort(); request = null;
        setState(previous => previous?.scope === scope ? { ...previous, busy: false } : previous);
      }
    };
    document.addEventListener("visibilitychange", resume); window.addEventListener("focus", resume);
    return () => {
      active = false; request?.abort(); refresh.current = null; window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume);
    };
  }, [actorPublicId, period, scope]);

  const current = state?.scope === scope ? state : null;
  const busy = current?.busy ?? true;
  return <div className={styles.stack} aria-busy={busy}>
    <div className={usage.toolbar}>
      <label className={usage.period}>Период MapTiler<select className={styles.select} value={period} disabled={current?.closed} onChange={event => setPeriod(event.target.value as AdminApiUsagePeriod)}>
        <option value="current_billing_period">Текущий расчётный период</option><option value="past_30_days">Последние 30 дней</option><option value="past_90_days">Последние 90 дней</option>
      </select></label>
      <button type="button" className={styles.button} disabled={busy || current?.closed} onClick={() => refresh.current?.()}>{busy ? <LoaderCircle size={17} className={styles.spin} /> : <RefreshCw size={17} />}Обновить статистику</button>
    </div>
    {current?.error && <div className={styles.notice} role="status"><CircleAlert size={18} /><p>{current.error}</p></div>}
    {current?.data ? <AdminApiUsageContent data={current.data} /> : !current?.error && <div className={styles.empty} role="status">{busy ? "Получаем статистику API…" : "Статистика пока не загружена."}</div>}
  </div>;
}
