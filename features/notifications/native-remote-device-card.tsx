"use client";
import { useSyncExternalStore } from "react";
import { Bell, BellOff } from "lucide-react";
import { EMPTY_REMOTE_PUSH_STATE, getNativeRemotePush } from "./native-remote-push";
import styles from "./notification-settings.module.css";

const noSubscribe = () => () => {};
const empty = () => EMPTY_REMOTE_PUSH_STATE;

/** Remote account events are a separate opt-in from already scheduled local game timers. */
export function NativeRemoteDeviceCard({ ownerPublicId, isOnline, disabled }: { ownerPublicId: string; isOnline: boolean; disabled: boolean }) {
  const service = getNativeRemotePush();
  const state = useSyncExternalStore(service?.subscribe ?? noSubscribe, service?.getSnapshot ?? empty, empty);
  if (!service) return null;
  const owned = state.ownerPublicId === ownerPublicId;
  const enabled = owned && state.enabled;
  const connected = owned && state.connected;
  const busy = owned && state.busy;
  const title = connected ? "Сообщения сервера подключены" : enabled ? "Подключение сообщений сервера не завершено" : "Сообщения сервера выключены";
  const error = owned ? state.error : "";
  const reason = state.reason || (!state.configured ? "Сообщения сервера пока недоступны в этой версии приложения. Игровые напоминания можно подключить отдельно." : "Письма администрации и напоминания об отметках приходят с сервера. Содержимое писем на экране блокировки не показываем.");
  return <div className={styles.device} role="group" aria-label="Сообщения сервера">
    <span className={styles.deviceIcon} aria-hidden="true">{connected ? <Bell size={19} /> : <BellOff size={19} />}</span>
    <div><strong>{title}</strong><p>{reason}</p></div>
    <div className={styles.deviceActions}>
      {enabled ? <>
        <button type="button" className={styles.connect} disabled={disabled} onClick={() => void service.disable(ownerPublicId).catch(() => undefined)}>Выключить сообщения сервера</button>
        {!connected && <button type="button" className={styles.connect} disabled={disabled || busy || !isOnline} onClick={() => void service.refresh().catch(() => undefined)}>Повторить подключение</button>}
      </> : state.configured && <button type="button" className={styles.connect} disabled={disabled || busy || !isOnline || !owned}
        onClick={() => void service.enable(ownerPublicId).catch(() => undefined)}>Подключить сообщения сервера</button>}
      {!enabled && !state.configured && <button type="button" className={styles.connect} disabled={disabled || busy || !isOnline} onClick={() => void service.refresh().catch(() => undefined)}>Проверить доступность</button>}
      {state.permission === "denied" && <p className={styles.deviceStatus}>Разрешите уведомления в настройках приложения на телефоне.</p>}
      {!isOnline && <p className={styles.deviceStatus}>Для подключения нужен интернет. Отключение на телефоне доступно сразу; сервер подтвердит его после восстановления связи.</p>}
      {busy && <p className={styles.deviceStatus} role="status">Проверяем подключение сообщений сервера…</p>}
      {error && <p className={styles.deviceError} role="alert">{error}</p>}
    </div>
  </div>;
}
