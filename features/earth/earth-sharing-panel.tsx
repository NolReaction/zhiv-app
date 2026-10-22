"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ChevronDown, Ghost, MapPin, RefreshCw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import type { PeopleResponse } from "@/lib/check-in-contract";
import type { EarthSharingDuration, EarthSharingPrecision, EarthSharingSettings } from "@/lib/earth-sharing-contract";
import type { useEarthSharing } from "./use-earth-sharing";
import { confirmedEarthChoices } from "./earth-friend-sharing";
import styles from "./earth-sharing-panel.module.css";

export { EarthSharingToggle } from "./earth-friend-sharing";

export type EarthSharingHandle = ReturnType<typeof useEarthSharing>;
export type EarthSharingChoices = { recipientCircleIds: string[]; frozenCircleIds: string[];
  precision: EarthSharingPrecision; durationMinutes: EarthSharingDuration; preserveSharingUntil?: boolean };
type Props = {
  sharing: EarthSharingHandle; people: PeopleResponse | null; peopleLoading: boolean; online: boolean;
  onShare: (choices: EarthSharingChoices) => Promise<void>; onGhost: () => void | Promise<void>; onOff: () => void | Promise<void>;
  locationAllowed?: boolean; sourceAccuracy?: number | null;
  onResume?: (resumeGhost?: boolean) => Promise<boolean | void>;
  onSetFrozen: (circleId: string, frozen: boolean) => Promise<boolean | void>;
  onRevokeRecipient: (circleId: string) => Promise<boolean | void>;
  onOpenPeople?: () => void;
};
type Draft = { revision: number | null; precision: EarthSharingPrecision; durationMinutes: EarthSharingDuration;
  initial?: { precision: EarthSharingPrecision; durationMinutes: EarthSharingDuration } };
function draftFor(settings: EarthSharingSettings | null): Draft {
  const choices = settings ? confirmedEarthChoices(settings) : { precision: "PRECISE" as const, durationMinutes: null };
  const initial = { precision: choices.precision, durationMinutes: choices.durationMinutes };
  return { revision: settings?.revision ?? null, ...initial, initial };
}
function choicesFor(settings: EarthSharingSettings, draft: Draft): EarthSharingChoices {
  return { recipientCircleIds: [...settings.recipientCircleIds], frozenCircleIds: [...(settings.frozenCircleIds ?? [])],
    precision: draft.precision, durationMinutes: draft.durationMinutes };
}

