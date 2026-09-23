"use client";

import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RefreshCw } from "lucide-react";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { feedbackCategories, feedbackStatuses, getAdminFeedback, updateAdminFeedbackStatus,
  type AdminFeedbackPage, type FeedbackCategory, type FeedbackStatus } from "@/features/feedback/feedback-api";
import styles from "./admin-feedback-panel.module.css";

const PAGE_SIZE = 25;
const dateFormatter = new Intl.DateTimeFormat("ru-RU", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function AdminFeedbackPanel({ onAccessError, refreshVersion = 0 }: { onAccessError: (error: ApiError) => void; refreshVersion?: number }) {
  const [status, setStatus] = useState<FeedbackStatus | "all">("new");
  const [category, setCategory] = useState<FeedbackCategory | "all">("all");
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [snapshot, setSnapshot] = useState<{ key: string; value: AdminFeedbackPage } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [changingId, setChangingId] = useState<string | null>(null);
  const actionRef = useRef<AbortController | null>(null);
  const pendingRef = useRef<{ id: string; status: FeedbackStatus; requestId: string } | null>(null);
  const key = JSON.stringify([status, category, offset]);

  useEffect(() => () => { actionRef.current?.abort(); }, []);
  useEffect(() => {
    const controller = new AbortController();
    let busy = false;
    async function load() {
      if (busy || controller.signal.aborted) return;
      busy = true;
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setLoading(true);
      try {
        const value = await getAdminFeedback({ status, category, offset, limit: PAGE_SIZE }, controller.signal);
        if (controller.signal.aborted) return;
        if (offset > 0 && !value.items.length && value.total <= offset) {
          setOffset(Math.max(0, Math.floor((value.total - 1) / PAGE_SIZE) * PAGE_SIZE));
          return;
        }
        setSnapshot({ key, value }); setError(null);
      } catch (cause) {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) { onAccessError(cause); return; }
        setError(cause instanceof ApiError ? cause.message : "Не удалось получить обращения. Повторите запрос.");
      } finally { busy = false; if (!controller.signal.aborted) setLoading(false); }
    }
    void load();
    const timer = globalThis.setInterval(() => { if (!document.hidden) void load(); }, 30_000);
    const refresh = () => { if (!document.hidden) void load(); };
    window.addEventListener("focus", refresh);
    return () => { controller.abort(); globalThis.clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [status, category, offset, version, key, refreshVersion, onAccessError]);

  async function changeStatus(id: string, nextStatus: FeedbackStatus) {
    if (actionRef.current) return;
    const controller = new AbortController();
    actionRef.current = controller;
    const previous = pendingRef.current;
    const pending = previous?.id === id && previous.status === nextStatus ? previous : { id, status: nextStatus, requestId: createUuidV4() };
    pendingRef.current = pending;
    setChangingId(id); setActionError(null);
    try {
      await updateAdminFeedbackStatus(id, nextStatus, pending.requestId, controller.signal);
      if (controller.signal.aborted) return;
      pendingRef.current = null;
      setVersion(value => value + 1);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) { onAccessError(cause); return; }
      setActionError(cause instanceof ApiError ? cause.message : "Статус не подтверждён. Нажмите ещё раз, чтобы повторить запрос.");
    } finally {
      if (!controller.signal.aborted) { setChangingId(null); actionRef.current = null; }
    }
  }

  const data = snapshot?.key === key ? snapshot.value : null;
  return <section className={styles.panel} aria-busy={loading}>
    <div className={styles.toolbar}>
      <label>Статус<select value={status} onChange={event => { setStatus(event.target.value as typeof status); setOffset(0); }}><option value="all">Все обращения</option>{Object.entries(feedbackStatuses).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <label>Тема<select value={category} onChange={event => { setCategory(event.target.value as typeof category); setOffset(0); }}><option value="all">Все темы</option>{Object.entries(feedbackCategories).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label>
      <button type="button" disabled={loading} onClick={() => setVersion(value => value + 1)}><RefreshCw size={17} aria-hidden="true" />Обновить</button>
    </div>
    <p className={styles.description}>Ошибки, идеи и вопросы от игроков. Одно обращение от аккаунта за 24 часа. Статус виден только администраторам.</p>
    {error && <p className={styles.error} role="alert">{error}{data ? " Показаны последние полученные данные." : ""}</p>}
    {actionError && <p className={styles.error} role="alert">{actionError}</p>}
    <div className={styles.list}>
      {data?.items.map(item => <article className={styles.item} key={item.id}>
        <div className={styles.meta}><span className={styles.category}>{feedbackCategories[item.category]}</span><span className={styles.badge} data-status={item.status}>{feedbackStatuses[item.status]}</span><time dateTime={item.createdAt}>{dateFormatter.format(new Date(item.createdAt))} UTC</time></div>
        <div className={styles.author}><strong>{item.authorDisplayName}</strong><code>{item.authorPublicId}</code></div>
        <p className={styles.message}>{item.message}</p>
        <div className={styles.actions} aria-label={`Статус обращения от ${item.authorDisplayName}`}>
          {(Object.entries(feedbackStatuses) as [FeedbackStatus, string][]).map(([value, label]) => <button type="button" key={value} disabled={changingId !== null || item.status === value} aria-pressed={item.status === value} onClick={() => { void changeStatus(item.id, value); }}>{value === "new" ? "Вернуть в новые" : value === "reviewed" ? "Отметить просмотренным" : label}</button>)}
          {changingId === item.id && <span role="status">Сохраняем…</span>}
        </div>
      </article>)}
      {!data && loading && <p role="status">Загружаем обращения…</p>}
      {data?.items.length === 0 && <p className={styles.empty}>Обращений с такими фильтрами пока нет.</p>}
    </div>
    <div className={styles.pagination}>
      <button type="button" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}><ChevronLeft size={17} aria-hidden="true" />Назад</button>
      <span>{data ? `${data.total ? offset + 1 : 0}–${Math.min(offset + PAGE_SIZE, data.total)} из ${data.total}` : "—"}</span>
      <button type="button" disabled={loading || !data || offset + PAGE_SIZE >= data.total} onClick={() => setOffset(offset + PAGE_SIZE)}>Далее<ChevronRight size={17} aria-hidden="true" /></button>
    </div>
  </section>;
}
