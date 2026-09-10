"use client";

import { useEffect, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PlayerName } from "@/components/player-name";
import { TAG_COLORS, playerTagSchema, type PlayerTag } from "@/lib/player-tag";
import { createUuidV4 } from "@/lib/browser-uuid";
import { ApiError } from "@/lib/check-in-api";
import { worldCatalog } from "@/features/world/model";
import { getAdminAccess, getAdminPlayer, manageAdminPlayer, type AdminPlayer, type AdminPlayerCommand, type AdminUser } from "./admin-api";
import styles from "./admin-management.module.css";

export function AdminPlayerDialog({ target, actorPublicId, onAccessLost, onClose, onChanged }: {
  target: AdminUser; actorPublicId: string; onAccessLost: (error: ApiError) => void; onClose: () => void; onChanged: () => void;
}) {
  const [player, setPlayer] = useState<AdminPlayer | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<AdminPlayerCommand | null>(null);
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [resource, setResource] = useState("sparks");
  const [amount, setAmount] = useState("10");
  const [item, setItem] = useState(worldCatalog.items[0].id);
  const [find, setFind] = useState(worldCatalog.finds[0].id);
  const [tagText, setTagText] = useState(target.tag?.text ?? "");
  const [tagColor, setTagColor] = useState<PlayerTag["color"]>(target.tag?.color ?? "green");
  const sending = useRef(false);
  const writeController = useRef<AbortController | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    getAdminPlayer(target.publicId, controller.signal).then(value => {
      if (!alive.current || controller.signal.aborted) return;
      if (value.publicId !== target.publicId) throw new ApiError("Ответ относится к другому игроку", 502);
      setPlayer(value); setTagText(value.tag?.text ?? ""); setTagColor(value.tag?.color ?? "green");
    }).catch(failure => {
      if (controller.signal.aborted) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) onAccessLost(failure);
      else setError(failure instanceof Error ? failure.message : "Не удалось загрузить игрока");
    });
    return () => { alive.current = false; controller.abort(); writeController.current?.abort(); };
  }, [target.publicId, onAccessLost]);
  const authorized = confirmation === target.publicId && reason.trim().length >= 8 && reason.trim().length <= 240;
  const locked = busy || Boolean(pending);
  async function run(action: AdminPlayerCommand["action"], extra: Partial<AdminPlayerCommand> = {}) {
    if (sending.current || !authorized || !player) return;
    const request = pending ?? { ...extra, requestId: createUuidV4(), confirmationPublicId: target.publicId, reason: reason.trim(), action };
    sending.current = true; setBusy(true); setError(""); setNotice(""); setPending(request);
    const controller = new AbortController(); writeController.current = controller;
    try {
      const actor = await getAdminAccess(controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (actor.publicId !== actorPublicId) {
        onAccessLost(new ApiError("Аккаунт администратора сменился. Откройте панель заново.", 403)); return;
      }
      const receipt = await manageAdminPlayer(target.publicId, request, controller.signal);
      if (!alive.current || controller.signal.aborted) return;
      if (receipt.requestId !== request.requestId || receipt.action !== request.action) throw new ApiError("Ответ не соответствует отправленному действию", 502);
      setPending(null); setNotice(receipt.changed ? "Изменение сохранено и записано в журнал." : "У игрока уже установлено это состояние. Повторная выдача не выполнена.");
      onChanged();
      try { const next = await getAdminPlayer(target.publicId, controller.signal); if (next.publicId !== target.publicId) throw new ApiError("Ответ относится к другому игроку", 502); if (alive.current && !controller.signal.aborted) setPlayer(next); }
      catch (failure) {
        if (!alive.current || controller.signal.aborted) return;
        if (failure instanceof ApiError && [401, 403].includes(failure.status)) onAccessLost(failure);
        else setError("Изменение сохранено, но состояние не обновилось. Откройте карточку снова.");
      }
    } catch (failure) {
      if (!alive.current || controller.signal.aborted) return;
      if (failure instanceof ApiError && [401, 403].includes(failure.status)) { onAccessLost(failure); return; }
      const definitive = failure instanceof ApiError && [400, 404, 409].includes(failure.status);
      if (definitive) setPending(null);
      setError(failure instanceof Error ? failure.message : "Нет ответа. Повторите тот же запрос.");
    } finally { sending.current = false; if (alive.current) setBusy(false); }
  }
  const tag = tagText ? { text: tagText, color: tagColor } : null;
  const tagValid = !tag || playerTagSchema.safeParse(tag).success;
  const quantity = Number(amount);
  return <Dialog open onOpenChange={open => { if (!open && !busy && !pending) onClose(); }}>
    <DialogContent className={styles.dialog} onInteractOutside={event => { if (locked) event.preventDefault(); }}>
      <DialogHeader><DialogTitle>Управление игроком</DialogTitle><DialogDescription>
        <PlayerName name={player?.displayName ?? target.displayName} tag={player ? player.tag : target.tag} /> · {target.publicId}
      </DialogDescription></DialogHeader>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {notice && <p className={styles.notice} role="status">{notice}</p>}
      {!player ? <p>Загружаем аккаунт…</p> : <>
        <div className={styles.balance}><span>Искры <b>{player.world.resources.sparks}</b></span><span>Дерево <b>{player.world.resources.wood}</b></span><span>Камень <b>{player.world.resources.stone}</b></span></div>
        <fieldset disabled={locked} className={styles.confirmation}>
          <label>Причина изменения<input maxLength={240} value={reason} onChange={event => setReason(event.target.value)} placeholder="Не менее 8 символов · останется в журнале" /></label>
          <label>Подтвердите ID игрока<input value={confirmation} onChange={event => setConfirmation(event.target.value.toUpperCase())} placeholder={target.publicId} autoComplete="off" /></label>
        </fieldset>
        <Tabs defaultValue="world">
          <TabsList className={styles.tabs}><TabsTrigger value="world">Ресурсы и вещи</TabsTrigger><TabsTrigger value="tag">Тег</TabsTrigger><TabsTrigger value="account">Аккаунт</TabsTrigger></TabsList>
          <TabsContent value="world" className={styles.stack}>
            <fieldset disabled={locked} className={styles.stack}>
              <label>Ресурс<select value={resource} onChange={event => setResource(event.target.value)}><option value="sparks">Искры</option><option value="wood">Дерево</option><option value="stone">Камень</option></select></label>
              <div className={styles.row}><label>Количество<input type="number" min="1" max="100000" step="1" value={amount} onChange={event => setAmount(event.target.value)} /></label><button disabled={!authorized || !Number.isInteger(quantity) || quantity < 1 || quantity > 100000} onClick={() => void run("grant_resource", { target: resource, amount: quantity })}>Выдать ресурс</button></div>
              <label>Предмет<select value={item} onChange={event => setItem(event.target.value)}>{worldCatalog.items.map(value => <option key={value.id} value={value.id}>{value.name}{player.world.inventory.includes(value.id) ? " · уже есть" : ""}</option>)}</select></label>
              <button disabled={!authorized || player.world.inventory.includes(item)} onClick={() => void run("grant_world_item", { target: item })}>Выдать предмет</button>
              <label>Находка<select value={find} onChange={event => setFind(event.target.value)}>{worldCatalog.finds.map(value => <option key={value.id} value={value.id}>{value.name}{player.world.collection.includes(value.id) ? " · уже есть" : ""}</option>)}</select></label>
              <button disabled={!authorized || player.world.collection.includes(find)} onClick={() => void run("grant_find", { target: find })}>Добавить в коллекцию</button>
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
            {player.watchlisted && <p className={styles.watchBadge}>Наблюдение</p>}
            {target.isAdmin && <p className={styles.hint}>Аккаунт администратора защищён от блокировки.</p>}
            {player.tapSignalAt && <><p className={styles.hint}>Автоматический сигнал: {new Date(player.tapSignalAt).toLocaleString("ru-RU")}. Проверьте историю кликов. Если рисунок нажатий сохраняется, сигнал может появиться вновь.</p><button disabled={locked || !authorized} onClick={() => void run("clear_signal")}>Сигнал проверен — снять отметку</button></>}
            <button disabled={locked || !authorized} onClick={() => void run(player.watchlisted ? "unwatch" : "watch")}>{player.watchlisted ? "Снять отметку наблюдения" : "Пометить для наблюдения"}</button>
          </TabsContent>
        </Tabs>
      </>}
      {pending && !busy && <div className={styles.notice}><p>Ответ не подтверждён. Повтор безопасно использует прежний запрос.</p><button onClick={() => void run(pending.action)}>Проверить тем же запросом</button></div>}
      <button disabled={locked} onClick={onClose}>{busy ? "Сохраняем…" : "Закрыть"}</button>
    </DialogContent>
  </Dialog>;
}
