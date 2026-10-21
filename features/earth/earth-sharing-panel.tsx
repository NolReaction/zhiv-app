"use client";

import { useState, type MouseEvent } from "react";
import { ChevronDown, MapPin, Pause, RefreshCw, ShieldCheck, SlidersHorizontal, Users } from "lucide-react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import type { PeopleResponse } from "@/lib/check-in-contract";
import type { EarthSharingDuration, EarthSharingPrecision, EarthSharingSettings } from "@/lib/earth-sharing-contract";
import type { useEarthSharing } from "./use-earth-sharing";
import styles from "./earth-sharing-panel.module.css";

export { EarthSharingToggle } from "./earth-friend-sharing";

export type EarthSharingHandle = ReturnType<typeof useEarthSharing>;
export type EarthSharingChoices = { recipientCircleIds: string[]; frozenCircleIds: string[];
  precision: EarthSharingPrecision; durationMinutes: EarthSharingDuration };
type Props = {
  sharing: EarthSharingHandle; people: PeopleResponse | null; peopleLoading: boolean; online: boolean;
  onShare: (choices: EarthSharingChoices) => Promise<void>; onGhost: () => void; onOff: () => void;
  onSetFrozen: (circleId: string, frozen: boolean) => Promise<boolean | void>;
  onRevokeRecipient: (circleId: string) => Promise<boolean | void>;
  onOpenPeople?: () => void;
};
type Draft = { revision: number | null; precision: EarthSharingPrecision; durationMinutes: EarthSharingDuration };
function draftFor(settings: EarthSharingSettings | null): Draft {
  return { revision: settings?.revision ?? null, precision: settings?.precision ?? "APPROXIMATE",
    durationMinutes: settings && settings.mode !== "OFF" && settings.sharingUntil === null ? null
      : settings?.sharingUntil && Date.parse(settings.sharingUntil) - Date.parse(settings.serverTime) > 60 * 60_000 ? 480 : 60 };
}
function choicesFor(settings: EarthSharingSettings, draft: Draft): EarthSharingChoices {
  return { recipientCircleIds: [...settings.recipientCircleIds], frozenCircleIds: [...(settings.frozenCircleIds ?? [])],
    precision: draft.precision, durationMinutes: draft.durationMinutes };
}

function playDisclosureCue(event: MouseEvent<HTMLElement>) {
  if (event.defaultPrevented) return;
  const details = event.currentTarget.closest("details");
  if (details) playUiCue(getAudioRuntime(), details.open ? "ui.close" : "ui.open");
}

export function sharingSummary(sharing: Pick<EarthSharingHandle, "settings" | "pendingGhost" | "publishing" | "lastPublishedAt">) {
  if (sharing.pendingGhost) return "Сохраняем приватность…";
  if (!sharing.settings) return "Моя геопозиция";
  if (sharing.settings.mode === "GHOST") return "Призрак включён";
  if (sharing.settings.mode === "OFF") return "Геопозиция закрыта";
  const live = sharing.settings.recipientCircleIds.length - (sharing.settings.frozenCircleIds?.length ?? 0);
  if (live === 0) return "Все на паузе";
  return sharing.publishing ? sharing.lastPublishedAt ? "Делюсь гео · " + live : "Ищем местоположение…" : "Обновление на паузе";
}

