"use client";

import { useEffect, useState } from "react";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { PlayerName } from "@/components/player-name";
import { ApiError } from "@/lib/check-in-api";
import { getAdminTapActivity, getAdminUsers, type AdminTapActivity, type AdminUser } from "./admin-api";
import { AdminTapHistoryPanel } from "./admin-tap-history-panel";
import styles from "./admin-management.module.css";

const format = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 2 });
const reasonLabels: Record<string, string> = {
  LOW_MINUTE_VARIATION: "Не менее 10 полных минут подряд с почти одинаковым количеством нажатий (разброс до 3%).",
  REGULAR_INTERVALS: "Не менее 600 интервалов между нажатиями с разбросом до 5%.",
  LONG_ACTIVITY: "Как минимум 25 полных минут активности подряд.",
  DELAYED_DELIVERY: "Есть нажатия, доставленные с задержкой более 10 секунд. Возможна отправка накопленной очереди.",
  MISSING_TIMESTAMPS: "Некоторые пакеты не содержат времени нажатий: точность анализа ограничена.",
};
const time = (value: string) => new Date(value).toLocaleTimeString("ru-RU", { timeZone: "UTC", hour: "2-digit", minute: "2-digit" });

export function AdminTapActivityPanel({ initialTarget, refreshVersion, onManage, onAccessError }: {
  initialTarget: AdminUser | null; refreshVersion: number; onManage: (target: AdminUser) => void; onAccessError: (error: ApiError) => void;
}) {
  const [query, setQuery] = useState("");
  const [players, setPlayers] = useState<AdminUser[]>([]);
  const [target, setTarget] = useState<AdminUser | null>(initialTarget);
  const [report, setReport] = useState<AdminTapActivity | null>(null);
  const [error, setError] = useState("");
  const [searchError, setSearchError] = useState("");
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      getAdminUsers({ q: query.trim(), sort: "review", offset: 0, limit: 12 }, controller.signal).then(value => {
        if (!controller.signal.aborted) { setPlayers(value.users); setSearchError(""); }
      }).catch(failure => {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) onAccessError(failure);
        else setSearchError(failure instanceof Error ? failure.message : "Поиск недоступен");
      });
    }, 250);
    return () => { controller.abort(); clearTimeout(timer); };
  }, [query, refreshVersion, onAccessError]);
  useEffect(() => {
    if (!target) return;
    let active = true, busy = false;
    let controller: AbortController | null = null;
    const load = async () => {
      if (!active || busy || document.hidden) return;
      busy = true; controller = new AbortController(); const request = controller;
      setLoading(true);
      try {
        const result = await getAdminTapActivity(target.publicId, request.signal);
        if (active && !request.signal.aborted) { setReport(result); setError(""); }
      } catch (failure) {
        if (!active || request.signal.aborted) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) onAccessError(failure);
        else setError(failure instanceof Error ? failure.message : "Не удалось обновить клики");
      } finally { busy = false; if (active) setLoading(false); }
    };
    const kickoff = setTimeout(() => void load(), 0);
    const timer = setInterval(() => void load(), 10_000);
    const visible = () => { void load(); };
    document.addEventListener("visibilitychange", visible);
    return () => { active = false; controller?.abort(); clearTimeout(kickoff); clearInterval(timer); document.removeEventListener("visibilitychange", visible); };
  }, [target, refreshVersion, onAccessError]);
  const selected = players.find(player => player.publicId === target?.publicId) ?? target;
  const current = report?.publicId === target?.publicId ? report : null;
  return <section className={styles.panel}>
    <div className={styles.search}><label>Найти игрока по имени или ID<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Например ABCD-EFGH-JKLM" maxLength={100} /></label></div>
    {searchError && <p role="alert" className={styles.error}>{searchError}</p>}
    <div className={styles.results}>{players.map(player => <button key={player.publicId} aria-pressed={target?.publicId === player.publicId} onClick={() => { setTarget(player); setError(""); }}>
      <PlayerName name={player.displayName} tag={player.tag} /> · {player.publicId}{player.tapSignalAt ? " · проверить клики" : ""}{player.watchlisted && <span className={styles.watchBadge}>Наблюдение</span>}
    </button>)}</div>
    {!players.length && !searchError && <p className={styles.hint}>По этому запросу игроков не найдено.</p>}
    {!target ? <p>Выберите игрока. Здесь появятся частота нажатий и история за последние полчаса.</p> : <>
      <div className={styles.search}><h2><PlayerName name={current?.displayName ?? selected?.displayName} tag={selected?.tag} /></h2><code>{target.publicId}</code>{(current?.watchlisted ?? selected?.watchlisted) && <span className={styles.watchBadge}>Наблюдение</span>}<button onClick={() => onManage(selected ?? target)}>Управление / наблюдение</button></div>
      {error && <p className={styles.error} role="alert">{error}{current ? " Показан последний полученный снимок." : ""}</p>}
      {!current ? <p>{loading ? "Собираем статистику…" : "Данные пока не получены."}</p> : <>
        <div className={styles.metrics}>{current.windows.map(window => <div className={styles.metric} key={window.seconds}>
          <span>{window.seconds === 1800 ? "За 30 минут" : `За ${window.seconds} секунд`}</span><strong>{format.format(window.eventTaps)}</strong>
          <small>{format.format(window.tapsPerSecond)} тап/с по времени клиента</small><small>Получено сервером: {format.format(window.receivedTaps)}</small>
        </div>)}</div>
        <div className={styles.signal} data-status={current.analysis.status}>
          <h3>{current.analysis.status === "review" ? "Есть основания для ручной проверки" : current.analysis.status === "insufficient_data" ? "Пока недостаточно надёжных данных" : "Сильных признаков равномерного кликера не найдено"}</h3>
          {current.watchlisted && <p>Игрок отмечен администратором для наблюдения.</p>}
          <p>Активных полных минут: {current.analysis.activeMinutes}. Ровная серия: {current.analysis.stableMinutes} мин.</p>
          {current.analysis.meanTapsPerMinute != null && <p>Среднее в ровной серии: {format.format(current.analysis.meanTapsPerMinute)} тап/мин. Разброс: {format.format((current.analysis.minuteVariation ?? 0) * 100)}%.</p>}
          {current.analysis.intervalVariation != null && <p>Разброс интервалов: {format.format(current.analysis.intervalVariation * 100)}% · измерений: {format.format(current.analysis.intervalSamples)}.</p>}
          {current.analysis.reasons.length > 0 && <ul>{current.analysis.reasons.map(reason => <li key={reason}>{reasonLabels[reason] ?? reason}</li>)}</ul>}
          <p className={styles.hint}>Это признаки для проверки, а не доказательство. Время нажатий передаёт клиент; его можно подделать. Алгоритм никогда не блокирует аккаунты.</p>
        </div>
        <div className={styles.chart} role="img" aria-label="Нажатия по минутам: время клиента и получение сервером. Точные значения доступны ниже.">
          <ResponsiveContainer width="100%" height="100%"><LineChart data={current.minutes} margin={{ top: 10, right: 12, bottom: 8, left: -12 }} accessibilityLayer>
            <CartesianGrid stroke="#384530" strokeDasharray="3 5" /><XAxis dataKey="at" tickFormatter={time} stroke="#aab79f" minTickGap={40} /><YAxis stroke="#aab79f" allowDecimals={false} />
            <Tooltip labelFormatter={value => `${time(String(value))} UTC`} contentStyle={{ background: "#20251f", borderColor: "#566946", color: "#edf2e7" }} /><Legend />
            <Line type="linear" dataKey="eventTaps" name="Время клиента" stroke="#b9d99c" dot={false} isAnimationActive={false} />
            <Line type="linear" dataKey="receivedTaps" name="Получено сервером" stroke="#8fc2ff" dot={false} isAnimationActive={false} />
          </LineChart></ResponsiveContainer>
        </div>
        <details><summary>Точные значения по минутам</summary><table><thead><tr><th>UTC</th><th>Время клиента</th><th>Получено</th></tr></thead><tbody>{current.minutes.map(minute => <tr key={minute.at}><td>{time(minute.at)}{!minute.complete ? " · неполная" : ""}</td><td>{minute.eventTaps}</td><td>{minute.receivedTaps}</td></tr>)}</tbody></table></details>
        <p className={styles.hint}>Отброшено в обработанных пакетах: {format.format(current.rejectedTaps)}. С задержкой &gt;10 с: {format.format(current.delayedTaps)}. Без временных меток: {format.format(current.legacyTaps)}.</p>
        <p className={styles.hint}>Снимок {time(current.serverTime)} UTC. Обновление каждые 10 секунд. Окна включают последние полные секунды; текущая неполная минута не участвует в оценке равномерности. История начинается после обновления сервера.</p>
      </>}
      <AdminTapHistoryPanel key={target.publicId} target={target.publicId} refreshVersion={refreshVersion} onAccessError={onAccessError} />
    </>}
  </section>;
}
