"use client";
import { useEffect, useId, useRef, useState } from "react";
import { Bell, BellOff, Check, Moon, SlidersHorizontal } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { timeZoneOptions } from "@/lib/time-zone";
import { ApiError } from "@/lib/check-in-api";
import { getNotificationSettings, saveNotificationPreferences } from "./notification-api";
import { notificationPreferencesSchema, type NotificationPreferences, type NotificationSnapshot } from "./notification-contract";
import { connectPush, currentPushSubscription, disconnectPush, notificationSupport } from "./notification-browser";
import styles from "./notification-settings.module.css";

const topics = [
  ["constructionCompleted", "Постройка и улучшения", "Когда здание готово к работе."],
  ["explorationCompleted", "Возвращение Мохлика", "Когда путешествие или рыбалка завершились."],
  ["productionCompleted", "Готовые ресурсы", "Когда закончились производство или сбор ресурсов."],
  ["checkinReminder", "Напомнить отметиться", "Только если с последней отметки прошло больше 24 часов. Одно напоминание до следующей отметки."],
] as const;

export function NotificationSettingsPanel({ ownerPublicId, isOnline, onSessionLost }: {
  ownerPublicId: string; isOnline: boolean; onSessionLost: () => void;
}) {
  const id = useId();
  const lifecycle = useRef({ generation: 0, mounted: true });
  useEffect(() => {
    lifecycle.current = { generation: lifecycle.current.generation + 1, mounted: true };
    return () => { lifecycle.current.mounted = false; };
  }, [ownerPublicId]);
  const [snapshot, setSnapshot] = useState<NotificationSnapshot | null>(null);
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  const [supported, setSupported] = useState<{ supported: boolean; reason: string | null }>({ supported: false, reason: null });
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [loadError, setLoadError] = useState("");
  const [reload, setReload] = useState(0);
  useEffect(() => {
    const abort = new AbortController();
    void getNotificationSettings(ownerPublicId, abort.signal).then(async value => {
      const subscription = await currentPushSubscription().catch(() => null);
      if (abort.signal.aborted) return;
      setSnapshot(value); setDraft(value.preferences); setSupported(notificationSupport());
      setConnected(value.subscription.subscribed && Boolean(subscription));
      setLoadError("");
    }).catch(error => {
      if (abort.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else setLoadError(error instanceof Error ? error.message : "Не удалось загрузить настройки");
    });
    return () => abort.abort();
  }, [ownerPublicId, onSessionLost, reload]);
  const dirty = Boolean(draft && snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.preferences));
  const update = <Key extends keyof NotificationPreferences>(key: Key, value: NotificationPreferences[Key]) => {
    setDraft(previous => previous ? { ...previous, [key]: value } : previous); setNotice("");
  };
  async function perform(operation: (isCurrent: () => boolean) => Promise<void>) {
    if (busy) return;
    const generation = lifecycle.current.generation;
    const isCurrent = () => lifecycle.current.mounted && lifecycle.current.generation === generation;
    setBusy(true); setNotice("");
    try { await operation(isCurrent); }
    catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else setNotice(error instanceof Error ? error.message : "Не удалось сохранить. Попробуйте ещё раз.");
    } finally { if (isCurrent()) { setBusy(false); setSupported(notificationSupport()); } }
  }
  function save() {
    if (!draft) return;
    const parsed = notificationPreferencesSchema.safeParse(draft);
    if (!parsed.success) { setNotice("Проверьте тихие часы: начало и конец должны отличаться."); return; }
    void perform(async isCurrent => {
      const value = await saveNotificationPreferences(ownerPublicId, parsed.data);
      if (!isCurrent()) return;
      if (value.ownerPublicId !== ownerPublicId) throw new Error("Профиль изменился. Откройте настройки заново.");
      setSnapshot(value); setDraft(value.preferences); setNotice("Настройки сохранены");
    });
  }
  function toggleConnection() {
    if (!snapshot) return;
    // perform invokes operation synchronously, preserving the permission button's user gesture.
    void perform(async isCurrent => {
      if (connected) {
        const value = await disconnectPush(ownerPublicId);
        if (!isCurrent()) return;
        if (value) setSnapshot(value);
        setConnected(false); setNotice("На этом устройстве уведомления выключены");
      } else {
        const value = await connectPush(ownerPublicId, snapshot);
        if (!isCurrent()) return;
        setSnapshot(value); setConnected(true); setNotice("Уведомления подключены на этом устройстве");
      }
    });
  }
  return <section className={styles.card} aria-labelledby={`${id}-title`} data-notification-settings>
    <header className={styles.heading}><Bell size={21} aria-hidden="true" /><div><h2 id={`${id}-title`}>Уведомления</h2><p>Только нужные события, в удобное время</p></div></header>
    {!snapshot || !draft ? <div className={styles.loading} role="status">{loadError || "Загружаем настройки…"}{loadError && <button type="button" disabled={!isOnline} onClick={() => setReload(value => value + 1)}>Попробовать снова</button>}</div> : <>
      <div className={styles.device}>
        <span className={styles.deviceIcon}>{connected ? <Bell size={19} aria-hidden="true" /> : <BellOff size={19} aria-hidden="true" />}</span>
        <div><strong>{connected ? "Подключены на этом устройстве" : "На этом устройстве выключены"}</strong><p>{!snapshot.delivery.configured
          ? "Отправка ещё не подключена на сервере. Вы уже можете выбрать события и сохранить настройки."
          : supported.reason ?? "Включите, когда захотите. Браузер отдельно попросит ваше разрешение."}</p></div>
        <button type="button" className={styles.connect} disabled={busy || !isOnline || (!connected && (!snapshot.delivery.configured || !supported.supported))} onClick={toggleConnection}>
          {connected ? "Выключить здесь" : "Подключить на устройстве"}
        </button>
      </div>
      <fieldset className={styles.topics} disabled={busy}>
        <legend>О чём сообщать</legend>
        {topics.map(([key, label, hint]) => <div className={styles.topic} key={key}>
          <label htmlFor={`${id}-${key}`}><strong>{label}</strong><span>{hint}</span></label>
          <Switch id={`${id}-${key}`} checked={draft[key]} onCheckedChange={value => update(key, value)} />
        </div>)}
      </fieldset>
      <div className={styles.limits}>
        <div className={styles.topic}><label htmlFor={`${id}-quiet`}><strong><Moon size={16} aria-hidden="true" />Тихие часы</strong><span>Ночью не беспокоим. Утром соберём актуальное в одно сообщение.</span></label><Switch id={`${id}-quiet`} checked={draft.quietHoursEnabled} disabled={busy} onCheckedChange={value => update("quietHoursEnabled", value)} /></div>
        {draft.quietHoursEnabled && <div className={styles.timeRow}>
          <label htmlFor={`${id}-from`}>С<input id={`${id}-from`} type="time" value={draft.quietStart} disabled={busy} onChange={event => update("quietStart", event.target.value)} /></label>
          <label htmlFor={`${id}-until`}>До<input id={`${id}-until`} type="time" value={draft.quietEnd} disabled={busy} onChange={event => update("quietEnd", event.target.value)} /></label>
          <label className={styles.timeZone} htmlFor={`${id}-zone`}>Часовой пояс уведомлений<select id={`${id}-zone`} value={draft.timeZone} disabled={busy} onChange={event => update("timeZone", event.target.value)}>{timeZoneOptions(draft.timeZone).map(zone => <option key={zone} value={zone}>{zone.replaceAll("_", " ")}</option>)}</select></label>
        </div>}
        <details className={styles.frequency}><summary><SlidersHorizontal size={16} aria-hidden="true" />Частота сообщений</summary>
          <div className={styles.selectRow}>
            <label htmlFor={`${id}-daily`}>Не больше за день<select id={`${id}-daily`} value={draft.maxPerDay} disabled={busy} onChange={event => update("maxPerDay", Number(event.target.value))}><option value={1}>1 сообщение</option><option value={2}>2 сообщения</option></select></label>
            <label htmlFor={`${id}-interval`}>Пауза между сообщениями<select id={`${id}-interval`} value={draft.minIntervalMinutes} disabled={busy} onChange={event => update("minIntervalMinutes", Number(event.target.value))}>
              <option value={60}>1 час</option><option value={120}>2 часа</option><option value={240}>4 часа</option><option value={480}>8 часов</option><option value={1440}>24 часа</option>
            </select></label>
          </div>
        </details>
      </div>
      <p className={styles.hint}>Пока вы играете, пуши не приходят. Готовые дела объединяем; собранные награды и отменённые задания не напоминают о себе. Настройки событий общие для аккаунта, подключение отдельное на каждом устройстве.</p>
      <div className={styles.actions}><button type="button" className={styles.save} disabled={busy || !isOnline || !dirty} onClick={save}><Check size={17} aria-hidden="true" />{busy ? "Сохраняем…" : "Сохранить настройки"}</button><span role="status" aria-live="polite">{notice || (!isOnline ? "Для сохранения нужно подключение к интернету" : dirty ? "Есть несохранённые изменения" : "")}</span></div>
    </>}
  </section>;
}
