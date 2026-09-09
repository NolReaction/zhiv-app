"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw, Copy } from "lucide-react";
import { getAdminIncidents, type AdminIncidents } from "@/lib/admin-api";
import { copyText } from "@/lib/identity-sharing";
import { incidentAdvice } from "@/lib/incident-advice";
import { ApiError } from "@/lib/check-in-api";
import { INCIDENT_MESSAGES } from "@/lib/client-incidents";
import styles from "./admin-dashboard.module.css";

export function AdminIncidentsPanel({ onAccessError }: { onAccessError: (error: ApiError) => void }) {
  const [rangeMinutes, setRange] = useState(1440);
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<"" | "client" | "server">("");
  const [codeInput, setCodeInput] = useState("");
  const [code, setCode] = useState("");
  const [copyNotice, setCopyNotice] = useState("");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; value: AdminIncidents } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(true);
  const key = JSON.stringify([rangeMinutes, query, source, code, offset]);
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(input.trim()); setCode(codeInput.trim().toUpperCase()); setOffset(0); }, 350);
    return () => clearTimeout(timer);
  }, [input, codeInput]);
  useEffect(() => {
    const controller = new AbortController();
    const load = async () => {
      setBusy(true);
      try {
        const value = await getAdminIncidents({ rangeMinutes, q: query, source, code, offset }, controller.signal);
        if (!controller.signal.aborted) {
          if (offset > 0 && offset >= value.total) setOffset(Math.max(0, Math.ceil(value.total / 25) - 1) * 25);
          setSnapshot({ key, value }); setError(null);
        }
      } catch (failure) {
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) { onAccessError(failure); return; }
        setError("Не удалось загрузить события. Сохранённые записи остаются на сервере.");
      } finally { if (!controller.signal.aborted) setBusy(false); }
    };
    void load();
    const timer = setInterval(() => { if (!document.hidden) void load(); }, 30000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [rangeMinutes, query, source, code, offset, version, key, onAccessError]);
  const data = snapshot?.key === key ? snapshot.value : null;
  const time = (value: string) => new Date(value).toLocaleString("ru-RU", { timeZone: "UTC", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  return <section className={styles.panel} aria-busy={busy}>
    <div className={styles.viewHeading}>
      <label className={styles.selectLabel}><span>Период</span><select className={styles.select} value={rangeMinutes} onChange={event => { setRange(Number(event.target.value)); setOffset(0); }}>
        <option value={60}>1 час</option><option value={360}>6 часов</option><option value={1440}>24 часа</option><option value={10080}>7 дней</option><option value={43200}>30 дней</option>
      </select></label>
      <label className={styles.selectLabel}><span>Игрок</span><input className={styles.select} value={input} maxLength={100} onChange={event => setInput(event.target.value)} placeholder="Имя или публичный код" /></label>
      <label className={styles.selectLabel}><span>Источник</span><select className={styles.select} value={source} onChange={event => { setSource(event.target.value as typeof source); setOffset(0); }}><option value="">Все источники</option><option value="client">Браузер</option><option value="server">API</option></select></label>
      <label className={styles.selectLabel}><span>Код события</span><input className={styles.select} value={codeInput} maxLength={64} onChange={event => setCodeInput(event.target.value)} list="incident-codes" placeholder="Все коды" /><datalist id="incident-codes">{Object.keys(INCIDENT_MESSAGES).map(value => <option value={value} key={value} />)}</datalist></label>
      <button type="button" className={styles.textButton} disabled={busy} onClick={() => setVersion(value => value + 1)}><RefreshCw size={18} />Обновить</button>
    </div>
    <p className={styles.muted}>Время UTC. Браузер может отправить событие позже, после восстановления связи. Повторы объединяются. Хранение — 30 дней.</p>
    {data && <p className={styles.muted}>Записей: {data.total.toLocaleString("ru-RU")} · С повторами: {data.totalOccurrences.toLocaleString("ru-RU")} · Игроков в выборке: {data.affectedUsers.toLocaleString("ru-RU")}</p>}
    {error && <p role="alert">{error}</p>}
    <span role="status" className={styles.muted}>{copyNotice}</span>
    <div className={styles.incidentList}>
      {data?.events.map(event => <article key={event.id} className={styles.incidentItem}>
        <div><strong>{INCIDENT_MESSAGES[event.code] ?? event.code}</strong><span className={styles.adminBadge}>{event.source === "server" ? "Ответ API" : "Сообщение браузера"}</span></div>
        <p><strong>{event.displayName}</strong> · <code>{event.publicId}</code></p>
        <p>{time(event.occurredAt)} · {event.operation}{event.httpStatus ? ` · HTTP ${event.httpStatus}` : ""} · ×{event.occurrences}</p>
        <small>Получено {time(event.receivedAt)} · В очереди: {event.pendingTaps.toLocaleString("ru-RU")}</small>
        <small><code>{event.code}</code>{event.requestId ? <> · Запрос <code>{event.requestId}</code><button type="button" className={styles.textButton} aria-label="Скопировать номер запроса" onClick={() => { void copyText(event.requestId!).then(copied => setCopyNotice(copied ? "Номер запроса скопирован" : "Выделите номер запроса и скопируйте вручную")); }}><Copy size={15} /></button></> : null}</small>
        <details><summary>Что проверить</summary><p>{incidentAdvice(event.code)}</p></details>
      </article>)}
      {!data && busy && <p>Загружаем события…</p>}{data && !data.events.length && !error && <p>За выбранный период событий не найдено.</p>}
    </div>
    <div className={styles.viewHeading}>
      <button type="button" className={styles.textButton} disabled={busy || offset === 0} onClick={() => setOffset(Math.max(0, offset - 25))}><ChevronLeft size={18} />Назад</button>
      <span>{data ? `${data.total ? offset + 1 : 0}–${Math.min(offset + 25, data.total)} из ${data.total}` : "—"}</span>
      <button type="button" className={styles.textButton} disabled={busy || !data || offset + 25 >= data.total} onClick={() => setOffset(offset + 25)}>Далее<ChevronRight size={18} /></button>
    </div>
  </section>;
}
