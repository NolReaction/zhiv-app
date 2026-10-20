"use client";

import { useState, type MouseEvent } from "react";
import { ChevronDown, Ghost, MapPin, MoreHorizontal, RefreshCw, ShieldCheck, SlidersHorizontal } from "lucide-react";
import { PlayerName } from "@/components/player-name";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import type { PeopleResponse } from "@/lib/check-in-contract";
import { personDisplayName } from "@/lib/person-nickname";
import type { EarthSharingDuration, EarthSharingPrecision, EarthSharingSettings } from "@/lib/earth-sharing-contract";
import type { useEarthSharing } from "./use-earth-sharing";
import styles from "./earth-sharing-panel.module.css";

export type EarthSharingHandle = ReturnType<typeof useEarthSharing>;
export type EarthSharingChoices = { recipientCircleIds: string[]; frozenCircleIds: string[];
  precision: EarthSharingPrecision; durationMinutes: EarthSharingDuration };
type Props = {
  sharing: EarthSharingHandle; people: PeopleResponse | null; peopleLoading: boolean; online: boolean;
  onShare: (choices: EarthSharingChoices) => Promise<void>; onGhost: () => void; onOff: () => void;
  onSetFrozen: (circleId: string, frozen: boolean) => Promise<boolean | void>;
  onRevokeRecipient: (circleId: string) => Promise<boolean | void>;
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

export function EarthSharingToggle({ checked, disabled, label, description, onChange, ghost = false }: {
  checked: boolean; disabled: boolean; label: string; description?: string; onChange: () => void; ghost?: boolean;
}) {
  return <button type="button" data-audio-cue="ui.click" role="switch" aria-checked={checked} disabled={disabled} aria-label={label}
    aria-describedby={description} className={styles.toggle + (ghost ? " " + styles.ghostToggle : "")}
    onClick={() => { if (!disabled) onChange(); }}><span className={styles.track}><span /></span></button>;
}

/** Confirmed sharing state controls every switch; rendering never grants access. */
export function EarthSharingPanelContent({ sharing, people, peopleLoading, online, onShare, onGhost, onOff, onSetFrozen,
  onRevokeRecipient, draft, onPrecisionChange, onDurationChange, query, onQueryChange, working = false, localError = null }: Props & {
  draft: Draft; onPrecisionChange: (value: EarthSharingPrecision) => void; onDurationChange: (value: EarthSharingDuration) => void;
  query: string; onQueryChange: (value: string) => void; working?: boolean; localError?: string | null;
}) {
  const settings = sharing.settings, busy = sharing.saving || working;
  const ghost = sharing.pendingGhost ? sharing.pendingPrivacyMode !== "OFF" : settings?.mode === "GHOST";
  const selected = new Set(settings?.recipientCircleIds ?? []), frozen = new Set(settings?.frozenCircleIds ?? []);
  const liveCount = [...selected].filter(id => !frozen.has(id)).length;
  const canChange = !!settings && online && !busy && !sharing.pendingGhost;
  const friends = people?.people ?? [], search = query.trim().toLocaleLowerCase("ru-RU");
  const matching = friends.filter(person => !search || personDisplayName(person).toLocaleLowerCase("ru-RU").includes(search));
  const displayed = matching.slice(0, 100);
  const savedChoices = settings ? choicesFor(settings, draftFor(settings)) : null;
  const resume = () => {
    if (!canChange || !savedChoices) return;
    if (savedChoices.recipientCircleIds.length) void onShare(savedChoices); else onOff();
  };
  const error = sharing.error || localError;

  return <div className={styles.panel}>
    <section className={styles.ghostCard} data-enabled={ghost || undefined} aria-labelledby="earth-ghost-heading">
      <div className={styles.ghostRow}>
        <span className={styles.ghostIcon}><Ghost size={23} aria-hidden="true" /></span>
        <div className={styles.ghostTitle}><strong id="earth-ghost-heading">Режим призрака</strong><span>{ghost ? "Включён для всех" : "Можно включить в любой момент"}</span></div>
        <EarthSharingToggle ghost checked={ghost} disabled={ghost && !canChange} label="Режим призрака"
          description="earth-ghost-hint" onChange={() => { if (ghost) resume(); else onGhost(); }} />
      </div>
      <p id="earth-ghost-hint">Последнее место вместо обновлений. Без уведомлений.</p>
    </section>

    <div className={styles.connection} role="status">
      <span className={styles.statusDot} data-live={sharing.publishing && !ghost || undefined} />
      <span>{busy ? "Сохраняем…" : sharingSummary(sharing)}</span>
      {settings?.mode === "SHARING" && !sharing.publishing && !sharing.pendingGhost && liveCount > 0 &&
        <button type="button" data-audio-cue="ui.click" className={styles.resume} disabled={!canChange} onClick={resume}>Возобновить</button>}
    </div>
    {sharing.pendingGhost && <p className={styles.pending} role="status">{sharing.pendingPrivacyMode === "OFF"
      ? "Удаление доступа ещё не подтверждено сервером."
      : "Передача остановлена на устройстве. Ждём подтверждения сервера."}</p>}
    {!online && <p className={styles.pending} role="status">Нет сети. Включить обновление можно после подключения.</p>}
    {error && <div className={styles.error} role="alert"><span>{error}</span>
      <button type="button" data-audio-cue="ui.click" aria-label="Обновить настройки геопозиции" disabled={!online || busy} onClick={sharing.refresh}><RefreshCw size={16} aria-hidden="true" /></button></div>}
    {sharing.loading && !settings && <p role="status">Загружаем настройки…</p>}

    <section className={styles.friends} aria-labelledby="earth-sharing-friends-title">
      <header><h3 id="earth-sharing-friends-title">Геопозиция для друзей</h3><span>{selected.size} из {friends.length}</span></header>
      {ghost && friends.length > 0 && <p className={styles.quiet}>Выключи призрака, чтобы делиться.</p>}
      {friends.length > 8 && <label className={styles.search}><span className={styles.srOnly}>Найти близкого</span>
        <input type="search" aria-label="Найти близкого" placeholder="Найти близкого" value={query}
          onChange={event => onQueryChange(event.target.value)} autoComplete="off" /></label>}
      {peopleLoading && !people && <p role="status">Загружаем близких…</p>}
      {displayed.length > 0 ? <ul className={styles.recipientList}>
        {displayed.map(person => {
          const name = personDisplayName(person), hasAccess = selected.has(person.circleId), isFrozen = frozen.has(person.circleId);
          const status = !hasAccess ? "Нет доступа" : ghost || isFrozen || !sharing.publishing ? "Последнее место" : "Обновляется";
          const disabled = !canChange || ghost || !hasAccess && selected.size >= 100;
          return <li key={person.circleId} className={styles.friend}>
            <div className={styles.friendMain} data-has-access={hasAccess || undefined}>
              <span className={styles.avatar} aria-hidden="true">{Array.from(name.trim())[0]?.toLocaleUpperCase("ru-RU") || "Ж"}</span>
              <div className={styles.friendName}><strong><PlayerName name={name} tag={person.user.tag} /></strong>
                <span id={"earth-friend-access-" + person.circleId} data-frozen={hasAccess && (ghost || isFrozen) || undefined}>{status}</span></div>
              <EarthSharingToggle checked={hasAccess && !isFrozen && !ghost} disabled={disabled}
                label={"Обновлять геопозицию для " + name} description={"earth-friend-access-" + person.circleId}
                onChange={() => {
                  if (!settings || disabled) return;
                  if (hasAccess) void onSetFrozen(person.circleId, !isFrozen);
                  else void onShare({ ...choicesFor(settings, selected.size === 0 ? draft : draftFor(settings)),
                    recipientCircleIds: [...settings.recipientCircleIds, person.circleId] });
                }} />
            </div>
            {hasAccess && <details className={styles.friendDetails}>
              <summary aria-label={"Настройки доступа: " + name} onClick={playDisclosureCue}><MoreHorizontal size={20} aria-hidden="true" /></summary>
              <div><p>{isFrozen || ghost ? "Доступно только последнее место." : "Виден выбранный вами район или точная позиция."}</p>
                <button type="button" data-audio-cue="ui.click" disabled={!canChange} onClick={() => { if (canChange) void onRevokeRecipient(person.circleId); }}>Убрать меня с карты друга</button></div>
            </details>}
          </li>;
        })}
      </ul> : !peopleLoading && <p className={styles.quiet}>{friends.length ? "Никого не нашли." : "Добавьте близких в разделе «Люди»."}</p>}
      {matching.length > displayed.length && <p className={styles.quiet}>Уточните поиск — показаны первые 100.</p>}
    </section>

    <details className={styles.options}>
      <summary onClick={playDisclosureCue}><SlidersHorizontal size={16} aria-hidden="true" /><span>Точность и срок</span><ChevronDown size={16} aria-hidden="true" /></summary>
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
      {selected.size > 0 && <button className={styles.revokeAll} type="button" data-audio-cue="ui.click" onClick={onOff}>Убрать меня с карты у всех</button>}
    </details>
  </div>;
}

export function EarthSharingPanel(props: Props) {
  const [draft, setDraft] = useState(() => draftFor(props.sharing.settings));
  const [query, setQuery] = useState("");
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
  return <EarthSharingPanelContent {...props} draft={draft} query={query} onQueryChange={setQuery} working={working} localError={localError}
    onPrecisionChange={precision => setDraft(value => ({ ...value, precision }))}
    onDurationChange={durationMinutes => setDraft(value => ({ ...value, durationMinutes }))}
    onShare={choices => run(() => props.onShare(choices))}
    onSetFrozen={(circleId, frozen) => run(() => props.onSetFrozen(circleId, frozen))}
    onRevokeRecipient={circleId => run(() => props.onRevokeRecipient(circleId))} />;
}
