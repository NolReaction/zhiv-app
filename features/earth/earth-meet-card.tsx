"use client";

import { useEffect, useRef, type MouseEvent } from "react";
import { ArrowUp, ChevronDown, ExternalLink, Footprints, LocateFixed, MapPinned, X } from "lucide-react";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import type { EarthMapPerson } from "@/lib/earth-sharing-contract";
import type { EarthPosition } from "./location";
import { canRecordEarthMeeting, earthMeetDetails, walkingRouteUrl, WALKING_MAP_SERVICES, type WalkingMapService } from "./meet";
import styles from "./earth-meet-card.module.css";

export function formatMeetDistance(meters: number): string {
  return meters < 1_000 ? `${Math.max(10, Math.round(meters / 10) * 10)} м`
    : `${(meters / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: meters < 10_000 ? 1 : 0 })} км`;
}

function openWalkingRoute(event: MouseEvent<HTMLAnchorElement>, person: EarthMapPerson | null, service: WalkingMapService) {
  // A tab may have slept since rendering; never open an expired destination.
  if (event.defaultPrevented || !person || !walkingRouteUrl(person, performance.now(), Date.now(), service)) { event.preventDefault(); return; }
  playUiCue(getAudioRuntime(), "ui.open");
}

export function EarthMeetCard({ person, name, position, now, monotonicNow, locating, locationAllowed = true, onLocate, onShowBoth, onClose,
  onRecordMeeting, meetingRecorded = false }: {
  person: EarthMapPerson | null; name?: string; position: EarthPosition | null;
  now: number; monotonicNow: number; locating: boolean; locationAllowed?: boolean;
  onLocate: () => void; onShowBoth: () => void; onClose: () => void;
  onRecordMeeting?: () => void; meetingRecorded?: boolean;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const routePicker = useRef<HTMLDetailsElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [person?.circleId]);
  const available = person && person.expiresAtMonotonic > monotonicNow && Date.parse(person.expiresAt) > now;
  const details = available && locationAllowed ? earthMeetDetails(position, person, monotonicNow, now) : null;
  const route = available ? walkingRouteUrl(person, monotonicNow, now) : null;
  const minutes = person ? Math.max(0, Math.floor((now - Date.parse(person.updatedAt)) / 60_000)) : 0;
  const updated = minutes < 1 ? "Только что" : minutes < 60 ? `${minutes} мин. назад` : `${Math.floor(minutes / 60)} ч. назад`;

  return <section className={styles.card} aria-labelledby="earth-meet-heading" onKeyDown={event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      playUiCue(getAudioRuntime(), "ui.close");
      if (routePicker.current?.open) { routePicker.current.open = false; routePicker.current.querySelector("summary")?.focus(); }
      else onClose();
    }
  }}>
    <header className={styles.header}>
      <span className={styles.avatar} aria-hidden="true">{Array.from(name?.trim() || "Ж")[0].toLocaleUpperCase("ru-RU")}</span>
      <div><span className={styles.eyebrow}>Навстречу другу</span><h2 id="earth-meet-heading" ref={heading} tabIndex={-1}>{name || "Друг"}</h2></div>
      <button type="button" data-audio-cue="ui.close" className={styles.close} onClick={onClose} aria-label="Закрыть встречу"><X size={18} aria-hidden="true" /></button>
    </header>
    {available ? <>
      <div className={styles.distance}>
        <span className={styles.compass} aria-hidden="true">{details?.bearingDegrees !== null && details?.bearingDegrees !== undefined
          ? <ArrowUp size={28} style={{ transform: `rotate(${details.bearingDegrees}deg)` }} /> : <Footprints size={26} />}</span>
        <div>{details ? <><strong>≈ {formatMeetDistance(details.distanceMeters)}</strong><span>по прямой{details.direction ? ` · ${details.direction}` : details.distanceMeters <= details.accuracyMeters ? " · в пределах точности GPS" : " · направление не определено"}</span></>
          : <><strong>{locating ? "Ищем тебя…" : locationAllowed ? "Где ты сейчас?" : "Геопозиция отключена"}</strong><span>{locationAllowed ? "Найди себя, чтобы увидеть расстояние" : "Включи её в настройках профиля"}</span></>}</div>
      </div>
      <p className={styles.updated}>{person.precision === "APPROXIMATE" ? "Примерный район" : "Последняя точка"} · {updated}</p>
      <div className={styles.actions}>
        {details ? <button type="button" data-audio-cue="ui.click" onClick={onShowBoth}><MapPinned size={18} aria-hidden="true" />Мы на карте</button>
          : <button type="button" data-audio-cue="ui.click" onClick={() => { if (locationAllowed) onLocate(); }} disabled={locating || !locationAllowed}><LocateFixed size={18} aria-hidden="true" />Найти меня</button>}
        {route && <details ref={routePicker} key={person.circleId} className={styles.routePicker}>
          <summary data-audio-cue="ui.open"><Footprints size={18} aria-hidden="true" />Пешком<ChevronDown size={14} aria-hidden="true" /></summary>
          <nav className={styles.routeOptions} aria-label="Выбрать карты для пешего маршрута">
            {WALKING_MAP_SERVICES.map(service => {
              const href = walkingRouteUrl(person, monotonicNow, now, service.id);
              return href && <a key={service.id} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
                onClick={event => openWalkingRoute(event, person, service.id)} onAuxClick={event => { if (event.button === 1) openWalkingRoute(event, person, service.id); }}>
                {service.name}<ExternalLink size={13} aria-hidden="true" />
              </a>;
            })}
          </nav>
        </details>}
      </div>
      <p className={styles.footnote}>{route ? "Выбери карты — откроется приложение или сайт." : person.precision === "APPROXIMATE"
        ? "Для пешего маршрута нужна точная геопозиция друга." : "Пеший маршрут появится, когда точка будет свежей и точной."}</p>
      {onRecordMeeting && locationAllowed && canRecordEarthMeeting(position, person, monotonicNow, now) && <div className={styles.meetingNote}>
        <button type="button" data-audio-cue="ui.click" disabled={meetingRecorded} onClick={() => {
          if (canRecordEarthMeeting(position, person, performance.now(), Date.now())) onRecordMeeting();
        }}>{meetingRecorded ? "Встреча отмечена в атласе" : "Отметить встречу в атласе"}</button>
        {!meetingRecorded && <span>Вы рядом. Отметь, если встретились.</span>}
      </div>}
    </> : <p className={styles.unavailable} role="status">Геопозиция больше недоступна.</p>}
  </section>;
}
