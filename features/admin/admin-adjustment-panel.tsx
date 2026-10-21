"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { formatPearls } from "@/features/economy/domain/money";
import type { AdminEconomyDetail } from "./admin-api";
import { adjustAdminEconomy, adjustmentPreview, readAdjustmentAttempt, saveAdjustmentAttempt, type AdminAdjustment } from "./admin-adjustment-api";
import { AdminDeliveryFields, AdminDeliveryPreview } from "./admin-delivery";
import { deliveryIssue, deliveryMessage, type AdminDelivery } from "./admin-delivery-contract";
import { validAdminReason } from "./admin-input";
import styles from "./admin-mail.module.css";
import { definitiveAdminWriteFailure } from "./admin-write-outcome";

export function AdminAdjustmentPanel({ actorPublicId, targetPublicId, detail, disabled, onLockChange, onChanged, onAccessLost }: {
  actorPublicId: string; targetPublicId: string; detail: AdminEconomyDetail | null; disabled: boolean;
  onLockChange: (value: boolean) => void; onChanged: () => void; onAccessLost: (error: ApiError) => void;
}) {
  const [pending, setPending] = useState<AdminAdjustment | null>(() => readAdjustmentAttempt(actorPublicId, targetPublicId));
  const [coins, setCoins] = useState(() => String(pending?.coinsDelta ?? 0));
  const [pearls, setPearls] = useState(() => String(pending?.pearlsDelta ?? 0));
  const [reason, setReason] = useState(pending?.reason ?? "");
  const [confirmation, setConfirmation] = useState(pending?.confirmationPublicId ?? "");
  const [delivery, setDelivery] = useState<AdminDelivery>(pending?.delivery ?? "silent");
  const [title, setTitle] = useState(pending?.playerMessage?.title ?? "");
  const [body, setBody] = useState(pending?.playerMessage?.body ?? "");
  const [review, setReview] = useState(!!pending);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [accessClosed, setAccessClosed] = useState(false);
  const write = useRef<AbortController | null>(null), sending = useRef(false);
  const [mountedKey] = useState(`${actorPublicId}:${targetPublicId}`);
  const locked = busy || !!pending;
  const economy = detail?.publicId === targetPublicId ? detail.economy : null;
  const preview = economy ? adjustmentPreview(economy.wallet, coins, pearls) : null;
  const issue = preview?.issue ?? (!economy ? "Для корректировки сначала нужен созданный профиль хозяйства. Используйте обычную выдачу." : null);
  const playerMessage = deliveryMessage(delivery, title, body);
  const messageIssue = deliveryIssue(delivery, title, body);
  const ready = !disabled && !issue && !messageIssue && validAdminReason(reason) && confirmation === targetPublicId;
  useEffect(() => { onLockChange(locked); return () => onLockChange(false); }, [locked, onLockChange]);
  useEffect(() => () => write.current?.abort(), [actorPublicId, targetPublicId]);
  useEffect(() => {
    if (!pending) return;
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", prevent); return () => window.removeEventListener("beforeunload", prevent);
  }, [pending]);
  async function submit() {
    if (sending.current || mountedKey !== `${actorPublicId}:${targetPublicId}` || (!pending && (disabled || !ready || !review || !preview || !economy))) return;
    const request = pending ?? { requestId: createUuidV4(), confirmationPublicId: targetPublicId, reason: reason.trim(),
      expectedRevision: economy!.revision, coinsDelta: preview!.coinsDelta!, pearlsDelta: preview!.pearlsDelta!, delivery,
      ...(playerMessage ? { playerMessage } : {}) };
    if (!saveAdjustmentAttempt(actorPublicId, targetPublicId, request)) { setError("Браузер не сохранил запрос. Корректировка не отправлена. Разрешите хранилище и повторите."); return; }
    setPending(request); setBusy(true); setError(""); setNotice(""); sending.current = true;
    const controller = new AbortController(); write.current = controller;
    try {
      const receipt = await adjustAdminEconomy(actorPublicId, targetPublicId, request, controller.signal);
      if (controller.signal.aborted) return;
      saveAdjustmentAttempt(actorPublicId, targetPublicId, null); setPending(null); setReview(false);
      setCoins("0"); setPearls("0"); setConfirmation(""); setNotice(`Корректировка подтверждена. Ревизия ${receipt.acceptedRevision}.`); onChanged();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && [401, 403].includes(cause.status)) {
        setAccessClosed(true); setPending(null); setReview(false); setReason(""); setTitle(""); setBody(""); onAccessLost(cause); return;
      }
      if (definitiveAdminWriteFailure(cause)) {
        saveAdjustmentAttempt(actorPublicId, targetPublicId, null); setPending(null); setReview(false); setConfirmation(""); onChanged();
      }
      setError(cause instanceof Error ? cause.message : "Ответ не получен. Проверьте тот же запрос.");
    } finally { sending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  if (mountedKey !== `${actorPublicId}:${targetPublicId}`) return null;
  if (accessClosed) return <p className={styles.hint} role="status">Доступ потерян. Операция могла быть принята; после входа исходным администратором проверьте прежний запрос.</p>;
  return <details className={styles.card} open={!!pending || review}>
    <summary>Корректировка баланса</summary>
    <div className={styles.panel}>
      <p className={styles.hint}>Отдельная операция для исправления баланса. Знак минус списывает валюту, плюс добавляет. Сервер проверит ревизию и итоговый баланс.</p>
      <fieldset disabled={locked || disabled} className={styles.panel}>
        <div className={styles.deltaGrid}>
          <label className={styles.field}>Изменение монет<input value={coins} inputMode="text" onChange={event => { setCoins(event.target.value); setReview(false); }} placeholder="Например, -100" /></label>
          <label className={styles.field}>Изменение жемчуга<input value={pearls} inputMode="text" onChange={event => { setPearls(event.target.value); setReview(false); }} placeholder="Например, +10" /></label>
        </div>
        <p className={styles.hint}>Изменения задаются целыми игровыми единицами. Имеющаяся половина жемчужины сохраняется.</p>
        <label className={styles.field}>Внутренняя причина корректировки<input value={reason} maxLength={240} onChange={event => { setReason(event.target.value); setReview(false); }} /></label>
        <label className={styles.field}>Подтвердите ID игрока<input value={confirmation} autoComplete="off" onChange={event => setConfirmation(event.target.value.toUpperCase())} placeholder={targetPublicId} /></label>
        <AdminDeliveryFields delivery={delivery} title={title} body={body} disabled={locked || disabled}
          onDelivery={value => { setDelivery(value); setReview(false); }} onTitle={value => { setTitle(value); setReview(false); }} onBody={value => { setBody(value); setReview(false); }} />
      </fieldset>
      {!pending && preview && !preview.issue && <ul className={styles.balancePreview} aria-label="Предпросмотр корректировки">
        <li><span>Монеты</span><strong>{economy!.wallet.coins.toLocaleString("ru-RU")} → {preview.coins!.toLocaleString("ru-RU")}</strong></li>
        <li><span>Жемчуг</span><strong>{formatPearls(economy!.wallet.pearls)} → {formatPearls(preview.pearls!)}</strong></li>
      </ul>}
      {!pending && (issue || messageIssue) && <p className={styles.hint} role="status">{issue || messageIssue}</p>}
      {pending && <div className={styles.notice}><p>Ответ ещё не подтверждён. Исходная ревизия: {pending.expectedRevision}. Монеты: {pending.coinsDelta > 0 ? "+" : ""}{pending.coinsDelta}; жемчуг: {pending.pearlsDelta > 0 ? "+" : ""}{pending.pearlsDelta}.</p><p>Текущее состояние уже может включать эту операцию. Повтор отправит прежний UUID и тот же состав, включая письмо.</p><code>{pending.requestId}</code></div>}
      {(review || pending) && <AdminDeliveryPreview {...(pending ?? { delivery, playerMessage })} />}
      {error && <p className={styles.error} role="alert">{error}</p>}{notice && <p className={styles.notice} role="status">{notice}</p>}
      <div className={styles.actions}>{!review && !pending ? <button type="button" className={styles.button} disabled={!ready || busy} onClick={() => setReview(true)}>Проверить корректировку</button>
        : <><button type="button" className={styles.button} disabled={locked} onClick={() => setReview(false)}>Изменить</button><button type="button" className={styles.primary} disabled={busy || (!pending && (disabled || !ready))} onClick={() => void submit()}>{busy ? "Проверяем…" : pending ? "Проверить прежнюю корректировку" : "Подтвердить корректировку"}</button></>}</div>
    </div>
  </details>;
}
