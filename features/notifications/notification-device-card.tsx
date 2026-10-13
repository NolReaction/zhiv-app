import { Bell, BellOff } from "lucide-react";
import styles from "./notification-settings.module.css";

export type NotificationDeviceState = {
  connected: boolean;
  configured: boolean;
  support: { supported: boolean; reason: string | null };
  permission: NotificationPermission | "unavailable";
  phase: "idle" | "preparing" | "subscribing" | "saving" | "disconnecting";
  prepared: boolean;
  isOnline: boolean;
  error: string;
  notice: string;
  disabled: boolean;
};

const progressLabels: Record<Exclude<NotificationDeviceState["phase"], "idle">, string> = {
  preparing: "Проверяем готовность устройства…",
  subscribing: "Подключаем уведомления в браузере…",
  saving: "Сохраняем подключение к вашему профилю…",
  disconnecting: "Выключаем уведомления на этом устройстве…",
};

/** Permission and a confirmed device subscription are deliberately separate states. */
export function NotificationDeviceCard({ id, state, onToggle, onRetry }: {
  id: string;
  state: NotificationDeviceState;
  onToggle: () => void;
  onRetry: () => void;
}) {
  const { connected, configured, support, permission, phase, prepared, isOnline, error, notice, disabled } = state;
  const working = phase !== "idle";
  const permitted = permission === "granted";
  const retry = !connected && !prepared && !working;
  const available = connected || (configured && support.supported);
  const blocked = disabled || working || !isOnline || !available;
  const title = connected ? !configured ? "Устройство подключено, отправка недоступна"
    : permission === "denied" ? "Устройство подключено, уведомления запрещены"
      : !support.supported ? "Устройство подключено, уведомления недоступны"
        : !permitted ? "Устройство подключено, требуется разрешение"
          : "Подключены на этом устройстве"
    : permitted ? "Разрешение получено, подключение не завершено"
      : "На этом устройстве выключены";
  const hint = !configured
    ? "Отправка ещё не подключена на сервере. Вы уже можете выбрать события и сохранить настройки."
    : support.reason ?? (permission === "denied" ? "Разрешите уведомления в настройках браузера или устройства, затем вернитесь сюда."
      : !support.supported ? "Этот браузер пока не поддерживает уведомления. Откройте приложение в поддерживаемом браузере."
        : connected && !permitted ? "Разрешите уведомления в браузере, затем проверьте подключение."
      : connected ? "Устройство подключено к вашему профилю."
      : permitted ? "Разрешение браузера уже есть. Завершите подключение, чтобы получать уведомления."
        : "Нажмите кнопку и разрешите уведомления в запросе браузера.");
  const buttonLabel = connected ? "Выключить здесь"
    : retry ? "Повторить проверку"
      : permitted ? "Завершить подключение" : "Подключить на устройстве";
  const descriptionIds = [`${id}-device-hint`,
    ...(support.reason && !configured ? [`${id}-device-support`] : []),
    ...(!isOnline ? [`${id}-device-offline`] : []),
    ...(error ? [`${id}-device-error`] : []),
    ...(working || (notice && !error) ? [`${id}-device-status`] : []),
  ].join(" ");

  return <div className={styles.device} role="group" aria-labelledby={`${id}-device-title`}>
    <span className={styles.deviceIcon} aria-hidden="true">{connected && permitted && configured && support.supported ? <Bell size={19} /> : <BellOff size={19} />}</span>
    <div>
      <strong id={`${id}-device-title`}>{title}</strong>
      <p id={`${id}-device-hint`}>{hint}</p>
      {support.reason && !configured && <p id={`${id}-device-support`}>{support.reason}</p>}
    </div>
    <div className={styles.deviceActions}>
      {available && <button type="button" className={styles.connect} disabled={blocked}
        aria-describedby={descriptionIds} aria-busy={working}
        onClick={() => {
          if (blocked) return;
          if (retry) onRetry();
          else if (connected || prepared) onToggle();
        }}>{buttonLabel}</button>}
      {!isOnline && <p id={`${id}-device-offline`} className={styles.deviceStatus}>
        {connected ? "Для отключения уведомлений нужно подключение к интернету." : "Для подключения уведомлений нужен интернет. Вернитесь сюда, когда связь появится."}
      </p>}
      {(working || (notice && !error)) && <p id={`${id}-device-status`} className={styles.deviceStatus} role="status" aria-live="polite" aria-atomic="true">
        {working ? progressLabels[phase] : notice}
      </p>}
      {error && <p id={`${id}-device-error`} className={styles.deviceError} role="alert">{error}</p>}
    </div>
  </div>;
}
