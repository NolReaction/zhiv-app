"use client";

import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { BookOpen, Globe2, Leaf, MapPin, Users, X } from "lucide-react";
import type { PeopleResponse } from "@/lib/check-in-contract";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import { PlayerName } from "@/components/player-name";
import { EarthMap } from "./earth-map";
import { EarthAtlasPanel } from "./earth-atlas-panel";
import { EarthAtlasExplorer } from "./earth-atlas-explorer";
import { EARTH_ATLAS_MEETING_ID, earthAtlasEntry, type EarthAtlasEntry } from "./earth-atlas";
import { earthAtlasPlaceProgress } from "./earth-atlas-visible";
import { useEarthAtlas } from "./use-earth-atlas";
import { useEarthAtlasExplorer } from "./use-earth-atlas-explorer";
import { useEarthAtlasDiscovery } from "./use-earth-atlas-discovery";
import { EarthAtlasDiscovery } from "./earth-atlas-discovery";
import { canRecordEarthMeeting } from "./meet";
import type { EarthCameraSession } from "./camera-session";
import { useEarthLocation } from "./use-earth-location";
import type { EarthLocationStatus, EarthPosition } from "./location";
import type { EarthMapPerson } from "@/lib/earth-sharing-contract";
import { EarthSharingPanel, sharingSummary, type EarthSharingChoices, type EarthSharingHandle } from "./earth-sharing-panel";
import { EarthMeetCard } from "./earth-meet-card";
import { useEarthWalkingRoute } from "./use-earth-walking-route";
import { readEarthModelEditorOpen } from "./dev/earth-model-editor-session";
import styles from "./earth-view.module.css";

const NO_SHARED_PEOPLE: readonly EarthMapPerson[] = [];
const EarthDevBots = process.env.NODE_ENV === "development"
  ? lazy(() => import("./dev/earth-dev-bots").then(module => ({ default: module.EarthDevBots }))) : null;

type Props = {
  ownerPublicId: string;
  active: boolean;
  visible: boolean;
  onReadyChange?: (ready: boolean) => void;
  cameraSession?: EarthCameraSession;
  sharing: EarthSharingHandle;
  privacyRequest?: number | null;
  onPrivacyRequestHandled?: (id: number) => void;
  devCommandsAvailable?: boolean;
  isOnline: boolean;
  people: PeopleResponse | null;
  peopleLoading: boolean;
  peopleError: string | null;
  onRefreshPeople: () => void;
  onOpenPeople: () => void;
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
  if (position) return "Последняя геопозиция · свежая пока недоступна";
  return "Найдите себя на Земле";
}

/** Only current map participants; a horizontal picker also handles co-located markers. */
export function EarthFriends({ people, locations = [], onFocusPerson, onMeetPerson, selectedCircleIds = [] }: {
  people: PeopleResponse | null; loading: boolean; error: string | null; online: boolean;
  onRefresh: () => void; onOpenPeople: () => void;
  locations?: readonly EarthMapPerson[]; onFocusPerson?: (circleId: string) => void; onMeetPerson?: (circleId: string) => void; selectedCircleIds?: readonly string[];
}) {
  const participants = locations.filter(person => (!selectedCircleIds.length || selectedCircleIds.includes(person.circleId))
    && (!people || people.people.some(contact => contact.circleId === person.circleId && contact.user.publicId === person.user.publicId)));
  const select = onMeetPerson ?? onFocusPerson;
  return <ul className={styles.participants} aria-label="Участники на карте" tabIndex={0}>
    {participants.map(person => {
      const contact = people?.people.find(row => row.circleId === person.circleId && row.user.publicId === person.user.publicId);
      const name = contact?.nickname || person.user.displayName;
      return <li key={person.circleId}><button type="button" data-audio-cue="ui.open" disabled={!select}
        aria-label={`Открыть встречу: ${name}`} onClick={() => {
          if (person.expiresAtMonotonic > performance.now() && Date.parse(person.expiresAt) > Date.now()) select?.(person.circleId);
        }}>
        <span className={styles.avatar} aria-hidden="true">{Array.from(name.trim())[0]?.toLocaleUpperCase("ru-RU") || "Ж"}</span>
        <span><PlayerName name={name} tag={person.user.tag} /></span>
      </button></li>;
    })}
    {!participants.length && <li className={styles.hint}>Сейчас на карте никого нет.</li>}
  </ul>;
}

