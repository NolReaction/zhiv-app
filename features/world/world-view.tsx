"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ArrowLeft, BookOpen, Check, Compass, X, Info, Leaf, LockKeyhole, MoreHorizontal, Package, PawPrint, Shirt, Store } from "lucide-react";
import { GAME_ITEMS, naturalItems } from "@/features/game/game-rewards";
import { DecorationPreview } from "./decoration-preview";
import { formatDayCount } from "@/lib/daily-streak";
import type { WorldPortalProps } from "./world-portal";
import { GameLevelIcon } from "@/features/game/game-level-icon";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { WorldScene } from "./world-scene";
import { worldCatalog as catalog } from "./model";
import { WorldCollections } from "./world-collections";
import { ItemIcon } from "@/features/items/item-icon";
import type { MapObjectSelection, WorldPlace } from "./map-engine";
import styles from "./world.module.css";
import { WorldJourneys } from "./world-journeys";
import { WorldFeedback } from "./world-feedback";
import { EconomyPanel, type EconomyTab } from "@/features/economy/economy-panel";
import { economyBuildingDestination, economySceneJourney, economySceneProduction, economyWorldState } from "@/features/economy/world-adapter";
import { WORLD_PRESENTATION } from "./presentation";
import { WorldHelp } from "./world-help";
import { WorldProfileMenu } from "./world-profile-menu";
import { WorldPantryMenu } from "@/features/economy/world-pantry-menu";
import { WorldExpeditionsMenu, type SectorId } from "@/features/economy/world-expeditions-menu";
import { WorldUpgradeDialog } from "@/features/economy/world-upgrade-dialog";
import { worldPlaceForStation } from "@/features/economy/world-stations";
import { WorldWallet } from "./world-wallet";
import { WorldInventoryGains } from "./world-inventory-gains";
import hudStyles from "./world-map-hud.module.css";
import { WorldObjectMenu } from "@/features/economy/world-object-menu";
import { WorldResidentDialog } from "./world-resident-dialog";
import { WorldCharacters } from "./world-characters";

type Panel = "journeys" | "economy" | "customize" | "wardrobe" | "collection" | "help";
type QuickMenu = "profile" | "pantry" | "expeditions" | "more";
const WorldDevPanel = process.env.NODE_ENV === "development"
  ? dynamic(() => import("./dev/world-dev-panel"), { ssr: false }) : null;
