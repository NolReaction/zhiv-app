"use client";

import { useEffect, useRef } from "react";
import { ArrowUp, ExternalLink, Footprints, LocateFixed, MapPinned, X } from "lucide-react";
import type { EarthMapPerson } from "@/lib/earth-sharing-contract";
import type { EarthPosition } from "./location";
import { earthMeetDetails, walkingRouteUrl } from "./meet";
import styles from "./earth-meet-card.module.css";

export function formatMeetDistance(meters: number): string {
  return meters < 1_000 ? `${Math.max(10, Math.round(meters / 10) * 10)} м`
    : `${(meters / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: meters < 10_000 ? 1 : 0 })} км`;
}

export function EarthMeetCard({ person, name, position, now, monotonicNow, locating, onLocate, onShowBoth, onClose }: {
  person: EarthMapPerson | null; name?: string; position: EarthPosition | null;
  now: number; monotonicNow: number; locating: boolean;
  onLocate: () => void; onShowBoth: () => void; onClose: () => void;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, [person?.circleId]);
  const available = person && person.expiresAtMonotonic > monotonicNow && Date.parse(person.expiresAt) > now;
  const details = available ? earthMeetDetails(position, person, monotonicNow, now) : null;
  const route = available ? walkingRouteUrl(person, monotonicNow, now) : null;
  const minutes = person ? Math.max(0, Math.floor((now - Date.parse(person.updatedAt)) / 60_000)) : 0;
  const updated = minutes < 1 ? "Только что" : minutes < 60 ? `${minutes} мин. назад` : `${Math.floor(minutes / 60)} ч. назад`;
  return <section className={styles.card} aria-labelledby="earth-meet-heading" onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); onClose(); }
  }}>
    <header className={styles.header}>
      <span className={styles.avatar} aria-hidden="true">{Array.from(name?.trim() || "Ж")[0].toLocaleUpperCase("ru-RU")}</span>
      <div><span className={styles.eyebrow}>Навстречу другу</span><h2 id="earth-meet-heading" ref={heading} tabIndex={-1}>{name || "Друг"}</h2></div>
      <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть встречу"><X size={18} aria-hidden="true" /></button>
    </header>
    {available ? <>
      <div className={styles.distance}>
        <span className={styles.compass} aria-hidden="true">{details?.bearingDegrees !== null && details?.bearingDegrees !== undefined
          ? <ArrowUp size={28} style={{ transform: `rotate(${details.bearingDegrees}deg)` }} /> : <Footprints size={26} />}</span>
        <div>{details ? <><strong>≈ {formatMeetDistance(details.distanceMeters)}</strong><span>по прямой{details.direction ? ` · ${details.direction}` : details.distanceMeters <= details.accuracyMeters ? " · в пределах точности GPS" : " · направление не определено"}</span></>
          : <><strong>{locating ? "Ищем тебя…" : "Где ты сейчас?"}</strong><span>Найди себя, чтобы увидеть расстояние</span></>}</div>
      </div>
      <p className={styles.updated}>{person.precision === "APPROXIMATE" ? "Примерный район" : "Последняя точка"} · {updated}</p>
      <div className={styles.actions}>
        {details ? <button type="button" onClick={onShowBoth}><MapPinned size={18} aria-hidden="true" />Мы на карте</button>
          : <button type="button" onClick={onLocate} disabled={locating}><LocateFixed size={18} aria-hidden="true" />Найти меня</button>}
        {route && <a href={route} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={event => {
          // A tab may have slept since rendering; never open an expired destination.
          if (!walkingRouteUrl(person, performance.now(), Date.now())) event.preventDefault();
        }}><Footprints size={18} aria-hidden="true" />Пешком<ExternalLink size={13} aria-hidden="true" /></a>}
      </div>
      <p className={styles.footnote}>{route ? "Пеший маршрут откроется в Google Картах." : person.precision === "APPROXIMATE"
        ? "Для пешего маршрута нужна точная геопозиция друга." : "Пеший маршрут появится, когда точка будет свежей и точной."}</p>
    </> : <p className={styles.unavailable} role="status">Геопозиция больше недоступна.</p>}
  </section>;
}
