"use client";

import type { MouseEvent, ReactNode } from "react";
import { ChevronDown, MapPin, ShieldCheck } from "lucide-react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import type { Person } from "@/lib/check-in-contract";
import type { EarthSharingDuration, EarthSharingPrecision, EarthSharingSettings } from "@/lib/earth-sharing-contract";
import { personDisplayName } from "@/lib/person-nickname";
import type { EarthSharingChoices, EarthSharingHandle } from "./earth-sharing-panel";
import styles from "./earth-friend-sharing.module.css";

type Friend = Person;
type Options = { precision: EarthSharingPrecision; durationMinutes: EarthSharingDuration };

/** Confirmed server choices are shared by People and the map; reading never resumes GPS. */
export function confirmedEarthChoices(settings: EarthSharingSettings): EarthSharingChoices {
  const durationMinutes = settings.mode !== "OFF" && settings.sharingUntil === null ? null
    : settings.sharingUntil && Date.parse(settings.sharingUntil) - Date.parse(settings.serverTime) > 60 * 60_000 ? 480 : 60;
  return { recipientCircleIds: [...settings.recipientCircleIds], frozenCircleIds: [...(settings.frozenCircleIds ?? [])],
    precision: settings.precision, durationMinutes };
}

export function EarthSharingToggle({ checked, disabled, label, description, onChange, ghost = false }: {
  checked: boolean; disabled: boolean; label: string; description?: string; onChange: () => void; ghost?: boolean;
}) {
  return <button type="button" data-audio-cue="ui.click" role="switch" aria-checked={checked} disabled={disabled} aria-label={label}
    aria-describedby={description} className={styles.toggle + (ghost ? " " + styles.ghostToggle : "")}
    onClick={() => { if (!disabled) onChange(); }}><span className={styles.track}><span /></span></button>;
}

function playDisclosureCue(event: MouseEvent<HTMLElement>) {
  if (event.defaultPrevented) return;
  const details = event.currentTarget.closest("details");
  if (details) playUiCue(getAudioRuntime(), details.open ? "ui.close" : "ui.open");
}

/** One consent control, reused verbatim on both screens. No local sharing state. */
export function EarthFriendSharingControls({ person, sharing, online, working = false, heading = "Геопозиция", avatar,
  idPrefix = "earth-friend-access", firstChoices, onShare, onSetFrozen, onRevokeRecipient, onOpenMap }: {
  person: Friend; sharing?: EarthSharingHandle; online: boolean; working?: boolean; heading?: ReactNode; avatar?: ReactNode;
  idPrefix?: string; firstChoices?: Options; onShare?: (choices: EarthSharingChoices) => Promise<void>;
  onSetFrozen?: (circleId: string, frozen: boolean) => Promise<boolean | void>;
  onRevokeRecipient?: (circleId: string) => Promise<boolean | void>; onOpenMap?: () => void;
}) {
  const settings = sharing?.settings, name = personDisplayName(person);
  const ghost = sharing?.pendingGhost ? sharing.pendingPrivacyMode !== "OFF" : settings?.mode === "GHOST";
  const hasAccess = !!settings?.recipientCircleIds.includes(person.circleId), frozen = !!settings?.frozenCircleIds?.includes(person.circleId);
  const canChange = !!settings && online && !sharing?.saving && !working && !sharing?.pendingGhost;
  const disabled = !canChange || ghost || (hasAccess ? !onSetFrozen : !onShare || (settings?.recipientCircleIds.length ?? 0) >= 100);
  const status = !settings ? "Загружаем…" : !hasAccess ? "Нет доступа" : sharing?.pendingGhost ? "Ждём подтверждения…"
    : ghost ? "Последнее место · призрак" : frozen ? "Последнее место" : !sharing?.publishing ? "Передача на паузе"
      : !sharing.lastPublishedAt ? "Ищем местоположение…" : "Обновляется";
  const id = `${idPrefix}-${person.circleId}`;
  return <div className={styles.control}>
    <div className={styles.main}>
      <span className={styles.avatar} aria-hidden="true">{avatar ?? <MapPin size={17} />}</span>
      <div className={styles.name}><strong>{heading}</strong><span id={id} data-frozen={hasAccess && (ghost || frozen) || undefined}>{status}</span></div>
      <EarthSharingToggle checked={hasAccess && !frozen && !ghost} disabled={disabled}
        label={"Обновлять геопозицию для " + name} description={id}
        onChange={() => {
          if (!settings || disabled) return;
          if (hasAccess) { void onSetFrozen?.(person.circleId, !frozen); return; }
          const choices = confirmedEarthChoices(settings);
          const initial = choices.recipientCircleIds.length === 0 && firstChoices
            ? { precision: firstChoices.precision, durationMinutes: firstChoices.durationMinutes } : {};
          void onShare?.({ ...choices, ...initial,
            recipientCircleIds: [...choices.recipientCircleIds, person.circleId] });
        }} />
    </div>
    {hasAccess && <details className={styles.details}>
      <summary aria-label={"Настройки доступа: " + name} onClick={playDisclosureCue}>
        <ShieldCheck size={14} aria-hidden="true" /><span>Доступ к геопозиции</span><ChevronDown size={15} aria-hidden="true" />
      </summary>
      <div className={styles.options}>
        <p>{sharing?.pendingGhost ? "Изменение доступа ещё не подтверждено." : ghost ? "Призрак включён для всех. Последнее место сохраняется."
          : frozen ? "Обновления выключены. Последнее место сохраняется." : "Выключение обновлений оставит последнее место."}</p>
        <button type="button" data-audio-cue="ui.click" disabled={!canChange || !onRevokeRecipient}
          onClick={() => { if (canChange) void onRevokeRecipient?.(person.circleId); }}>Убрать доступ</button>
      </div>
    </details>}
    {onOpenMap && hasAccess && !ghost && !frozen && !sharing?.publishing && <button type="button"
      className={styles.openMap} onClick={onOpenMap}>Возобновить на карте</button>}
  </div>;
}
