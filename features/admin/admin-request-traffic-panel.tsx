"use client";

import { useEffect, useRef, useState } from "react";
import { CircleAlert, LoaderCircle, RefreshCw } from "lucide-react";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ApiError } from "@/lib/check-in-api";
import { loadAdminRequestTraffic, type AdminRequestTraffic } from "./admin-request-traffic-api";
import styles from "./admin-dashboard.module.css";

const number = new Intl.NumberFormat("ru-RU");
const timestamp = new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
});
const reasons: Record<AdminRequestTraffic["signals"][number]["reasons"][number], string> = {
  REQUEST_BURST: "Много запросов",
  ACCESS_DENIED_BURST: "Повторные отказы в доступе",
  THROTTLED_BURST: "Повторные ответы 429",
};
const time = (value: string) => timestamp.format(new Date(value));

export function AdminRequestTrafficContent({ data }: { data: AdminRequestTraffic }) {
  return <>
    <p className={styles.footnote}>Это признаки для ручной проверки, а не доказательство нарушения. Причиной может быть ошибка вкладки или повтор после обрыва связи. Автоматических блокировок нет; пороги наблюдения не меняют игровые ограничения.</p>
    {data.signals.length === 0 ? <div className={styles.empty}>В сохранённых наблюдениях нет всплесков запросов.</div> : <Table className={styles.auditTable}>
      <TableHeader><TableRow>
        <TableHead>Источник</TableHead><TableHead>Операция / причина</TableHead>
        <TableHead>Интервал, UTC</TableHead><TableHead>Запросы</TableHead><TableHead>Ответы с ошибкой</TableHead>
      </TableRow></TableHeader>
      <TableBody>{data.signals.map(signal => <TableRow key={JSON.stringify([signal.publicId, signal.operation, signal.method, signal.windowStartedAt])}>
        <TableCell className={styles.reasonCell}>{signal.publicId ? <>
          <div className={styles.userIdentity}><strong>{signal.displayName ?? "Имя недоступно"}</strong></div><code>{signal.publicId}</code>
        </> : <><strong>Без авторизации</strong><small>Общий поток разных посетителей, не один игрок</small></>}</TableCell>
        <TableCell className={styles.reasonCell}><code>{signal.method} {signal.operation}</code>
          {signal.reasons.map(reason => <small key={reason}>{reasons[reason]}</small>)}
        </TableCell>
        <TableCell>{time(signal.windowStartedAt)}<small>Последний ответ: {time(signal.lastAt)}</small></TableCell>
        <TableCell><strong>{number.format(signal.requests)}</strong><small>В указанном минутном окне</small></TableCell>
        <TableCell>Отказ в доступе: {number.format(signal.denied)}<small>429: {number.format(signal.throttled)}</small><small>5xx: {number.format(signal.serverErrors)}</small></TableCell>
      </TableRow>)}</TableBody>
    </Table>}
    <p className={styles.footnote}>Снимок {time(data.serverTime)} UTC. Наблюдения за последние 15 минут хранятся в памяти этого экземпляра API и сбрасываются при его перезапуске. Начало наблюдения: {time(data.startedAt)} UTC. В списке до 100 сигналов; отсутствие записи не доказывает отсутствие проблемы. В этих наблюдениях нет IP-адресов.</p>
    {data.evicted > 0 && <p className={styles.footnote}>История неполная: из-за заполнения памяти вытеснено записей — {number.format(data.evicted)}. Вместимость — {number.format(data.capacity)} групп.</p>}
  </>;
}

type State = { actor: string; data: AdminRequestTraffic | null; busy: boolean; error: string | null; closed: boolean };

export function AdminRequestTrafficPanel({ actorPublicId, onAccessLost }: {
  actorPublicId: string; onAccessLost: (error: ApiError) => void;
}) {
  const [state, setState] = useState<State | null>(null);
  const refresh = useRef<(() => void) | null>(null);
  const accessLost = useRef(onAccessLost);
  useEffect(() => { accessLost.current = onAccessLost; }, [onAccessLost]);

  useEffect(() => {
    let active = true;
    let busy = false;
    let closed = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (!active || busy || closed || document.visibilityState !== "visible") return;
      busy = true;
      controller = new AbortController();
      const signal = controller.signal;
      await Promise.resolve();
      if (!active || signal.aborted) { busy = false; return; }
      setState(previous => ({ actor: actorPublicId, data: previous?.actor === actorPublicId ? previous.data : null, busy: true, error: null, closed: false }));
      try {
        const data = await loadAdminRequestTraffic(actorPublicId, signal);
        if (active && !signal.aborted) setState({ actor: actorPublicId, data, busy: false, error: null, closed: false });
      } catch (error) {
        if (!active || signal.aborted) return;
        const denied = error instanceof ApiError && (error.status === 401 || error.status === 403);
        // Clear private data even when the parent keeps this component mounted.
        if (denied) {
          closed = true;
          setState({ actor: actorPublicId, data: null, busy: false, error: "Доступ к наблюдениям закрыт.", closed: true });
          accessLost.current(error);
        } else {
          setState({ actor: actorPublicId, data: null, busy: false, error: "Не удалось получить наблюдения. Повторите запрос позже.", closed: false });
        }
      } finally { busy = false; }
    };
    refresh.current = () => { void load(); };
    void load();
    const timer = window.setInterval(() => { void load(); }, 30_000);
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", resume);
    window.addEventListener("focus", resume);
    return () => {
      active = false; controller?.abort(); refresh.current = null; window.clearInterval(timer);
      document.removeEventListener("visibilitychange", resume); window.removeEventListener("focus", resume);
    };
  }, [actorPublicId]);

  const current = state?.actor === actorPublicId ? state : null;
  const busy = current?.busy ?? true;
  return <section className={styles.panel} aria-busy={busy}>
    <div className={styles.sectionHeading}><div><h2>Всплески запросов</h2><p>Наблюдение за API без изменения правил игры</p></div>
      <button type="button" className={styles.button} disabled={busy || current?.closed} onClick={() => refresh.current?.()}>
        {busy ? <LoaderCircle size={17} className={styles.spin} /> : <RefreshCw size={17} />}Обновить запросы
      </button>
    </div>
    {current?.error && <div className={styles.notice} role="status"><CircleAlert size={18} /><p>{current.error}</p></div>}
    {current?.data ? <AdminRequestTrafficContent data={current.data} /> : !current?.error && <div className={styles.empty} role="status">{busy ? "Получаем наблюдения…" : "Наблюдения пока не загружены."}</div>}
  </section>;
}
