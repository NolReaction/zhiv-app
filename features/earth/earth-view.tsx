"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Footprints, Ghost, Globe2, Leaf, MapPin, RefreshCw, Users, X } from "lucide-react";
import type { PeopleResponse, Person } from "@/lib/check-in-contract";
import { PlayerName } from "@/components/player-name";
import { PersonGameActions, type PersonVisitAction } from "@/features/people/person-game-actions";
import { EarthMap } from "./earth-map";
import type { EarthCameraSession } from "./camera-session";
import { useEarthLocation } from "./use-earth-location";
import type { EarthLocationStatus, EarthPosition } from "./location";
import type { EarthMapPerson } from "@/lib/earth-sharing-contract";
import { EarthSharingPanel, sharingSummary, type EarthSharingChoices, type EarthSharingHandle } from "./earth-sharing-panel";
import { EarthMeetCard } from "./earth-meet-card";
import { readEarthModelEditorOpen } from "./dev/earth-model-editor-session";
import styles from "./earth-view.module.css";

const NO_SHARED_PEOPLE: readonly EarthMapPerson[] = [];

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
  onOpenProfile?: (person: Person) => void;
  onVisitFriend?: PersonVisitAction;
  onOpenWorld: (trigger: HTMLButtonElement) => void;
};

export function locationSummary(status: EarthLocationStatus, position: EarthPosition | null): string {
  if (status === "paused") return position ? "Последняя геопозиция · обновление остановлено" : "Обновление на паузе";
  if (status === "requesting") return "Определяем местоположение…";
  if (position && status === "active") {
    const accuracy = position.accuracy < 1_000
      ? `${Math.max(1, Math.round(position.accuracy))} м`
      : `${(position.accuracy / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`;
    return `Вы на карте · точность ±${accuracy}`;
  }
  return "Найдите себя на Земле";
}

