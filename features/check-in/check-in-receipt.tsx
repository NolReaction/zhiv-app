"use client";

import { useId, type ReactNode } from "react";
import { Check, CircleAlert, Clock3, Server, WifiOff } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import styles from "./check-in-receipt.module.css";
import glass from "@/components/glass-action.module.css";

export function CheckInReceipt({ lastCheckInAt, lastCheckInLabel, timeZone, isSending, unconfirmed, isOnline, onRetry, children, gameStatus, gameNotice, gamePending = 0, gameArchived = 0, gameRequestId, onRetryGame }: {
  lastCheckInAt: string | null;
  lastCheckInLabel: string;
  timeZone: string;
  isSending: boolean;
  unconfirmed: boolean;
  isOnline: boolean;
  onRetry: () => void;
  children?: ReactNode;
  gameStatus?: string;
  gameNotice?: string;
  gamePending?: number;
  gameArchived?: number;
  gameRequestId?: string;
  onRetryGame?: () => void;
}) {
  const titleId = useId();
  const gameIssue = gameStatus === "error" || gameStatus === "blocked" || gameArchived > 0;
  const state = gameIssue ? "pending" : isSending ? "sending" : unconfirmed ? "pending" : !isOnline ? "offline" : lastCheckInAt ? "saved" : "empty";
  const title = gameIssue ? "Проверить соединение" : state === "sending" ? "Сохраняем данные" : state === "pending" ? "Нужна проверка отправки"
    : state === "offline" ? "Нет интернета" : state === "saved" ? "Отметка сохранена" : "Ваша первая отметка";
  const timestamp = lastCheckInAt ? new Date(lastCheckInAt).toLocaleString("ru-RU", {
    timeZone, day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  }) : null;
  return <div className={styles.receipt} data-state={state}>
    <div className={styles.row}>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className={`${glass.button} ${styles.indicator}`} aria-label={`${title}. ${lastCheckInLabel}. Подробнее об отметке`}
            onPointerDown={event => event.stopPropagation()}>
            <Server size={20} aria-hidden="true" />
            <span className={styles.badge} aria-hidden="true">
              {state === "sending" ? <Clock3 size={11} /> : state === "pending" ? <CircleAlert size={11} />
                : state === "offline" ? <WifiOff size={11} /> : state === "saved" ? <Check size={11} /> : null}
            </span>
          </button>
        </PopoverTrigger>
        <PopoverContent className={styles.details} side="top" sideOffset={10} collisionPadding={20} aria-labelledby={titleId}>
          <h3 id={titleId}>{title}</h3>
          <p className={styles.fact}>{lastCheckInLabel}</p>
          <p>{state === "sending" ? "Ещё немного — ждём подтверждения отправки."
            : state === "pending" ? "Связь прервалась. Проверьте, дошла ли отметка."
              : state === "offline" ? "Последняя сохранённая отметка остаётся с вами. Для новой нужно подключение."
                : state === "saved" ? "Всё готово. Эта отметка сохранена в вашем аккаунте."
                  : "Нажмите «Я ЖИВОЙ», чтобы отметиться."}</p>
          {gameNotice && <div className={styles.gameDetails}><h3>Игровые нажатия</h3><p>{gameNotice}</p>
            {gamePending > 0 && <p>В очереди: {gamePending.toLocaleString("ru-RU")}</p>}
            {gameRequestId && <p>Код запроса: <code>{gameRequestId}</code></p>}
            {(gameIssue || gamePending > 0) && <button type="button" disabled={!isOnline} onClick={onRetryGame}>Проверить связь</button>}
          </div>}
          {timestamp && <time dateTime={lastCheckInAt!}>{timestamp}</time>}
          {unconfirmed && <button type="button" disabled={!isOnline || isSending} onClick={onRetry}>Проверить отправку</button>}
        </PopoverContent>
      </Popover>
      {children}
    </div>
    <span className={styles.srOnly} role="status" aria-live="polite">{title}</span>

  </div>;
}
