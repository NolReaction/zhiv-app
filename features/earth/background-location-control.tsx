"use client";

import { useId, useSyncExternalStore } from "react";
import { SharingSwitch } from "@/components/sharing-switch";
import { backgroundLocationChoice } from "./native-publisher";
import styles from "./background-location-control.module.css";

/** A device preference only: changing it never creates a sharing lease. */
export function BackgroundLocationControl({ canEnable }: { canEnable: boolean }) {
  const id = useId();
  const choice = useSyncExternalStore(backgroundLocationChoice.subscribe, backgroundLocationChoice.getSnapshot, backgroundLocationChoice.getServerSnapshot);
  if (!choice.available) return null;
  return <section className={styles.control} aria-label="Фоновая геопозиция">
    <div className={styles.row}>
      <label htmlFor={id}><strong>Обновлять в фоне</strong>
        <span>Продолжать обмен с выбранными близкими при свёрнутом приложении и заблокированном экране.</span></label>
      <SharingSwitch id={id} checked={choice.enabled} disabled={choice.busy || !choice.enabled && !canEnable}
        onCheckedChange={value => { void backgroundLocationChoice.setEnabled(value); }} data-audio-cue="ui.click" />
    </div>
    <p>Получатели и срок доступа не меняются. Телефон показывает индикатор или уведомление. Принудительное закрытие и ограничения системы могут остановить обновления.</p>
    {choice.busy && <p role="status">Сохраняем…</p>}
    {choice.error && <p className={styles.error} role="alert">{choice.error}</p>}
  </section>;
}
