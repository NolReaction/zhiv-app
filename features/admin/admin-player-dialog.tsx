"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlayerName } from "@/components/player-name";
import { TAG_COLORS, playerTagSchema, type PlayerTag } from "@/lib/player-tag";
import { createUuidV4 } from "@/lib/browser-uuid";
import { validAdminReason } from "./admin-input";
import { ApiError } from "@/lib/check-in-api";
import { worldCatalog } from "@/features/world/domain/model";
import { getAdminAccess, manageAdminPlayer, verifyAdminActor, type AdminPlayerCommand, type AdminUser } from "./admin-api";
import { definitiveAdminWriteFailure } from "./admin-write-outcome";
import { AdminSecurityContent, adminReviewReasons, loadAdminPlayerReview } from "./admin-security-panel";
import { AdminDeliveryFields, AdminDeliveryPreview } from "./admin-delivery";
import { deliveryIssue, deliveryMessage, type AdminDelivery } from "./admin-delivery-contract";
import { readLegacyManageAttempt, saveLegacyManageAttempt } from "./admin-legacy-delivery-journal";
import styles from "./admin-management.module.css";

export function AdminPlayerDialog({ target, actorPublicId, onAccessLost, onClose, onChanged }: {
  target: AdminUser; actorPublicId: string; onAccessLost: (error: ApiError) => void; onClose: () => void; onChanged: () => void;
}) {
  const [restored] = useState(() => readLegacyManageAttempt(actorPublicId, target.publicId));
  const [snapshot, setSnapshot] = useState<{ key: string; value: Awaited<ReturnType<typeof loadAdminPlayerReview>> } | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AdminPlayerCommand | null>(restored);
  const [reason, setReason] = useState(restored?.reason ?? "");
  const [confirmation, setConfirmation] = useState(restored?.confirmationPublicId ?? "");
  const [delivery, setDelivery] = useState<AdminDelivery>(restored?.delivery ?? "silent");
  const [playerTitle, setPlayerTitle] = useState(restored?.playerMessage?.title ?? "");
  const [playerBody, setPlayerBody] = useState(restored?.playerMessage?.body ?? "");
  const [item, setItem] = useState(worldCatalog.items[0].id);
  const [find, setFind] = useState(worldCatalog.finds[0].id);
  const [tagText, setTagText] = useState(target.tag?.text ?? "");
  const [tagColor, setTagColor] = useState<PlayerTag["color"]>(target.tag?.color ?? "green");
  const sending = useRef(false);
  const writeController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  const snapshotKey = JSON.stringify([actorPublicId, target.publicId]);
  const current = snapshot?.key === snapshotKey ? snapshot.value : null;
  const player = current?.player;
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    loadAdminPlayerReview(actorPublicId, target.publicId, controller.signal).then(value => {
      if (!alive.current || controller.signal.aborted) return;
      setSnapshot({ key: snapshotKey, value }); setTagText(value.player.tag?.text ?? ""); setTagColor(value.player.tag?.color ?? "green");
    }).catch(failure => {
      if (!alive.current || controller.signal.aborted) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { setPending(null); setSnapshot(null); onAccessLost(failure); }
      else setError(failure instanceof Error ? failure.message : "Не удалось загрузить игрока");
    });
    return () => { alive.current = false; controller.abort(); writeController.current?.abort(); };
  }, [actorPublicId, target.publicId, snapshotKey, onAccessLost]);
  const authorized = confirmation === target.publicId && validAdminReason(reason);
  const locked = busy || Boolean(pending);
  const playerMessage = deliveryMessage(delivery, playerTitle, playerBody);
  const messageIssue = deliveryIssue(delivery, playerTitle, playerBody);
  async function run(action: AdminPlayerCommand["action"], extra: Partial<AdminPlayerCommand> = {}) {
    if (sending.current || !authorized || (!player && !pending)) return;
    const isGrant = ["grant_world_item", "grant_find"].includes(pending?.action ?? action);
    if (!pending && isGrant && messageIssue) return;
    const request = pending ?? { ...extra, requestId: createUuidV4(), confirmationPublicId: target.publicId, reason: reason.trim(), action,
      ...(isGrant ? { delivery, ...(playerMessage ? { playerMessage } : {}) } : {}) };
    if (isGrant && !saveLegacyManageAttempt(actorPublicId, target.publicId, request)) { setError("Браузер не сохранил запрос. Выдача не отправлена. Разрешите хранилище и повторите."); return; }
    sending.current = true; setBusy(true); setError(""); setNotice(""); setPending(request);
    const controller = new AbortController(); writeController.current = controller;
    try {
      const actor = await getAdminAccess(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (actor.publicId !== actorPublicId) {
        setSnapshot(null); onAccessLost(new ApiError("Аккаунт администратора сменился. Откройте панель заново.", 403)); return;
      }
      const receipt = await manageAdminPlayer(target.publicId, request, controller.signal);
      await verifyAdminActor(actorPublicId, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (receipt.requestId !== request.requestId || receipt.action !== request.action) throw new ApiError("Ответ не соответствует отправленному действию", 502);
      if (isGrant) saveLegacyManageAttempt(actorPublicId, target.publicId, null);
      setPending(null); setNotice(receipt.changed ? "Изменение сохранено и записано в журнал." : "У игрока уже установлено это состояние. Повторная выдача не выполнена.");
      onChanged();
      try { const next = await loadAdminPlayerReview(actorPublicId, target.publicId, controller.signal); if (alive.current && !controller.signal.aborted) setSnapshot({ key: snapshotKey, value: next }); }
      catch (failure) {
        if (!alive.current || controller.signal.aborted) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) { setPending(null); setSnapshot(null); onAccessLost(failure); }
        else setError("Изменение сохранено, но состояние не обновилось. Откройте карточку снова.");
      }
    } catch (failure) {
      if (!alive.current || controller.signal.aborted) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { setPending(null); setSnapshot(null); onAccessLost(failure); return; }
      const definitive = definitiveAdminWriteFailure(failure);
      if (definitive) { if (isGrant) saveLegacyManageAttempt(actorPublicId, target.publicId, null); setPending(null); }
      setError(failure instanceof Error ? failure.message : "Нет ответа. Повторите тот же запрос.");
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  }
  const tag = tagText ? { text: tagText, color: tagColor } : null;
  const tagValid = !tag || playerTagSchema.safeParse(tag).success;
  return <Dialog open onOpenChange={open => { if (!open && !busy && !pending) onClose(); }}>
    <DialogContent className={styles.dialog} onInteractOutside={event => { if (locked) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Управление игроком</DialogTitle><DialogDescription>
        <PlayerName name={player?.displayName ?? target.displayName} tag={player ? player.tag : target.tag} /> · {target.publicId}
      </DialogDescription></DialogHeader>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {!player ? <p>Загружаем аккаунт…</p> : <>
        <p className={styles.hint}>Старые ресурсы пересчитаны в хозяйство. Здесь можно управлять одеждой и коллекциями.</p>
        <fieldset disabled={locked} className={styles.confirmation}>
          <label>Причина изменения<input maxLength={240} value={reason} onChange={event => setReason(event.target.value)} placeholder="Не менее 8 символов · останется в журнале" /></label>
          <label>Подтвердите ID игрока<input value={confirmation} onChange={event => setConfirmation(event.target.value.toUpperCase())} placeholder={target.publicId} autoComplete="off" /></label>
        </fieldset>
        <Tabs defaultValue={restored ? "world" : adminReviewReasons(target).length ? "security" : "world"}>
          <TabsList className={styles.tabs}><TabsTrigger value="security">Наблюдение</TabsTrigger><TabsTrigger value="world">Вещи и коллекции</TabsTrigger><TabsTrigger value="tag">Тег</TabsTrigger><TabsTrigger value="account">Аккаунт</TabsTrigger></TabsList>
          <TabsContent value="security" className={styles.stack}>
            {current && <AdminSecurityContent detail={current.security} canManage={authorized} locked={locked}
              onClear={() => void run("clear_signal")} onWatch={() => void run(current.security.watchlisted ? "unwatch" : "watch")} />}
          </TabsContent>
          <TabsContent value="world" className={styles.stack}>
            <AdminDeliveryFields delivery={delivery} title={playerTitle} body={playerBody} disabled={locked} onDelivery={setDelivery} onTitle={setPlayerTitle} onBody={setPlayerBody} />
            {messageIssue && <p className={styles.error} role="status">{messageIssue}</p>}
            {pending && ["grant_world_item", "grant_find"].includes(pending.action) && <AdminDeliveryPreview {...pending} />}
            <fieldset disabled={locked} className={styles.stack}>
              <label>Предмет<select value={item} onChange={event => setItem(event.target.value)}>{worldCatalog.items.map(value => <option key={value.id} value={value.id}>{value.name}{player.world.inventory.includes(value.id) ? " · уже есть" : ""}</option>)}</select></label>
              <button disabled={!authorized || !!messageIssue || player.world.inventory.includes(item)} onClick={() => void run("grant_world_item", { target: item })}>Выдать предмет</button>
              <label>Находка<select value={find} onChange={event => setFind(event.target.value)}>{worldCatalog.finds.map(value => <option key={value.id} value={value.id}>{value.name}{player.world.collection.includes(value.id) ? " · уже есть" : ""}</option>)}</select></label>
              <button disabled={!authorized || !!messageIssue || player.world.collection.includes(find)} onClick={() => void run("grant_find", { target: find })}>Добавить в коллекцию</button>
            </fieldset>
          </TabsContent>
          <TabsContent value="tag" className={styles.stack}>
            <fieldset disabled={locked} className={styles.stack}>
              <label>Текст тега<input value={tagText} maxLength={16} onChange={event => setTagText(event.target.value)} placeholder="До 16 букв, цифр, _ или -" /></label>
              <label>Цвет<select value={tagColor} onChange={event => setTagColor(event.target.value as PlayerTag["color"])}>{Object.entries(TAG_COLORS).map(([key, value]) => <option key={key} value={key}>{value.label}</option>)}</select></label>
              <p className={styles.tagPreview}><PlayerName name={target.displayName} tag={tagValid ? tag : null} /></p>
              {!tagValid && <p className={styles.error}>Используйте буквы, цифры, подчёркивание или дефис.</p>}
              <button disabled={!authorized || !tagValid} onClick={() => void run("set_tag", { tag })}>{tag ? "Сохранить тег" : "Снять тег"}</button>
              <p className={styles.hint}>Тег доступен только администратору. Он отображается рядом с именем и не даёт прав администратора.</p>
            </fieldset>
          </TabsContent>
          <TabsContent value="account" className={styles.stack}>
            <p>{player.bannedAt ? `Аккаунт заблокирован. Причина: ${player.banReason}` : "Аккаунт активен."}</p>
            <p className={styles.hint}>Блокировка завершает сеансы и запрещает вход в этот аккаунт. Прогресс сохраняется. После разблокировки потребуется войти заново.</p>
            <button className={styles.danger} disabled={locked || !authorized || target.isAdmin} onClick={() => void run(player.bannedAt ? "unban" : "ban")}>{player.bannedAt ? "Разблокировать аккаунт" : "Заблокировать аккаунт"}</button>
            {target.isAdmin && <p className={styles.hint}>Аккаунт администратора защищён от блокировки.</p>}
            <p className={styles.hint}>Причины наблюдения, автоматические сигналы и снятие отметок находятся во вкладке «Наблюдение».</p>
          </TabsContent>
        </Tabs>
      </>}
      {pending && !busy && <div className={styles.notice}><p>Ответ не подтверждён. Повтор безопасно использует прежний запрос.</p><button onClick={() => void run(pending.action)}>Проверить тем же запросом</button></div>}
      <button disabled={locked} onClick={onClose}>{busy ? "Сохраняем…" : "Закрыть"}</button>
    </DialogContent>
  </Dialog>;
}
