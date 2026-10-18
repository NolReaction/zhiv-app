"use client";

import { useEffect, useRef, useState } from "react";
import { validAdminReason } from "./admin-input";
import { Gift, LoaderCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { GAME_ITEMS, GAME_ACHIEVEMENTS } from "@/features/game/game-rewards";
import { getAdminRewards, grantAdminReward, verifyAdminActor, type AdminRewards, type AdminUser, type AdminGrantRequest } from "@/features/admin/admin-api";
import { AdminDeliveryFields, AdminDeliveryPreview } from "./admin-delivery";
import { deliveryIssue, deliveryMessage, type AdminDelivery } from "./admin-delivery-contract";
import { readLegacyRewardAttempt, saveLegacyRewardAttempt } from "./admin-legacy-delivery-journal";
import { definitiveAdminWriteFailure } from "./admin-write-outcome";
import styles from "./admin-dashboard.module.css";

const REWARDS = [
  ...GAME_ITEMS.map(item => ({ ...item, kind: "item" as const })),
  ...GAME_ACHIEVEMENTS.map(item => ({ ...item, kind: "achievement" as const })),
];

export function AdminRewardsDialog({ target, actorPublicId, onClose, onGranted, onAccessLost, returnFocus }: {
  target: AdminUser; actorPublicId: string; onClose: () => void; onGranted: (message: string) => void;
  onAccessLost: (error: ApiError) => void; returnFocus: () => void;
}) {
  const [restored] = useState(() => readLegacyRewardAttempt(actorPublicId, target.publicId));
  const [owned, setOwned] = useState<AdminRewards | null>(null);
  const [rewardId, setRewardId] = useState<string>(restored?.rewardId ?? REWARDS[0].id);
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [confirmation, setConfirmation] = useState(restored?.confirmationPublicId ?? "");
  const [delivery, setDelivery] = useState<AdminDelivery>(restored?.delivery ?? "silent");
  const [playerTitle, setPlayerTitle] = useState(restored?.playerMessage?.title ?? "");
  const [playerBody, setPlayerBody] = useState(restored?.playerMessage?.body ?? "");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [actorVerified, setActorVerified] = useState(false);
  const [attempt, setAttempt] = useState<AdminGrantRequest | null>(restored);
  const write = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const reward = REWARDS.find(item => item.id === rewardId)!;
  const multipleTiers = reward.kind === "achievement" && reward.tiers.length > 1;
  const hasReward = !multipleTiers && owned && (reward.kind === "item" ? owned.items : owned.achievements).some(id => id === rewardId);
  const messageIssue = deliveryIssue(delivery, playerTitle, playerBody);
  const playerMessage = deliveryMessage(delivery, playerTitle, playerBody);

  useEffect(() => {
    const controller = new AbortController();
    void verifyAdminActor(actorPublicId, controller.signal).then(() => {
      if (controller.signal.aborted) return null;
      setActorVerified(true); return getAdminRewards(target.publicId, controller.signal);
    }).then(async value => {
      if (!value) return;
      await verifyAdminActor(actorPublicId, controller.signal);
      if (controller.signal.aborted) return;
      if (value.publicId !== target.publicId) throw new Error("Reward owner mismatch");
      setOwned(value); setError("");
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) { setActorVerified(false); setAttempt(null); setOwned(null); onAccessLost(cause); }
      else setError("Не удалось загрузить награды игрока. Повторите загрузку.");
    });
    return () => controller.abort();
  }, [actorPublicId, target.publicId, reload, onAccessLost]);
  useEffect(() => () => write.current?.abort(), []);

  async function submit() {
    if (!actorVerified || pending.current || (!attempt && (!owned || hasReward || messageIssue || confirmation.trim() !== target.publicId
      || !validAdminReason(reason)))) return;
    const body = attempt ?? { requestId: createUuidV4(), confirmationPublicId: confirmation.trim(),
      kind: reward.kind, rewardId: reward.id, reason: reason.trim(), delivery, ...(playerMessage ? { playerMessage } : {}) };
    if (!saveLegacyRewardAttempt(actorPublicId, target.publicId, body)) { setError("Браузер не сохранил запрос. Выдача не отправлена. Разрешите хранилище и повторите."); return; }
    setAttempt(body); pending.current = true; setBusy(true); setError("");
    const controller = new AbortController(); write.current = controller;
    try {
      await verifyAdminActor(actorPublicId, controller.signal);
      const receipt = await grantAdminReward(target.publicId, body, controller.signal);
      await verifyAdminActor(actorPublicId, controller.signal);
      if (controller.signal.aborted) return;
      if (receipt.requestId !== body.requestId || receipt.rewardId !== body.rewardId || receipt.kind !== body.kind) throw new Error("Reward receipt mismatch");
      saveLegacyRewardAttempt(actorPublicId, target.publicId, null); setAttempt(null);
      onGranted(`${target.displayName}: «${reward.title}» ${receipt.granted ? "выдано" : "уже было получено"}. Запись сохранена в журнале.`);
      onClose();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) { setActorVerified(false); setAttempt(null); setOwned(null); onAccessLost(cause); }
      else {
        if (definitiveAdminWriteFailure(cause)) { saveLegacyRewardAttempt(actorPublicId, target.publicId, null); setAttempt(null); }
        setError(cause instanceof ApiError ? cause.message : "Ответ не получен. Повторите тот же запрос: повторная выдача не создаст дубликат.");
      }
    } finally { pending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  const valid = confirmation.trim() === target.publicId && validAdminReason(reason);
  if (!actorVerified) return <Dialog open onOpenChange={open => { if (!open) onClose(); }}><DialogContent className={styles.confirmDialog}><DialogHeader><DialogTitle>Проверка доступа</DialogTitle><DialogDescription>Незавершённая операция могла быть принята. После входа исходным администратором будет доступен прежний запрос.</DialogDescription></DialogHeader><p role="status">{error || "Проверяем аккаунт администратора…"}</p></DialogContent></Dialog>;
  return <Dialog open onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
    <DialogContent onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }} className={styles.confirmDialog} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Выдать награду</DialogTitle><DialogDescription>{target.displayName} · {target.publicId}. Предмет появится у Мохлика. Выдача достижения добавляет все недостающие ступени. Игровые счётчики, уровень и рейтинг не меняются.</DialogDescription></DialogHeader>
      {owned ? <>
        <label className={styles.field}>Награда<select className={styles.select} value={rewardId} disabled={busy || !!attempt} onChange={event => { setRewardId(event.target.value); setError(""); }}>
          <optgroup label="Предметы">{REWARDS.filter(item => item.kind === "item").map(item => <option value={item.id} key={item.id}>{item.title}{owned.items.some(id => id === item.id) ? " · получено" : ""}</option>)}</optgroup>
          <optgroup label="Достижения">{REWARDS.filter(item => item.kind === "achievement").map(item => <option value={item.id} key={item.id}>{item.title}{owned.achievements.some(id => id === item.id) ? item.tiers.length > 1 ? " · есть полученные ступени" : " · получено" : ""}</option>)}</optgroup>
        </select><small>{hasReward ? "Эта награда уже есть у игрока." : "Будет выдана только выбранная награда."}</small></label>
        <label className={styles.field}>Причина выдачи<input type="text" value={reason} maxLength={240} disabled={busy || !!attempt} onChange={event => setReason(event.target.value)} placeholder="Например: награда за помощь в тестировании" /><small>8–240 символов. Причина попадёт в журнал.</small></label>
        <label className={styles.field}>Подтвердите ID получателя<code>{target.publicId}</code><input value={confirmation} disabled={busy || !!attempt} onChange={event => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} /></label>
        <AdminDeliveryFields delivery={delivery} title={playerTitle} body={playerBody} disabled={busy || !!attempt} onDelivery={setDelivery} onTitle={setPlayerTitle} onBody={setPlayerBody} />
        {messageIssue && <p className={styles.notice} role="status">{messageIssue}</p>}
      </> : <p role="status">{error || "Загружаем награды…"}</p>}
      {attempt && <><AdminDeliveryPreview {...attempt} /><p className={styles.notice}>Есть незавершённая выдача. Повтор использует прежний UUID, награду и сообщение.<br /><code>{attempt.requestId}</code></p></>}
      {owned && error && <p className={styles.notice} role="alert">{error}</p>}
      <div className={styles.gateActions}>
        <button type="button" className={styles.button} disabled={busy} onClick={onClose}>Закрыть</button>
        {!owned && error && !attempt ? <button type="button" className={styles.button} onClick={() => setReload(value => value + 1)}>Загрузить снова</button> :
          <button type="button" className={styles.primaryButton} disabled={busy || (!attempt && (!owned || !valid || !!messageIssue || !!hasReward))} onClick={() => void submit()}>
            {busy ? <LoaderCircle size={17} className={styles.spin} /> : <Gift size={17} />}{busy ? "Выдаём…" : attempt ? "Повторить запрос" : "Выдать награду"}
          </button>}
      </div>
    </DialogContent>
  </Dialog>;
}