export function EarthView(props: Props) {
  return <EarthViewSession key={props.ownerPublicId} {...props} />;
}

function EarthViewSession({ ownerPublicId, active, visible, onReadyChange, cameraSession, sharing, privacyRequest = null, onPrivacyRequestHandled, devCommandsAvailable = false, isOnline, people, peopleLoading, peopleError,
  onRefreshPeople, onOpenPeople, onOpenWorld }: Props) {
  const [modelEditorOpen, setModelEditorOpen] = useState(readEarthModelEditorOpen);
  const editingModel = process.env.NODE_ENV === "development" && modelEditorOpen;
  const locationEnabled = active && visible && !editingModel;
  const autoLocate = sharing.pendingGhost ? false : sharing.settings ? sharing.settings.mode !== "GHOST" : null;
  const location = useEarthLocation({ ownerPublicId, enabled: locationEnabled, autoStartWhenGranted: autoLocate });
  const [focusRequest, setFocusRequest] = useState(0);
  const [focusAfter, setFocusAfter] = useState<number | null>(null);
  const [meetCircleId, setMeetCircleId] = useState<string | null>(null);
  const [meetFocusRequest, setMeetFocusRequest] = useState(0);
  const [meetFocusTarget, setMeetFocusTarget] = useState<string | null>(null);
  const atlas = useEarthAtlas(ownerPublicId);
  const atlasProgress = earthAtlasPlaceProgress(atlas.snapshot.ids);
  const atlasFeedback = useEarthAtlasDiscovery(ownerPublicId, active && visible && !editingModel);
  const explorer = useEarthAtlasExplorer(ownerPublicId);
  const closeExplorer = explorer.close;
  const explorerForeground = useRef(false);
  const restoreAtlasFocus = useRef(false);
  const [panelSelection, setPanelSelection] = useState<{ visible: boolean; value: "friends" | "sharing" | "info" | "atlas" | null; privacyRequest: number | null }>({
    visible, value: visible && privacyRequest !== null ? "sharing" : null, privacyRequest: visible ? privacyRequest : null,
  });
  const newPrivacyRequest = visible && privacyRequest !== null
    && (panelSelection.privacyRequest !== privacyRequest || panelSelection.visible !== visible);
  if (panelSelection.visible !== visible || newPrivacyRequest) {
    setPanelSelection({ visible, value: newPrivacyRequest ? "sharing" : null,
      privacyRequest: visible && privacyRequest !== null ? privacyRequest : panelSelection.privacyRequest });
  }
  const panel = panelSelection.visible === visible ? panelSelection.value : null;
  const setPanel = (value: "friends" | "sharing" | "info" | "atlas" | null) => {
    if (value) { explorerForeground.current = false; restoreAtlasFocus.current = false; }
    if (value && value !== "atlas") explorer.close();
    setPanelSelection(current => ({ ...current, visible, value }));
  };
  useEffect(() => {
    if (visible && !editingModel && panel === "sharing" && privacyRequest !== null
      && panelSelection.privacyRequest === privacyRequest) onPrivacyRequestHandled?.(privacyRequest);
  }, [visible, editingModel, panel, privacyRequest, panelSelection.privacyRequest, onPrivacyRequestHandled]);
  const onModelEditorOpenChange = useCallback((open: boolean) => {
    const editing = process.env.NODE_ENV === "development" && open;
    setModelEditorOpen(editing);
    if (editing) {
      explorerForeground.current = false;
      closeExplorer();
      setPanelSelection(current => current.value === null ? current : { ...current, value: null });
    }
  }, [closeExplorer]);
  const friendsOpen = panel === "friends";
  const sharingOpen = panel === "sharing";
  const atlasOpen = panel === "atlas";
  useLayoutEffect(() => {
    explorerForeground.current = active && visible && !editingModel && panel === null && meetCircleId === null;
    if (!active || !visible || editingModel || panel && panel !== "atlas" || meetCircleId) closeExplorer();
    return () => { explorerForeground.current = false; };
  }, [active, visible, editingModel, panel, meetCircleId, closeExplorer]);
  const [selectedCircleIds, setSelectedCircleIds] = useState<readonly string[]>([]);
  const [friendFocusRequest, setFriendFocusRequest] = useState<{ circleId: string; requestId: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [monotonicNow, setMonotonicNow] = useState(() => performance.now());
  const heading = useRef<HTMLHeadingElement>(null);
  const friendsButton = useRef<HTMLButtonElement>(null);
  const meetingTrigger = useRef<HTMLButtonElement | null>(null);
  const sharingButton = useRef<HTMLButtonElement>(null);
  const atlasButton = useRef<HTMLButtonElement>(null);
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const stopLocation = location.stop;
  const freezeLocation = location.freeze;
  const { setPosition: setSharedPosition, stopPublishing, pendingGhost, pendingPrivacyMode, publishing } = sharing;
  const foreground = useRef(locationEnabled);
  const wasPublishing = useRef(false);
  const pendingPrivacy = useRef<string | null>(null);
  const sharedPeople = sharing.people.filter(person => !people || people.people.some(contact => contact.circleId === person.circleId && contact.user.publicId === person.user.publicId));
  useLayoutEffect(() => {
    if (!restoreAtlasFocus.current) return;
    restoreAtlasFocus.current = false;
    if (panel === null && !newPrivacyRequest && locationEnabled && !document.hidden) atlasButton.current?.focus({ preventScroll: true });
  }, [panel, newPrivacyRequest, locationEnabled]);
  useLayoutEffect(() => { foreground.current = locationEnabled; return () => { foreground.current = false; }; }, [locationEnabled]);
  // The location hook pauses a hidden retained view's watch. Keep its private
  // last fix in RAM until owner teardown/unmount; stop() would erase the marker
  // and suppress even an already granted lookup when returning to this view.
  useEffect(() => { if (visible) heading.current?.focus({ preventScroll: true }); }, [visible]);
  useEffect(() => {
    if (!locationEnabled || !location.position && sharedPeople.length === 0 && !friendsOpen) return;
    const interval = setInterval(() => { setNow(Date.now()); setMonotonicNow(performance.now()); }, 15_000);
    return () => clearInterval(interval);
  }, [locationEnabled, location.position, sharedPeople.length, friendsOpen]);
  useEffect(() => { if (friendsOpen || sharingOpen || atlasOpen) panelHeading.current?.focus({ preventScroll: true }); }, [friendsOpen, sharingOpen, atlasOpen]);
  useEffect(() => {
    setSharedPosition(locationEnabled && location.allowed && location.status === "active" ? location.position : null);
    // Editing temporarily pauses the private watch. Keep that request resumable;
    // do not treat its paused snapshot as a terminal publication/GPS failure.
    // Closing can briefly retain "paused" until the hook starts its next watch.
    if (!editingModel && (["denied", "unavailable", "timeout", "unsupported", "insecure"].includes(location.status)
      || location.status === "paused" && (!active || !visible))) stopPublishing();
  }, [active, visible, editingModel, locationEnabled, location.allowed, location.status, location.position, setSharedPosition, stopPublishing]);
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
  const closeFriends = () => {
    if (atlasOpen) restoreAtlasFocus.current = true;
    setPanel(null);
    if (!atlasOpen) (sharingOpen ? sharingButton : friendsButton).current?.focus({ preventScroll: true });
  };
  const locating = location.status === "requesting";
  const watching = locating || location.status === "active";
  const age = location.position ? Math.max(0, Math.floor((now - location.position.timestamp) / 60_000)) : 0;

  const locate = () => {
    if (!foreground.current || !location.allowed) return;
    const freshAfter = Date.now() - 15_000;
    setFocusAfter(freshAfter);
    setFocusRequest(value => value + 1);
    if (!location.position || location.position.timestamp < freshAfter || location.status !== "active") location.locate();
  };
  const stopGps = () => { sharing.stopPublishing(); location.freeze(); };
  const ghost = () => { location.freeze(); sharing.ghost(); };
  const off = () => { location.stop(); sharing.off(); };
  const share = async (choices: EarthSharingChoices) => {
    if (!location.allowed) return;
    location.freeze();
    sharing.setPosition(null);
    const accepted = await sharing.share(choices);
    if (accepted && foreground.current && choices.recipientCircleIds.some(id => !choices.frozenCircleIds.includes(id))) location.start();
  };
  const focusFriend = (circleId: string) => {
    explorer.close();
    setMeetCircleId(null);
    setFriendFocusRequest(previous => ({ circleId, requestId: (previous?.requestId ?? 0) + 1 }));
    setPanel(null);
  };
  const meetFriend = useCallback((circleId: string) => {
    if (!sharedPeople.some(person => person.circleId === circleId)) return;
    closeExplorer();
    setNow(Date.now());
    setMonotonicNow(performance.now());
    setMeetCircleId(circleId);
    setMeetFocusTarget(null);
    setFriendFocusRequest(previous => ({ circleId, requestId: (previous?.requestId ?? 0) + 1 }));
    setPanelSelection(current => ({ ...current, visible, value: null }));
    if (location.allowed && (!location.position || Date.now() - location.position.timestamp > 60_000 || location.status !== "active")) location.locate();
  }, [sharedPeople, location, visible, closeExplorer]);
  const frameMeeting = () => { setMeetFocusTarget(meetCircleId); setMeetFocusRequest(value => value + 1); };
  const closeMeeting = () => {
    setMeetCircleId(null);
    const trigger = meetingTrigger.current;
    if (trigger?.isConnected && !trigger.disabled) trigger.focus({ preventScroll: true });
    else (friendsButton.current ?? sharingButton.current)?.focus({ preventScroll: true });
  };
  const meetPerson = sharedPeople.find(person => person.circleId === meetCircleId) ?? null;
  const walking = useEarthWalkingRoute({ owner: ownerPublicId, foreground: locationEnabled && panel === null,
    online: isOnline, allowed: location.allowed, position: location.status === "active" ? location.position : null, person: meetPerson });
  const prepareAtlasSelection = () => {
    setMeetCircleId(null);
    setMeetFocusTarget(null);
    meetingTrigger.current = null;
    setSelectedCircleIds([]);
    setPanel(null);
  };
  const focusAtlasEntry = (entry: EarthAtlasEntry) => {
    if (explorer.selectEntry(entry)) prepareAtlasSelection();
  };
  const persistAtlasEntry = (entry: EarthAtlasEntry) => {
    const canonical = earthAtlasEntry(entry.id);
    if (!canonical || !foreground.current || document.hidden || !atlas.readSnapshot().loaded) return;
    if (atlas.discover(canonical.id)) {
      const ids = atlas.readSnapshot().ids;
      atlasFeedback.show(canonical, canonical.kind === "landmark" ? earthAtlasPlaceProgress(ids).opened : ids.length);
    }
  };
  const discoverAtlasEntry = (entry: EarthAtlasEntry) => {
    if (explorer.canDiscover(entry, { foreground: foreground.current && explorerForeground.current,
      hidden: document.hidden, loaded: atlas.readSnapshot().loaded })) persistAtlasEntry(entry);
  };
  const dismissExplorer = () => {
    explorer.close(true);
    atlasButton.current?.focus({ preventScroll: true });
  };
  const meetContact = people?.people.find(person => person.circleId === meetCircleId && person.user.publicId === meetPerson?.user.publicId);
  const locationDetails = <section className={styles.locationDetails} aria-labelledby="earth-location-heading">
    <h3 id="earth-location-heading">Моё местоположение</h3>
    <strong role="status">{location.allowed ? locationSummary(location.status, location.position) : "Геопозиция отключена"}</strong>
    {!location.allowed && <p>Включи её в «Профиль → Настройки → Геопозиция».</p>}
    {location.position && <p>{age > 0 ? `Обновлено ${age} мин. назад` : "Только что"}</p>}
    {location.error && <p className={styles.locationError}>{location.error}</p>}
    <button className={styles.stopButton} type="button" data-audio-cue="ui.click" onClick={locate} disabled={!location.allowed}>Найти меня</button>
    {watching && <button className={styles.stopButton} type="button" data-audio-cue="ui.click" onClick={stopGps}>Приостановить GPS</button>}
  </section>;

  return <section className={styles.view} aria-labelledby="earth-title" data-earth-world onKeyDown={event => {
    if (event.key === "Escape" && panel === null && explorer.snapshot.entry) { event.stopPropagation(); dismissExplorer(); }
  }} onContextMenu={event => {
    if (!(event.target instanceof Element) || !event.target.closest("input, textarea, [contenteditable='true'], a[href]")) event.preventDefault();
  }}>
    <p id="earth-location-privacy" className={styles.srOnly}>«Найти меня» центрирует карту. Доступ друзей к геопозиции не меняется.</p>
    <div className={styles.stage}>
      <EarthMap position={visible && !editingModel && location.allowed ? location.position : null} active={active} visible={visible} onReadyChange={onReadyChange} cameraSession={cameraSession}
        cameraFocusRequest={explorer.snapshot.request} onAtlasPreviewChange={explorer.setPreview}
        focusRequest={focusRequest} focusWhenReady={focusAfter === null || location.status === "active" && Boolean(location.position && location.position.timestamp >= focusAfter)}
        walkingRoute={locationEnabled && panel === null ? walking.snapshot.route : null}
        meetCircleId={!editingModel && panel === null ? meetPerson?.circleId : null} meetFocusRequest={meetFocusTarget === meetCircleId ? meetFocusRequest : 0} isOnline={isOnline} friends={editingModel ? NO_SHARED_PEOPLE : sharedPeople} friendFocusRequest={editingModel ? null : friendFocusRequest}
        onSelectFriends={(ids, trigger) => { if (!editingModel) {
          meetingTrigger.current = trigger ?? null;
          explorer.close();
          playUiCue(getAudioRuntime(), "ui.open");
          if (ids.length === 1) meetFriend(ids[0]);
          else { setMeetCircleId(null); setSelectedCircleIds(ids); setPanel("friends"); }
        } }}
        onLocate={() => { explorer.close(); setMeetCircleId(null); locate(); }} locating={locating} locationActive={location.status === "active"} locationStatus={location.status} showLocationControl={!editingModel && location.allowed}
        locationDetails={editingModel ? null : locationDetails} onModelEditorOpenChange={onModelEditorOpenChange}
        infoOpen={panel === "info"} onInfoOpenChange={open => setPanel(open ? "info" : null)} />
    </div>
    <header className={styles.header} data-earth-camera-blocker>
      <h1 id="earth-title" ref={heading} tabIndex={-1} className={styles.brand}>
        <Globe2 size={21} aria-hidden="true" /><span>Я живой<span className={styles.brandDivider}>·</span><span className={styles.brandPlace}>Земля</span></span>
      </h1>
      <button type="button" className={styles.worldButton} data-audio-cue="ui.open" onClick={event => onOpenWorld(event.currentTarget)} aria-label="Войти в мир Мохлика" aria-haspopup="dialog">
        <Leaf size={18} aria-hidden="true" /><span>Моя полянка</span>
      </button>
    </header>
    <EarthAtlasDiscovery discovery={atlasOpen || explorer.snapshot.entry || atlasFeedback.discovery?.entry.kind !== "meeting" ? null : atlasFeedback.discovery} />
    {EarthDevBots && active && visible && !editingModel && <Suspense fallback={null}><EarthDevBots
      key={ownerPublicId} ownerPublicId={ownerPublicId} online={isOnline} commandsAvailable={devCommandsAvailable} position={location.status === "active" ? location.position : null}
      otherPanelOpen={panel !== null || meetCircleId !== null || explorer.snapshot.entry !== null} onOpen={() => { explorer.close(); setPanel(null); setMeetCircleId(null); }}
      readCenter={() => { const camera = cameraSession?.read(); return camera ? { latitude: camera.center[1], longitude: ((camera.center[0] + 540) % 360) - 180 } : null; }}
      onChanged={() => { onRefreshPeople(); sharing.refresh(); }} onFocus={focusFriend} /></Suspense>}

    {!editingModel && <div className={styles.bottomOverlay} data-atlas-open={atlasOpen} data-panel-open={panel !== null || meetCircleId !== null || explorer.snapshot.entry !== null}>
      {atlasOpen && <section id="earth-atlas-panel" data-earth-camera-panel className={`${styles.friendsPanel} ${styles.atlasPanel}`} aria-labelledby="earth-atlas-title" onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); closeFriends(); }
      }}>
        <header><h2 id="earth-atlas-title" ref={panelHeading} tabIndex={-1}>Личный атлас <span className={styles.atlasProgress}
          aria-label={`Открыто ${atlasProgress.opened} из ${atlasProgress.total}`}>{atlasProgress.opened}/{atlasProgress.total}</span></h2>
          <button type="button" data-audio-cue="ui.close" onClick={closeFriends} aria-label="Закрыть атлас"><X size={18} aria-hidden="true" /></button></header>
        <EarthAtlasPanel atlas={atlas} onFocus={focusAtlasEntry} recentDiscoveryId={atlasFeedback.discovery?.entry.id} />
      </section>}
      {panel === null && !meetCircleId && explorer.snapshot.entry && <EarthAtlasExplorer entry={explorer.snapshot.entry}
        opened={atlas.snapshot.ids.includes(explorer.snapshot.entry.id)} loaded={atlas.snapshot.loaded} persistent={atlas.snapshot.persistent}
        preview={explorer.snapshot.preview} onDiscover={() => discoverAtlasEntry(explorer.snapshot.entry!)}
        onFocus={() => { if (explorer.snapshot.entry && explorer.focusEntry(explorer.snapshot.entry)) prepareAtlasSelection(); }}
        onClose={dismissExplorer} />}
      {(friendsOpen || sharingOpen) && <section id="earth-friends-panel" data-earth-camera-panel className={styles.friendsPanel} aria-labelledby="earth-friends-title" onKeyDown={event => {
        if (event.key === "Escape") { event.stopPropagation(); closeFriends(); }
      }}>
        <header><h2 id="earth-friends-title" ref={panelHeading} tabIndex={-1}>{sharingOpen ? "Моя геопозиция" : selectedCircleIds.length ? "Участники рядом" : "Участники на карте"}</h2>
          <button type="button" data-audio-cue="ui.close" onClick={closeFriends} aria-label={sharingOpen ? "Закрыть настройки геопозиции" : "Закрыть список друзей"}><X size={18} aria-hidden="true" /></button></header>
        {sharingOpen ? <EarthSharingPanel sharing={sharing} people={people} peopleLoading={peopleLoading} online={isOnline} onShare={share} onGhost={ghost} onOff={off}
          onSetFrozen={sharing.setFrozen} onRevokeRecipient={sharing.revokeRecipient} locationAllowed={location.allowed} />
          : <><EarthFriends people={people} loading={peopleLoading || sharing.loading} error={peopleError || sharing.error} online={isOnline}
              locations={sharedPeople} selectedCircleIds={selectedCircleIds} onFocusPerson={focusFriend} onMeetPerson={meetFriend}
              onRefresh={() => { onRefreshPeople(); sharing.refresh(); }} onOpenPeople={onOpenPeople} /></>}
      </section>}
      {meetCircleId && panel === null && <EarthMeetCard person={meetPerson} name={meetContact?.nickname || meetPerson?.user.displayName}
        meetingRecorded={atlas.snapshot.ids.includes(EARTH_ATLAS_MEETING_ID)} onRecordMeeting={() => {
          if (foreground.current && location.allowed && location.status === "active" && meetPerson
            && canRecordEarthMeeting(location.position, meetPerson, performance.now(), Date.now())) {
            const entry = earthAtlasEntry(EARTH_ATLAS_MEETING_ID);
            if (entry?.kind === "meeting" && entry.id === EARTH_ATLAS_MEETING_ID) persistAtlasEntry(entry);
          }
        }}
        position={location.status === "active" ? location.position : null} now={now} monotonicNow={monotonicNow} locating={locating} locationAllowed={location.allowed}
        onLocate={() => { if (location.allowed) { location.locate(); frameMeeting(); } }}
        walkingRoute={walking.snapshot} onBuildWalkingRoute={() => { if (walking.request()) frameMeeting(); }} onClearWalkingRoute={walking.clear}
        onShowBoth={frameMeeting} onClose={closeMeeting} />}
      <div className={styles.bottomButtons}>
      {sharedPeople.length > 0 && <button ref={friendsButton} className={styles.friendsButton} type="button" aria-label={`Участники на карте: ${sharedPeople.length}`} data-audio-cue={friendsOpen ? "ui.close" : "ui.open"} aria-expanded={friendsOpen} aria-controls="earth-friends-panel" onClick={() => { meetingTrigger.current = null; setSelectedCircleIds([]); setPanel(friendsOpen ? null : "friends"); }}>
        <Users size={17} aria-hidden="true" /><span>На карте</span><span className={styles.friendsCount}>{sharedPeople.length}</span>
      </button>}
      <button ref={sharingButton} className={`${styles.sharingButton} ${styles.privacyButton}`} type="button" data-audio-cue={sharingOpen ? "ui.close" : "ui.open"} aria-expanded={sharingOpen} aria-controls="earth-friends-panel"
        aria-label={`Моя геопозиция: ${location.allowed ? sharingSummary(sharing) : "отключена"}`} title={location.allowed ? sharingSummary(sharing) : "Геопозиция отключена"}
        onClick={() => { setPanel(sharingOpen ? null : "sharing"); if (!sharingOpen) { onRefreshPeople(); sharing.refresh(); } }}>
        <MapPin size={17} aria-hidden="true" /><span>Геопозиция</span>
      </button>
      <button ref={atlasButton} className={`${styles.sharingButton} ${styles.atlasButton}`} type="button" title="Личный атлас" aria-label="Личный атлас"
        data-audio-cue={atlasOpen ? "ui.close" : "ui.open"} aria-expanded={atlasOpen} aria-controls="earth-atlas-panel"
        onClick={() => setPanel(atlasOpen ? null : "atlas")}><BookOpen size={18} aria-hidden="true" /></button>
      </div>
    </div>}
    {!editingModel && (!isOnline || location.error) && panel === null && !explorer.snapshot.entry && <p className={styles.notice} role="status">
      {location.error || "Нет сети · новые участки пока недоступны"}
    </p>}
  </section>;
}
