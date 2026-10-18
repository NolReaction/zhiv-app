"use client";

import { useEffect, useRef, useState } from "react";
import { Globe2, Leaf, LocateFixed, MapPin, RefreshCw, ShieldCheck, Users, X } from "lucide-react";
import type { PeopleResponse } from "@/lib/check-in-contract";
import { personDisplayName } from "@/lib/person-nickname";
import { PlayerName } from "@/components/player-name";
import { EarthMap } from "./earth-map";
import { useEarthLocation } from "./use-earth-location";
import type { EarthLocationStatus, EarthPosition } from "./location";
import styles from "./earth-view.module.css";

type Props = {
  ownerPublicId: string;
  active: boolean;
  isOnline: boolean;
  people: PeopleResponse | null;
  peopleLoading: boolean;
  peopleError: string | null;
  onRefreshPeople: () => void;
  onOpenPeople: () => void;
  onOpenWorld: (trigger: HTMLButtonElement) => void;
};

export function locationSummary(status: EarthLocationStatus, position: EarthPosition | null): string {
  if (status === "paused") return "Обновление на паузе";
  if (status === "requesting") return "Определяем местоположение…";
  if (position && status === "active") {
    const accuracy = position.accuracy < 1_000
      ? `${Math.max(1, Math.round(position.accuracy))} м`
      : `${(position.accuracy / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`;
    return `Вы на карте · точность ±${accuracy}`;
  }
  return "Найдите себя на Земле";
}

export function EarthFriends({ people, loading, error, online, onRefresh, onOpenPeople }: {
  people: PeopleResponse | null; loading: boolean; error: string | null; online: boolean;
  onRefresh: () => void; onOpenPeople: () => void;
}) {
  return <div className={styles.friendsContent}>
    <p className={styles.friendsIntro}>Здесь будут ваши близкие. Обмен геопозицией ещё готовится, поэтому местоположения друзей пока не показаны.</p>
    {(!online || error || loading) && <p role="status" className={styles.hint}>
      {!online ? "Нет сети. Список может быть неактуален." : loading ? "Обновляем список друзей…" : "Не удалось обновить список друзей."}
    </p>}
    {people && people.people.length > 0 ? <ul className={styles.friendsList}>
      {people.people.map(person => <li key={person.circleId}>
        <span className={styles.avatar} aria-hidden="true">{Array.from(personDisplayName(person).trim())[0]?.toLocaleUpperCase("ru-RU") || "Ж"}</span>
        <div><strong><PlayerName name={personDisplayName(person)} tag={person.user.tag} /></strong><span>Геопозиция пока недоступна</span></div>
      </li>)}
    </ul> : !loading && <p className={styles.hint}>{people ? "Добавьте близких в разделе «Люди»." : "Обновите список, чтобы увидеть своих друзей."}</p>}
    <div className={styles.panelActions}>
      <button type="button" onClick={onOpenPeople}><Users size={16} aria-hidden="true" />Открыть «Люди»</button>
      <button type="button" disabled={loading || !online} onClick={onRefresh} aria-label="Обновить список друзей"><RefreshCw size={16} aria-hidden="true" /></button>
    </div>
  </div>;
}

export function EarthView({ ownerPublicId, active, isOnline, people, peopleLoading, peopleError,
  onRefreshPeople, onOpenPeople, onOpenWorld }: Props) {
  const location = useEarthLocation({ ownerPublicId, enabled: active });
  const [focusRequest, setFocusRequest] = useState(0);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const friendsButton = useRef<HTMLButtonElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  useEffect(() => {
    if (!active || !location.position) return;
    const interval = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, [active, location.position]);
  useEffect(() => { if (friendsOpen) panelHeading.current?.focus({ preventScroll: true }); }, [friendsOpen]);
  const closeFriends = () => { setFriendsOpen(false); friendsButton.current?.focus({ preventScroll: true }); };
  const locating = location.status === "requesting";
  const watching = locating || location.status === "active" || location.status === "paused";
  const age = location.position ? Math.max(0, Math.floor((now - location.position.timestamp) / 60_000)) : 0;

  return <section className={styles.view} aria-labelledby="earth-title" data-earth-world>
    <div className={styles.stage}>
      <EarthMap position={location.position} active={active} focusRequest={focusRequest} isOnline={isOnline} />
    </div>
    <header className={styles.header}>
      <div><span className={styles.eyebrow}><Globe2 size={13} aria-hidden="true" />ПЛАНЕТА ЖИВОЙ</span>
        <h1 id="earth-title" ref={heading} tabIndex={-1}>Весь мир рядом</h1></div>
      <button type="button" className={styles.worldButton} onClick={event => onOpenWorld(event.currentTarget)} aria-label="Войти в мир Мохлика" aria-haspopup="dialog">
        <Leaf size={18} aria-hidden="true" /><span>Моя полянка</span>
      </button>
    </header>

    <div className={styles.bottomOverlay}>
      {!isOnline && <p className={styles.offline} role="status">Нет сети · новые участки пока недоступны</p>}
      {friendsOpen && <section id="earth-friends-panel" className={styles.friendsPanel} aria-labelledby="earth-friends-title" onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); closeFriends(); }
      }}>
        <header><h2 id="earth-friends-title" ref={panelHeading} tabIndex={-1}>Близкие на карте</h2>
          <button type="button" onClick={closeFriends} aria-label="Закрыть список друзей"><X size={18} aria-hidden="true" /></button></header>
        <EarthFriends people={people} loading={peopleLoading} error={peopleError} online={isOnline} onRefresh={onRefreshPeople} onOpenPeople={onOpenPeople} />
      </section>}
    <div className={styles.dock}>
      <div className={styles.locationRow}>
        <span className={styles.locationIcon} data-active={location.status === "active"}><MapPin size={20} aria-hidden="true" /></span>
        <div className={styles.locationText}>
          <strong role="status">{locationSummary(location.status, location.position)}</strong>
          {location.position ? <span>{age > 0 ? `Обновлено ${age} мин. назад` : "Координаты получены только что"}</span>
            : <span>Вращайте глобус и приближайте города</span>}
        </div>
        <button type="button" className={styles.locateButton} disabled={locating || !active} aria-describedby="earth-location-privacy" onClick={() => {
          if (location.position && location.status === "active") setFocusRequest(value => value + 1);
          else { setFocusRequest(value => value + 1); location.start(); }
        }}><LocateFixed size={17} aria-hidden="true" /><span>{locating ? "Ищем…" : location.position && location.status === "active" ? "К себе" : "Где я"}</span></button>
      </div>
      {location.error && <p className={styles.locationError} role="status">{location.error}</p>}
      <div className={styles.dockBottom}>
        <p><ShieldCheck size={14} aria-hidden="true" /><span>Видна только вам</span></p>
        {watching && <button className={styles.stopButton} type="button" onClick={location.stop}>Выключить</button>}
        <button ref={friendsButton} className={styles.friendsButton} type="button" aria-expanded={friendsOpen} aria-controls="earth-friends-panel" onClick={() => setFriendsOpen(open => !open)}>
          <Users size={16} aria-hidden="true" />Близкие{people ? <span>{people.people.length}</span> : null}
        </button>
      </div>
      <p id="earth-location-privacy" className={styles.srOnly}>Геопозиция видна только вам и обновляется, пока карта открыта. При выходе из раздела геопозиция очищается.</p>
    </div>
    </div>
  </section>;
}
