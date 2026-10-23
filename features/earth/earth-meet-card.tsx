"use client";

import { useEffect, useRef, useState, type MouseEvent } from "react";
import { ArrowUp, ChevronDown, ExternalLink, Footprints, LoaderCircle, LocateFixed, MapPinned, X } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import type { EarthMapPerson } from "@/lib/earth-sharing-contract";
import type { EarthLocationStatus, EarthPosition } from "./location";
import { earthWalkingRouteIssue, type EarthWalkingRouteIssue, type EarthWalkingRouteState } from "./walking-route";
import { canRecordEarthMeeting, earthFriendWalkingRouteIssue, earthLastKnownMeetDetails,
  EARTH_WALKING_FRIEND_MAX_AGE_MS, walkingRouteUrl, WALKING_MAP_SERVICES, type WalkingMapService } from "./meet";
import { formatMeetLocationUpdate } from "./location-update";
import styles from "./earth-meet-card.module.css";

export function formatMeetDistance(meters: number): string {
  return meters < 1_000 ? `${Math.max(10, Math.round(meters / 10) * 10)} м`
    : `${(meters / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: meters < 10_000 ? 1 : 0 })} км`;
}

export { formatMeetLocationUpdate };

const formatAccuracy = (meters: number) => meters < 1_000 ? `${Math.max(1, Math.ceil(meters))} м` : formatMeetDistance(meters);

const ROUTE_ISSUES: Record<EarthWalkingRouteIssue, string> = {
  friend_unavailable: "Геопозиция друга больше недоступна.",
  self_missing: "Сначала дождись своей геопозиции или нажми «Найти меня».",
  self_invalid: "Не удалось прочитать твою точку. Нажми «Найти меня».",
};

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

