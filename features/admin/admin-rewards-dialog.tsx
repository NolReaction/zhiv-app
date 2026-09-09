"use client";

import { useEffect, useRef, useState } from "react";
import { Gift, LoaderCircle } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ApiError } from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { GAME_ITEMS, GAME_ACHIEVEMENTS } from "@/features/game/game-rewards";
import { getAdminAccess, getAdminRewards, grantAdminReward, type AdminRewards, type AdminUser, type AdminGrantRequest } from "@/features/admin/admin-api";
import styles from "./admin-dashboard.module.css";

const REWARDS = [
  ...GAME_ITEMS.map(item => ({ ...item, kind: "item" as const })),
  ...GAME_ACHIEVEMENTS.map(item => ({ ...item, kind: "achievement" as const })),
];

export function AdminRewardsDialog({ target, actorPublicId, onClose, onGranted, onAccessLost, returnFocus }: {
  target: AdminUser; actorPublicId: string; onClose: () => void; onGranted: (message: string) => void;
  onAccessLost: (error: ApiError) => void; returnFocus: () => void;
}) {
  const [owned, setOwned] = useState<AdminRewards | null>(null);
  const [rewardId, setRewardId] = useState<string>(REWARDS[0].id);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState<AdminGrantRequest | null>(null);
  const write = useRef<AbortController | null>(null);
  const pending = useRef(false);
  const reward = REWARDS.find(item => item.id === rewardId)!;
  const hasReward = owned && (reward.kind === "item" ? owned.items : owned.achievements).some(id => id === rewardId);

  useEffect(() => {
    const controller = new AbortController();
    void getAdminRewards(target.publicId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      if (value.publicId !== target.publicId) throw new Error("Reward owner mismatch");
      setOwned(value); setError("");
    }).catch(cause => {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) onAccessLost(cause);
      else setError("Не удалось загрузить награды игрока. Повторите загрузку.");
    });
    return () => controller.abort();
  }, [target.publicId, reload, onAccessLost]);
  useEffect(() => () => write.current?.abort(), []);

  async function submit() {
    if (pending.current || !owned || (!attempt && hasReward) || confirmation.trim() !== target.publicId
      || reason.trim().length < 8 || reason.trim().length > 240 || /[\u0000-\u001f\u007f]/.test(reason)) return;
    const body = attempt ?? { requestId: createUuidV4(), confirmationPublicId: confirmation.trim(),
      kind: reward.kind, rewardId: reward.id, reason: reason.trim() };
    setAttempt(body); pending.current = true; setBusy(true); setError("");
    const controller = new AbortController(); write.current = controller;
    try {
      const actor = await getAdminAccess(controller.signal);
      if (controller.signal.aborted) return;
      if (actor.publicId !== actorPublicId) { onAccessLost(new ApiError("Аккаунт администратора изменился. Откройте панель заново.", 403)); return; }
      const receipt = await grantAdminReward(target.publicId, body, controller.signal);
      if (controller.signal.aborted) return;
      if (receipt.requestId !== body.requestId || receipt.rewardId !== body.rewardId || receipt.kind !== body.kind) throw new Error("Reward receipt mismatch");
      onGranted(`${target.displayName}: «${reward.title}» ${receipt.granted ? "выдано" : "уже было получено"}. Запись сохранена в журнале.`);
      onClose();
    } catch (cause) {
      if (controller.signal.aborted) return;
      if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) onAccessLost(cause);
      else {
        if (cause instanceof ApiError && [400, 404, 409].includes(cause.status)) setAttempt(null);
        setError(cause instanceof ApiError ? cause.message : "Ответ не получен. Повторите тот же запрос: повторная выдача не создаст дубликат.");
      }
    } finally { pending.current = false; if (!controller.signal.aborted) setBusy(false); }
  }
  const valid = confirmation.trim() === target.publicId && reason.trim().length >= 8 && reason.trim().length <= 240
    && !/[\u0000-\u001f\u007f]/.test(reason);
  return <Dialog open onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
    <DialogContent onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }} className={styles.confirmDialog} onEscapeKeyDown={event => { if (busy) event.preventDefault(); }} onPointerDownOutside={event => { if (busy) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Выдать награду</DialogTitle><DialogDescription>{target.displayName} · {target.publicId}. Предмет появится у Мохлика, достижение — в профиле. Тапы, уровень и рейтинг от выдачи не меняются.</DialogDescription></DialogHeader>
      {owned ? <>
        <label className={styles.field}>Награда<select className={styles.select} value={rewardId} disabled={busy || !!attempt} onChange={event => { setRewardId(event.target.value); setError(""); }}>
          <optgroup label="Предметы">{REWARDS.filter(item => item.kind === "item").map(item => <option value={item.id} key={item.id}>{item.title}{owned.items.some(id => id === item.id) ? " · получено" : ""}</option>)}</optgroup>
          <optgroup label="Достижения">{REWARDS.filter(item => item.kind === "achievement").map(item => <option value={item.id} key={item.id}>{item.title}{owned.achievements.some(id => id === item.id) ? " · получено" : ""}</option>)}</optgroup>
        </select><small>{hasReward ? "Эта награда уже есть у игрока." : "Будет выдана только выбранная награда."}</small></label>
        <label className={styles.field}>Причина выдачи<input type="text" value={reason} maxLength={240} disabled={busy || !!attempt} onChange={event => setReason(event.target.value)} placeholder="Например: награда за помощь в тестировании" /><small>8–240 символов. Причина попадёт в журнал.</small></label>
        <label className={styles.field}>Подтвердите ID получателя<code>{target.publicId}</code><input value={confirmation} disabled={busy || !!attempt} onChange={event => setConfirmation(event.target.value)} autoComplete="off" spellCheck={false} /></label>
      </> : <p role="status">{error || "Загружаем награды…"}</p>}
      {owned && error && <p className={styles.notice} role="alert">{error}</p>}
      <div className={styles.gateActions}>
        <button type="button" className={styles.button} disabled={busy} onClick={onClose}>Закрыть</button>
        {!owned && error ? <button type="button" className={styles.button} onClick={() => setReload(value => value + 1)}>Загрузить снова</button> :
          <button type="button" className={styles.primaryButton} disabled={busy || !owned || !valid || (!!hasReward && !attempt)} onClick={() => void submit()}>
            {busy ? <LoaderCircle size={17} className={styles.spin} /> : <Gift size={17} />}{busy ? "Выдаём…" : attempt ? "Повторить запрос" : "Выдать награду"}
          </button>}
      </div>
    </DialogContent>
  </Dialog>;
}
