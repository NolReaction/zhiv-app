"use client";
import { useCallback, useEffect, useId, useImperativeHandle, useRef, useState, type Ref } from "react";
import { Bell, Check, Moon, SlidersHorizontal } from "lucide-react";
import { SharingSwitch as Switch } from "@/components/sharing-switch";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import glass from "@/components/glass-dialog.module.css";
import { timeZoneOptions } from "@/lib/time-zone";
import { ApiError } from "@/lib/check-in-api";
import { saveNotificationPreferences } from "./notification-api";
import { notificationPreferencesSchema, type NotificationPreferences, type NotificationSnapshot } from "./notification-contract";
import { NotificationDeviceCard } from "./notification-device-card";
import { useNotificationDevice } from "./use-notification-device";
import styles from "./notification-settings.module.css";

const topics = [
  ["constructionCompleted", "Постройка и улучшения", "Когда здание готово к работе."],
  ["explorationCompleted", "Возвращение Мохлика", "Когда путешествие или рыбалка завершились."],
  ["productionCompleted", "Готовые ресурсы", "Когда закончились производство или сбор ресурсов."],
  ["checkinReminder", "Напомнить отметиться", "Только если с последней отметки прошло больше 24 часов. Одно напоминание до следующей отметки."],
] as const;

export type NotificationSettingsExit = { requestLeave: (leave: () => void) => void };