export default function WorldView({ world, economy, ownerPublicId, timeZone, onClose, displayName, level, wakeSignal, bestStreakDays, items, escapeHandlerRef }: WorldPortalProps & { escapeHandlerRef?: RefObject<(() => boolean) | null> }) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [economyTab, setEconomyTab] = useState<EconomyTab>("overview");
  const [economyFocusId, setEconomyFocusId] = useState<string | undefined>();
  const [selection, setSelection] = useState<MapObjectSelection | null>(null);
  const selectedId = useRef<string | null>(null);
  const requestedStation = useRef<string | undefined>(undefined);
  const [objectStation, setObjectStation] = useState<string | undefined>();
  const objectReturn = useRef<HTMLElement | null>(null);
  const requestedObjectReturn = useRef<HTMLElement | null>(null);
  const [openObjectRequest, setOpenObjectRequest] = useState<{ id: number; place: WorldPlace }>();
  const [quickMenu, setQuickMenu] = useState<QuickMenu | null>(null);
  const [charactersOpen, setCharactersOpen] = useState(false);
  const leavingCharacters = useRef(false);
  const [expeditionSector, setExpeditionSector] = useState<SectorId>("forest");
  const [residentOpen, setResidentOpen] = useState(false);
  const [residentFromCharacters, setResidentFromCharacters] = useState(false);
  const residentReturn = useRef<HTMLElement | null>(null);
  const leavingResident = useRef(false);
  const [quickUpgrade, setQuickUpgrade] = useState<string | null>(null);
  const quickFrame = useRef<HTMLElement>(null);
  const panelReturn = useRef<HTMLElement | null>(null);
  const quickReturn = useRef<HTMLElement | null>(null);
  const upgradeReturn = useRef<HTMLElement | null>(null);
  const navigatingUpgrade = useRef(false);
  const completedQuickUpgrade = useRef(false);
  const [localNotice, setLocalNotice] = useState(0);
  const [menuBounds, setMenuBounds] = useState({ top: 144, bottom: 88, left: 12, right: 12 });
  const worldElement = useRef<HTMLElement>(null);
  const economicJourney = useMemo(() => economySceneJourney(economy.snapshot), [economy.snapshot]);
  const economicProduction = useMemo(() => economySceneProduction(economy.snapshot), [economy.snapshot]);
  const renderedState = useMemo(() => economyWorldState(world.snapshot?.state, economy.snapshot), [world.snapshot?.state, economy.snapshot]);
  const topHud = useRef<HTMLElement>(null), bottomHud = useRef<HTMLDivElement>(null);
  const hasWorld = Boolean(world.snapshot);
  useEffect(() => {
    if (!hasWorld) return;
    const measure = () => {
      const top = topHud.current, bottom = bottomHud.current;
      if (!top || !bottom) return;
      // Match camera insets; entrance transforms must not change layout bounds.
      const padding = getComputedStyle(top);
      const next = { top: top.offsetHeight, bottom: bottom.offsetHeight, left: Math.max(12, parseFloat(padding.paddingLeft) || 0), right: Math.max(12, parseFloat(padding.paddingRight) || 0) };
      setMenuBounds(previous => previous.top === next.top && previous.bottom === next.bottom && previous.left === next.left && previous.right === next.right ? previous : next);
    };
    const observer = new ResizeObserver(measure);
    for (const element of [worldElement.current, topHud.current, bottomHud.current]) if (element) observer.observe(element);
    const frame = requestAnimationFrame(measure);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [hasWorld]);
  const clearObject = useCallback(() => { selectedId.current = null; setSelection(null); }, []);
  const closeQuick = useCallback(() => {
    setQuickMenu(null); setCharactersOpen(false);
    if (quickReturn.current?.isConnected) quickReturn.current.focus({ preventScroll: true });
  }, []);
  const openQuick = useCallback((next: QuickMenu, sector: SectorId = "forest") => {
    quickReturn.current = worldElement.current?.querySelector<HTMLElement>(`[data-world-quick="${next}"]`) ?? null;
    if (next === "expeditions") setExpeditionSector(sector);
    clearObject(); setPanel(null); setCharactersOpen(false); setQuickMenu(next);
  }, [clearObject]);
  const openResident = useCallback(() => {
    residentReturn.current = quickMenu ? quickReturn.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    leavingResident.current = false;
    setResidentFromCharacters(false);
    clearObject(); setPanel(null); setQuickMenu(null); setResidentOpen(true);
  }, [clearObject, quickMenu]);
  const closeResident = useCallback(() => {
    setResidentOpen(false);
    if (residentFromCharacters) setCharactersOpen(true);
  }, [residentFromCharacters]);
  const openCharacterResident = (id: "plesk") => {
    if (id !== "plesk") return;
    leavingCharacters.current = true; setCharactersOpen(false);
    openResident(); setResidentFromCharacters(true);
  };
  const openCharacters = () => {
    leavingCharacters.current = false; clearObject(); setPanel(null); setQuickMenu(null); setCharactersOpen(true);
  };
  const closeCharacters = () => { setCharactersOpen(false); setQuickMenu("more"); };
  const leaveResident = (next: () => void) => {
    leavingResident.current = true; setResidentFromCharacters(false); setResidentOpen(false); next();
  };
  const toggleQuick = (next: QuickMenu) => { if (quickMenu === next) closeQuick(); else openQuick(next); };
  useEffect(() => {
    if (!quickMenu) return;
    const outside = (event: PointerEvent) => {
      if (quickUpgrade || !(event.target instanceof Element) || quickFrame.current?.contains(event.target)
        || event.target.closest("[data-world-quick]")) return;
      setQuickMenu(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [quickMenu, quickUpgrade]);
  useEffect(() => { if (quickMenu) quickFrame.current?.focus({ preventScroll: true }); }, [quickMenu]);
  const restoreObjectFocus = useCallback(() => {
    if (objectReturn.current?.isConnected) objectReturn.current.focus({ preventScroll: true });
    else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="profile"]')?.focus({ preventScroll: true });
  }, []);
  const closeObject = useCallback(() => {
    clearObject();
    restoreObjectFocus();
  }, [clearObject, restoreObjectFocus]);
  useEffect(() => {
    if (!escapeHandlerRef) return;
    // Radix handles Escape in document capture, before a popover's own key handler.
    escapeHandlerRef.current = () => {
      if (quickMenu) { closeQuick(); return true; }
      if (selection) { closeObject(); return true; }
      return false;
    };
    return () => { escapeHandlerRef.current = null; };
  }, [escapeHandlerRef, quickMenu, selection, closeObject, closeQuick]);
  const onObjectSelection = useCallback((next: MapObjectSelection | null) => {
    if (next === null) { selectedId.current = null; setSelection(null); }
    else if (selectedId.current === next.objectId) setSelection(next);
  }, []);
  const openObject = useCallback((place: WorldPlace, stationId?: string) => {
    if (stationId === "warehouse") { openQuick("pantry"); return; }
    requestedStation.current = stationId;
    requestedObjectReturn.current = quickMenu ? quickReturn.current : panel ? panelReturn.current : selectedId.current ? objectReturn.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPanel(null); setQuickMenu(null);
    setOpenObjectRequest(previous => ({ id: (previous?.id ?? 0) + 1, place }));
  }, [openQuick, quickMenu, panel]);
  const claim = useRef<{ id: string; owner: string } | null>(null);
  useEffect(() => {
    const pending = claim.current;
    if (!pending || world.busy || world.uncertain || !world.snapshot) return;
    if (pending.owner !== ownerPublicId || world.error) { claim.current = null; return; }
    if (!world.snapshot.state.journeys.some(journey => journey.id === pending.id)) {
      claim.current = null;
      const close = setTimeout(() => setPanel(null), 0);
      return () => clearTimeout(close);
    }
  }, [world.snapshot, world.busy, world.uncertain, world.error, ownerPublicId]);
  const confirming = (id: string) => { claim.current = { id, owner: ownerPublicId }; };
  const openPanel = useCallback((next: Panel) => {
    if (!WORLD_PRESENTATION.streakDecor && next === "customize") return;
    if (panel === null) panelReturn.current = quickMenu ? quickReturn.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    clearObject(); setQuickMenu(null);
    setPanel(next);
  }, [panel, quickMenu, clearObject]);
  const openEconomy = useCallback((tab: EconomyTab, focusId?: string) => {
    if (tab === "exploration") { openQuick("expeditions"); return; }
    if (tab === "inventory") { openQuick("pantry"); return; }
    if (tab === "overview") { openQuick("profile"); return; }
    if (tab === "buildings" || tab === "production") {
      const station = focusId ?? "home", place = worldPlaceForStation(station);
      if (place) openObject(place, station);
      return;
    }
    setEconomyTab(tab); setEconomyFocusId(focusId); openPanel("economy");
  }, [openPanel, openObject, openQuick]);
  const onPlace = useCallback((place: WorldPlace, object?: MapObjectSelection) => {
    if (object) {
      if (requestedObjectReturn.current) { objectReturn.current = requestedObjectReturn.current; requestedObjectReturn.current = null; }
      else if (!selectedId.current) objectReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      selectedId.current = object.objectId; setObjectStation(requestedStation.current); requestedStation.current = undefined; setSelection(object); setPanel(null); setQuickMenu(null);
      return;
    }
    if (place === "journeys") { openPanel("journeys"); return; }
    if (["cave", "fishing", "river", "trail"].includes(place)) { openEconomy("exploration"); return; }
    if (place === "wardrobe") openPanel("wardrobe");
    else {
      const destination = economyBuildingDestination(place === "house" ? "home" : place, economy.snapshot);
      openEconomy(destination.tab, destination.focusId);
    }
  }, [openPanel, openEconomy, economy.snapshot]);
  const openStation = (stationId: string) => {
    const place = worldPlaceForStation(stationId);
    if (place) openObject(place, stationId);
  };
  const openUpgrade = (stationId: string) => {
    upgradeReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    navigatingUpgrade.current = false;
    setQuickUpgrade(stationId);
  };
  const leaveUpgrade = (next: () => void) => {
    navigatingUpgrade.current = true; setQuickUpgrade(null); next();
  };
  const { snapshot, busy, uncertain, act } = world;
  if (!snapshot) return <section className={styles.loading} aria-live="polite"><button id="world-exit" onClick={onClose}><ArrowLeft size={18} />Назад</button><Compass size={32} /><h1>Лес Мохлика</h1>
    <p>{world.error ?? "Открываем вашу полянку…"}</p>{world.error && <button onClick={() => void world.retry()}>Попробовать ещё раз</button>}</section>;
  const state = renderedState ?? snapshot.state;
  const expeditionReady = Boolean(economicJourney && economy.now >= Date.parse(economicJourney.finishesAt));
  const locked = busy || uncertain;
  const ownedGifts = new Set([...snapshot.gifts, ...(items ?? []), ...naturalItems(bestStreakDays)]);
  const quickTitle = quickMenu === "profile" ? "Мой Мохлик" : quickMenu === "pantry" ? "Кладовая" : quickMenu === "expeditions" ? "Вылазки" : "Ещё";
  const QuickIcon = quickMenu === "profile" ? Leaf : quickMenu === "pantry" ? Package : quickMenu === "expeditions" ? Compass : MoreHorizontal;
  const SheetIcon = panel === "help" ? Info : panel === "economy" ? Store : panel === "wardrobe" ? Shirt : panel === "collection" ? BookOpen : panel === "customize" ? Leaf : Compass;
  return <section ref={worldElement} className={styles.world} aria-label="Лес Мохлика" data-quick-open={quickMenu ?? undefined} style={{ "--quick-top": `${menuBounds.top + 6}px`, "--quick-bottom": `${menuBounds.bottom + 6}px` } as CSSProperties}>
    <WorldScene economyJourney={economicJourney} cancelledExplorations={economy.cancelledExplorations} economyBuildings={economy.snapshot?.buildings} economyProduction={economicProduction} state={state} gifts={snapshot.gifts} items={items} owner={ownerPublicId} now={economy.snapshot ? economy.now : world.now} timeZone={timeZone}
      hideJourneyStatus hideMapControls={quickMenu !== null || selection !== null || residentOpen || charactersOpen} onPlace={onPlace} onResident={openResident} selectedObjectId={selection?.objectId ?? null} onObjectSelection={onObjectSelection} openObjectRequest={openObjectRequest}
      constructionEconomy={economy} hideConstructionStatus={quickMenu !== null || panel !== null || selection !== null || quickUpgrade !== null || residentOpen || charactersOpen}
      onOpenConstruction={stationId => { clearObject(); setPanel(null); setQuickMenu(null); openUpgrade(stationId); }}
      bestStreakDays={bestStreakDays} wakeSignal={wakeSignal + localNotice} topHud={topHud} bottomHud={bottomHud} />
    {WorldDevPanel && <WorldDevPanel world={world} economy={economy} worldView active={panel === null && quickMenu === null && quickUpgrade === null && !residentOpen && !charactersOpen}
      presenceKey={`zhiv:mochlik:presence:${ownerPublicId}`}
      onOpenObject={openObject} onOpenWardrobe={() => openPanel("wardrobe")} onOpenCollection={() => openPanel("collection")} />}
    <header ref={topHud} className={hudStyles.hud}>
      <div className={hudStyles.headerRow}>
        <div className={hudStyles.leftControls}>
          <button id="world-exit" className={hudStyles.iconButton} onClick={onClose} aria-label="Вернуться к отметке Я живой"><ArrowLeft size={19} /></button>
          <button className={hudStyles.level} data-world-quick="profile" aria-haspopup="dialog" aria-expanded={quickMenu === "profile"} aria-controls={quickMenu === "profile" ? "world-quick-menu" : undefined}
            onClick={() => toggleQuick("profile")} aria-label={`Профиль Мохлика. ${displayName}, уровень ${level}`}>
            <GameLevelIcon level={level} size={21} /><span><small>Уровень</small><strong>{level}</strong></span>
          </button>
        </div>
        <div className={hudStyles.rightControls}>
          {economy.snapshot ? <WorldWallet key={ownerPublicId} {...economy.snapshot.wallet} /> : <button className={hudStyles.loadingWallet} onClick={() => void economy.retry()} disabled={economy.busy || economy.retryAt > economy.now}>{economy.error ? "Повторить загрузку" : "Загрузка…"}</button>}
          <button className={`${hudStyles.iconButton} ${hudStyles.helpButton}`} onClick={() => openPanel("help")} aria-label="Справка по игре" title="Справка по игре"><Info size={20} aria-hidden="true" /></button>
        </div>
      </div>
      <WorldInventoryGains key={ownerPublicId} economy={economy} hud={topHud} />
    </header>
    {panel === null && quickMenu === null && <WorldFeedback world={world} />}
    {panel === null && selection && <div className={styles.objectLayer}><WorldObjectMenu key={`${selection.objectId}:${objectStation ?? ""}`} initialStationId={objectStation} selection={selection} economy={economy} bounds={menuBounds} onClose={closeObject} onReturnFocus={restoreObjectFocus} onNavigate={openObject} onOpenPantry={() => openQuick("pantry")} onExplore={() => openQuick("expeditions")} /></div>}
    <div ref={bottomHud} className={hudStyles.bottomHud}>
      <nav className={hudStyles.dock} aria-label="Действия в игре">
        <button data-world-quick="pantry" aria-haspopup="dialog" aria-expanded={quickMenu === "pantry"} aria-controls={quickMenu === "pantry" ? "world-quick-menu" : undefined}
          aria-label={economy.snapshot ? `Кладовая: занято ${economy.snapshot.storage.used + economy.snapshot.storage.reserved} из ${economy.snapshot.storage.capacity} мест` : "Открыть кладовую"}
          data-full={economy.snapshot && economy.snapshot.storage.available <= 0 || undefined} onClick={() => toggleQuick("pantry")}>
          <Package size={18} aria-hidden="true" /><span>Кладовая</span>
        </button>
        <button data-world-quick="expeditions" data-expedition-ready={expeditionReady || undefined} aria-haspopup="dialog" aria-expanded={quickMenu === "expeditions"} aria-controls={quickMenu === "expeditions" ? "world-quick-menu" : undefined} onClick={() => toggleQuick("expeditions")}
          aria-label={expeditionReady ? "В путь. Вылазка завершена — забрать находки" : economicJourney ? "В путь. Мохлик в пути" : "В путь"}>
          <span className={hudStyles.expeditionIcon}><Compass size={18} aria-hidden="true" />{expeditionReady && <span className={hudStyles.expeditionCheck}><Check size={9} aria-hidden="true" /></span>}</span>
          <span className={hudStyles.expeditionLabel}>В путь{expeditionReady && <small>Находки ждут</small>}</span>{economicJourney && !expeditionReady && <span className={hudStyles.journeyDot} aria-hidden="true" />}
        </button>
        <button data-world-quick="more" aria-haspopup="dialog" aria-expanded={quickMenu === "more"} aria-controls={quickMenu === "more" ? "world-quick-menu" : undefined} onClick={() => toggleQuick("more")}><MoreHorizontal size={19} aria-hidden="true" /><span>Ещё</span></button>
      </nav>
    </div>
    {quickMenu && <section ref={quickFrame} id="world-quick-menu" className={`${hudStyles.quickMenu} ${styles.quickMenu}`} data-kind={quickMenu} role="dialog" aria-modal="false" aria-labelledby="world-quick-title" tabIndex={-1}
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeQuick(); } }}>
      <header className={`${hudStyles.quickHeader} ${styles.quickHeader}`}><h2 id="world-quick-title"><QuickIcon size={17} aria-hidden="true" />{quickTitle}</h2><button type="button" aria-label={`Закрыть: ${quickTitle}`} onClick={closeQuick}><X size={18} aria-hidden="true" /></button></header>
      <div className={`${hudStyles.quickBody} ${styles.quickBody}`}>
        {quickMenu === "profile" && <WorldProfileMenu world={world} economy={economy} presenceKey={`zhiv:mochlik:presence:${ownerPublicId}`} displayName={displayName} level={level} bestStreakDays={bestStreakDays} onCall={() => { setLocalNotice(value => value + 1); closeQuick(); }} />}
        {quickMenu === "pantry" && <WorldPantryMenu economy={economy} onUpgrade={() => openUpgrade("warehouse")} onExplore={() => openQuick("expeditions")} onOpenMarket={() => openEconomy("market")} onOpenFishingShop={openResident} />}
        {quickMenu === "expeditions" && <WorldExpeditionsMenu key={expeditionSector} initialSector={expeditionSector} economy={economy} onOpenPantry={() => openQuick("pantry")} onNavigateStation={openStation} onOpenFishingShop={openResident} />}
        {quickMenu === "more" && <div className={`${hudStyles.moreActions} ${styles.moreActions}`}>
          <button type="button" data-world-characters-trigger aria-haspopup="dialog" onClick={openCharacters}><PawPrint size={18} aria-hidden="true" /><span className={styles.moreLabel}>Персонажи<small>Жители леса</small></span></button>
          <button type="button" aria-haspopup="dialog" onClick={() => openEconomy("market")}><Store size={18} aria-hidden="true" /><span className={styles.moreLabel}>Рынок<small>Покупки и свой прилавок</small></span></button>
          <button type="button" aria-haspopup="dialog" onClick={() => openPanel("wardrobe")}><Shirt size={18} aria-hidden="true" /><span className={styles.moreLabel}>Гардероб<small>Одежда и оттенки мха</small></span></button>
          <button type="button" aria-haspopup="dialog" onClick={() => openPanel("collection")}><BookOpen size={18} aria-hidden="true" /><span className={styles.moreLabel}>Коллекции<small>Книга личных находок</small></span></button>
          {state.journeys.length > 0 && <button type="button" aria-haspopup="dialog" onClick={() => openPanel("journeys")}><Compass size={18} aria-hidden="true" /><span className={styles.moreLabel}>Старые походы<small>Забрать прежние награды</small></span></button>}
        </div>}
      </div>
    </section>}
    <WorldCharacters open={charactersOpen} onClose={closeCharacters} onResident={openCharacterResident}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (leavingCharacters.current) { leavingCharacters.current = false; return; }
        worldElement.current?.querySelector<HTMLElement>('[data-world-characters-trigger]')?.focus({ preventScroll: true });
      }} />
    <WorldResidentDialog open={residentOpen} economy={economy} onClose={closeResident} onBack={residentFromCharacters ? closeResident : undefined}
      onFishing={() => leaveResident(() => openQuick("expeditions", "shore"))}
      onOpenPantry={() => leaveResident(() => openQuick("pantry"))}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (leavingResident.current) { leavingResident.current = false; quickFrame.current?.focus({ preventScroll: true }); return; }
        if (residentFromCharacters) {
          setResidentFromCharacters(false);
          // The gallery lives in a portal; its own open autofocus restores the card.
          return;
        }
        if (residentReturn.current?.isConnected) residentReturn.current.focus({ preventScroll: true });
        else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="more"]')?.focus({ preventScroll: true });
      }} />
    <WorldUpgradeDialog stationId={quickUpgrade} economy={economy} onClose={() => setQuickUpgrade(null)}
      onCompleted={() => { completedQuickUpgrade.current = true; setQuickUpgrade(null); closeQuick(); }}
      navigation={{ canOpen: id => Boolean(worldPlaceForStation(id)), open: id => leaveUpgrade(() => openStation(id)), explore: () => leaveUpgrade(() => openQuick("expeditions")) }}
      onOpenPantry={() => leaveUpgrade(() => openQuick("pantry"))}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (completedQuickUpgrade.current) {
          completedQuickUpgrade.current = false;
          if (quickReturn.current?.isConnected) quickReturn.current.focus({ preventScroll: true });
          else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="profile"]')?.focus({ preventScroll: true });
          return;
        }
        if (navigatingUpgrade.current) { navigatingUpgrade.current = false; return; }
        const target = upgradeReturn.current?.dataset.constructionTarget;
        const trigger = target ? worldElement.current?.querySelector<HTMLElement>(`[data-construction-target="${target}"]`) : upgradeReturn.current;
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        else if (quickFrame.current) quickFrame.current.focus({ preventScroll: true });
        else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="profile"]')?.focus({ preventScroll: true });
      }} />
    <Dialog open={panel !== null} onOpenChange={open => { if (!open) setPanel(null); }}>
      <DialogPortal>
      <DialogOverlay className={styles.sheetScrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={styles.sheet} data-market={panel === "economy" && economyTab === "market" || undefined} data-book={panel === "collection" || undefined}
        onCloseAutoFocus={event => { event.preventDefault(); if (quickMenu) quickFrame.current?.focus({ preventScroll: true }); else if (selectedId.current) worldElement.current?.querySelector<HTMLElement>('[role="dialog"][data-place]')?.focus({ preventScroll: true }); else if (panelReturn.current?.isConnected) panelReturn.current.focus(); else document.getElementById("world-exit")?.focus(); }}>
        <div className={styles.sheetHeader}>
          <DialogTitle><SheetIcon size={20} aria-hidden="true" />{panel === "help" ? "Справка по игре" : panel === "economy" ? "Лесной рынок" : panel === "customize" ? "Украшения" : panel === "wardrobe" ? "Гардероб" : panel === "collection" ? "Книга находок" : "Путешествия"}</DialogTitle>
          <button type="button" onClick={() => setPanel(null)} aria-label="Закрыть панель"><X size={21} aria-hidden="true" /></button>
        </div>
        <DialogDescription className={styles.sr}>{panel === "help" ? "Правила игры, управление картой и ответы на частые вопросы. Найдите тему через поиск или раскройте нужный раздел." : "Управление домом и путешествиями Мохлика"}</DialogDescription>
        <div className={styles.sheetBody}>
          {panel === "help" && <WorldHelp />}
          {panel === "economy" && <EconomyPanel key={`${economyTab}:${economyFocusId ?? ""}`} economy={economy} initialTab={economyTab} initialFocusId={economyFocusId} standalone onNavigate={openEconomy} />}
          {WORLD_PRESENTATION.streakDecor && panel === "customize" && <div className={styles.panel}>
            <div className={styles.panelHeading}><span className={styles.eyebrow}>ДОМИК ПО ТВОЕМУ ВКУСУ</span><p>Выбирай, что оставить у дома. Подарки сохраняются, даже когда выключены.</p></div>
            {GAME_ITEMS.map(item => {
              const owned = ownedGifts.has(item.id), enabled = owned && !(state.hiddenGifts ?? []).includes(item.id);
              return <article className={styles.decoration} key={item.id} data-owned={owned}>
                <DecorationPreview item={item.id} />
                <div><h3>{item.title}</h3><p>{owned ? item.id === "leaf_garland" ? "Мягкие огоньки среди листьев" : enabled ? "Украшает домик" : "Хранится в коллекции" : `${formatDayCount(item.days)} отметок подряд`}</p></div>
                <button className={styles.decorationSwitch} role="switch" aria-checked={enabled} aria-label={item.title} disabled={!owned || locked}
                  onClick={() => act("set_decoration", `${enabled ? "hide" : "show"}_${item.id}`)}><span /></button>
              </article>;
            })}
          </div>}
          {panel === "journeys" && <WorldJourneys world={world} destination="trail" onClaim={confirming} allowStart={false} />}
        {panel === "wardrobe" && <div className={styles.panel}><div className={styles.panelHeading}><span className={styles.eyebrow}>ХАРАКТЕР В ДЕТАЛЯХ</span><p>Выбери одежду и оттенок мха для своего Мохлика.</p></div>
          <div className={styles.wardrobe}>{catalog.items.map(item => {
            const owned = state.inventory.includes(item.id), equipped = Object.values(state.equipment).includes(item.id);
            return <article key={item.id} className={styles.item} data-owned={owned} data-equipped={equipped || undefined}><span className={styles.itemSwatch} style={{ background: `${item.color}26` }}><ItemIcon itemId={item.id} size={38} /></span>
              <div><h3>{item.name}</h3><p>{item.slot === "palette" ? "Цвет мха" : item.slot === "head" ? "Головной убор" : item.slot === "rod" ? "Снаряжение для рыбалки" : "Шарф"}</p></div>
              {owned ? <button disabled={locked || equipped && item.slot === "palette"} onClick={() => act("equip", equipped ? `remove_${item.slot}` : item.id)}>{equipped ? item.slot === "palette" ? "Выбран" : item.slot === "rod" ? "Убрать" : "Снять" : item.slot === "rod" ? "Взять" : "Надеть"}</button>
                : item.id === "explorer_cap" || item.id === "willow_rod" ? <span className={styles.kicker}><LockKeyhole size={13} />Награда прежних путешествий</span>
                  : <span className={styles.kicker}>Новые рецепты появятся позже</span>}
            </article>;
          })}</div>
        </div>}
        {panel === "collection" && <WorldCollections state={state} economy={economy.snapshot} gifts={snapshot.gifts} />}

          <WorldFeedback world={world} />
        </div>
      </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  </section>;
}
