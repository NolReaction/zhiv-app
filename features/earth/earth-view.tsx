"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Globe2, Leaf, RefreshCw, ShieldCheck, Users, X } from "lucide-react";
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
  visible: boolean;
  onReadyChange?: (ready: boolean) => void;
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

export function EarthView({ ownerPublicId, active, visible, onReadyChange, isOnline, people, peopleLoading, peopleError,
  onRefreshPeople, onOpenPeople, onOpenWorld }: Props) {
  const location = useEarthLocation({ ownerPublicId, enabled: active && visible });
  const [focusRequest, setFocusRequest] = useState(0);
  const [panelSelection, setPanelSelection] = useState<{ visible: boolean; value: "friends" | "info" | null }>({ visible, value: null });
  if (panelSelection.visible !== visible) setPanelSelection({ visible, value: null });
  const panel = panelSelection.visible === visible ? panelSelection.value : null;
  const setPanel = (value: "friends" | "info" | null) => setPanelSelection({ visible, value });
  const friendsOpen = panel === "friends";
  const [now, setNow] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const friendsButton = useRef<HTMLButtonElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const stopLocation = location.stop;
  // A retained map is allowed to keep its tiles/camera, never a location watch.
  useLayoutEffect(() => { if (!visible) stopLocation(); }, [visible, stopLocation]);
  useEffect(() => { if (visible) heading.current?.focus({ preventScroll: true }); }, [visible]);
  useEffect(() => {
    if (!active || !visible || !location.position) return;
    const interval = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, [active, visible, location.position]);
  useEffect(() => { if (friendsOpen) panelHeading.current?.focus({ preventScroll: true }); }, [friendsOpen]);
  const closeFriends = () => { setPanel(null); friendsButton.current?.focus({ preventScroll: true }); };
  const locating = location.status === "requesting";
  const watching = locating || location.status === "active" || location.status === "paused";
  const age = location.position ? Math.max(0, Math.floor((now - location.position.timestamp) / 60_000)) : 0;

  const locate = () => {
    setFocusRequest(value => value + 1);
    if (!location.position || location.status !== "active") location.start();
  };
  const locationDetails = <section className={styles.locationDetails} aria-labelledby="earth-location-heading">
    <h3 id="earth-location-heading">Моё местоположение</h3>
    <strong role="status">{locationSummary(location.status, location.position)}</strong>
    {location.position && <p>{age > 0 ? `Обновлено ${age} мин. назад` : "Координаты получены только что"}</p>}
    {location.error && <p className={styles.locationError}>{location.error}</p>}
    <p><ShieldCheck size={15} aria-hidden="true" />Геопозиция видна только вам. Обновляется, пока карта открыта, и очищается при выходе из раздела.</p>
    {watching && <button className={styles.stopButton} type="button" onClick={location.stop}>Выключить геопозицию</button>}
  </section>;

  return <section className={styles.view} aria-labelledby="earth-title" data-earth-world>
    <p id="earth-location-privacy" className={styles.srOnly}>Геопозиция видна только вам. Обновляется, пока карта открыта, и очищается при выходе из раздела.</p>
    <div className={styles.stage}>
      <EarthMap position={visible ? location.position : null} active={active} visible={visible} onReadyChange={onReadyChange}
        focusRequest={focusRequest} isOnline={isOnline}
        onLocate={locate} locating={locating} locationActive={location.status === "active"}
        locationDetails={locationDetails} infoOpen={panel === "info"} onInfoOpenChange={open => setPanel(open ? "info" : null)} />
    </div>
    <header className={styles.header}>
      <h1 id="earth-title" ref={heading} tabIndex={-1} className={styles.brand}>
        <Globe2 size={21} aria-hidden="true" /><span>Я живой<span className={styles.brandDivider}>·</span><span className={styles.brandPlace}>Земля</span></span>
      </h1>
      <button type="button" className={styles.worldButton} onClick={event => onOpenWorld(event.currentTarget)} aria-label="Войти в мир Мохлика" aria-haspopup="dialog">
        <Leaf size={18} aria-hidden="true" /><span>Моя полянка</span>
      </button>
    </header>

    <div className={styles.bottomOverlay}>
      {friendsOpen && <section id="earth-friends-panel" className={styles.friendsPanel} aria-labelledby="earth-friends-title" onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); closeFriends(); }
      }}>
        <header><h2 id="earth-friends-title" ref={panelHeading} tabIndex={-1}>Близкие на карте</h2>
          <button type="button" onClick={closeFriends} aria-label="Закрыть список друзей"><X size={18} aria-hidden="true" /></button></header>
        <EarthFriends people={people} loading={peopleLoading} error={peopleError} online={isOnline} onRefresh={onRefreshPeople} onOpenPeople={onOpenPeople} />
      </section>}
      <button ref={friendsButton} className={styles.friendsButton} type="button" aria-expanded={friendsOpen} aria-controls="earth-friends-panel" onClick={() => setPanel(friendsOpen ? null : "friends")}>
        <span className={styles.friendsIcon}><Users size={18} aria-hidden="true" /></span>Близкие{people ? <span className={styles.friendsCount}>{people.people.length}</span> : null}
      </button>
    </div>
    {(!isOnline || location.error) && panel === null && <p className={styles.notice} role="status">
      {location.error || "Нет сети · новые участки пока недоступны"}
    </p>}
  </section>;
}
