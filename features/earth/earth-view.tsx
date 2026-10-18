"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Ghost, Globe2, Leaf, MapPin, RefreshCw, ShieldCheck, Users, X } from "lucide-react";
import type { PeopleResponse } from "@/lib/check-in-contract";
import { PlayerName } from "@/components/player-name";
import { EarthMap } from "./earth-map";
import type { EarthCameraSession } from "./camera-session";
import { useEarthLocation } from "./use-earth-location";
import type { EarthLocationStatus, EarthPosition } from "./location";
import type { EarthMapPerson } from "@/lib/earth-sharing-contract";
import { EarthSharingPanel, sharingSummary, type EarthSharingChoices, type EarthSharingHandle } from "./earth-sharing-panel";
import styles from "./earth-view.module.css";

type Props = {
  ownerPublicId: string;
  active: boolean;
  visible: boolean;
  onReadyChange?: (ready: boolean) => void;
  cameraSession?: EarthCameraSession;
  sharing: EarthSharingHandle;
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

export function EarthFriends({ people, loading, error, online, onRefresh, onOpenPeople, locations = [], onFocusPerson, selectedCircleIds = [] }: {
  people: PeopleResponse | null; loading: boolean; error: string | null; online: boolean;
  onRefresh: () => void; onOpenPeople: () => void;
  locations?: readonly EarthMapPerson[]; onFocusPerson?: (circleId: string) => void; selectedCircleIds?: readonly string[];
}) {
  const contacts = people?.people ?? locations.map(person => ({ circleId: person.circleId, user: person.user, nickname: null }));
  const displayed = selectedCircleIds.length ? contacts.filter(person => selectedCircleIds.includes(person.circleId)) : contacts;
  return <div className={styles.friendsContent}>
    <p className={styles.friendsIntro}>На карте появляются только близкие, которые разрешили вам видеть свою свежую геопозицию. Делиться своей позицией в ответ не обязательно.</p>
    {(!online || error || loading) && <p role="status" className={styles.hint}>
      {!online ? "Нет сети. Список может быть неактуален." : loading ? "Обновляем список друзей…" : "Не удалось обновить список друзей."}
    </p>}
    {displayed.length > 0 ? <ul className={styles.friendsList}>
      {displayed.map(person => {
        const displayName = person.nickname || person.user.displayName;
        const position = locations.find(row => row.circleId === person.circleId);
        const accuracy = position ? position.accuracyMeters >= 1_000
          ? `${(position.accuracyMeters / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`
          : `${Math.max(1, Math.round(position.accuracyMeters))} м` : "";
        return <li key={person.circleId}>
        <span className={styles.avatar} aria-hidden="true">{Array.from(displayName.trim())[0]?.toLocaleUpperCase("ru-RU") || "Ж"}</span>
        <div><strong><PlayerName name={displayName} tag={person.user.tag} /></strong>
          <span>{position ? `${position.precision === "APPROXIMATE" ? "Примерный район" : "Геопозиция"} · ±${accuracy}` : "Нет доступной геопозиции"}</span>
          {position && <span>Обновлено в {new Date(position.updatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}</span>}
        </div>
        {position && onFocusPerson && <button className={styles.friendLocate} type="button" onClick={() => onFocusPerson(person.circleId)} aria-label={`Показать на карте: ${displayName}`}><MapPin size={18} aria-hidden="true" /></button>}
      </li>;
      })}
    </ul> : !loading && <p className={styles.hint}>{people ? "Добавьте близких в разделе «Люди»." : "Обновите список, чтобы увидеть своих друзей."}</p>}
    <div className={styles.panelActions}>
      <button type="button" onClick={onOpenPeople}><Users size={16} aria-hidden="true" />Открыть «Люди»</button>
      <button type="button" disabled={loading || !online} onClick={onRefresh} aria-label="Обновить список друзей"><RefreshCw size={16} aria-hidden="true" /></button>
    </div>
  </div>;
}

export function EarthView({ ownerPublicId, active, visible, onReadyChange, cameraSession, sharing, isOnline, people, peopleLoading, peopleError,
  onRefreshPeople, onOpenPeople, onOpenWorld }: Props) {
  const location = useEarthLocation({ ownerPublicId, enabled: active && visible });
  const [focusRequest, setFocusRequest] = useState(0);
  const [panelSelection, setPanelSelection] = useState<{ visible: boolean; value: "friends" | "sharing" | "info" | null }>({ visible, value: null });
  if (panelSelection.visible !== visible) setPanelSelection({ visible, value: null });
  const panel = panelSelection.visible === visible ? panelSelection.value : null;
  const setPanel = (value: "friends" | "sharing" | "info" | null) => setPanelSelection({ visible, value });
  const friendsOpen = panel === "friends";
  const sharingOpen = panel === "sharing";
  const [selectedCircleIds, setSelectedCircleIds] = useState<readonly string[]>([]);
  const [friendFocusRequest, setFriendFocusRequest] = useState<{ circleId: string; requestId: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const friendsButton = useRef<HTMLButtonElement>(null);
  const sharingButton = useRef<HTMLButtonElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const stopLocation = location.stop;
  const { setPosition: setSharedPosition, stopPublishing, pendingGhost, publishing } = sharing;
  const foreground = useRef(active && visible);
  const wasPublishing = useRef(false);
  const sharedPeople = sharing.people.filter(person => !people || people.people.some(contact => contact.circleId === person.circleId));
  useLayoutEffect(() => { foreground.current = active && visible; return () => { foreground.current = false; }; }, [active, visible]);
  // A retained map is allowed to keep its tiles/camera, never a location watch.
  useLayoutEffect(() => { if (!visible) stopLocation(); }, [visible, stopLocation]);
  useEffect(() => { if (visible) heading.current?.focus({ preventScroll: true }); }, [visible]);
  useEffect(() => {
    if (!active || !visible || !location.position && sharedPeople.length === 0) return;
    const interval = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(interval);
  }, [active, visible, location.position, sharedPeople.length]);
  useEffect(() => { if (friendsOpen || sharingOpen) panelHeading.current?.focus({ preventScroll: true }); }, [friendsOpen, sharingOpen]);
  useEffect(() => {
    setSharedPosition(active && visible && location.status === "active" ? location.position : null);
    if (["denied", "unavailable", "timeout", "unsupported", "insecure", "paused"].includes(location.status)) stopPublishing();
  }, [active, visible, location.status, location.position, setSharedPosition, stopPublishing]);
  useEffect(() => {
    // A GPS failure already cleared its watch. Preserve the reason instead of
    // replacing denied/unavailable/timeout with an unexplained idle state.
    if (pendingGhost || wasPublishing.current && !publishing && !location.error) stopLocation();
    wasPublishing.current = publishing;
  }, [pendingGhost, publishing, location.error, stopLocation]);
  const closeFriends = () => { const privacy = sharingOpen; setPanel(null); (privacy ? sharingButton : friendsButton).current?.focus({ preventScroll: true }); };
  const locating = location.status === "requesting";
  const watching = locating || location.status === "active" || location.status === "paused";
  const age = location.position ? Math.max(0, Math.floor((now - location.position.timestamp) / 60_000)) : 0;

  const locate = () => {
    setFocusRequest(value => value + 1);
    if (!location.position || location.status !== "active") location.start();
  };
  const stopGps = () => { sharing.stopPublishing(); location.stop(); };
  const ghost = () => { location.stop(); sharing.ghost(); };
  const off = () => { location.stop(); sharing.off(); };
  const share = async (choices: EarthSharingChoices) => {
    location.stop();
    sharing.setPosition(null);
    const accepted = await sharing.share(choices);
    if (accepted && foreground.current) location.start();
  };
  const focusFriend = (circleId: string) => {
    setFriendFocusRequest(previous => ({ circleId, requestId: (previous?.requestId ?? 0) + 1 }));
    setPanel(null);
  };
  const locationDetails = <section className={styles.locationDetails} aria-labelledby="earth-location-heading">
    <h3 id="earth-location-heading">Моё местоположение</h3>
    <strong role="status">{locationSummary(location.status, location.position)}</strong>
    {location.position && <p>{age > 0 ? `Обновлено ${age} мин. назад` : "Координаты получены только что"}</p>}
    {location.error && <p className={styles.locationError}>{location.error}</p>}
    <p><ShieldCheck size={15} aria-hidden="true" />{sharing.publishing ? "Позиция передаётся только выбранным близким, пока открыта карта." : "Кнопка «Найти себя» показывает вашу позицию только вам. Доступ друзьям включается отдельно."}</p>
    {watching && <button className={styles.stopButton} type="button" onClick={stopGps}>Остановить GPS и обновление позиции</button>}
  </section>;

  return <section className={styles.view} aria-labelledby="earth-title" data-earth-world>
    <p id="earth-location-privacy" className={styles.srOnly}>«Найти себя» запускает GPS только для вас. Доступ выбранным близким включается отдельно. В фоне обновления остановлены.</p>
    <div className={styles.stage}>
      <EarthMap position={visible ? location.position : null} active={active} visible={visible} onReadyChange={onReadyChange} cameraSession={cameraSession}
        focusRequest={focusRequest} isOnline={isOnline} friends={sharedPeople} friendFocusRequest={friendFocusRequest}
        onSelectFriends={ids => { setSelectedCircleIds(ids); setPanel("friends"); }}
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
      {(friendsOpen || sharingOpen) && <section id="earth-friends-panel" className={styles.friendsPanel} aria-labelledby="earth-friends-title" onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); closeFriends(); }
      }}>
        <header><h2 id="earth-friends-title" ref={panelHeading} tabIndex={-1}>{sharingOpen ? "Моя геопозиция" : "Близкие на карте"}</h2>
          <button type="button" onClick={closeFriends} aria-label={sharingOpen ? "Закрыть настройки геопозиции" : "Закрыть список друзей"}><X size={18} aria-hidden="true" /></button></header>
        {sharingOpen ? <><EarthSharingPanel sharing={sharing} people={people} peopleLoading={peopleLoading} online={isOnline} onShare={share} onGhost={ghost} onOff={off} />{locationDetails}</>
          : <>{selectedCircleIds.length > 0 && <button className={styles.allFriends} type="button" onClick={() => setSelectedCircleIds([])}>Показать всех близких</button>}
            <EarthFriends people={people} loading={peopleLoading || sharing.loading} error={peopleError || sharing.error} online={isOnline}
              locations={sharedPeople} selectedCircleIds={selectedCircleIds} onFocusPerson={focusFriend}
              onRefresh={() => { onRefreshPeople(); sharing.refresh(); }} onOpenPeople={onOpenPeople} /></>}
      </section>}
      <div className={styles.bottomButtons}>
      <button ref={friendsButton} className={styles.friendsButton} type="button" aria-expanded={friendsOpen} aria-controls="earth-friends-panel" onClick={() => setPanel(friendsOpen ? null : "friends")}>
        <span className={styles.friendsIcon}><Users size={18} aria-hidden="true" /></span>Близкие{people ? <span className={styles.friendsCount}>{people.people.length}</span> : null}
      </button>
      <button ref={sharingButton} className={styles.sharingButton} type="button" aria-expanded={sharingOpen} aria-controls="earth-friends-panel"
        onClick={() => { setPanel(sharingOpen ? null : "sharing"); if (!sharingOpen) { onRefreshPeople(); sharing.refresh(); } }}>
        <Ghost size={17} aria-hidden="true" /><span>{sharingSummary(sharing)}</span>
      </button>
      {sharing.settings?.mode === "SHARING" && <button className={styles.quickGhost} type="button" title="Включить режим призрака" aria-label="Тихо скрыть геопозицию от всех" onClick={ghost}><Ghost size={18} aria-hidden="true" /></button>}
      </div>
    </div>
    {(!isOnline || location.error) && panel === null && <p className={styles.notice} role="status">
      {location.error || "Нет сети · новые участки пока недоступны"}
    </p>}
  </section>;
}
