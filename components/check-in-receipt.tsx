"use client";

import { useId } from "react";
import { Check, CircleAlert, LoaderCircle, Server, WifiOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover";
import styles from "./check-in-receipt.module.css";

export function CheckInReceipt({ lastCheckInAt, lastCheckInLabel, timeZone, isSending, unconfirmed, isOnline, onRetry }: {
  lastCheckInAt: string | null;
  lastCheckInLabel: string;
  timeZone: string;
  isSending: boolean;
  unconfirmed: boolean;
  isOnline: boolean;
  onRetry: () => void;
}) {
  const titleId = useId();
  const state = isSending ? "sending" : unconfirmed ? "pending" : !isOnline ? "offline" : lastCheckInAt ? "saved" : "empty";
  const title = state === "sending" ? "Сохраняем отметку" : state === "pending" ? "Нужна проверка отправки"
    : state === "offline" ? "Нет интернета" : state === "saved" ? "Отметка сохранена" : "Ваша первая отметка";
  const timestamp = lastCheckInAt ? new Date(lastCheckInAt).toLocaleString("ru-RU", {
    timeZone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  }) : null;
  return <div className={styles.receipt} data-state={state}>
    <div className={styles.row}>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={styles.indicator} aria-label={`${title}. Подробнее об отметке`}
            onPointerDown={event => event.stopPropagation()}>
            <Server size={20} aria-hidden="true" className={styles.server} />
            <span key={`${state}:${lastCheckInAt ?? "first"}`} className={styles.badge} aria-hidden="true">
              {state === "sending" ? <LoaderCircle size={11} /> : state === "pending" ? <CircleAlert size={11} />
                : state === "offline" ? <WifiOff size={11} /> : state === "saved" ? <Check size={11} /> : null}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent className={styles.details} side="top" sideOffset={10} collisionPadding={20} aria-labelledby={titleId}>
          <h3 id={titleId}>{title}</h3>
          <p>{state === "sending" ? "Ещё немного — ждём подтверждения отправки."
            : state === "pending" ? "Связь прервалась. Проверьте, дошла ли отметка."
              : state === "offline" ? "Последняя сохранённая отметка остаётся с вами. Для новой нужно подключение."
                : state === "saved" ? "Всё готово. Эта отметка сохранена в вашем аккаунте."
                  : "Нажмите «Я ЖИВОЙ», чтобы отметиться."}</p>
          {timestamp && <time dateTime={lastCheckInAt!}>{timestamp}</time>}
          {unconfirmed && <button type="button" disabled={!isOnline || isSending} onClick={onRetry}>Проверить отправку</button>}
        </PopoverContent>
      </Popover>
      <p className={styles.fact}>{lastCheckInLabel}</p>
    </div>
    <span className={styles.srOnly} role="status" aria-live="polite">{title}</span>
    {(unconfirmed || !isOnline) && <div className={styles.warning}>
      <span>{unconfirmed ? "Не удалось проверить отправку" : "Нет интернета"}</span>
      {unconfirmed && <button type="button" disabled={!isOnline || isSending} onClick={onRetry}>Проверить</button>}
    </div>}
  </div>;
}
