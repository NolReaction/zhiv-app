"use client";

import { useId } from "react";
import type { AdminDelivery, DeliveryOptions } from "./admin-delivery-contract";
import styles from "./admin-mail.module.css";

export function AdminDeliveryFields({ delivery, title, body, disabled, onDelivery, onTitle, onBody }: {
  delivery: AdminDelivery; title: string; body: string; disabled: boolean;
  onDelivery: (value: AdminDelivery) => void; onTitle: (value: string) => void; onBody: (value: string) => void;
}) {
  const group = useId();
  return <fieldset className={styles.delivery} disabled={disabled}>
    <legend>Как сообщить игроку</legend>
    <label className={styles.check}><input type="radio" name={group} checked={delivery === "silent"} onChange={() => onDelivery("silent")} />Тихо, без письма и уведомления</label>
    <label className={styles.check}><input type="radio" name={group} checked={delivery === "notify"} onChange={() => onDelivery("notify")} />Письмо и уведомление</label>
    {delivery === "notify" && <>
      <p className={styles.hint}>Можно добавить сообщение игроку. Пустые поля оставят стандартный текст с фактическим результатом операции. Внутренняя причина сюда не попадёт.</p>
      <label className={styles.field}>Заголовок письма<input value={title} maxLength={240} onChange={event => onTitle(event.target.value)} placeholder="Необязательно, например: Спасибо за помощь" /></label>
      <label className={styles.field}>Сообщение игроку<textarea rows={3} value={body} maxLength={4000} onChange={event => onBody(event.target.value)} placeholder="Отдельный текст для игрока" /></label>
    </>}
  </fieldset>;
}
export function AdminDeliveryPreview({ delivery, playerMessage }: DeliveryOptions) {
  return <div className={styles.preview}>
    <strong>{delivery === "notify" ? "Письмо и уведомление" : "Тихо, без письма и уведомления"}</strong>
    {delivery === "notify" && (playerMessage ? <><h3>{playerMessage.title}</h3><p>{playerMessage.body}</p></> : <p>Стандартное письмо с фактическим результатом операции.</p>)}
  </div>;
}
