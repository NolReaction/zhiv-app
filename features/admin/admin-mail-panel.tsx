"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { getAdminUsers, verifyAdminActor, type AdminUser } from "./admin-api";
import { adminBroadcastSchema, loadAdminBroadcasts, readBroadcastAttempt, saveBroadcastAttempt, sendAdminBroadcast,
  type AdminBroadcastHistory, type AdminBroadcastRequest } from "./admin-mail-api";
import styles from "./admin-mail.module.css";
import { definitiveAdminWriteFailure } from "./admin-write-outcome";

const date = (value: string) => new Date(value).toLocaleString("ru-RU", { timeZone: "UTC" });
export function AdminMailPanel({ actorPublicId, onAccessLost }: { actorPublicId: string; onAccessLost: (error: ApiError) => void }) {
  const [pending, setPending] = useState<AdminBroadcastRequest | null>(() => readBroadcastAttempt(actorPublicId));
  const [title, setTitle] = useState(pending?.title ?? ""), [body, setBody] = useState(pending?.body ?? "");
  const [reason, setReason] = useState(pending?.reason ?? ""), [confirmation, setConfirmation] = useState("");
  const [audience, setAudience] = useState<"all" | "players">(pending?.audience ?? "players");
  const [selected, setSelected] = useState<{ publicId: string; displayName: string }[]>(() => (pending?.publicIds ?? []).map(publicId => ({ publicId, displayName: publicId })));
  const [notify, setNotify] = useState(pending?.notify ?? false), [review, setReview] = useState(!!pending);
  const [query, setQuery] = useState(""), [users, setUsers] = useState<{ actor: string; query: string; value: AdminUser[] } | null>(null);
  const [history, setHistory] = useState<{ actor: string; offset: number; value: AdminBroadcastHistory } | null>(null);
  const [offset, setOffset] = useState(0), [version, setVersion] = useState(0);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [actorVerified, setActorVerified] = useState(false);
  const [historyError, setHistoryError] = useState(""), [searchError, setSearchError] = useState("");
  const write = useRef<AbortController | null>(null), sending = useRef(false);
  const [mountedActor] = useState(actorPublicId);
  const locked = busy || !!pending;
  const accessLost = useCallback((cause: ApiError) => {
    setPending(null); setHistory(null); setUsers(null); setActorVerified(false);
    setTitle(""); setBody(""); setReason(""); setSelected([]); onAccessLost(cause);
  }, [onAccessLost]);
  useEffect(() => {
    const controller = new AbortController();
    void verifyAdminActor(actorPublicId, controller.signal).then(() => {
      if (controller.signal.aborted) return null;
      setActorVerified(true); return loadAdminBroadcasts(actorPublicId, offset, controller.signal);
    }).then(value => {
      if (!value) return;
      if (!controller.signal.aborted) { setHistory({ actor: actorPublicId, offset, value }); setHistoryError(""); }
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) accessLost(cause);
      else setHistoryError(cause instanceof Error ? cause.message : "История рассылок недоступна.");
    });
    return () => controller.abort();
  }, [actorPublicId, offset, version, accessLost]);
  useEffect(() => {
    if (audience !== "players" || locked) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      void (async () => {
        await verifyAdminActor(actorPublicId, controller.signal);
        const result = await getAdminUsers({ q: query.trim(), sort: "created", offset: 0, limit: 8 }, controller.signal);
        await verifyAdminActor(actorPublicId, controller.signal);
        if (!controller.signal.aborted) { setUsers({ actor: actorPublicId, query: query.trim(), value: result.users }); setSearchError(""); }
      })().catch(cause => {
        if (controller.signal.aborted) return;
        if (cause instanceof ApiError && [401, 403].includes(cause.status)) accessLost(cause);
        else setSearchError(cause instanceof Error ? cause.message : "Поиск недоступен.");
      });
    }, 250);
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [actorPublicId, audience, query, locked, accessLost]);
  useEffect(() => () => write.current?.abort(), [actorPublicId]);
  useEffect(() => {
    if (!pending) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard); return () => window.removeEventListener("beforeunload", guard);
  }, [pending]);
  const candidate = { requestId: "00000000-0000-4000-8000-000000000000", title: title.trim(), body: body.trim().replace(/\r\n?/g, "\n"), reason: reason.trim(),
    audience, publicIds: audience === "players" ? selected.map(user => user.publicId) : [], notify, confirmation: "ОТПРАВИТЬ" as const };
  const valid = adminBroadcastSchema.safeParse(candidate).success;
  async function submit() {
    if (sending.current || mountedActor !== actorPublicId || (!pending && (!review || !valid || confirmation !== "ОТПРАВИТЬ"))) return;
    const request = pending ?? { ...candidate, requestId: createUuidV4() };
    if (!saveBroadcastAttempt(actorPublicId, request)) { setError("Браузер не сохранил запрос. Рассылка не отправлена. Разрешите хранилище и повторите."); return; }
    sending.current = true; setPending(request); setBusy(true); setError(""); setNotice("");
    const controller = new AbortController(); write.current = controller;
    try {
      const receipt = await sendAdminBroadcast(actorPublicId, request, controller.signal);
      if (controller.signal.aborted) return;
      saveBroadcastAttempt(actorPublicId, null); setPending(null); setReview(false); setConfirmation("");
      setTitle(""); setBody(""); setReason(""); setSelected([]); setNotice(`Рассылка подтверждена. Получателей: ${receipt.recipientCount.toLocaleString("ru-RU")}.`); setVersion(value => value + 1); setOffset(0);
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) { accessLost(cause); return; }
      if (definitiveAdminWriteFailure(cause)) { saveBroadcastAttempt(actorPublicId, null); setPending(null); setReview(false); setConfirmation(""); }
      setError(cause instanceof Error ? cause.message : "Ответ не получен. Проверьте тот же запрос.");
    } finally { sending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  const data = history?.actor === actorPublicId && history.offset === offset ? history.value : null;
  const found = users?.actor === actorPublicId && users.query === query.trim() ? users.value : [];
  const shown = pending ?? candidate;
  if (mountedActor !== actorPublicId) return null;
  if (!actorVerified) return <p className={styles.hint} role="status">{historyError || "Проверяем доступ к почте…"}</p>;
  return <div className={styles.panel}>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.columns}>
      <section className={styles.card} aria-label="Новая рассылка">
        <h2>Новое письмо</h2><p className={styles.hint}>Текст доставляется в игровую почту. Форматирование и ссылки не исполняются. Причина остаётся внутренней.</p>
        <fieldset disabled={locked || review} className={styles.panel}>
          <label className={styles.field}>Получатели<select value={audience} onChange={event => setAudience(event.target.value as "all" | "players")}><option value="players">Выбранные игроки</option><option value="all">Все доступные аккаунты</option></select></label>
          {audience === "players" && <>
            <label className={styles.field}>Найти получателя<input type="search" value={query} maxLength={100} onChange={event => setQuery(event.target.value)} placeholder="Имя или ID игрока" /></label>
            {searchError && <p role="alert" className={styles.error}>{searchError}</p>}
            <div className={styles.results}>{found.map(user => <button type="button" className={styles.button} key={user.publicId} disabled={!!user.bannedAt || selected.length >= 100 || selected.some(value => value.publicId === user.publicId)} onClick={() => setSelected(previous => user.bannedAt || previous.length >= 100 || previous.some(value => value.publicId === user.publicId) ? previous : [...previous, user])}>{user.displayName} · {user.publicId}</button>)}</div>
            <div className={styles.recipients}>{selected.map(user => <span key={user.publicId} className={styles.recipient}><span>{user.displayName}<br /><code>{user.publicId}</code></span><button type="button" className={styles.button} aria-label={`Убрать получателя ${user.publicId}`} onClick={() => setSelected(previous => previous.filter(value => value.publicId !== user.publicId))}>Убрать</button></span>)}</div>
            <p className={styles.hint}>Выбрано {selected.length} из 100. Заблокированные и удалённые аккаунты сервер исключит.</p>
          </>}
          {audience === "all" && <p className={styles.notice}>Все незаблокированные аккаунты на момент отправки. Точный состав определяет сервер, максимум 10 000 получателей.</p>}
          <label className={styles.field}>Заголовок<input value={title} maxLength={240} onChange={event => setTitle(event.target.value)} /></label>
          <label className={styles.field}>Текст письма<textarea rows={6} value={body} maxLength={4000} onChange={event => setBody(event.target.value)} /></label>
          <label className={styles.check}><input type="checkbox" checked={notify} onChange={event => setNotify(event.target.checked)} />Почта и уведомление</label><p className={styles.hint}>{notify ? "Письмо появится в почте и в уведомлениях." : "Только почта, без уведомления."}</p>
          <label className={styles.field}>Внутренняя причина<input value={reason} maxLength={240} onChange={event => setReason(event.target.value)} placeholder="От 8 символов, только в журнале" /></label>
        </fieldset>
        {!review && !pending && <button type="button" className={styles.button} disabled={!valid || busy} onClick={() => { setReview(true); setConfirmation(""); setError(""); }}>Проверить рассылку</button>}
        {(review || pending) && <>
          <div className={styles.preview}><strong>{shown.audience === "all" ? "Всем доступным аккаунтам" : `Выбранным игрокам: ${shown.publicIds.length}`}</strong>
            {shown.audience === "players" && <p>{shown.publicIds.join(" · ")}</p>}<h3>{shown.title}</h3><p>{shown.body}</p><p>{shown.notify ? "Почта и уведомление" : "Только почта"}</p>
          </div>
          {!pending && <label className={styles.field}>Для подтверждения введите ОТПРАВИТЬ<input value={confirmation} autoComplete="off" onChange={event => setConfirmation(event.target.value)} /></label>}
          {pending && <div className={styles.notice}>Ответ ещё не подтверждён. Повтор проверит тот же состав и UUID, новая рассылка не создаётся.<br /><code>{pending.requestId}</code></div>}
          <div className={styles.actions}><button type="button" className={styles.button} disabled={locked} onClick={() => setReview(false)}>Изменить письмо</button><button type="button" className={styles.primary} disabled={busy || (!pending && confirmation !== "ОТПРАВИТЬ")} onClick={() => void submit()}>{busy ? "Проверяем…" : pending ? "Проверить прежнюю рассылку" : "Отправить письмо"}</button></div>
        </>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
      <section className={styles.card} aria-label="История рассылок">
        <h2>История рассылок</h2><button type="button" className={styles.button} onClick={() => setVersion(value => value + 1)}>Обновить историю</button>
        {historyError && <p role="alert" className={styles.error}>{historyError}</p>}
        {!data ? <p className={styles.hint}>История пока не загружена.</p> : !data.broadcasts.length ? <p className={styles.hint}>Рассылок пока нет.</p> : data.broadcasts.map(item => <details className={styles.history} key={item.requestId}>
          <summary>{item.title} · {item.recipientCount} получателей</summary><p>{item.body}</p><small>{item.audience === "all" ? "Всем доступным аккаунтам" : "Выбранным игрокам"} · {item.notify ? "Почта и уведомление" : "Только почта"}</small><small>{date(item.createdAt)} UTC · {item.actorPublicId}</small><small>Внутренняя причина: {item.reason}</small><small>{item.requestId}</small>
        </details>)}
        <div className={styles.actions}><button type="button" className={styles.button} disabled={offset === 0} onClick={() => setOffset(value => Math.max(0, value - 20))}>Назад</button><button type="button" className={styles.button} disabled={!data || offset + 20 >= data.total} onClick={() => setOffset(value => value + 20)}>Далее</button></div>
      </section>
    </div>
  </div>;
}
