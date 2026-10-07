"use client";
import { useEffect, useRef } from "react";
import type { useActivity } from "./use-activity";
import styles from "./activity.module.css";
export function ActivityGate({ activity }: { activity: ReturnType<typeof useActivity> }) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus(); }, [activity.mode]);
  const away = activity.mode === "away", connecting = activity.mode === "connecting", offline = !activity.online;
  return <main className={styles.screen} aria-busy={connecting}>
    <section className={styles.card} aria-labelledby="activity-title">
      <p className={styles.brand}>Я ЖИВОЙ</p>
      <h1 ref={heading} tabIndex={-1} id="activity-title">{away ? "Вы отошли" : offline ? "Нет подключения" : connecting ? "Возвращаемся в игру…" : "Игра на паузе"}</h1>
      <p>{away ? "Пять минут без действий — игровая сессия завершена." : offline ? "Для игры нужна связь с сервером. Когда сеть вернётся, проверим последние действия." : connecting ? "Сверяем сохранение и неподтверждённые действия с сервером." : "Перед продолжением нужно проверить подключение и сохранённые действия."}</p>
      <p>Ваш профиль и ресурсы сохранены. Оплаченная стройка, производство и вылазки продолжаются по серверному времени.</p>
      {activity.error && <p role="status" className={styles.error}>{activity.error}</p>}
      {!connecting && <button type="button" disabled={offline || activity.retrySeconds > 0} onClick={() => void (away ? activity.resume() : activity.retry())}>
        {offline ? "Ожидаем сеть" : activity.retrySeconds > 0 ? `Повторить через ${activity.retrySeconds} с` : away ? "Вернуться в игру" : "Проверить подключение"}
      </button>}
    </section>
  </main>;
}
