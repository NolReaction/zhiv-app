"use client";

import { useEffect, useId } from "react";
import { BellRing, Check } from "lucide-react";
import type { NotificationDeviceState } from "./notification-device-card";
import { useNotificationDevice } from "./use-notification-device";
import styles from "./notification-onboarding-prompt.module.css";

function ignoreSnapshot() {}

/** Preparation never requests permission. The native prompt stays in the explicit button gesture. */
export function NotificationOnboardingPrompt({ owner, isOnline, onSessionLost, onContinue }: {
  owner: string;
  isOnline: boolean;
  onSessionLost: () => void;
  onContinue: () => void;
}) {
  const id = useId();
  const device = useNotificationDevice(owner, isOnline, ignoreSnapshot, onSessionLost);
  useEffect(() => {
    if (device.state.connected && device.state.permission === "granted") onContinue();
  }, [device.state.connected, device.state.permission, onContinue]);
  return <NotificationOnboardingCard id={id} state={device.state} onEnable={device.toggle}
    onRetry={() => { void device.refresh(true); }} onContinue={onContinue} />;
}

/** The offer precedes the course welcome; dismissing it does not skip any tutorial step. */
export function NotificationOnboardingCard({ id, state, onEnable, onRetry, onContinue }: {
  id: string;
  state: NotificationDeviceState;
  onEnable: () => void;
  onRetry: () => void;
  onContinue: () => void;
}) {
  const connecting = state.phase === "subscribing" || state.phase === "saving" || state.phase === "disconnecting";
  const preparing = state.phase === "preparing";
  const available = state.configured && state.support.supported && !state.connected
    && (state.permission === "default" || state.permission === "granted");
  const permitted = state.permission === "granted";
  const retry = available && !state.prepared && !preparing && !connecting;
  const disabled = state.disabled || !state.isOnline || preparing || connecting;
  const label = preparing ? "Готовим подключение…" : connecting ? "Подключаем уведомления…"
    : retry ? "Повторить проверку" : permitted ? "Завершить подключение" : "Включить уведомления";
  const hint = state.support.reason ?? (preparing ? "Подготовим устройство, чтобы запрос разрешения открылся сразу по кнопке."
    : state.permission === "denied" ? "Уведомления запрещены в настройках устройства или браузера. Их можно разрешить позже из профиля."
      : state.permission === "unavailable" ? "В этом браузере уведомления недоступны. Можно подключить их позже на другом устройстве."
        : state.connected ? "Уведомления уже подключены на этом устройстве."
          : !state.configured ? "Подключить уведомления можно будет позже в настройках профиля."
            : permitted ? "Разрешение уже есть. Осталось подключить это устройство к профилю."
              : "Нажми кнопку и разреши уведомления в запросе устройства. Настройки событий можно изменить в профиле.");
  const progress = state.phase === "saving" ? "Сохраняем подключение к профилю…"
    : connecting ? "Подтверди запрос уведомлений на устройстве…"
      : preparing ? "Проверяем готовность уведомлений…" : state.notice;
  return <section className={styles.card} role="region" aria-labelledby={`${id}-title`}
    data-guide-coach="app" data-guide-step="notifications" data-inline="true"
    onKeyDown={event => { if (event.key === "Escape" && !connecting) { event.preventDefault(); onContinue(); } }}>
    <div className={styles.heading}>
      <span className={styles.icon} aria-hidden="true">{state.connected ? <Check size={24} /> : <BellRing size={24} />}</span>
      <div><span className={styles.eyebrow}>Перед знакомством</span><h2 id={`${id}-title`}>Включим уведомления?</h2></div>
    </div>
    <p className={styles.summary}>Подскажем, когда закончится стройка, путешествие или производство.</p>
    <p id={`${id}-hint`} className={styles.hint}>{hint}</p>
    {!state.isOnline && <p className={styles.hint}>Для подключения нужен интернет. Можно продолжить знакомство и вернуться к уведомлениям позже.</p>}
    {progress && <p className={styles.status} role="status" aria-live="polite">{progress}</p>}
    {state.error && <p id={`${id}-error`} className={styles.error} role="alert">{state.error}</p>}
    <div className={styles.actions}>
      {(available || preparing) && <button type="button" className={styles.enable} disabled={disabled}
        aria-busy={preparing || connecting} aria-describedby={`${id}-hint${state.error ? ` ${id}-error` : ""}`}
        onClick={() => {
          if (disabled) return;
          if (retry) onRetry();
          else if (state.prepared && !state.connected) onEnable();
        }}>{label}</button>}
      <button type="button" className={styles.later} disabled={connecting} onClick={onContinue}>
        {state.connected || (!available && !preparing) ? "Продолжить знакомство" : "Пока без уведомлений"}
      </button>
    </div>
  </section>;
}
