"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { LoaderCircle, Pause, WifiOff } from "lucide-react";
import type { useActivity } from "./use-activity";
import styles from "./activity.module.css";

type Activity = ReturnType<typeof useActivity>;

/** A retained scene belongs to AppShell; this layer never mounts or resumes it. */
export function ActivityGate({ activity, retained = false }: { activity: Activity; retained?: boolean }) {
  const heading = useRef<HTMLHeadingElement>(null), returnTarget = useRef<HTMLElement | null>(null);
  const latest = useRef(activity), requested = useRef(false), mounted = useRef(true);
  const [submitting, setSubmitting] = useState(false);
  const titleId = useId(), descriptionId = useId();
  useLayoutEffect(() => { latest.current = activity; }, [activity]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (!retained) heading.current?.focus({ preventScroll: true }); }, [activity.mode, retained]);
  const away = activity.mode === "away", connecting = activity.mode === "connecting", offline = !activity.online;
  if (activity.active || activity.mode === "hidden" || retained && activity.mode === "offline" && !activity.resumeRequired) return null;
  const title = away ? "Игра на паузе" : offline ? retained ? "Ждём сеть" : "Нет подключения" : connecting ? "Сверяем прогресс…" : "Проверим соединение";
  const description = away ? "Несколько минут без действий. Продолжим, когда ты вернёшься."
    : offline ? retained ? "Игра остаётся на паузе. Подключись к сети, чтобы продолжить." : "Подключись к сети, чтобы загрузить игру." : connecting ? "Проверяем сохранение и последние действия."
      : "Не удалось сверить прогресс. Попробуй ещё раз.";
  const Icon = away ? Pause : connecting ? LoaderCircle : WifiOff;
  async function proceed() {
    const current = latest.current;
    if (requested.current || current.mode !== activity.mode || current.active || current.mode === "connecting" || !current.online || current.retrySeconds > 0) return;
    requested.current = true; setSubmitting(true);
    try { await (current.mode === "away" ? current.resume() : current.retry()); }
    catch { /* Activity reconciliation owns its error and retry deadline. */ }
    finally { requested.current = false; if (mounted.current) setSubmitting(false); }
  }
  const content = <>
    <header className={styles.heading}><span className={styles.symbol} data-connecting={connecting || undefined} aria-hidden="true"><Icon size={21} /></span>
      {retained ? <Dialog.Title ref={heading} id={titleId} tabIndex={-1}>{title}</Dialog.Title> : <h1 ref={heading} id={titleId} tabIndex={-1}>{title}</h1>}
    </header>
    {retained ? <Dialog.Description id={descriptionId} className={styles.description}>{description}</Dialog.Description>
      : <p id={descriptionId} className={styles.description}>{description}</p>}
    {retained && <p className={styles.hint}>Начатые работы продолжаются по времени сервера.</p>}
    {activity.error && <p role="status" className={styles.error}>{activity.error}</p>}
    {!connecting && <button type="button" disabled={offline || activity.retrySeconds > 0 || submitting} onClick={() => void proceed()}>
      {offline ? "Ожидаем сеть" : submitting ? "Проверяем…" : activity.retrySeconds > 0 ? `Повторить через ${activity.retrySeconds} с` : away ? "Продолжить" : "Проверить связь"}
    </button>}
  </>;
  if (!retained) return <main className={styles.startup} data-activity-startup><section className={styles.card} aria-labelledby={titleId} aria-describedby={descriptionId} aria-busy={connecting}>{content}</section></main>;
  return <Dialog.Root open modal>
    <Dialog.Portal><Dialog.Overlay className={styles.scrim} />
      <Dialog.Content data-slot="dialog-content" className={`${styles.card} ${styles.overlay}`} data-activity-gate data-retained-world aria-busy={connecting}
        aria-labelledby={titleId} aria-describedby={descriptionId}
        onEscapeKeyDown={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}
        onOpenAutoFocus={event => {
          event.preventDefault(); returnTarget.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
          heading.current?.focus({ preventScroll: true });
        }} onCloseAutoFocus={event => {
          event.preventDefault();
          if (returnTarget.current?.isConnected && !returnTarget.current.closest("[inert]")) returnTarget.current.focus({ preventScroll: true });
          returnTarget.current = null;
        }}>{content}</Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