export function EarthMeetCard({ person, name, position, now, monotonicNow, locating, locationAllowed = true,
  locationStatus, locationError, online = true, onLocate, onShowBoth, onClose,
  onRecordMeeting, meetingRecorded = false, walkingRoute, onBuildWalkingRoute, onClearWalkingRoute }: {
  person: EarthMapPerson | null; name?: string; position: EarthPosition | null;
  now: number; monotonicNow: number; locating: boolean; locationAllowed?: boolean;
  locationStatus?: EarthLocationStatus; locationError?: string | null; online?: boolean;
  onLocate: () => void; onShowBoth: () => void; onClose: () => void;
  onRecordMeeting?: () => void; meetingRecorded?: boolean;
  walkingRoute?: EarthWalkingRouteState; onBuildWalkingRoute?: () => void; onClearWalkingRoute?: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const [picker, setPicker] = useState<{ circleId: string | null; open: boolean }>({ circleId: null, open: false });
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [person?.circleId]);
  const available = person && person.expiresAtMonotonic > monotonicNow && Date.parse(person.expiresAt) > now;
  const livePosition = locationAllowed ? position : null;
  const meetingPosition = !locationStatus || locationStatus === "active" ? livePosition : null;
  const selfLastKnown = Boolean(position && (locationStatus && locationStatus !== "active" || now - position.timestamp > 60_000));
  const details = available ? earthLastKnownMeetDetails(livePosition, person, monotonicNow, now) : null;
  const routing = walkingRoute?.status === "loading";
  const friendIssue = earthFriendWalkingRouteIssue(person, monotonicNow, now);
  const routeIssue = earthWalkingRouteIssue(livePosition, person, monotonicNow, now);
  const path = details && !routeIssue && walkingRoute?.status === "ready" ? walkingRoute.route : null;
  const friendUpdate = person ? formatMeetLocationUpdate(Date.parse(person.updatedAt), now) : null;
  const selfUpdate = position ? formatMeetLocationUpdate(position.timestamp, now) : null;
  const friendStale = person && now - Date.parse(person.updatedAt) >= EARTH_WALKING_FRIEND_MAX_AGE_MS;
  const routeEstimate = Boolean(friendStale || selfLastKnown || person && (person.precision === "APPROXIMATE" || person.accuracyMeters > 200) || position && position.accuracy > 200);
  const selfHint = !locationAllowed ? "Включи её в настройках профиля" : locationError
    ?? (position && !livePosition ? "На карте сохранена последняя точка. Ждём обновления GPS."
      : position && !details ? "На карте сохранена последняя точка. Обнови геопозицию." : null);
  const routeHint = friendIssue ? ROUTE_ISSUES[friendIssue]
    : !locationAllowed ? "Для маршрута на этой карте включи геопозицию в настройках профиля."
    : routeIssue ? ROUTE_ISSUES[routeIssue] : !online ? "Нет сети. Пеший маршрут станет доступен после подключения."
      : !routing && walkingRoute && !walkingRoute.canRequest ? "Подожди несколько секунд перед новым построением." : null;
  const canBuild = Boolean(!routing && !routeIssue && locationAllowed && online && walkingRoute?.canRequest);

  return <section className={styles.card} data-earth-camera-panel="bottom" aria-labelledby="earth-meet-heading" onKeyDown={event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      playUiCue(getAudioRuntime(), "ui.close");
      onClose();
    }
  }}>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}>Навстречу другу</span><h2 id="earth-meet-heading" ref={heading} tabIndex={-1}>{name || "Друг"}</h2></div>
      <button type="button" data-audio-cue="ui.close" className={styles.close} onClick={onClose} aria-label="Закрыть встречу"><X size={18} aria-hidden="true" /></button>
    </header>
    {available ? <>
      <p className={styles.updated} data-stale={friendStale || undefined}>
        {friendStale ? "Последняя точка друга" : "Точка друга"}{friendUpdate && <> · <time dateTime={friendUpdate.dateTime}>{friendUpdate.time}</time> · {friendUpdate.age}</>}
        {Number.isFinite(person.accuracyMeters) && <> · ±{formatAccuracy(person.accuracyMeters)}</>}
        {person.precision === "APPROXIMATE" && <> · Примерный район</>}
      </p>
      <div className={styles.distance}>
        <span className={styles.compass} aria-hidden="true">{details?.bearingDegrees !== null && details?.bearingDegrees !== undefined
          ? <ArrowUp size={17} style={{ transform: `rotate(${details.bearingDegrees}deg)` }} /> : <Footprints size={17} />}</span>
        <div>{details ? <><strong>≈ {formatMeetDistance(path?.distanceMeters ?? details.distanceMeters)}</strong><span>{path
          ? `Пешком · ≈${Math.max(1, Math.ceil(path.durationSeconds / 60))} мин`
          : `по прямой${friendStale ? " до последней точки" : ""}${details.direction ? ` · ${details.direction}` : details.distanceMeters <= details.accuracyMeters ? " · в пределах точности GPS" : " · направление не определено"}`}</span></>
          : <><strong>{locating ? "Ищем тебя…" : !locationAllowed ? "Геопозиция отключена" : position ? "Не удалось прочитать геопозицию" : "Расстояние — после поиска тебя"}</strong>
            {selfHint && <span>{selfHint}</span>}</>}</div>
      </div>
      {selfUpdate && locationAllowed && <p className={styles.updated} data-stale={selfLastKnown || !details || undefined}>
        {details && !selfLastKnown ? "Ты" : "Твоя последняя точка"} · <time dateTime={selfUpdate.dateTime}>{selfUpdate.time}</time> · {selfUpdate.age}
        {position && Number.isFinite(position.accuracy) && <> · ±{formatAccuracy(position.accuracy)}</>}
      </p>}
      <div className={styles.actions}>
        {details ? <button type="button" data-audio-cue="ui.click" onClick={onShowBoth}><MapPinned size={18} aria-hidden="true" />Мы на карте</button>
          : <button type="button" data-audio-cue="ui.click" onClick={() => { if (locationAllowed) onLocate(); }} disabled={locating || !locationAllowed}><LocateFixed size={18} aria-hidden="true" />Найти меня</button>}
        <Popover key={person.circleId} open={!friendIssue && picker.circleId === person.circleId && picker.open}
          onOpenChange={open => setPicker({ circleId: person.circleId, open })}><PopoverTrigger asChild>
          <button type="button" className={styles.routeTrigger} disabled={Boolean(friendIssue)} data-audio-cue="ui.open" aria-label="Выбери карты для пешего маршрута"><ExternalLink size={16} aria-hidden="true" />Внешние карты<ChevronDown size={14} aria-hidden="true" /></button>
        </PopoverTrigger><PopoverContent className={styles.routePopover} side="top" align="end" sideOffset={7} collisionPadding={12}
          aria-label="Карты для пешего маршрута" onEscapeKeyDown={event => { event.stopPropagation(); playUiCue(getAudioRuntime(), "ui.close"); }}>
          <div className={styles.routeHeading}>Открыть в других картах</div>
          <EarthWalkingRouteOptions person={person} now={now} monotonicNow={monotonicNow} />
          <p className={styles.routeHint}>Передадим только точку друга. Начало пути выберешь в картах.</p>
        </PopoverContent></Popover>
      </div>
      {onBuildWalkingRoute && walkingRoute && <div className={styles.walking}>
        <div className={styles.buildRow}><button type="button" className={styles.buildRoute} data-audio-cue="ui.click"
          disabled={!canBuild} onClick={() => { if (canBuild) onBuildWalkingRoute(); }}>
          {routing ? <LoaderCircle size={16} className={styles.spin} aria-hidden="true" /> : <Footprints size={16} aria-hidden="true" />}
          {routing ? "Строим пеший маршрут…" : path ? "Обновить на карте" : "Пешком на этой карте"}</button>
          {walkingRoute.route && onClearWalkingRoute && <button type="button" className={styles.clearRoute} data-audio-cue="ui.close" aria-label="Убрать пеший маршрут с карты"
            onClick={onClearWalkingRoute}><X size={16} aria-hidden="true" /></button>}
        </div>
        <p className={styles.routeDisclosure}>По нажатию две точки отправятся OSRM/FOSSGIS</p>
      </div>}
      {routeEstimate && <p className={styles.estimate}>Маршрут до последней полученной точки. Положение могло измениться; учитывай погрешность GPS.</p>}
      {(routeHint || walkingRoute?.status === "error") && <p className={styles.footnote} role="status">
        {routeHint}{walkingRoute?.status === "error" && <>{routeHint ? " " : ""}{walkingRoute.error}</>}
      </p>}
      {onRecordMeeting && locationAllowed && canRecordEarthMeeting(meetingPosition, person, monotonicNow, now) && <div className={styles.meetingNote}>
        <button type="button" data-audio-cue="ui.click" disabled={meetingRecorded} onClick={() => {
          if (canRecordEarthMeeting(meetingPosition, person, performance.now(), Date.now())) onRecordMeeting();
        }}>{meetingRecorded ? "Встреча отмечена в атласе" : "Отметить встречу в атласе"}</button>
        {!meetingRecorded && <span>Вы рядом. Отметь, если встретились.</span>}
      </div>}
    </> : <p className={styles.unavailable} role="status">Геопозиция больше недоступна.</p>}
  </section>;
}