export function EarthFriends({ people, loading, error, online, onRefresh, onOpenPeople, onOpenProfile, onVisitFriend, locations = [], onFocusPerson, onMeetPerson, selectedCircleIds = [] }: {
  people: PeopleResponse | null; loading: boolean; error: string | null; online: boolean;
  onRefresh: () => void; onOpenPeople: () => void;
  onOpenProfile?: Props["onOpenProfile"]; onVisitFriend?: PersonVisitAction;
  locations?: readonly EarthMapPerson[]; onFocusPerson?: (circleId: string) => void; onMeetPerson?: (circleId: string) => void; selectedCircleIds?: readonly string[];
}) {
  const contacts = people?.people ?? locations.map(person => ({ circleId: person.circleId, user: person.user, nickname: null }));
  const displayed = selectedCircleIds.length ? contacts.filter(person => selectedCircleIds.includes(person.circleId)) : contacts;
  return <div className={styles.friendsContent}>
    <p className={styles.friendsIntro}>Геопозиция видна, когда друг ей делится.</p>
    {(!online || error || loading) && <p role="status" className={styles.hint}>
      {!online ? "Нет сети. Список может быть неактуален." : loading ? "Обновляем список друзей…" : "Не удалось обновить список друзей."}
    </p>}
    {displayed.length > 0 ? <ul className={styles.friendsList}>
      {displayed.map(person => {
        const displayName = person.nickname || person.user.displayName;
        const connected = people?.people.find(contact => contact.circleId === person.circleId && contact.user.publicId === person.user.publicId);
        const position = locations.find(row => row.circleId === person.circleId);
        const accuracy = position ? position.accuracyMeters >= 1_000
          ? `${(position.accuracyMeters / 1_000).toLocaleString("ru-RU", { maximumFractionDigits: 1 })} км`
          : `${Math.max(1, Math.round(position.accuracyMeters))} м` : "";
        return <li key={person.circleId}>
        <span className={styles.avatar} aria-hidden="true">{Array.from(displayName.trim())[0]?.toLocaleUpperCase("ru-RU") || "Ж"}</span>
        <div className={styles.friendIdentity}><strong><PlayerName name={displayName} tag={person.user.tag} /></strong>
          <span>{position ? `${position.precision === "APPROXIMATE" ? "Примерный район" : "Последняя геопозиция"} · ±${accuracy}` : "Нет доступной геопозиции"}</span>
          {position && <span>Обновлено {new Date(position.updatedAt).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</span>}
        </div>
        {position && onFocusPerson && <button className={styles.friendLocate} type="button" onClick={() => onFocusPerson(person.circleId)} aria-label={`Показать на карте: ${displayName}`}><MapPin size={18} aria-hidden="true" /></button>}
        {position && onMeetPerson && <button className={styles.meetButton} type="button" onClick={() => onMeetPerson(person.circleId)}><Footprints size={17} aria-hidden="true" />Подойти к другу</button>}
        {connected && (onOpenProfile || onVisitFriend) && <PersonGameActions className={styles.gameActions} person={connected}
          online={online} onOpenProfile={onOpenProfile} onVisitFriend={onVisitFriend} />}
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
  onRefreshPeople, onOpenPeople, onOpenProfile, onVisitFriend, onOpenWorld }: Props) {
  const [modelEditorOpen, setModelEditorOpen] = useState(readEarthModelEditorOpen);
  const editingModel = process.env.NODE_ENV === "development" && modelEditorOpen;
  const locationEnabled = active && visible && !editingModel;
  const autoLocate = sharing.pendingGhost ? false : sharing.settings ? sharing.settings.mode !== "GHOST" : null;
  const location = useEarthLocation({ ownerPublicId, enabled: locationEnabled, autoStartWhenGranted: autoLocate });
  const [focusRequest, setFocusRequest] = useState(0);
  const [focusAfter, setFocusAfter] = useState<number | null>(null);
  const [meetCircleId, setMeetCircleId] = useState<string | null>(null);
  const [meetFocusRequest, setMeetFocusRequest] = useState(0);
  const [panelSelection, setPanelSelection] = useState<{ visible: boolean; value: "friends" | "sharing" | "info" | null }>({ visible, value: null });
  if (panelSelection.visible !== visible) setPanelSelection({ visible, value: null });
  const panel = panelSelection.visible === visible ? panelSelection.value : null;
  const setPanel = (value: "friends" | "sharing" | "info" | null) => setPanelSelection({ visible, value });
  const onModelEditorOpenChange = useCallback((open: boolean) => {
    const editing = process.env.NODE_ENV === "development" && open;
    setModelEditorOpen(editing);
    if (editing) setPanelSelection(current => current.value === null ? current : { ...current, value: null });
  }, []);
  const friendsOpen = panel === "friends";
  const sharingOpen = panel === "sharing";
  const [selectedCircleIds, setSelectedCircleIds] = useState<readonly string[]>([]);
  const [friendFocusRequest, setFriendFocusRequest] = useState<{ circleId: string; requestId: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [monotonicNow, setMonotonicNow] = useState(() => performance.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const friendsButton = useRef<HTMLButtonElement>(null);
  const sharingButton = useRef<HTMLButtonElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const stopLocation = location.stop;
  const freezeLocation = location.freeze;
  const { setPosition: setSharedPosition, stopPublishing, pendingGhost, pendingPrivacyMode, publishing } = sharing;
  const foreground = useRef(locationEnabled);
  const wasPublishing = useRef(false);
  const pendingPrivacy = useRef<string | null>(null);
  const sharedPeople = sharing.people.filter(person => !people || people.people.some(contact => contact.circleId === person.circleId));
  useLayoutEffect(() => { foreground.current = locationEnabled; return () => { foreground.current = false; }; }, [locationEnabled]);
  // A retained map is allowed to keep its tiles/camera, never a location watch.
  useLayoutEffect(() => { if (!visible) stopLocation(); }, [visible, stopLocation]);
  useEffect(() => { if (visible) heading.current?.focus({ preventScroll: true }); }, [visible]);
  useEffect(() => {
    if (!locationEnabled || !location.position && sharedPeople.length === 0) return;
    const interval = setInterval(() => { setNow(Date.now()); setMonotonicNow(performance.now()); }, 15_000);
    return () => clearInterval(interval);
  }, [locationEnabled, location.position, sharedPeople.length]);
  useEffect(() => { if (friendsOpen || sharingOpen) panelHeading.current?.focus({ preventScroll: true }); }, [friendsOpen, sharingOpen]);
  useEffect(() => {
    setSharedPosition(locationEnabled && location.status === "active" ? location.position : null);
    // Editing temporarily pauses the private watch. Keep that request resumable;
    // do not treat its paused snapshot as a terminal publication/GPS failure.
    // Closing can briefly retain "paused" until the hook starts its next watch.
    if (!editingModel && (["denied", "unavailable", "timeout", "unsupported", "insecure"].includes(location.status)
      || location.status === "paused" && (!active || !visible))) stopPublishing();
  }, [active, visible, editingModel, locationEnabled, location.status, location.position, setSharedPosition, stopPublishing]);
  useEffect(() => {
    // A GPS failure already cleared its watch. Preserve the reason instead of
    // replacing denied/unavailable/timeout with an unexplained idle state.
    const privacy = pendingGhost ? pendingPrivacyMode : null;
    if (privacy && privacy !== pendingPrivacy.current) {
      if (pendingPrivacyMode === "OFF") stopLocation();
      else freezeLocation();
    } else if (!editingModel && wasPublishing.current && !publishing && !location.error) freezeLocation();
    pendingPrivacy.current = privacy;
    wasPublishing.current = publishing;
  }, [pendingGhost, pendingPrivacyMode, publishing, editingModel, location.error, stopLocation, freezeLocation]);
  const closeFriends = () => { const privacy = sharingOpen; setPanel(null); (privacy ? sharingButton : friendsButton).current?.focus({ preventScroll: true }); };
  const locating = location.status === "requesting";
  const watching = locating || location.status === "active";
  const age = location.position ? Math.max(0, Math.floor((now - location.position.timestamp) / 60_000)) : 0;

  const locate = () => {
    if (!foreground.current) return;
    const freshAfter = Date.now() - 15_000;
    setFocusAfter(freshAfter);
    setFocusRequest(value => value + 1);
    if (!location.position || location.position.timestamp < freshAfter || location.status !== "active") location.locate();
  };
  const stopGps = () => { sharing.stopPublishing(); location.freeze(); };
  const ghost = () => { location.freeze(); sharing.ghost(); };
  const off = () => { location.stop(); sharing.off(); };
  const share = async (choices: EarthSharingChoices) => {
    location.freeze();
    sharing.setPosition(null);
    const accepted = await sharing.share(choices);
    if (accepted && foreground.current && choices.recipientCircleIds.some(id => !choices.frozenCircleIds.includes(id))) location.start();
  };
  const focusFriend = (circleId: string) => {
    setMeetCircleId(null);
    setFriendFocusRequest(previous => ({ circleId, requestId: (previous?.requestId ?? 0) + 1 }));
    setPanel(null);
  };
  const meetFriend = useCallback((circleId: string) => {
    if (!sharedPeople.some(person => person.circleId === circleId)) return;
    setNow(Date.now());
    setMonotonicNow(performance.now());
    setMeetCircleId(circleId);
    setMeetFocusRequest(value => value + 1);
    setPanelSelection({ visible, value: null });
    if (!location.position || Date.now() - location.position.timestamp > 60_000 || location.status !== "active") location.locate();
  }, [sharedPeople, location, visible]);
  const meetPerson = sharedPeople.find(person => person.circleId === meetCircleId) ?? null;
  const meetContact = people?.people.find(person => person.circleId === meetCircleId && person.user.publicId === meetPerson?.user.publicId);
  const locationDetails = <section className={styles.locationDetails} aria-labelledby="earth-location-heading">
    <h3 id="earth-location-heading">Моё местоположение</h3>
    <strong role="status">{locationSummary(location.status, location.position)}</strong>
    {location.position && <p>{age > 0 ? `Обновлено ${age} мин. назад` : "Только что"}</p>}
    {location.error && <p className={styles.locationError}>{location.error}</p>}
    <button className={styles.stopButton} type="button" onClick={locate}>Найти меня</button>
    {watching && <button className={styles.stopButton} type="button" onClick={stopGps}>Приостановить GPS</button>}
  </section>;

  return <section className={styles.view} aria-labelledby="earth-title" data-earth-world>
    <p id="earth-location-privacy" className={styles.srOnly}>«Найти меня» центрирует карту. Доступ друзей к геопозиции не меняется.</p>
    <div className={styles.stage}>
      <EarthMap position={visible && !editingModel ? location.position : null} active={active} visible={visible} onReadyChange={onReadyChange} cameraSession={cameraSession}
        focusRequest={focusRequest} focusWhenReady={focusAfter === null || location.status === "active" && Boolean(location.position && location.position.timestamp >= focusAfter)}
        meetCircleId={!editingModel && panel === null ? meetPerson?.circleId : null} meetFocusRequest={meetFocusRequest} isOnline={isOnline} friends={editingModel ? NO_SHARED_PEOPLE : sharedPeople} friendFocusRequest={editingModel ? null : friendFocusRequest}
        onSelectFriends={ids => { if (!editingModel) { setSelectedCircleIds(ids); setPanel("friends"); } }}
        onLocate={() => { setMeetCircleId(null); locate(); }} locating={locating} locationActive={location.status === "active"} showLocationControl={!editingModel}
        locationDetails={editingModel ? null : locationDetails} onModelEditorOpenChange={onModelEditorOpenChange}
        infoOpen={panel === "info"} onInfoOpenChange={open => setPanel(open ? "info" : null)} />
    </div>
    <header className={styles.header}>
      <h1 id="earth-title" ref={heading} tabIndex={-1} className={styles.brand}>
        <Globe2 size={21} aria-hidden="true" /><span>Я живой<span className={styles.brandDivider}>·</span><span className={styles.brandPlace}>Земля</span></span>
      </h1>
      <button type="button" className={styles.worldButton} onClick={event => onOpenWorld(event.currentTarget)} aria-label="Войти в мир Мохлика" aria-haspopup="dialog">
        <Leaf size={18} aria-hidden="true" /><span>Моя полянка</span>
      </button>
    </header>

    {!editingModel && <div className={styles.bottomOverlay}>
      {(friendsOpen || sharingOpen) && <section id="earth-friends-panel" className={styles.friendsPanel} aria-labelledby="earth-friends-title" onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); closeFriends(); }
      }}>
        <header><h2 id="earth-friends-title" ref={panelHeading} tabIndex={-1}>{sharingOpen ? "Моя геопозиция" : "Близкие на карте"}</h2>
          <button type="button" onClick={closeFriends} aria-label={sharingOpen ? "Закрыть настройки геопозиции" : "Закрыть список друзей"}><X size={18} aria-hidden="true" /></button></header>
        {sharingOpen ? <EarthSharingPanel sharing={sharing} people={people} peopleLoading={peopleLoading} online={isOnline} onShare={share} onGhost={ghost} onOff={off}
          onSetFrozen={sharing.setFrozen} onRevokeRecipient={sharing.revokeRecipient} />
          : <>{selectedCircleIds.length > 0 && <button className={styles.allFriends} type="button" onClick={() => setSelectedCircleIds([])}>Показать всех близких</button>}
            <EarthFriends people={people} loading={peopleLoading || sharing.loading} error={peopleError || sharing.error} online={isOnline}
              locations={sharedPeople} selectedCircleIds={selectedCircleIds} onFocusPerson={focusFriend} onMeetPerson={meetFriend}
              onOpenProfile={onOpenProfile} onVisitFriend={onVisitFriend}
              onRefresh={() => { onRefreshPeople(); sharing.refresh(); }} onOpenPeople={onOpenPeople} /></>}
      </section>}
      {meetCircleId && panel === null && <EarthMeetCard person={meetPerson} name={meetContact?.nickname || meetPerson?.user.displayName}
        position={location.status === "active" ? location.position : null} now={now} monotonicNow={monotonicNow} locating={locating}
        onLocate={() => { location.locate(); setMeetFocusRequest(value => value + 1); }}
        onShowBoth={() => setMeetFocusRequest(value => value + 1)} onClose={() => setMeetCircleId(null)} />}
      <div className={styles.bottomButtons}>
      <button ref={friendsButton} className={styles.friendsButton} type="button" aria-expanded={friendsOpen} aria-controls="earth-friends-panel" onClick={() => setPanel(friendsOpen ? null : "friends")}>
        <span className={styles.friendsIcon}><Users size={18} aria-hidden="true" /></span>Близкие{people ? <span className={styles.friendsCount}>{people.people.length}</span> : null}
      </button>
      <button ref={sharingButton} className={styles.sharingButton} type="button" aria-expanded={sharingOpen} aria-controls="earth-friends-panel"
        onClick={() => { setPanel(sharingOpen ? null : "sharing"); if (!sharingOpen) { onRefreshPeople(); sharing.refresh(); } }}>
        <Ghost size={17} aria-hidden="true" /><span>{sharingSummary(sharing)}</span>
      </button>
      </div>
    </div>}
    {!editingModel && (!isOnline || location.error) && panel === null && <p className={styles.notice} role="status">
      {location.error || "Нет сети · новые участки пока недоступны"}
    </p>}
  </section>;
}
