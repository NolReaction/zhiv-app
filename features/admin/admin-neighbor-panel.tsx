"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { RefreshCw, TreePine } from "lucide-react";
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { economyCatalog } from "@/features/economy/domain/model";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { validAdminReason } from "./admin-input";
import { definitiveNeighborFailure, loadAdminNeighbor, writeAdminNeighbor, type AdminNeighborView } from "./admin-neighbor-api";
import { readNeighborAttempt, saveNeighborAttempt, type NeighborAttempt } from "./admin-neighbor-journal";
import { AdminNeighborSettingsForm, AdminNeighborSettingsSummary } from "./admin-neighbor-settings";
import adminStyles from "./admin-dashboard.module.css";
import styles from "./admin-neighbor-panel.module.css";

const publicIdPattern = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/;
const itemName = (id: string) => economyCatalog.items.find(item => item.id === id)?.name ?? id;
const time = (value: string) => new Intl.DateTimeFormat("ru-RU", {
  timeZone: "UTC", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
}).format(new Date(value));
const isDenied = (error: unknown): error is ApiError => error instanceof ApiError && (error.status === 401 || error.status === 403);
const message = (error: unknown) => error instanceof ApiError ? error.message : "Ответ не получен. Проверьте соединение и повторите запрос.";

export function AdminNeighborPanel({ actorPublicId, onAccessLost }: {
  actorPublicId: string; onAccessLost: (error: ApiError) => void;
}) {
  const [data, setData] = useState<AdminNeighborView | null>(null);
  const [verified, setVerified] = useState(false);
  const [closed, setClosed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState("");
  const [query, setQuery] = useState("");
  const [reason, setReason] = useState("");
  const [readError, setReadError] = useState("");
  const [writeError, setWriteError] = useState("");
  const [notice, setNotice] = useState("");
  const [pending, setPending] = useState<NeighborAttempt | null>(() => readNeighborAttempt(actorPublicId));
  const [review, setReview] = useState<NeighborAttempt | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const alive = useRef(false);
  const writeController = useRef<AbortController | null>(null);
  const readController = useRef<AbortController | null>(null);
  const reviewTrigger = useRef<HTMLElement | null>(null);
  const locked = loading || busy || pending !== null || !!readError || closed;
  const searchLocked = loading || busy || pending !== null || closed;

  useLayoutEffect(() => {
    alive.current = true;
    return () => { alive.current = false; writeController.current?.abort(); readController.current?.abort(); };
  }, [actorPublicId]);

  useEffect(() => {
    const controller = new AbortController(); readController.current = controller;
    void Promise.resolve().then(async () => {
      if (controller.signal.aborted || closed) return;
      setLoading(true); setReadError("");
      try {
        const result = await loadAdminNeighbor(actorPublicId, target, controller.signal);
        if (controller.signal.aborted || !alive.current) return;
        setData(result); setVerified(true);
      } catch (error) {
        if (controller.signal.aborted || !alive.current) return;
        if (isDenied(error)) {
          setData(null); setVerified(false); setClosed(true); setReview(null); onAccessLost(error);
        } else setReadError(message(error));
      } finally { if (!controller.signal.aborted && alive.current) setLoading(false); }
    });
    return () => controller.abort();
  }, [actorPublicId, target, reload, closed, onAccessLost]);

  useEffect(() => {
    if (!pending) return;
    const guard = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [pending]);

  function openReview(attempt: NeighborAttempt) {
    reviewTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReview(attempt); setConfirmed(false); setWriteError("");
  }
  async function submit() {
    if (sending.current || !review || !confirmed || !verified || closed || (!pending && locked)) return;
    const attempt = pending ?? review;
    if (!saveNeighborAttempt(actorPublicId, attempt)) {
      setWriteError("Браузер не сохранил запрос. Операция не отправлена. Разрешите хранилище и повторите."); return;
    }
    sending.current = true; setBusy(true); setPending(attempt); setWriteError(""); setNotice("");
    readController.current?.abort();
    const controller = new AbortController(); writeController.current = controller;
    try {
      const result = await writeAdminNeighbor(actorPublicId, attempt.kind, attempt.body, controller.signal);
      if (controller.signal.aborted || !alive.current) return;
      saveNeighborAttempt(actorPublicId, null);
      setData(result); setTarget(result.player?.publicId ?? ""); setLoading(false); setReadError("");
      setPending(null); setReview(null); setConfirmed(false); setReason("");
      setNotice(`${result.receipt.replayed ? "Операция уже была выполнена. Получено подтверждение." : attempt.kind === "settings" ? "Настройки сохранены." : "Лот выкуплен. Продавец может забрать выручку на рынке."} Запрос ${result.receipt.requestId}.`);
    } catch (error) {
      if (controller.signal.aborted || !alive.current) return;
      if (isDenied(error)) {
        setData(null); setVerified(false); setClosed(true); setReview(null); onAccessLost(error); return;
      }
      if (definitiveNeighborFailure(error)) {
        saveNeighborAttempt(actorPublicId, null); setPending(null); setReview(null); setConfirmed(false);
        setReload(value => value + 1);
      }
      setWriteError(message(error));
    } finally { sending.current = false; if (!controller.signal.aborted && alive.current) setBusy(false); }
  }

  return <div className={styles.stack}>
    <section className={adminStyles.panel}>
      <div className={styles.heading}><div><h2><TreePine size={20} aria-hidden="true" /> Лесной сосед</h2><span className={styles.badge}>Персонаж мира · berest</span>
        <p>Личная лавка, показательное хозяйство и небольшой выкуп товаров игроков.</p></div>
        <button type="button" className={styles.button} disabled={loading || busy || closed} onClick={() => setReload(value => value + 1)}><RefreshCw size={17} />Обновить</button>
      </div>
      {readError && <p className={styles.error} role="alert">{readError}</p>}
      {loading && <p className={styles.hint} role="status">Получаем настройки и журнал…</p>}
      {verified && data && <>
        <p className={styles.hint}>Снимок {time(data.serverTime)} UTC · версия {data.version}. {data.pausedReason ?? "Автоматический выкуп работает по расписанию."}</p>
        <p className={styles.hint}>Сегодня выкуплено на {data.usage.globalSpentCoins} из {data.settings.globalDailyBudgetCoins} монет общего бюджета.</p>
        <details><summary>Действующие настройки</summary><AdminNeighborSettingsSummary settings={data.settings} /></details>
      </>}
    </section>
    {verified && !closed && <>
      {notice && <p className={styles.success} role="status">{notice}</p>}
      {writeError && !review && <p className={styles.error} role="alert">{writeError}</p>}
      {pending && <section className={styles.notice} aria-label="Незавершённая операция">
        <strong>Ожидает подтверждения: {pending.kind === "settings" ? "изменение настроек" : "выкуп лота"}</strong>
        <p>Повтор отправит тот же запрос. До подтверждения новые действия заблокированы.</p>
        <p className={styles.requestId}>{pending.body.requestId}</p>
        <button type="button" className={styles.button} disabled={busy} onClick={() => openReview(pending)}>Проверить тот же запрос</button>
      </section>}
      {data && <>
        <section className={adminStyles.panel}><div className={styles.heading}><h3>Настройки соседа</h3></div>
          <AdminNeighborSettingsForm key={data.version} settings={data.settings} disabled={locked} onReview={(settings, auditReason) => openReview({
            kind: "settings", body: { requestId: createUuidV4(), expectedVersion: data.version, settings, reason: auditReason },
          })} />
        </section>
        <section className={adminStyles.panel}>
          <div className={styles.heading}><div><h3>Выкупить лот игрока</h3><p>Ручной выкуп пропускает ожидание. Цена, комиссия, дневные лимиты и бюджет проверяются сервером.</p></div></div>
          <form className={styles.search} onSubmit={event => { event.preventDefault(); if (!searchLocked && publicIdPattern.test(query.trim())) { setTarget(query.trim()); setReload(value => value + 1); } }}>
            <label className={styles.field}>Публичный ID игрока<input value={query} placeholder="XXXX-XXXX-XXXX" maxLength={14} autoCapitalize="characters" spellCheck={false} disabled={searchLocked} onChange={event => setQuery(event.target.value.toUpperCase())} /></label>
            <button type="submit" className={styles.button} disabled={searchLocked || !publicIdPattern.test(query.trim())}>Найти лоты</button>
          </form>
          {data.player && data.player.publicId === target && <>
            <p><strong>{data.player.name}</strong> · <code>{data.player.publicId}</code></p>
            <p className={styles.hint}>Выкуплено сегодня: {data.usage.usedLots} из {data.settings.maxLotsPerDay} лотов · потрачено {data.usage.spentCoins} из {data.settings.dailyBudgetCoins} монет.</p>
            <label className={styles.field}>Причина ручной покупки<textarea value={reason} disabled={locked} maxLength={240} placeholder="Для внутреннего журнала, от 8 символов" onChange={event => setReason(event.target.value)} /></label>
            {data.pending.length === 0 ? <p className={styles.hint}>У игрока нет активных лотов.</p> : <Table>
              <TableHeader><TableRow><TableHead>Лот</TableHead><TableHead>Цена / выручка</TableHead><TableHead>Состояние</TableHead><TableHead>Действие</TableHead></TableRow></TableHeader>
              <TableBody>{data.pending.map(lot => <TableRow key={lot.id}>
                <TableCell><strong>{itemName(lot.itemId)} × {lot.quantity}</strong><small>{time(lot.createdAt)} UTC</small><small>{lot.id}</small></TableCell>
                <TableCell>{lot.totalPrice} монет<small>Продавцу: {lot.proceedsCoins ?? "не подтверждено"}</small></TableCell>
                <TableCell>{lot.reason ?? (lot.eligible ? "Можно выкупить вручную" : "Выкуп недоступен")}</TableCell>
                <TableCell><button type="button" className={styles.button} disabled={locked || !lot.eligible || lot.proceedsCoins === undefined || !validAdminReason(reason)} onClick={() => {
                  if (lot.proceedsCoins === undefined) return;
                  openReview({ kind: "buy", body: { requestId: createUuidV4(), listingId: lot.id, playerPublicId: lot.sellerPublicId, expectedTotalPrice: lot.totalPrice, reason: reason.trim() },
                    selection: { ...lot, proceedsCoins: lot.proceedsCoins } });
                }}>Проверить покупку</button></TableCell>
              </TableRow>)}</TableBody>
            </Table>}
          </>}
        </section>
        <section className={adminStyles.panel}><div className={styles.heading}><div><h3>Журнал выкупа</h3><p>Последние {data.history.length} операций, максимум 50 · время UTC{data.player ? ` · игрок ${data.player.publicId}` : " · все игроки"}</p></div></div>
          {data.history.length === 0 ? <p className={styles.hint}>Выкупов пока нет.</p> : <Table>
            <TableHeader><TableRow><TableHead>Когда / источник</TableHead><TableHead>Игрок / лот</TableHead><TableHead>Товар</TableHead><TableHead>Цена / выручка</TableHead></TableRow></TableHeader>
            <TableBody>{data.history.map(operation => <TableRow key={operation.id}>
              <TableCell>{time(operation.createdAt)}<small>{operation.source === "manual" ? "Вручную" : "Автоматически"}</small></TableCell>
              <TableCell><code>{operation.sellerPublicId}</code><small>{operation.listingId}</small>{operation.requestId && <small>Запрос: {operation.requestId}</small>}</TableCell>
              <TableCell>{itemName(operation.itemId)} × {operation.quantity}</TableCell>
              <TableCell>{operation.totalPrice} монет<small>Продавцу: {operation.proceedsCoins}</small><small>Комиссия: {operation.totalPrice - operation.proceedsCoins}</small></TableCell>
            </TableRow>)}</TableBody>
          </Table>}
        </section>
      </>}
      <AlertDialog open={review !== null} onOpenChange={open => { if (!open && !busy) { setReview(null); setConfirmed(false); } }}>
        <AlertDialogContent className={styles.dialog} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onCloseAutoFocus={event => { event.preventDefault(); reviewTrigger.current?.focus(); }}>
          <AlertDialogHeader><AlertDialogTitle>{review?.kind === "buy" ? "Подтвердить выкуп лота" : "Подтвердить настройки соседа"}</AlertDialogTitle>
            <AlertDialogDescription className={styles.dialogDescription}>{pending ? "Ответ на этот запрос ещё не подтверждён. Повтор использует тот же идентификатор и не создаёт вторую покупку." : "Проверьте точные условия. Операция будет сохранена в журнале администратора."}</AlertDialogDescription></AlertDialogHeader>
          {review?.kind === "settings" && <AdminNeighborSettingsSummary settings={review.body.settings} />}
          {review?.kind === "buy" && <dl className={styles.summary}>
            <div><dt>Продавец</dt><dd>{review.selection.sellerName} · <code>{review.body.playerPublicId}</code></dd></div>
            <div><dt>Лот</dt><dd>{itemName(review.selection.itemId)} × {review.selection.quantity}<br /><code>{review.body.listingId}</code></dd></div>
            <div><dt>Цена</dt><dd>{review.body.expectedTotalPrice} монет</dd></div>
            <div><dt>Продавцу после комиссии</dt><dd>{review.selection.proceedsCoins} монет · комиссия {review.selection.totalPrice - review.selection.proceedsCoins}</dd></div>
          </dl>}
          <p className={styles.hint}>Причина: {review?.body.reason}</p>
          <p className={styles.requestId}>Запрос: {review?.body.requestId}</p>
          {writeError && <p className={styles.error} role="alert">{writeError}</p>}
          <label className={styles.confirm}><input type="checkbox" checked={confirmed} disabled={busy} onChange={event => setConfirmed(event.target.checked)} />Подтверждаю показанные условия и причину</label>
          <div className={styles.dialogActions}><button type="button" className={styles.button} disabled={busy} onClick={() => { setReview(null); setConfirmed(false); }}>Закрыть</button>
            <button type="button" className={styles.primaryButton} disabled={busy || !confirmed || (!pending && locked)} onClick={() => void submit()}>{busy ? "Ожидаем ответ…" : pending ? "Повторить тот же запрос" : review?.kind === "buy" ? "Выкупить этот лот" : "Сохранить настройки"}</button></div>
        </AlertDialogContent>
      </AlertDialog>
    </>}
  </div>;
}