type NotificationSettingsProps = {
  ownerPublicId: string; isOnline: boolean; onSessionLost: () => void;
  exitRef?: Ref<NotificationSettingsExit>;
};
export function NotificationSettingsPanel(props: NotificationSettingsProps) {
  return <NotificationSettingsForOwner key={props.ownerPublicId} {...props} />;
}
function NotificationSettingsForOwner({ ownerPublicId, isOnline, onSessionLost, exitRef }: NotificationSettingsProps) {
  const id = useId();
  const lifecycle = useRef({ generation: 0, mounted: true });
  useEffect(() => {
    lifecycle.current = { generation: lifecycle.current.generation + 1, mounted: true };
    return () => { lifecycle.current.mounted = false; };
  }, [ownerPublicId]);
  const [snapshot, setSnapshot] = useState<NotificationSnapshot | null>(null);
  const [draft, setDraft] = useState<NotificationPreferences | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState("");
  const [confirmLeave, setConfirmLeave] = useState(false);
  const pendingLeave = useRef<(() => void) | null>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  const applySnapshot = useCallback((value: NotificationSnapshot) => {
    setSnapshot(value);
    // Returning from browser settings must not discard an edited preference form.
    setDraft(previous => previous ?? value.preferences);
  }, []);
  const device = useNotificationDevice(ownerPublicId, isOnline, applySnapshot, onSessionLost);
  const busy = saving || device.busy;
  const dirty = Boolean(draft && snapshot && JSON.stringify(draft) !== JSON.stringify(snapshot.preferences));
  useImperativeHandle(exitRef, () => ({ requestLeave(leave) {
    if (!dirty && !saving) { leave(); return; }
    if (pendingLeave.current) return;
    pendingLeave.current = leave;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmLeave(true);
  } }), [dirty, saving]);
  useEffect(() => {
    if (!dirty && !saving) return;
    const warnBeforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => window.removeEventListener("beforeunload", warnBeforeUnload);
  }, [dirty, saving]);
  function cancelLeave() { pendingLeave.current = null; setConfirmLeave(false); }
  function finishLeave() {
    const leave = pendingLeave.current;
    pendingLeave.current = null;
    returnFocus.current = null;
    setConfirmLeave(false);
    leave?.();
  }
  function discardAndLeave() {
    if (saving) return;
    setDraft(snapshot?.preferences ?? null);
    setNotice("");
    finishLeave();
  }
  const update = <Key extends keyof NotificationPreferences>(key: Key, value: NotificationPreferences[Key]) => {
    setDraft(previous => previous ? { ...previous, [key]: value } : previous); setNotice("");
  };
  async function perform(operation: (isCurrent: () => boolean) => Promise<void>) {
    if (busy) return;
    const generation = lifecycle.current.generation;
    const isCurrent = () => lifecycle.current.mounted && lifecycle.current.generation === generation;
    device.pauseRefresh();
    setSaving(true); setNotice("");
    try { await operation(isCurrent); }
    catch (error) {
      if (!isCurrent()) return;
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else setNotice(error instanceof Error ? error.message : "Не удалось сохранить. Попробуйте ещё раз.");
    } finally { if (isCurrent()) { setSaving(false); device.resumeRefresh(); } }
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
      if (pendingLeave.current) finishLeave();
    });
  }
  return <section className={styles.card} aria-labelledby={`${id}-title`} data-notification-settings>
    <header className={styles.heading}><Bell size={21} aria-hidden="true" /><div><h2 ref={headingRef} tabIndex={-1} id={`${id}-title`}>Уведомления</h2><p>Только нужные события, в удобное время</p></div></header>
    {!snapshot || snapshot.ownerPublicId !== ownerPublicId || !draft ? <div className={styles.loading} role="status">{device.loadError || "Загружаем настройки…"}{device.loadError && <button type="button" disabled={!isOnline} onClick={() => void device.refresh(true)}>Попробовать снова</button>}</div> : <>
      <NotificationDeviceCard id={id} state={{ ...device.state, disabled: saving }} onToggle={device.toggle} onRetry={() => void device.refresh(true)} />
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
          <div className={styles.topic}>
            <label htmlFor={`${id}-limits`}><strong>Ограничивать частоту</strong><span>Лимит за день и пауза между сообщениями. Выключите, чтобы получать готовые события без этих задержек.</span></label>
            <Switch id={`${id}-limits`} checked={draft.rateLimitsEnabled} disabled={busy} onCheckedChange={value => update("rateLimitsEnabled", value)} />
          </div>
          {draft.rateLimitsEnabled ? <div className={styles.selectRow}>
            <label htmlFor={`${id}-daily`}>Не больше за день<select id={`${id}-daily`} value={draft.maxPerDay} disabled={busy} onChange={event => update("maxPerDay", Number(event.target.value))}><option value={1}>1 сообщение</option><option value={2}>2 сообщения</option></select></label>
            <label htmlFor={`${id}-interval`}>Пауза между сообщениями<select id={`${id}-interval`} value={draft.minIntervalMinutes} disabled={busy} onChange={event => update("minIntervalMinutes", Number(event.target.value))}>
              <option value={60}>1 час</option><option value={120}>2 часа</option><option value={240}>4 часа</option><option value={480}>8 часов</option><option value={1440}>24 часа</option>
            </select></label>
          </div> : <p className={styles.hint}>Готовые события придут при ближайшей отправке. Тихие часы действуют отдельно.</p>}
        </details>
      </div>
      <p className={styles.hint}>Пока вы играете, пуши не приходят. Готовые дела объединяем; собранные награды и отменённые задания не напоминают о себе. Настройки событий общие для аккаунта, подключение отдельное на каждом устройстве.</p>
      <div className={styles.actions}><button type="button" className={styles.save} disabled={busy || !isOnline || !dirty} onClick={save}><Check size={17} aria-hidden="true" />{saving ? "Сохраняем…" : "Сохранить настройки"}</button><span role="status" aria-live="polite">{notice || (!isOnline ? "Для сохранения нужно подключение к интернету" : dirty ? "Есть несохранённые изменения" : "")}</span></div>
    </>}
    <Dialog open={confirmLeave} onOpenChange={open => { if (!open) cancelLeave(); }}>
      <DialogContent className={glass.dialog} onCloseAutoFocus={event => {
        event.preventDefault();
        const trigger = returnFocus.current;
        if (!trigger) return;
        // Focusing an inactive Radix tab would immediately request the same exit again.
        if (trigger.isConnected && !(trigger.getAttribute("role") === "tab" && trigger.getAttribute("aria-selected") !== "true")) trigger.focus();
        else headingRef.current?.focus();
      }}>
        <DialogHeader>
          <DialogTitle className={glass.title}>Настройки не сохранены</DialogTitle>
          <DialogDescription>{saving ? "Настройки ещё сохраняются. Подождите завершения." : "Вы изменили настройки уведомлений. Если выйти сейчас, эти изменения не сохранятся."}</DialogDescription>
        </DialogHeader>
        {notice && <p className={styles.hint} role="status">{notice}</p>}
        <div className={styles.leaveActions}>
          <button type="button" className={styles.save} onClick={cancelLeave}>Вернуться к настройкам</button>
          <button type="button" className={styles.connect} disabled={saving} onClick={discardAndLeave}>Выйти без сохранения</button>
        </div>
      </DialogContent>
    </Dialog>
  </section>;
}
