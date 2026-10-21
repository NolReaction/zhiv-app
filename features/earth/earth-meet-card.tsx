"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowUp, ChevronDown, ExternalLink, Footprints, LoaderCircle, LocateFixed, MapPinned, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import type { EarthMapPerson } from "@/lib/earth-sharing-contract";
import type { EarthPosition } from "./location";
import type { EarthWalkingRouteState } from "./walking-route";
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

/** Destination-only links are generated only for the explicitly opened chooser. */
export function EarthWalkingRouteOptions({ person, now, monotonicNow }: { person: EarthMapPerson; now: number; monotonicNow: number }) {
  return <nav className={styles.routeOptions} aria-label="Выбрать карты для пешего маршрута">
    {WALKING_MAP_SERVICES.map(service => {
      const href = walkingRouteUrl(person, monotonicNow, now, service.id);
      return href && <a key={service.id} href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer"
        onClick={event => openWalkingRoute(event, person, service.id)} onAuxClick={event => { if (event.button === 1) openWalkingRoute(event, person, service.id); }}>
        {service.name}<ExternalLink size={13} aria-hidden="true" />
      </a>;
    })}
  </nav>;
}

export function EarthMeetCard({ person, name, position, now, monotonicNow, locating, locationAllowed = true, onLocate, onShowBoth, onClose,
  onRecordMeeting, meetingRecorded = false, walkingRoute, onBuildWalkingRoute, onClearWalkingRoute }: {
  person: EarthMapPerson | null; name?: string; position: EarthPosition | null;
  now: number; monotonicNow: number; locating: boolean; locationAllowed?: boolean;
  onLocate: () => void; onShowBoth: () => void; onClose: () => void;
  onRecordMeeting?: () => void; meetingRecorded?: boolean;
  walkingRoute?: EarthWalkingRouteState; onBuildWalkingRoute?: () => void; onClearWalkingRoute?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [picker, setPicker] = useState<{ circleId: string | null; open: boolean }>({ circleId: null, open: false });
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [person?.circleId]);
  const available = person && person.expiresAtMonotonic > monotonicNow && Date.parse(person.expiresAt) > now;
  const details = available && locationAllowed ? earthMeetDetails(position, person, monotonicNow, now) : null;
  const path = details && walkingRoute?.status === "ready" ? walkingRoute.route : null;
  const routing = walkingRoute?.status === "loading";
  const routeStatus = routing ? "Строим пеший маршрут…" : walkingRoute?.status === "error" ? "Маршрут не построен — попробуй ещё раз" : null;
  const route = available ? walkingRouteUrl(person, monotonicNow, now) : null;
  const minutes = person ? Math.max(0, Math.floor((now - Date.parse(person.updatedAt)) / 60_000)) : 0;
  const updated = minutes < 1 ? "Только что" : minutes < 60 ? `${minutes} мин. назад` : `${Math.floor(minutes / 60)} ч. назад`;

  return <section className={styles.card} data-earth-camera-panel="bottom" aria-labelledby="earth-meet-heading" onKeyDown={event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      playUiCue(getAudioRuntime(), "ui.close");
      onClose();
    }
  }}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>Навстречу другу{available ? ` · ${updated}` : ""}</span><h2 id="earth-meet-heading" ref={heading} tabIndex={-1}>{name || "Друг"}</h2></div>
      <button type="button" data-audio-cue="ui.close" className={styles.close} onClick={onClose} aria-label="Закрыть встречу"><X size={18} aria-hidden="true" /></button>
    </header>
    {available ? <>
      <div className={styles.distance}>
        <span className={styles.compass} aria-hidden="true">{details?.bearingDegrees !== null && details?.bearingDegrees !== undefined
          ? <ArrowUp size={17} style={{ transform: `rotate(${details.bearingDegrees}deg)` }} /> : <Footprints size={17} />}</span>
        <div>{details ? <><strong>≈ {formatMeetDistance(path?.distanceMeters ?? details.distanceMeters)}</strong><span title={walkingRoute?.status === "error" ? walkingRoute.error ?? undefined : undefined}>{path
          ? `Пешком · ≈${Math.max(1, Math.ceil(path.durationSeconds / 60))} мин`
          : routeStatus ?? `по прямой${details.direction ? ` · ${details.direction}` : details.distanceMeters <= details.accuracyMeters ? " · в пределах точности GPS" : " · направление не определено"}`}</span></>
          : <><strong>{locating ? "Ищем тебя…" : locationAllowed ? "Расстояние — после поиска тебя" : "Геопозиция отключена"}</strong>{!locationAllowed && <span>Включи её в настройках профиля</span>}</>}</div>
      </div>
      {person.precision === "APPROXIMATE" && <p className={styles.updated}>Примерный район</p>}
      <div className={styles.actions}>
        {details ? <button type="button" data-audio-cue="ui.click" onClick={onShowBoth}><MapPinned size={18} aria-hidden="true" />Мы на карте</button>
          : <button type="button" data-audio-cue="ui.click" onClick={() => { if (locationAllowed) onLocate(); }} disabled={locating || !locationAllowed}><LocateFixed size={18} aria-hidden="true" />Найти меня</button>}
        {route && <Popover key={person.circleId} open={picker.circleId === person.circleId && picker.open}
          onOpenChange={open => setPicker({ circleId: person.circleId, open })}><PopoverTrigger asChild>
          <button type="button" className={styles.routeTrigger} data-audio-cue="ui.open" aria-label="Выбери карты для пешего маршрута"><Footprints size={16} aria-hidden="true" />Маршрут<ChevronDown size={14} aria-hidden="true" /></button>
        </PopoverTrigger><PopoverContent className={styles.routePopover} side="top" align="end" sideOffset={7} collisionPadding={12}
          aria-label="Карты для пешего маршрута" onEscapeKeyDown={event => { event.stopPropagation(); playUiCue(getAudioRuntime(), "ui.close"); }}>
          {onBuildWalkingRoute && walkingRoute && <>
            <div className={styles.buildRow}><button type="button" className={styles.buildRoute} data-audio-cue="ui.click"
              disabled={routing || !walkingRoute.canRequest} onClick={() => {
                if (routing || !walkingRoute.canRequest) return;
                setPicker({ circleId: person.circleId, open: false }); onBuildWalkingRoute();
              }}>{routing ? <LoaderCircle size={16} className={styles.spin} aria-hidden="true" /> : <Footprints size={16} aria-hidden="true" />}
              {routing ? "Строим маршрут…" : path ? "Обновить на карте" : "Пешком на этой карте"}</button>
              {walkingRoute.route && onClearWalkingRoute && <button type="button" className={styles.clearRoute} data-audio-cue="ui.close" aria-label="Убрать пеший маршрут с карты"
                onClick={() => { setPicker({ circleId: person.circleId, open: false }); onClearWalkingRoute(); }}><X size={16} aria-hidden="true" /></button>}
            </div>
            {(walkingRoute.status === "error" || !details || !walkingRoute.canRequest && !routing) && <p className={styles.routeHint} role="status">{walkingRoute.status === "error" ? walkingRoute.error : !details ? "Сначала найди себя" : "Нужны сеть и свежие точные точки"}</p>}
            <p className={styles.routeHint}>Две точки отправятся OSRM/FOSSGIS</p>
          </>}
          <div className={styles.routeHeading}>Открыть в других картах</div>
          <EarthWalkingRouteOptions person={person} now={now} monotonicNow={monotonicNow} />
        </PopoverContent></Popover>}
      </div>
      {!route && <p className={styles.footnote}>{person.precision === "APPROXIMATE"
        ? "Для пешего маршрута нужна точная геопозиция друга." : "Пеший маршрут появится, когда точка будет свежей и точной."}</p>}
      {onRecordMeeting && locationAllowed && canRecordEarthMeeting(position, person, monotonicNow, now) && <div className={styles.meetingNote}>
        <button type="button" data-audio-cue="ui.click" disabled={meetingRecorded} onClick={() => {
          if (canRecordEarthMeeting(position, person, performance.now(), Date.now())) onRecordMeeting();
        }}>{meetingRecorded ? "Встреча отмечена в атласе" : "Отметить встречу в атласе"}</button>
        {!meetingRecorded && <span>Вы рядом. Отметь, если встретились.</span>}
      </div>}
    </> : <p className={styles.unavailable} role="status">Геопозиция больше недоступна.</p>}
  </section>;
}
