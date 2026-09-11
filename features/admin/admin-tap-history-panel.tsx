"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { ApiError } from "@/lib/check-in-api";
import { getAdminTapHistory, type AdminTapHistory } from "./admin-api";
import { tapHistoryCsv, tapHistoryDays } from "./tap-history";
import styles from "./admin-management.module.css";

export function AdminTapHistoryPanel({ target, refreshVersion, onAccessError }: {
  target: string; refreshVersion: number; onAccessError: (error: ApiError) => void;
}) {
  const [history, setHistory] = useState<AdminTapHistory | null>(null);
  const [error, setError] = useState("");
  const [day, setDay] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const kickoff = setTimeout(() => {
      setLoading(true); setError("");
      void getAdminTapHistory(target, controller.signal).then(result => {
        if (!controller.signal.aborted && result.publicId === target) setHistory(result);
      }).catch(failure => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) { setHistory(null); onAccessError(failure); }
        else setError("Не удалось загрузить историю. Нажмите «Обновить данные» и повторите.");
      }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    }, 0);
    return () => { clearTimeout(kickoff); controller.abort(); };
  }, [target, refreshVersion, onAccessError]);
  const current = history?.publicId === target ? history : null;
  const days = current ? tapHistoryDays(current) : [];
  const selectedDay = days.some(value => value.day === day) ? day : days.at(-1)?.day ?? "";
  const minutes = current?.minutes.filter(row => row.at.startsWith(selectedDay)) ?? [];
  const download = () => {
    if (!current) return;
    const url = URL.createObjectURL(new Blob([tapHistoryCsv(current)], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url;
    anchor.download = `tap-history-${target}-${current.serverTime.slice(0, 10)}.csv`;
    document.body.append(anchor); anchor.click(); anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className={styles.history} aria-busy={loading}>
    <div className={styles.search}><h3>История за 30 дней</h3><button type="button" disabled={!current || loading} onClick={download}><Download size={17} />Выгрузить CSV</button></div>
    <p className={styles.hint}>Поминутная история хранится 30 дней. Время клиента и время получения сервером разделены. Выгрузка содержит все доступные минуты, интервалы, сигналы алгоритма и отметки наблюдения.</p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!current ? <p>{loading ? "Загружаем историю…" : "История пока не загружена."}</p> : !days.length ? <p>За этот период записей пока нет.</p> : <>
      <div className={styles.tableScroll}><table><caption>Активность по дням UTC</caption><thead><tr><th>День</th><th>Получено</th><th>Время клиента</th><th>Отклонено</th><th>Минут с сигналом</th><th>Под наблюдением</th></tr></thead><tbody>
        {days.map(value => <tr key={value.day}><td><button onClick={() => setDay(value.day)} aria-pressed={value.day === selectedDay}>{value.day}</button></td><td>{value.received}</td><td>{value.events}</td><td>{value.rejected}</td><td>{value.signals}</td><td>{value.watched} мин</td></tr>)}
      </tbody></table></div>
      <label>Детали за день UTC<select value={selectedDay} onChange={event => setDay(event.target.value)}>{days.map(value => <option key={value.day}>{value.day}</option>)}</select></label>
      <div className={styles.tableScroll}><table><caption>Минуты активности · {selectedDay}</caption><thead><tr><th>UTC</th><th>Получено</th><th>Время клиента</th><th>Интервал, мс</th><th>Отметки</th></tr></thead><tbody>
        {minutes.map(row => <tr key={row.at}><td>{row.at.slice(11, 16)}{!row.complete && " · неполная"}</td><td>{row.receivedTaps}</td><td>{row.eventTaps}</td><td>{row.intervalCount ? Math.round(row.intervalSumMs / row.intervalCount) : "—"}</td><td>{row.watchlisted && <span className={styles.watchBadge}>Наблюдение</span>}{row.reviewSignal && " Сигнал для проверки"}</td></tr>)}
      </tbody></table></div>
    </>}
    <p className={styles.hint}>Секундные окна выше доступны за последние два часа. Месячная история накапливается после обновления сервера; уже удалённые записи не восстанавливаются. История обновляется при выборе игрока и по кнопке обновления.</p>
  </section>;
}