function localTime(value: string, seconds = false) {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("ru-RU", {
    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", ...(seconds ? { second: "2-digit" } : {}),
  }) : null;
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
export function EarthSharingPanelContent({ sharing, online, onShare, onResume, onGhost, onOff, locationAllowed = true, sourceAccuracy = null,
  draft, onPrecisionChange, onDurationChange, working = false, localError = null }: Props & {
  draft: Draft; onPrecisionChange: (value: EarthSharingPrecision) => void; onDurationChange: (value: EarthSharingDuration) => void;
  query?: string; onQueryChange?: (value: string) => void; working?: boolean; localError?: string | null;
}) {
  const settings = sharing.settings, busy = sharing.saving || working;
  const ghost = sharing.pendingGhost ? sharing.pendingPrivacyMode !== "OFF" : settings?.mode === "GHOST";
  const selected = new Set(settings?.recipientCircleIds ?? []), frozen = new Set(settings?.frozenCircleIds ?? []);
  const liveCount = [...selected].filter(id => !frozen.has(id)).length;
  const canChange = !!settings && online && !busy && !sharing.pendingGhost;
  const active = settings?.mode === "SHARING" && sharing.publishing && !!sharing.lastPublishedAt && !sharing.publicationError && !sharing.pendingGhost && liveCount > 0;
  const emptyGhost = ghost && selected.size === 0;
  const switchDisabled = !settings || !locationAllowed || sharing.pendingGhost
    || ghost && (emptyGhost ? busy : !canChange);
  const resume = (resumeGhost = false) => {
    if (!canChange || !locationAllowed || !settings || settings.mode === "OFF" || selected.size === 0) return;
    void (onResume ?? sharing.resume)?.(resumeGhost);
  };
  const saved = draftFor(settings), initial = draft.initial ?? saved;
  const dirty = draft.precision !== initial.precision || draft.durationMinutes !== initial.durationMinutes;
  const until = settings?.sharingUntil ? localTime(settings.sharingUntil) : null;
  const published = sharing.lastPublishedAt ? localTime(sharing.lastPublishedAt, true) : null;
  const accuracy = sourceAccuracy !== null && Number.isFinite(sourceAccuracy) && sourceAccuracy >= 0
    ? sourceAccuracy < 1_000 ? `${Math.max(1, Math.round(sourceAccuracy))} м`
      : `${(sourceAccuracy / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км` : null;
  const error = sharing.publicationError || sharing.error || localError;
  const status = !locationAllowed ? "Геопозиция отключена в профиле" : busy ? "Сохраняем…" : sharing.pendingGhost ? sharingSummary(sharing)
    : ghost ? "На паузе · последнее место" : sharing.publicationError ? "Не удалось обновить геопозицию" : sharingSummary(sharing);

  return <div className={styles.panel}>
    <section className={styles.sharingCard} data-live={active || undefined} aria-labelledby="earth-sharing-heading">
      <div className={styles.sharingRow}>
        <span className={styles.sharingIcon} aria-hidden="true"><Ghost size={20} /></span>
        <div className={styles.sharingTitle}><strong id="earth-sharing-heading">Моя геопозиция</strong>
          <span role="status"><i className={styles.statusDot} data-live={active || undefined} />{status}</span></div>
        <button type="button" role="switch" data-audio-cue="ui.click" className={styles.ghostSwitch} aria-checked={ghost}
          aria-label="Режим призрака" aria-describedby="earth-sharing-hint" disabled={switchDisabled}
          onClick={() => {
            if (switchDisabled) return;
            if (!ghost) void onGhost();
            else if (emptyGhost) void onOff();
            else resume(true);
          }}>
          <span className={styles.ghostLabel} aria-hidden="true">Призрак</span>
          <span className={styles.switchTrack} aria-hidden="true"><span /></span>
          <span aria-hidden="true">{ghost ? "Вкл" : "Выкл"}</span>
        </button>
      </div>
      <div className={styles.hintRow}><p id="earth-sharing-hint" className={styles.sharingHint}>{!locationAllowed ? "Включить геопозицию можно в настройках профиля."
        : selected.size === 0 ? "Доступ закрыт: получателей нет."
          : `Доступ у ${selected.size} · обновления разрешены для ${liveCount}.`}</p>
        {!ghost && settings?.mode === "SHARING" && !sharing.publishing && liveCount > 0 && <button type="button" className={styles.resumeButton}
          data-audio-cue="ui.click" disabled={!canChange || !locationAllowed} onClick={() => resume()}>Возобновить</button>}
      </div>
      <p className={styles.settingSummary}>{saved.precision === "PRECISE" ? "Точная геопозиция" : "Примерный район"} · {until ? <>доступ до <time dateTime={settings!.sharingUntil!}>{until}</time></>
        : saved.durationMinutes === null ? "пока не выключу" : saved.durationMinutes === 480 ? "на 8 часов" : "на 1 час"}</p>
      {published && <p className={styles.lastUpdate}>Друзьям отправлено: <time dateTime={sharing.lastPublishedAt!}>{published}</time></p>}
      {accuracy && <p className={styles.lastUpdate}>Точность GPS: ±{accuracy}</p>}
      <p className={styles.sharingHint}>Обновляется, пока приложение открыто на экране, в том числе во время игры. В фоне остаётся последнее место.</p>
    </section>
    <p className={styles.consentHint}>Своё место вы показываете только выбранным друзьям в «Людях». Чтобы видеть друга, он тоже должен открыть вам доступ.</p>

    {sharing.pendingGhost && <p className={styles.pending} role="status">{sharing.pendingPrivacyMode === "OFF"
      ? "Удаление доступа ещё не подтверждено сервером."
      : "Передача остановлена на устройстве. Ждём подтверждения сервера."}</p>}
    {!online && <p className={styles.pending} role="status">Нет сети. Включить обновление можно после подключения.</p>}
    {error && <div className={styles.error} role="alert"><span>{error}</span>
      <button type="button" data-audio-cue="ui.click" aria-label="Обновить настройки геопозиции" disabled={!online || busy} onClick={sharing.refresh}><RefreshCw size={16} aria-hidden="true" /></button></div>}
    {sharing.loading && !settings && <p role="status">Загружаем настройки…</p>}
    <details className={styles.options}>
      <summary onClick={playDisclosureCue}><SlidersHorizontal size={16} aria-hidden="true" /><span>Дополнительные настройки</span>
        <small>{saved.precision === "PRECISE" ? "Точно" : "Примерно"}</small><ChevronDown size={16} aria-hidden="true" /></summary>
      <form onSubmit={event => { event.preventDefault(); if (settings && canChange && locationAllowed && !ghost && selected.size > 0 && dirty) void onShare(choicesFor(settings, draft)); }}>
        <fieldset disabled={!canChange || !locationAllowed || ghost} className={styles.precision}><legend>Точность</legend>
          <label><input type="radio" name="earth-sharing-precision" value="APPROXIMATE" checked={draft.precision === "APPROXIMATE"}
            onChange={() => { if (canChange && !ghost && draft.precision !== "APPROXIMATE") { onPrecisionChange("APPROXIMATE"); playUiCue(getAudioRuntime(), "ui.click"); } }} /><span>Примерно</span></label>
          <label><input type="radio" name="earth-sharing-precision" value="PRECISE" checked={draft.precision === "PRECISE"}
            onChange={() => { if (canChange && !ghost && draft.precision !== "PRECISE") { onPrecisionChange("PRECISE"); playUiCue(getAudioRuntime(), "ui.click"); } }} /><span>Точно</span></label>
        </fieldset>
        <label className={styles.duration}>Срок после сохранения<select value={draft.durationMinutes === null ? "forever" : String(draft.durationMinutes)} disabled={!canChange || !locationAllowed || ghost}
          onChange={event => {
            const duration = event.target.value === "forever" ? null : Number(event.target.value) as 60 | 480;
            if (canChange && !ghost && duration !== draft.durationMinutes) { onDurationChange(duration); playUiCue(getAudioRuntime(), "ui.click"); }
          }}>
          <option value="60">На 1 час</option><option value="480">На 8 часов</option><option value="forever">Пока не выключу</option>
        </select></label>
        <p className={styles.quiet}>Примерно — район около 1,5 км. В фоне обновлений нет.</p>
        {until && <p className={styles.quiet}>Текущий доступ до {until}. Сохранение заново отсчитает выбранный срок.</p>}
        <button className={styles.applyButton} type="submit" data-audio-cue="ui.click" disabled={!canChange || !locationAllowed || ghost || selected.size === 0 || !dirty}><MapPin size={16} aria-hidden="true" />Сохранить настройки</button>
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
  const operationId = useRef(0);
  const busy = useRef<"change" | "ghost" | "off" | null>(null);
  useEffect(() => () => { operationId.current++; }, []);
  const run = async (operation: () => Promise<boolean | void> | boolean | void, privacy: "ghost" | "off" | null = null) => {
    if (busy.current && (!privacy || busy.current === "off" || busy.current === "ghost" && privacy !== "off")) return;
    const current = ++operationId.current;
    busy.current = privacy ?? "change";
    setWorking(true); setLocalError(null);
    try { await operation(); }
    catch { if (operationId.current === current) setLocalError("Не удалось сохранить. Попробуйте ещё раз."); }
    finally { if (operationId.current === current) { busy.current = null; setWorking(false); } }
  };
  return <EarthSharingPanelContent {...props} draft={draft} working={working} localError={localError}
    onPrecisionChange={precision => setDraft(value => ({ ...value, precision }))}
    onDurationChange={durationMinutes => setDraft(value => ({ ...value, durationMinutes }))}
    onShare={choices => run(() => props.onShare(choices))}
    onResume={resumeGhost => run(() => props.onResume ? props.onResume(resumeGhost) : props.sharing.resume(resumeGhost))}
    onGhost={() => run(() => { props.sharing.stopPublishing(); return props.onGhost(); }, "ghost")}
    onOff={() => run(() => { props.sharing.stopPublishing(); return props.onOff(); }, "off")}
    onSetFrozen={(circleId, frozen) => run(() => props.onSetFrozen(circleId, frozen))}
    onRevokeRecipient={circleId => run(() => props.onRevokeRecipient(circleId))} />;
}