/** Confirmed sharing state controls every switch; rendering never grants access. */
export function EarthSharingPanelContent({ sharing, online, onShare, onGhost, onOff, onOpenPeople,
  draft, onPrecisionChange, onDurationChange, working = false, localError = null }: Props & {
  draft: Draft; onPrecisionChange: (value: EarthSharingPrecision) => void; onDurationChange: (value: EarthSharingDuration) => void;
  query?: string; onQueryChange?: (value: string) => void; working?: boolean; localError?: string | null;
}) {
  const settings = sharing.settings, busy = sharing.saving || working;
  const ghost = sharing.pendingGhost ? sharing.pendingPrivacyMode !== "OFF" : settings?.mode === "GHOST";
  const selected = new Set(settings?.recipientCircleIds ?? []), frozen = new Set(settings?.frozenCircleIds ?? []);
  const liveCount = [...selected].filter(id => !frozen.has(id)).length;
  const canChange = !!settings && online && !busy && !sharing.pendingGhost;
  const active = settings?.mode === "SHARING" && sharing.publishing && !sharing.pendingGhost && liveCount > 0;
  const emptyGhost = settings?.mode === "GHOST" && selected.size === 0;
  const frozenGhost = settings?.mode === "GHOST" && selected.size > 0 && liveCount === 0;
  const needsAudience = !!settings && (settings.mode === "OFF" || selected.size === 0 || liveCount === 0 && settings.mode !== "GHOST");
  const primaryDisabled = active || emptyGhost ? sharing.pendingGhost : needsAudience
    ? !onOpenPeople || busy || sharing.pendingGhost : !canChange;
  const resume = () => {
    if (!canChange || !settings || settings.mode === "OFF" || selected.size === 0) return;
    void onShare(choicesFor(settings, draftFor(settings)));
  };
  const error = sharing.error || localError;
  const status = busy ? "Сохраняем…" : sharing.pendingGhost ? sharingSummary(sharing)
    : ghost ? "На паузе · последнее место" : sharingSummary(sharing);

  return <div className={styles.panel}>
    <section className={styles.sharingCard} data-live={active || undefined} aria-labelledby="earth-sharing-heading">
      <div className={styles.sharingRow}>
        <span className={styles.sharingIcon} aria-hidden="true"><MapPin size={18} /></span>
        <div className={styles.sharingTitle}><strong id="earth-sharing-heading">Обновления для друзей</strong>
          <span role="status"><i className={styles.statusDot} data-live={active || undefined} />{status}</span></div>
        <button type="button" data-audio-cue="ui.click" className={styles.sharingAction} aria-pressed={active}
          aria-label={active ? "Приостановить обновления геопозиции" : emptyGhost || frozenGhost ? "Выключить режим призрака" : needsAudience ? "Выбрать получателей в Людях" : "Включить обновления геопозиции"}
          aria-describedby="earth-sharing-hint" disabled={primaryDisabled}
          onClick={() => {
            if (primaryDisabled) return;
            if (active) onGhost();
            else if (emptyGhost) onOff();
            else if (needsAudience) onOpenPeople?.();
            else resume();
          }}>
          {active && <Pause size={13} aria-hidden="true" />}{active ? "Приостановить" : emptyGhost ? "Выключить призрака" : frozenGhost ? "Снять паузу" : needsAudience ? "Выбрать" : "Включить"}
        </button>
      </div>
      <p id="earth-sharing-hint" className={styles.sharingHint}>{selected.size === 0 ? "Получатели выбираются в «Людях»."
        : `Доступ у ${selected.size} · обновления разрешены для ${liveCount}.`}</p>
    </section>

    {sharing.pendingGhost && <p className={styles.pending} role="status">{sharing.pendingPrivacyMode === "OFF"
      ? "Удаление доступа ещё не подтверждено сервером."
      : "Передача остановлена на устройстве. Ждём подтверждения сервера."}</p>}
    {!online && <p className={styles.pending} role="status">Нет сети. Включить обновление можно после подключения.</p>}
    {error && <div className={styles.error} role="alert"><span>{error}</span>
      <button type="button" data-audio-cue="ui.click" aria-label="Обновить настройки геопозиции" disabled={!online || busy} onClick={sharing.refresh}><RefreshCw size={16} aria-hidden="true" /></button></div>}
    {sharing.loading && !settings && <p role="status">Загружаем настройки…</p>}
    {onOpenPeople && <button type="button" data-audio-cue="ui.open" className={styles.peopleLink} onClick={onOpenPeople}>
      <Users size={16} aria-hidden="true" /><span>Кому доступно — в «Людях»</span>
    </button>}

    <details className={styles.options}>
      <summary onClick={playDisclosureCue}><SlidersHorizontal size={16} aria-hidden="true" /><span>Точность и срок</span>
        <small>{settings?.precision === "PRECISE" ? "Точно" : "Примерно"}</small><ChevronDown size={16} aria-hidden="true" /></summary>
      <form onSubmit={event => { event.preventDefault(); if (settings && canChange && !ghost && selected.size > 0) void onShare(choicesFor(settings, draft)); }}>
        <fieldset disabled={!canChange || ghost} className={styles.precision}><legend>Точность</legend>
          <label><input type="radio" name="earth-sharing-precision" value="APPROXIMATE" checked={draft.precision === "APPROXIMATE"}
            onChange={() => { if (canChange && !ghost && draft.precision !== "APPROXIMATE") { onPrecisionChange("APPROXIMATE"); playUiCue(getAudioRuntime(), "ui.click"); } }} /><span>Примерно</span></label>
          <label><input type="radio" name="earth-sharing-precision" value="PRECISE" checked={draft.precision === "PRECISE"}
            onChange={() => { if (canChange && !ghost && draft.precision !== "PRECISE") { onPrecisionChange("PRECISE"); playUiCue(getAudioRuntime(), "ui.click"); } }} /><span>Точно</span></label>
        </fieldset>
        <label className={styles.duration}>Срок доступа<select value={draft.durationMinutes === null ? "forever" : String(draft.durationMinutes)} disabled={!canChange || ghost}
          onChange={event => {
            const duration = event.target.value === "forever" ? null : Number(event.target.value) as 60 | 480;
            if (canChange && !ghost && duration !== draft.durationMinutes) { onDurationChange(duration); playUiCue(getAudioRuntime(), "ui.click"); }
          }}>
          <option value="60">На 1 час</option><option value="480">На 8 часов</option><option value="forever">Пока не выключу</option>
        </select></label>
        <p className={styles.quiet}>Примерно — район около 1,5 км. В фоне обновлений нет.</p>
        {settings?.sharingUntil && <p className={styles.quiet}>Текущий доступ до {new Date(settings.sharingUntil).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}.</p>}
        <button className={styles.applyButton} type="submit" data-audio-cue="ui.click" disabled={!canChange || ghost || selected.size === 0}><MapPin size={16} aria-hidden="true" />Применить и обновлять</button>
      </form>
      <p className={styles.retention}><ShieldCheck size={15} aria-hidden="true" />Только последнее место, без истории. До 24 часов, в пределах срока доступа.</p>
      {(selected.size > 0 || settings?.mode === "GHOST") && <button className={styles.revokeAll} type="button" data-audio-cue="ui.click" onClick={onOff}>Убрать меня с карты у всех</button>}
    </details>
  </div>;
}

export function EarthSharingPanel(props: Props) {
  const [draft, setDraft] = useState(() => draftFor(props.sharing.settings));
  const [working, setWorking] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  if (props.sharing.settings && draft.revision !== props.sharing.settings.revision) {
    setDraft(draftFor(props.sharing.settings)); setLocalError(null);
  }
  const run = async (operation: () => Promise<boolean | void>) => {
    if (working) return;
    setWorking(true); setLocalError(null);
    try { await operation(); }
    catch { setLocalError("Не удалось сохранить. Попробуйте ещё раз."); }
    finally { setWorking(false); }
  };
  return <EarthSharingPanelContent {...props} draft={draft} working={working} localError={localError}
    onPrecisionChange={precision => setDraft(value => ({ ...value, precision }))}
    onDurationChange={durationMinutes => setDraft(value => ({ ...value, durationMinutes }))}
    onShare={choices => run(() => props.onShare(choices))}
    onSetFrozen={(circleId, frozen) => run(() => props.onSetFrozen(circleId, frozen))}
    onRevokeRecipient={circleId => run(() => props.onRevokeRecipient(circleId))} />;
}
