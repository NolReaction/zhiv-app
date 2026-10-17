"use client";
import { WorldDevEntry } from "./dev/world-dev-entry";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ArrowLeft, BookOpen, BookOpenCheck, Check, Compass, X, Info, Leaf, MoreHorizontal, Package, PawPrint, Pin, Shirt, ShoppingBag, Store } from "lucide-react";
import { GAME_ITEMS, naturalItems } from "@/features/game/game-rewards";
import { DecorationPreview } from "@/features/world/ui/collections/decoration-preview";
import { formatDayCount } from "@/lib/daily-streak";
import type { WorldPortalProps } from "./world-portal";
import { worldNotificationDestination } from "./notification-destination";
import { GameLevelIcon } from "@/features/game/game-level-icon";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { WorldScene } from "@/features/world/scene/world-scene";
import { WorldCollections } from "@/features/world/ui/collections/world-collections";
import { WorldWardrobe } from "@/features/world/ui/wardrobe/world-wardrobe";
import type { MapObjectSelection, WorldPlace } from "@/features/world/scene/map-engine";
import styles from "./world.module.css";
import { WorldJourneys } from "@/features/world/ui/journeys/world-journeys";
import { WorldFeedback } from "@/features/world/ui/feedback/world-feedback";
import { EconomyPanel, type EconomyTab } from "@/features/economy/ui/economy-panel";
import { economyMarketUnlocked } from "@/features/economy/domain/market-rules";
import { economyBuildingDestination, economySceneJourney, economySceneProduction, economySceneConstruction, economySceneResidents, economyWorldState } from "@/features/economy/integration/world-adapter";
import { TILED_WORLD, WORLD_PRESENTATION } from "@/features/world/scene/presentation";
import { interactiveMapObjects } from "@/features/world/scene/site-interactions";
import { WorldHelp } from "@/features/world/ui/help/world-help";
import type { WorldHelpContext, WorldHelpTarget } from "@/features/world/ui/help/world-help-types";
import { WorldProfileMenu, type WorldProfileDestination } from "@/features/world/ui/profile/world-profile-menu";
import { ForestSessionNotice } from "@/features/world/ui/feedback/forest-session-notice";
import { WorldOrderJournal } from "@/features/economy/ui/orders/world-order-journal";
import { orderJournalSummary } from "@/features/economy/ui/orders/order-journal-summary";
import { WorldPantryMenu } from "@/features/economy/ui/inventory/world-pantry-menu";
import { WorldPantryUpgrade } from "@/features/economy/ui/inventory/world-pantry-upgrade";
import { WorldExpeditionsMenu, type SectorId } from "@/features/economy/ui/expeditions/world-expeditions-menu";
import { WorldUpgradeDialog } from "@/features/economy/ui/construction/world-upgrade-dialog";
import { worldPlaceForStation, worldStations } from "@/features/economy/ui/shared/world-stations";
import { WorldWallet } from "@/features/world/ui/hud/world-wallet";
import { WorldInventoryGains } from "@/features/world/ui/feedback/world-inventory-gains";
import hudStyles from "./world-map-hud.module.css";
import { WorldObjectMenu } from "@/features/economy/ui/stations/world-object-menu";
import { WorldResidentDialog } from "@/features/world/ui/characters/world-resident-dialog";
import { WorldBuilderDialog } from "@/features/world/ui/characters/world-builder-dialog";
import { worldResidentAvailable, type WorldCharacterId, type WorldResidentId } from "@/features/world/characters/world-characters-model";
import { WorldVillagerDialog, type NewVillagerId } from "@/features/world/ui/characters/world-villager-dialog";
import { useLeaftailArrival } from "@/features/world/state/use-leaftail-arrival";
import { LeaftailArrivalOnboarding } from "@/features/world/ui/onboarding/leaftail-arrival-onboarding";
import { useMinerArrival } from "@/features/world/state/use-miner-arrival";
import { MinerArrivalOnboarding } from "@/features/world/ui/onboarding/miner-arrival-onboarding";
import { WorldCharacters } from "@/features/world/ui/characters/world-characters";
import { DailyRewardsButton, DailyRewardsDialog } from "@/features/game/daily-rewards";
import { CurrencyShopPanel, type CurrencyShopPage } from "@/features/economy/ui/market/currency-shop-panel";
import { useConstructionGoal } from "@/features/economy/ui/construction/use-construction-goal";
import { ConstructionGoalSummary } from "@/features/economy/ui/construction/construction-goal-summary";
import { SectionGuide } from "@/features/onboarding/section-guide";
import { pauseFocusedGuide } from "@/features/onboarding/guide-keyboard";
import { useForestObservation } from "@/features/world/state/use-forest-observation";
import { useWorldOnboarding } from "@/features/world/state/use-world-onboarding";
import { worldOnboardingNeedsHarvest } from "@/features/world/domain/world-onboarding";
import { tutorialOrderProgress, tutorialResidentOrder } from "@/features/economy/domain/tutorial-order";
import { useWorldRewardPromptGate } from "@/features/world/state/onboarding-reward-gate";
import { WorldOnboardingSession } from "@/features/world/ui/onboarding/world-onboarding";
import { WorldOnboardingReward } from "@/features/world/ui/onboarding/world-onboarding-reward";
import { useMarketUnlockOnboarding } from "@/features/world/state/use-market-unlock-onboarding";
import { MarketUnlockOnboarding } from "@/features/world/ui/onboarding/market-unlock-onboarding";

type Panel = "journeys" | "economy" | "customize" | "wardrobe" | "collection" | "help" | "shop" | "orders";
type QuickMenu = "profile" | "pantry" | "expeditions" | "more";
const WorldDevPanel = process.env.NODE_ENV === "development"
  ? WorldDevEntry : null;
export default function WorldView({ open, suspended = false, world, economy, ownerPublicId, timeZone, onClose, displayName, level, wakeSignal, bestStreakDays, items, isOnline, onSessionLost, friends, onOpenPeople, onSceneReady, sceneReady, notificationEntry, onNotificationHandled, escapeHandlerRef }: WorldPortalProps & { escapeHandlerRef?: RefObject<(() => boolean) | null> }) {
  const currentOwner = useRef(ownerPublicId);
  useLayoutEffect(() => { currentOwner.current = ownerPublicId; }, [ownerPublicId]);
  const constructionGoal = useConstructionGoal(ownerPublicId, economy.snapshot);
  const onboarding = useWorldOnboarding(ownerPublicId);
  const observation = useForestObservation(`zhiv:mochlik:presence:${ownerPublicId}`);
  const sectionsReady = Boolean(open && economy.snapshot && onboarding.loaded && observation?.memory.sync?.mode !== "other-device");
  const mainCourseActive = onboarding.loaded && !onboarding.isPaused && (!onboarding.progress || onboarding.progress.status === "started");
  const [panel, setPanel] = useState<Panel | null>(null);
  const [shopPage, setShopPage] = useState<CurrencyShopPage>("pearls");
  const [economyTab, setEconomyTab] = useState<EconomyTab>("overview");
  const [economyFocusId, setEconomyFocusId] = useState<string | undefined>();
  const [selection, setSelection] = useState<MapObjectSelection | null>(null);
  const [objectOpenRequest, setObjectOpenRequest] = useState(0);
  const selectedId = useRef<string | null>(null);
  const requestedStation = useRef<string | undefined>(undefined);
  const [objectStation, setObjectStation] = useState<string | undefined>();
  const requestedRecipe = useRef<string | undefined>(undefined);
  const [objectRecipe, setObjectRecipe] = useState<string | undefined>();
  const objectReturn = useRef<HTMLElement | null>(null);
  const requestedObjectReturn = useRef<HTMLElement | null>(null);
  const [openObjectRequest, setOpenObjectRequest] = useState<{ id: number; place: WorldPlace }>();
  const objectRequestSequence = useRef(0);
  const [quickMenu, setQuickMenu] = useState<QuickMenu | null>(null);
  const [pantryFishSale, setPantryFishSale] = useState<{ owner: string; open: boolean } | null>(null);
  const pantryFishSaleOpen = quickMenu === "pantry" && pantryFishSale?.owner === ownerPublicId && pantryFishSale.open;
  const onFishSaleOpenChange = useCallback((value: boolean) => {
    setPantryFishSale(previous => value ? previous?.owner === ownerPublicId && previous.open ? previous : { owner: ownerPublicId, open: true }
      : previous?.owner === ownerPublicId ? null : previous);
  }, [ownerPublicId]);
  const [orderEntry, setOrderEntry] = useState<{ residentId?: "plesk" | "builder"; request: number }>({ request: 0 });
  const [helpEntry, setHelpEntry] = useState<{ context?: WorldHelpContext; topicId?: string; request: number }>({ request: 0 });
  const [profileEntry, setProfileEntry] = useState<{ tab: WorldProfileDestination; request: number }>({ tab: "profile", request: 0 });
  const lastHelpContext = useRef<WorldHelpContext | undefined>(undefined);
  const rememberHelpContext = useCallback((context: WorldHelpContext) => { lastHelpContext.current = context; }, []);
  const navigatingHelp = useRef(false);
  const [charactersOpen, setCharactersOpen] = useState(false);
  const [focusedCharacter, setFocusedCharacter] = useState<WorldCharacterId>("plesk");
  const [shopGalleryOwner, setShopGalleryOwner] = useState<string | null>(null);
  const [dailyOpen, setDailyOpen] = useState(false);
  const [giftPantryOwner, setGiftPantryOwner] = useState<string | null>(null);
  const leavingDaily = useRef(false);
  const dailyTrigger = useRef<HTMLButtonElement | null>(null);
  const leavingCharacters = useRef(false);
  const [expeditionSector, setExpeditionSector] = useState<SectorId>("forest");
  const [expeditionOpenRequest, setExpeditionOpenRequest] = useState(0);
  const [residentOpen, setResidentOpen] = useState(false);
  const [residentId, setResidentId] = useState<WorldResidentId>("plesk");
  const [residentFromCharacters, setResidentFromCharacters] = useState(false);
  const [residentOwner, setResidentOwner] = useState(ownerPublicId);
  const residentReturn = useRef<HTMLElement | null>(null);
  const leavingResident = useRef(false);
  const [quickUpgrade, setQuickUpgrade] = useState<string | null>(null);
  const quickFrame = useRef<HTMLElement>(null);
  const panelRoot = useRef<HTMLDivElement>(null), pleskGuideRoot = useRef<HTMLDivElement>(null), builderGuideRoot = useRef<HTMLDivElement>(null);
  const workshopGuideRoot = useRef<HTMLElement>(null);
  const panelReturn = useRef<HTMLElement | null>(null);
  const panelReturnOwner = useRef(ownerPublicId);
  const panelReturnKind = useRef<Panel | null>(null);
  const quickReturn = useRef<HTMLElement | null>(null);
  const upgradeReturn = useRef<HTMLElement | null>(null);
  const upgradeReturnOwner = useRef(ownerPublicId);
  const navigatingUpgrade = useRef(false);
  const openingPinnedGoal = useRef(false);
  const completedQuickUpgrade = useRef(false);
  const [localNotice, setLocalNotice] = useState(0);
  const [menuBounds, setMenuBounds] = useState({ top: 144, bottom: 88, left: 12, right: 12 });
  const worldElement = useRef<HTMLElement>(null);
  const playerMarketUnlocked = Boolean(economy.snapshotConfirmed && economy.snapshot?.ownerPublicId === ownerPublicId
    && economyMarketUnlocked(economy.snapshot, economy.snapshot.catalog));
  const marketGuide = useMarketUnlockOnboarding(ownerPublicId, {
    unlocked: playerMarketUnlocked,
    enabled: Boolean(open && !suspended && world.snapshot && !panel && !quickMenu && !selection && !quickUpgrade
      && !residentOpen && !charactersOpen && !dailyOpen && !economy.busy && !economy.uncertain
      && observation?.memory.sync?.mode !== "other-device"),
    onboarding,
  });
  const { open: marketGuideOpen, complete: completeMarketGuide } = marketGuide;
  const quarryBuilt = Boolean(economy.snapshotConfirmed && economy.snapshot?.ownerPublicId === ownerPublicId
    && (economy.snapshot.buildings.quarry ?? 0) >= 1);
  const minerArrival = useMinerArrival(ownerPublicId, {
    unlocked: quarryBuilt,
    enabled: Boolean(open && !suspended && world.snapshot && !panel && !quickMenu && !selection && !quickUpgrade
      && !residentOpen && !charactersOpen && !dailyOpen && !marketGuide.open && !economy.busy && !economy.uncertain
      && !world.busy && !world.uncertain && observation?.memory.sync?.mode !== "other-device"),
    onboarding,
  });
  const merchantUnlocked = Boolean(economy.snapshotConfirmed && economy.snapshot?.ownerPublicId === ownerPublicId
    && (economy.snapshot.buildings.home ?? 0) >= 3);
  const merchantArrival = useLeaftailArrival(ownerPublicId, {
    unlocked: merchantUnlocked,
    enabled: Boolean(open && !suspended && world.snapshot && !panel && !quickMenu && !selection && !quickUpgrade
      && !residentOpen && !charactersOpen && !dailyOpen && !marketGuide.open && !minerArrival.open && !minerArrival.enabled
      && !economy.busy && !economy.uncertain && !world.busy && !world.uncertain
      && observation?.memory.sync?.mode !== "other-device"),
    onboarding,
  });
  const leaftailAvailable = Boolean(merchantUnlocked && merchantArrival.loaded && merchantArrival.seen);
  const dailyAutoPromptAllowed = useWorldRewardPromptGate(ownerPublicId, onboarding,
    Boolean(!open || panel || quickMenu || selection || quickUpgrade || residentOpen || charactersOpen
      || marketGuide.open || minerArrival.open || minerArrival.enabled || merchantArrival.open || merchantArrival.enabled || economy.busy || economy.uncertain || world.busy || world.uncertain), worldElement);
  const replayOnboarding = () => {
    navigatingHelp.current = panel === "help";
    setPanel(null); setQuickMenu(null); clearObject();
    if (onboarding.progress?.status === "started") onboarding.resume();
    else onboarding.replay();
  };
  const economicJourney = useMemo(() => economySceneJourney(economy.snapshot), [economy.snapshot]);
  const economicProduction = useMemo(() => economySceneProduction(economy.snapshot), [economy.snapshot]);
  const economicResidents = useMemo(() => economySceneResidents(economy.snapshot, Boolean(economy.snapshotConfirmed), ownerPublicId), [economy.snapshot, economy.snapshotConfirmed, ownerPublicId]);
  const economicConstruction = useMemo(() => economySceneConstruction(economy.snapshot), [economy.snapshot]);
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
  const clearObject = useCallback(() => { selectedId.current = null; setSelection(null); setShopGalleryOwner(null); }, []);
  const openDailyRewards = useCallback(() => {
    leavingDaily.current = false;
    setGiftPantryOwner(null);
    setDailyOpen(true);
  }, []);
  const closeQuick = useCallback(() => {
    setQuickMenu(null); setCharactersOpen(false);
    if (quickReturn.current?.isConnected) quickReturn.current.focus({ preventScroll: true });
  }, []);
  const openQuick = useCallback((next: QuickMenu, sector: SectorId = "forest", profileTab: WorldProfileDestination = "profile") => {
    quickReturn.current = worldElement.current?.querySelector<HTMLElement>(`[data-world-quick="${next}"]`) ?? null;
    if (next === "profile") setProfileEntry(value => ({ tab: profileTab, request: value.request + 1 }));
    if (next === "expeditions") { setExpeditionSector(sector); setExpeditionOpenRequest(value => value + 1); }
    clearObject(); setPanel(null); setCharactersOpen(false); setQuickMenu(next);
  }, [clearObject]);
  const openResident = useCallback((id: WorldResidentId = "plesk") => {
    if (currentOwner.current !== ownerPublicId || economy.snapshot && economy.snapshot.ownerPublicId !== ownerPublicId
      || !worldResidentAvailable(id, quarryBuilt, leaftailAvailable)) return false;
    setResidentOwner(ownerPublicId);
    residentReturn.current = quickMenu ? quickReturn.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    leavingResident.current = false;
    setResidentFromCharacters(false);
    clearObject(); setPanel(null); setQuickMenu(null); setResidentId(id); setResidentOpen(true);
    return true;
  }, [clearObject, quickMenu, economy.snapshot, ownerPublicId, quarryBuilt, leaftailAvailable]);
  const closeResident = useCallback(() => {
    if (currentOwner.current !== ownerPublicId || residentOwner !== ownerPublicId) return;
    setResidentOpen(false);
    if (residentFromCharacters) setCharactersOpen(true);
  }, [residentFromCharacters, ownerPublicId, residentOwner]);
  const openCharacterResident = (id: WorldResidentId) => {
    if (!openResident(id)) return;
    setFocusedCharacter(id);
    leavingCharacters.current = true; setCharactersOpen(false);
    setResidentFromCharacters(true);
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
      if (document.querySelector("[data-activity-gate]") || quickUpgrade || dailyOpen || !(event.target instanceof Element) || quickFrame.current?.contains(event.target)
        || event.target.closest('[data-world-quick], [data-connection-status], [data-connection-details], [data-guide-coach="world"], [data-meal-picker], [data-audio-settings], [data-audio-settings-overlay], [data-world-mood], [data-world-mood-overlay]')) return;
      const pantryPopup = quickMenu === "pantry" ? event.target.closest<HTMLElement>("[data-pantry-fish-popover]") : null;
      if (pantryPopup?.dataset.pantryFishOwner === ownerPublicId) return;
      setQuickMenu(null);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [quickMenu, quickUpgrade, dailyOpen, ownerPublicId]);
  useEffect(() => { if (quickMenu) quickFrame.current?.focus({ preventScroll: true }); }, [quickMenu]);
  const restoreObjectFocus = useCallback(() => {
    if (objectReturn.current?.isConnected) objectReturn.current.focus({ preventScroll: true });
    else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="profile"]')?.focus({ preventScroll: true });
  }, []);
  const closeObject = useCallback(() => {
    const fromGallery = selection?.place === "leaftail-caravan" && shopGalleryOwner === ownerPublicId;
    const foreignShop = shopGalleryOwner !== null && shopGalleryOwner !== ownerPublicId;
    clearObject();
    if (fromGallery) { setCharactersOpen(true); return; }
    if (!foreignShop) restoreObjectFocus();
  }, [clearObject, restoreObjectFocus, selection?.place, shopGalleryOwner, ownerPublicId]);
  useEffect(() => {
    if (!escapeHandlerRef) return;
    // Radix handles Escape in document capture, before a popover's own key handler.
    escapeHandlerRef.current = () => {
      if (document.querySelector("[data-activity-gate]")) return true;
      if (pauseFocusedGuide()) return true;
      const moodClose = document.querySelector<HTMLButtonElement>("[data-world-mood-close]");
      if (moodClose) { moodClose.click(); return true; }
      const audioClose = document.querySelector<HTMLButtonElement>("[data-audio-settings-close]");
      if (audioClose) { audioClose.click(); return true; }
      const mealClose = document.querySelector<HTMLButtonElement>("[data-meal-picker] [data-meal-picker-close]");
      if (mealClose) { mealClose.click(); return true; }
      if (dailyOpen) { setDailyOpen(false); return true; }
      if (quickMenu === "pantry") {
        const fishClose = Array.from(document.querySelectorAll<HTMLButtonElement>("[data-pantry-fish-popover] [data-pantry-fish-close]"))
          .find(button => button.closest<HTMLElement>("[data-pantry-fish-popover]")?.dataset.pantryFishOwner === ownerPublicId);
        if (fishClose) { fishClose.click(); return true; }
      }
      if (quickMenu) { closeQuick(); return true; }
      if (selection) { closeObject(); return true; }
      return false;
    };
    return () => { escapeHandlerRef.current = null; };
  }, [escapeHandlerRef, quickMenu, selection, closeObject, closeQuick, dailyOpen, ownerPublicId]);
  const onObjectSelection = useCallback((next: MapObjectSelection | null) => {
    if (next === null) { selectedId.current = null; setSelection(null); }
    else if (selectedId.current === next.objectId) setSelection(next);
  }, []);
  const openObject = useCallback((place: WorldPlace, stationId?: string, recipeId?: string, tab?: "buildings" | "production") => {
    if (currentOwner.current !== ownerPublicId || economy.snapshot && economy.snapshot.ownerPublicId !== ownerPublicId) return;
    if (stationId === "warehouse") { openQuick("pantry"); return; }
    const mine = place === "quarry" || place === "cave" || stationId === "quarry";
    const targetPlace = mine ? "quarry" : place;
    const targetStation = mine ? "quarry" : stationId ?? worldStations[targetPlace]?.stationIds[0];
    if (WORLD_PRESENTATION.rebuilding && targetStation && !interactiveMapObjects(TILED_WORLD).some(object => object.place === targetPlace)) {
      // A deferred drawing must not remove already implemented production or
      // paid jobs. Use the existing account panel without inventing a map anchor.
      const destination = economyBuildingDestination(targetStation, economy.snapshot);
      panelReturn.current = quickMenu ? quickReturn.current : panel ? panelReturn.current : selectedId.current ? objectReturn.current
        : document.activeElement instanceof HTMLElement ? document.activeElement : null;
      panelReturnOwner.current = ownerPublicId; panelReturnKind.current = "economy";
      requestedStation.current = undefined; requestedRecipe.current = undefined; requestedObjectReturn.current = null;
      clearObject(); setQuickMenu(null); setOpenObjectRequest(undefined);
      const nextTab = tab ?? destination.tab;
      setEconomyTab(nextTab); setEconomyFocusId(nextTab === "production" ? recipeId ?? targetStation : targetStation); setPanel("economy");
      return;
    }
    requestedStation.current = mine ? "quarry" : stationId;
    requestedRecipe.current = recipeId;
    requestedObjectReturn.current = quickMenu ? quickReturn.current : panel ? panelReturn.current : selectedId.current ? objectReturn.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    clearObject(); setPanel(null); setQuickMenu(null);
    setOpenObjectRequest({ id: ++objectRequestSequence.current, place: targetPlace });
  }, [openQuick, quickMenu, panel, clearObject, economy.snapshot, ownerPublicId]);
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
    if (panel === null) {
      panelReturn.current = quickMenu ? quickReturn.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
      panelReturnOwner.current = ownerPublicId;
    }
    clearObject(); setQuickMenu(null);
    panelReturnKind.current = next;
    setPanel(next);
  }, [panel, quickMenu, clearObject, ownerPublicId]);
  const openOrders = useCallback((residentId?: "plesk" | "builder", trigger?: HTMLElement) => {
    if (economy.snapshot && economy.snapshot.ownerPublicId !== ownerPublicId) return;
    const source = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setOrderEntry(value => ({ residentId, request: value.request + 1 }));
    openPanel("orders");
    panelReturn.current = source;
    panelReturnOwner.current = ownerPublicId;
  }, [economy.snapshot, ownerPublicId, openPanel]);
  const openCurrencyShop = (kind: "coins" | "pearls", trigger: HTMLButtonElement) => {
    if (economy.snapshot?.ownerPublicId !== ownerPublicId) return;
    setShopPage(kind === "coins" ? "gold" : "pearls");
    openPanel("shop");
    panelReturn.current = trigger;
    panelReturnOwner.current = ownerPublicId;
  };
  const openContextHelp = (context?: WorldHelpContext, topicId?: string) => {
    setHelpEntry(value => ({ context, topicId, request: value.request + 1 }));
    if (quickUpgrade) { navigatingUpgrade.current = true; setQuickUpgrade(null); }
    openPanel("help");
  };
  const openEconomy = useCallback((tab: EconomyTab, focusId?: string) => {
    if (tab === "exploration") { openQuick("expeditions"); return; }
    if (tab === "inventory") { openQuick("pantry"); return; }
    if (tab === "overview") { openQuick("profile"); return; }
    if (tab === "buildings" || tab === "production") {
      const recipe = economy.snapshot?.catalog.recipes.find(entry => entry.id === focusId);
      const station = recipe?.buildingId ?? focusId ?? "home", place = worldPlaceForStation(station);
      if (place) openObject(place, station, recipe?.id, tab);
      return;
    }
    setEconomyTab(tab); setEconomyFocusId(focusId); openPanel("economy");
  }, [openPanel, openObject, openQuick, economy.snapshot]);
  const onPlace = useCallback((place: WorldPlace, object?: MapObjectSelection) => {
    if (place === "plesk-shop") { openResident(); return; }
    if (place === "builder-home") { openResident("builder"); return; }
    if (place === "market") { if (marketGuideOpen) completeMarketGuide(); openEconomy("market"); return; }
    if (place === "bulletin-board") { openOrders(); return; }
    if (place === "cave" || place === "quarry" && !object) { openObject("quarry", "quarry"); return; }
    if (object) {
      if (requestedObjectReturn.current) { objectReturn.current = requestedObjectReturn.current; requestedObjectReturn.current = null; }
      else if (!selectedId.current) objectReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      selectedId.current = object.objectId; setObjectStation(requestedStation.current); requestedStation.current = undefined;
      setObjectRecipe(requestedRecipe.current); requestedRecipe.current = undefined;
      if (place !== "leaftail-caravan") setShopGalleryOwner(null);
      setSelection(object); setObjectOpenRequest(value => value + 1); setPanel(null); setQuickMenu(null);
      return;
    }
    if (place === "journeys") { openPanel("journeys"); return; }
    if (["fishing", "river", "trail"].includes(place)) { openEconomy("exploration"); return; }
    if (place === "wardrobe") openPanel("wardrobe");
    else {
      const destination = economyBuildingDestination(place === "house" ? "home" : place, economy.snapshot);
      openEconomy(destination.tab, destination.focusId);
    }
  }, [openPanel, openEconomy, openObject, openResident, openOrders, economy.snapshot, marketGuideOpen, completeMarketGuide]);
  const openStation = (stationId: string, recipeId?: string) => {
    const place = worldPlaceForStation(stationId);
    if (place) openObject(place, stationId, recipeId);
  };
  const openExpeditions = (sector: SectorId = "forest") => {
    if (sector === "caves") openStation("quarry");
    else openQuick("expeditions", sector);
  };
  const handledNotification = useRef<number | null>(null);
  useEffect(() => {
    if (!open || !sceneReady || !economy.snapshot || !notificationEntry || notificationEntry.ownerPublicId !== ownerPublicId
      || handledNotification.current === notificationEntry.request || economy.busy || economy.uncertain) return;
    const destination = worldNotificationDestination(notificationEntry.target, economy.snapshot, economy.now);
    const timer = window.setTimeout(() => {
      handledNotification.current = notificationEntry.request;
      setDailyOpen(false); setCharactersOpen(false); setResidentOpen(false); setQuickUpgrade(null);
      if (destination.kind === "activities") openQuick("expeditions");
      else if (destination.kind === "pantry") openQuick("pantry");
      else if (destination.kind === "builder") openResident("builder");
      else {
        const place = worldPlaceForStation(destination.stationId);
        if (place) openObject(place, destination.stationId, destination.recipeId);
        else openQuick("pantry");
      }
      onNotificationHandled?.(notificationEntry.request);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [open, sceneReady, economy.snapshot, economy.now, economy.busy, economy.uncertain, notificationEntry, onNotificationHandled, ownerPublicId, openQuick, openResident, openObject]);
  const openUpgrade = (stationId: string) => {
    openingPinnedGoal.current = false;
    upgradeReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    upgradeReturnOwner.current = ownerPublicId;
    navigatingUpgrade.current = false;
    setQuickUpgrade(stationId);
  };
  const leaveUpgrade = (next: () => void) => {
    navigatingUpgrade.current = true; setQuickUpgrade(null); next();
  };
  const openPinnedGoal = () => {
    if (!constructionGoal.goal) return;
    clearObject(); setPanel(null); setQuickMenu(null);
    openUpgrade(constructionGoal.goal.buildingId);
    openingPinnedGoal.current = true;
  };
  const openGiftPantry = () => {
    leavingDaily.current = true;
    setGiftPantryOwner(ownerPublicId); setDailyOpen(false);
    setQuickUpgrade(null); setResidentOpen(false);
    openQuick("pantry");
  };
  const returnToGift = () => {
    setGiftPantryOwner(null); setQuickMenu(null);
    openDailyRewards(); void economy.refresh();
  };
  const navigateHelp = (target: WorldHelpTarget) => {
    if (target.kind === "retry-economy") {
      if (isOnline !== false && !economy.busy && economy.retryAt <= economy.now) void economy.retry();
      return;
    }
    if (target.kind === "retry-world") {
      if (isOnline !== false && !world.busy) void world.retry();
      return;
    }
    navigatingHelp.current = target.kind !== "collection" && target.kind !== "wardrobe" && target.kind !== "orders"
      && !(target.kind === "food" && target.tab === "orders");
    switch (target.kind) {
      case "pantry": openQuick("pantry"); break;
      case "expeditions": openExpeditions(target.sector === "coast" ? "shore" : target.sector); break;
      case "station": openStation(target.stationId, target.recipeId); break;
      case "upgrade": setPanel(null); openUpgrade(target.stationId); break;
      case "orders": openOrders(target.residentId); break;
      case "food":
        if (target.tab === "orders") openOrders(target.residentId);
        else if (target.residentId === "builder") openResident("builder");
        else openQuick("expeditions");
        break;
      case "resident": openResident(target.residentId); break;
      case "profile": openQuick("profile", "forest", target.tab); break;
      case "collection": openPanel("collection"); break;
      case "wardrobe": openPanel("wardrobe"); break;
      case "people": onOpenPeople?.(); break;
    }
  };
  const { snapshot, busy, uncertain, act } = world;
  const guideStep = onboarding.progress?.status === "started" ? onboarding.progress.stepId : null;
  const guideCrop = economy.snapshot?.jobs.find(job => job.id === onboarding.progress?.cropJobId);
  const guideCropReady = Boolean(guideCrop && economy.now >= Date.parse(guideCrop.finishesAt));
  const guideOrder = economy.snapshot ? tutorialResidentOrder(economy.snapshot) : null;
  const guideOrderProgress = economy.snapshot ? tutorialOrderProgress(economy.snapshot) : null;
  const guideNeedsHarvest = worldOnboardingNeedsHarvest(onboarding.progress, guideOrder,
    Boolean(guideOrderProgress && (guideOrderProgress.completed || guideOrderProgress.step > 0)));
  const guideMapAvailable = open && onboarding.loaded && !onboarding.isPaused && !panel && !quickMenu && !selection
    && !quickUpgrade && !residentOpen && !charactersOpen && !dailyOpen && observation?.memory.sync?.mode !== "other-device";
  const guideWantsGarden = guideNeedsHarvest || guideStep === "garden" || guideStep === "grow" && (!guideCrop || guideCropReady)
    || onboarding.progress?.status === "completed" && guideCropReady;
  const guideWantsWorkshop = guideStep === "workshop";
  const guidePlace = marketGuide.open ? "market" : minerArrival.open || minerArrival.enabled ? "quarry" : merchantArrival.open || merchantArrival.enabled ? "leaftail-caravan" : guideMapAvailable ? guideWantsGarden ? "garden"
    : guideStep === "orders" ? "bulletin-board" : guideWantsWorkshop ? "workshop" : null : null;
  if (!snapshot) return <section className={styles.loading} aria-live="polite"><button id="world-exit" onClick={onClose}><ArrowLeft size={18} />Назад</button><Compass size={32} /><h1>Лес Мохлика</h1>
    <p>{world.error ?? "Открываем вашу полянку…"}</p>{world.error && <button onClick={() => void world.retry()}>Попробовать ещё раз</button>}</section>;
  const state = renderedState ?? snapshot.state;
  const expeditionReady = Boolean(economicJourney && economy.now >= Date.parse(economicJourney.finishesAt));
  const locked = busy || uncertain;
  const ownedGifts = new Set([...snapshot.gifts, ...(items ?? []), ...naturalItems(bestStreakDays)]);
  const quickSection = quickMenu === "pantry" || quickMenu === "expeditions" ? quickMenu : null;
  const orders = economy.snapshot?.ownerPublicId === ownerPublicId ? orderJournalSummary(economy.snapshot, economy.now, undefined, mainCourseActive) : { total: 0, ready: 0 };
  const quickGuideEnabled = sectionsReady && !mainCourseActive && !panel && !quickUpgrade && !residentOpen && !charactersOpen && !dailyOpen;
  const warehouseState = economy.snapshot?.ownerPublicId === ownerPublicId ? economy.snapshot : null;
  const quickTitle = quickMenu === "profile" ? "Мой Мохлик" : quickMenu === "pantry" ? "Кладовая" : quickMenu === "expeditions" ? "Вылазки" : "Ещё";
  const QuickIcon = quickMenu === "profile" ? Leaf : quickMenu === "pantry" ? Package : quickMenu === "expeditions" ? Compass : MoreHorizontal;
  const SheetIcon = panel === "help" ? Info : panel === "orders" ? BookOpenCheck : panel === "economy" ? economyTab === "market" ? Store : Package : panel === "shop" ? ShoppingBag : panel === "wardrobe" ? Shirt : panel === "collection" ? BookOpen : panel === "customize" ? Leaf : Compass;
  return <section ref={worldElement} className={styles.world} aria-label="Лес Мохлика" data-quick-open={quickMenu ?? undefined} style={{ "--quick-top": `${menuBounds.top + 6}px`, "--quick-bottom": `${menuBounds.bottom + 6}px` } as CSSProperties}>
    <WorldScene tutorialActive={Boolean(open && !suspended && mainCourseActive && onboarding.progress?.status === "started" && observation?.memory.sync?.mode !== "other-device")} suspended={!open || suspended} onReady={onSceneReady} economyJourney={economicJourney} cancelledExplorations={economy.cancelledExplorations} economyBuildings={economy.snapshot?.buildings} economyResidents={economicResidents} residentArrival={{ seen: minerArrival.seen, enabled: minerArrival.enabled, onComplete: minerArrival.complete }} merchantArrival={{ seen: merchantArrival.seen, enabled: merchantArrival.enabled, onComplete: merchantArrival.complete }} economyProduction={economicProduction} economyConstruction={economicConstruction} state={state} gifts={snapshot.gifts} items={items} owner={ownerPublicId} now={economy.snapshot ? economy.now : world.now} timeZone={timeZone}
      hideJourneyStatus onPlace={onPlace} onResident={openResident} selectedObjectId={selection?.objectId ?? null} onObjectSelection={onObjectSelection} openObjectRequest={openObjectRequest} guidePlace={guidePlace}
      constructionEconomy={economy} hideConstructionStatus={quickMenu !== null || panel !== null || selection !== null || quickUpgrade !== null || residentOpen || charactersOpen || dailyOpen}
      onOpenConstruction={stationId => { clearObject(); setPanel(null); setQuickMenu(null); openUpgrade(stationId); }}
      onOpenProduction={openStation}
      bestStreakDays={bestStreakDays} wakeSignal={wakeSignal + localNotice} topHud={topHud} bottomHud={bottomHud} />
    {WorldDevPanel && <WorldDevPanel world={world} economy={economy} worldView active={panel === null && quickMenu === null && !selection && quickUpgrade === null && !residentOpen && !charactersOpen && !dailyOpen}
      presenceKey={`zhiv:mochlik:presence:${ownerPublicId}`}
      onOpenObject={openObject} onOpenWardrobe={() => openPanel("wardrobe")} onOpenCollection={() => openPanel("collection")} />}
    <header ref={topHud} className={hudStyles.hud} data-world-hud="top">
      <div className={hudStyles.headerRow}>
        <div className={hudStyles.leftControls}>
          <button id="world-exit" className={hudStyles.iconButton} onClick={onClose} aria-label="Вернуться к отметке Я живой" data-audio-cue="ui.close"><ArrowLeft size={19} /></button>
          <button className={hudStyles.level} data-audio-cue={quickMenu === "profile" ? "ui.close" : "ui.open"} data-world-quick="profile" aria-haspopup="dialog" aria-expanded={quickMenu === "profile"} aria-controls={quickMenu === "profile" ? "world-quick-menu" : undefined}
            onClick={() => toggleQuick("profile")} aria-label={`Профиль Мохлика. ${displayName}, уровень ${level}`}>
            <GameLevelIcon level={level} size={21} /><span><small>Уровень</small><strong>{level}</strong></span>
          </button>
        </div>
        <div className={hudStyles.rightControls}>
          {economy.snapshot ? <WorldWallet key={`wallet:${ownerPublicId}`} {...economy.snapshot.wallet} onOpenShop={economy.snapshot.ownerPublicId === ownerPublicId ? openCurrencyShop : undefined} /> : <button className={hudStyles.loadingWallet} onClick={() => void economy.retry()} disabled={economy.busy || economy.retryAt > economy.now}>{economy.error ? "Повторить загрузку" : "Загрузка…"}</button>}
          <button data-world-onboarding-help data-audio-cue="ui.open" className={`${hudStyles.iconButton} ${hudStyles.helpButton}`} onClick={() => openContextHelp(quickUpgrade ? { stationId: quickUpgrade, intent: "construction" } : selection ? lastHelpContext.current : undefined)} aria-label="Справка по игре" title="Справка по игре"><Info size={20} aria-hidden="true" /></button>
        </div>
      </div>
      <WorldInventoryGains key={`inventory-gains:${ownerPublicId}`} economy={economy} hud={topHud} />
    </header>
    {constructionGoal.details && panel === null && !selection && !quickMenu && !quickUpgrade && !dailyOpen && !residentOpen && !charactersOpen && <div className={styles.goalHud}><button type="button" className={styles.goalPin} data-construction-goal-open aria-haspopup="dialog" aria-label={`Открыть цель: ${constructionGoal.details.name} · ур. ${constructionGoal.details.goal.targetLevel}`} title={`${constructionGoal.details.name} · ур. ${constructionGoal.details.goal.targetLevel}`} onClick={openPinnedGoal}><Pin size={20} aria-hidden="true" /></button></div>}
    {panel === null && quickMenu === null && <WorldFeedback world={world} />}
    {panel === null && selection && <div className={styles.objectLayer}><WorldObjectMenu leaftailAvailable={leaftailAvailable} tutorialWorkshop={Boolean(open && mainCourseActive && guideStep === "workshop")} guideRoot={workshopGuideRoot} guide={open && selection.place === "workshop" && (economy.snapshot?.buildings.workshop ?? 0) > 0 ? <SectionGuide key={`${ownerPublicId}:workshop`} owner={ownerPublicId} section="workshop" enabled={quickGuideEnabled} targetRoot={workshopGuideRoot} /> : undefined} key={`${selection.objectId}:${objectStation ?? ""}:${objectRecipe ?? ""}:${objectOpenRequest}`} initialStationId={objectStation} initialRecipeId={objectRecipe} isOnline={isOnline} onOpenHelp={openContextHelp} onHelpContextChange={rememberHelpContext} selection={selection} economy={economy} constructionGoal={constructionGoal} onOpenGoal={openPinnedGoal} bounds={menuBounds} onClose={closeObject} onBack={selection.place === "leaftail-caravan" && shopGalleryOwner === ownerPublicId ? closeObject : undefined} onReturnFocus={restoreObjectFocus} onNavigate={openObject} onOpenPantry={() => openQuick("pantry")} onExplore={() => openQuick("expeditions")} /></div>}
    <div ref={bottomHud} className={hudStyles.bottomHud} data-world-hud="bottom">
      <nav className={hudStyles.dock} aria-label="Действия в игре">
        <button data-audio-cue={quickMenu === "pantry" ? "ui.close" : "ui.open"} data-world-quick="pantry" aria-haspopup="dialog" aria-expanded={quickMenu === "pantry"} aria-controls={quickMenu === "pantry" ? "world-quick-menu" : undefined}
          aria-label={economy.snapshot ? `Кладовая: занято ${economy.snapshot.storage.used + economy.snapshot.storage.reserved} из ${economy.snapshot.storage.capacity} мест` : "Открыть кладовую"}
          data-full={economy.snapshot && economy.snapshot.storage.available <= 0 || undefined} onClick={() => toggleQuick("pantry")}>
          <Package size={18} aria-hidden="true" /><span>Кладовая</span>
        </button>
        <button data-audio-cue={quickMenu === "expeditions" ? "ui.close" : "ui.open"} data-world-quick="expeditions" data-expedition-ready={expeditionReady || undefined} aria-haspopup="dialog" aria-expanded={quickMenu === "expeditions"} aria-controls={quickMenu === "expeditions" ? "world-quick-menu" : undefined} onClick={() => toggleQuick("expeditions")}
          aria-label={expeditionReady ? "В путь. Вылазка завершена, забрать находки" : economicJourney ? "В путь. Мохлик в пути" : "В путь"}>
          <span className={hudStyles.expeditionIcon}><Compass size={18} aria-hidden="true" />{expeditionReady && <span className={hudStyles.expeditionCheck}><Check size={9} aria-hidden="true" /></span>}</span>
          <span className={hudStyles.expeditionLabel}>В путь{expeditionReady && <small>Находки ждут</small>}</span>{economicJourney && !expeditionReady && <span className={hudStyles.journeyDot} aria-hidden="true" />}
        </button>
        <button type="button" data-world-orders-entry data-orders-ready={orders.ready > 0 || undefined} data-audio-cue="ui.open" aria-haspopup="dialog"
          aria-expanded={panel === "orders"} aria-controls={panel === "orders" ? "world-order-journal" : undefined}
          aria-label={orders.ready > 0 ? `Журнал заказов. Можно выполнить: ${orders.ready}` : "Журнал заказов"} onClick={event => openOrders(undefined, event.currentTarget)}>
          <span className={hudStyles.orderIcon}><BookOpenCheck size={18} aria-hidden="true" />{orders.ready > 0 && <span className={hudStyles.orderCount} aria-hidden="true">{orders.ready}</span>}</span><span>Заказы</span>
        </button>
        <button data-audio-cue={quickMenu === "more" ? "ui.close" : "ui.open"} data-world-quick="more" aria-haspopup="dialog" aria-expanded={quickMenu === "more"} aria-controls={quickMenu === "more" ? "world-quick-menu" : undefined} onClick={() => toggleQuick("more")}><MoreHorizontal size={19} aria-hidden="true" /><span>Ещё</span></button>
      </nav>
    </div>
    {quickMenu && <section ref={quickFrame} id="world-quick-menu" className={`${hudStyles.quickMenu} ${styles.quickMenu}`} data-kind={quickMenu} role="dialog" aria-modal="false" aria-labelledby="world-quick-title" tabIndex={-1}
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeQuick(); } }}>
      <header className={`${hudStyles.quickHeader} ${styles.quickHeader}`}><h2 id="world-quick-title"><QuickIcon size={17} aria-hidden="true" />{quickMenu === "pantry" ? <span>{quickTitle}{warehouseState && <small>Ур. {warehouseState.buildings.warehouse ?? 1}</small>}</span> : quickTitle}</h2>
        {quickMenu === "pantry" && <WorldPantryUpgrade state={warehouseState} now={economy.now} onUpgrade={() => openUpgrade("warehouse")} className={hudStyles.headerUpgrade} />}
        <button type="button" aria-label={`Закрыть: ${quickTitle}`} onClick={closeQuick} data-audio-cue="ui.close"><X size={18} aria-hidden="true" /></button></header>
      <div data-guide-coach-slot />
      {open && quickSection && <SectionGuide key={`${ownerPublicId}:${quickSection}`} owner={ownerPublicId} section={quickSection} enabled={quickGuideEnabled && !pantryFishSaleOpen} targetRoot={quickFrame} />}
      <div className={`${hudStyles.quickBody} ${styles.quickBody}`}>
        {quickMenu === "expeditions" && economy.snapshot && <ConstructionGoalSummary state={economy.snapshot} constructionGoal={constructionGoal} onOpenGoal={openPinnedGoal} compact />}
        {quickMenu === "profile" && <WorldProfileMenu key={`${ownerPublicId}:${profileEntry.request}`} initialTab={profileEntry.tab} onOpenOnboarding={replayOnboarding} onboardingStatus={onboarding.progress?.status ?? null} friends={friends} onOpenPeople={onOpenPeople} onOpenHelp={() => openContextHelp(undefined, "mochlik-life")} onOpenExpeditions={() => openExpeditions()} world={world} economy={economy} presenceKey={`zhiv:mochlik:presence:${ownerPublicId}`} displayName={displayName} level={level} bestStreakDays={bestStreakDays} onCall={() => setLocalNotice(value => value + 1)}
          rewards={<DailyRewardsButton ownerPublicId={ownerPublicId} isOnline={isOnline} onSessionLost={onSessionLost} open={dailyOpen} onRequestOpen={openDailyRewards} triggerRef={dailyTrigger} />} />}
        {quickMenu === "pantry" && <WorldPantryMenu economy={economy} onFishSaleOpenChange={onFishSaleOpenChange} constructionGoal={constructionGoal} onOpenGoal={openPinnedGoal} navigation={{ canOpen: id => Boolean(worldPlaceForStation(id)), open: openStation, explore: () => openQuick("expeditions") }} onReturnToGift={giftPantryOwner === ownerPublicId ? returnToGift : undefined} onExplore={() => openQuick("expeditions")} onOpenFishingShop={() => openResident("plesk")} />}
        {quickMenu === "expeditions" && <WorldExpeditionsMenu key={`${expeditionSector}:${expeditionOpenRequest}`} initialSector={expeditionSector} isOnline={isOnline} onOpenHelp={openContextHelp} economy={economy} onOpenPantry={() => openQuick("pantry")} onNavigateStation={openStation} onOpenFishingShop={() => openResident("plesk")} />}
        {quickMenu === "more" && <div className={`${hudStyles.moreActions} ${styles.moreActions}`}>
          <button type="button" data-world-characters-trigger aria-haspopup="dialog" onClick={openCharacters}><PawPrint size={18} aria-hidden="true" /><span className={styles.moreLabel}>Персонажи<small>Жители леса</small></span></button>
          <button type="button" aria-haspopup="dialog" onClick={() => openPanel("wardrobe")}><Shirt size={18} aria-hidden="true" /><span className={styles.moreLabel}>Гардероб<small>Одежда и оттенки мха</small></span></button>
          <button type="button" aria-haspopup="dialog" onClick={() => openPanel("collection")}><BookOpen size={18} aria-hidden="true" /><span className={styles.moreLabel}>Коллекции<small>Книга личных находок</small></span></button>
          {state.journeys.length > 0 && <button type="button" aria-haspopup="dialog" onClick={() => openPanel("journeys")}><Compass size={18} aria-hidden="true" /><span className={styles.moreLabel}>Старые походы<small>Забрать прежние награды</small></span></button>}
        </div>}
      </div>
    </section>}
    <DailyRewardsDialog key={`daily-rewards:${ownerPublicId}`} ownerPublicId={ownerPublicId} economy={economy} isOnline={isOnline} onSessionLost={onSessionLost}
      autoPromptAllowed={dailyAutoPromptAllowed}
      open={dailyOpen} onOpenChange={setDailyOpen} onOpenPantry={openGiftPantry} onReturnFocus={() => {
        if (leavingDaily.current) { leavingDaily.current = false; quickFrame.current?.focus({ preventScroll: true }); return; }
        if (dailyTrigger.current?.isConnected) dailyTrigger.current.focus({ preventScroll: true });
        else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="profile"]')?.focus({ preventScroll: true });
      }} />
    <WorldCharacters open={charactersOpen} onClose={closeCharacters} onResident={openCharacterResident} quarryBuilt={quarryBuilt} leaftailAvailable={leaftailAvailable} leaftailUnlocked={merchantUnlocked} focusedCharacter={focusedCharacter}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (leavingCharacters.current) { leavingCharacters.current = false; return; }
        worldElement.current?.querySelector<HTMLElement>('[data-world-characters-trigger]')?.focus({ preventScroll: true });
      }} />
    <WorldResidentDialog guideRoot={pleskGuideRoot} guide={open ? <SectionGuide key={`${ownerPublicId}:plesk`} owner={ownerPublicId} section="plesk" enabled={sectionsReady && residentOpen && residentId === "plesk"} targetRoot={pleskGuideRoot} /> : undefined} open={residentOpen && residentOwner === ownerPublicId && residentId === "plesk"} economy={economy} onClose={closeResident} onBack={residentFromCharacters ? closeResident : undefined}
      onOpenOrders={() => leaveResident(() => openOrders("plesk"))}
      onFishing={() => leaveResident(() => openQuick("expeditions", "shore"))}
      onOpenPantry={() => leaveResident(() => openQuick("pantry"))}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (currentOwner.current !== ownerPublicId || residentOwner !== ownerPublicId) return;
        if (leavingResident.current) { leavingResident.current = false; quickFrame.current?.focus({ preventScroll: true }); return; }
        if (residentFromCharacters) {
          setResidentFromCharacters(false);
          // The gallery lives in a portal; its own open autofocus restores the card.
          return;
        }
        if (residentReturn.current?.isConnected) residentReturn.current.focus({ preventScroll: true });
        else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="more"]')?.focus({ preventScroll: true });
      }} />
    <WorldBuilderDialog guideRoot={builderGuideRoot} guide={open ? <SectionGuide key={`${ownerPublicId}:builder`} owner={ownerPublicId} section="builder" enabled={sectionsReady && residentOpen && residentId === "builder"} targetRoot={builderGuideRoot} /> : undefined} isOnline={isOnline} onNavigateStation={(id, recipeId) => leaveResident(() => openStation(id, recipeId))} open={residentOpen && residentOwner === ownerPublicId && residentId === "builder"} economy={economy} onClose={closeResident}
      onBack={residentFromCharacters ? closeResident : undefined}
      onOpenOrders={() => leaveResident(() => openOrders("builder"))}
      onOpenConstruction={stationId => leaveResident(() => openUpgrade(stationId))}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (currentOwner.current !== ownerPublicId || residentOwner !== ownerPublicId) return;
        if (leavingResident.current) { leavingResident.current = false; return; }
        if (residentFromCharacters) { setResidentFromCharacters(false); return; }
        if (residentReturn.current?.isConnected) residentReturn.current.focus({ preventScroll: true });
        else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="more"]')?.focus({ preventScroll: true });
      }} />
    {residentId !== "plesk" && residentId !== "builder" && <WorldVillagerDialog key={`${ownerPublicId}:${residentId}`} id={residentId as NewVillagerId}
      open={residentOpen && residentOwner === ownerPublicId} ownerPublicId={ownerPublicId} economy={economy} isOnline={isOnline !== false} quarryBuilt={quarryBuilt}
      onClose={closeResident} onBack={residentFromCharacters ? closeResident : undefined}
      onOpenStation={stationId => {
        if (currentOwner.current !== ownerPublicId || residentOwner !== ownerPublicId) return;
        leaveResident(() => openStation(stationId));
      }}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (currentOwner.current !== ownerPublicId || residentOwner !== ownerPublicId) return;
        if (leavingResident.current) { leavingResident.current = false; return; }
        if (residentFromCharacters) { setResidentFromCharacters(false); return; }
        if (residentReturn.current?.isConnected) residentReturn.current.focus({ preventScroll: true });
        else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="more"]')?.focus({ preventScroll: true });
      }} />}
    <WorldUpgradeDialog isOnline={isOnline} onOpenHelp={openContextHelp} stationId={quickUpgrade} economy={economy} constructionGoal={constructionGoal} onClose={() => setQuickUpgrade(null)}
      onCompleted={() => { completedQuickUpgrade.current = true; setQuickUpgrade(null); closeQuick(); }}
      navigation={{ canOpen: id => Boolean(worldPlaceForStation(id)), open: (id, recipeId) => leaveUpgrade(() => openStation(id, recipeId)), explore: () => leaveUpgrade(() => openQuick("expeditions")) }}
      onOpenPantry={() => leaveUpgrade(() => openQuick("pantry"))}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (upgradeReturnOwner.current !== ownerPublicId) {
          openingPinnedGoal.current = false; completedQuickUpgrade.current = false; navigatingUpgrade.current = false; return;
        }
        const wasPinnedGoal = openingPinnedGoal.current;
        openingPinnedGoal.current = false;
        if (completedQuickUpgrade.current) {
          completedQuickUpgrade.current = false;
          if (quickReturn.current?.isConnected) quickReturn.current.focus({ preventScroll: true });
          else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="profile"]')?.focus({ preventScroll: true });
          return;
        }
        if (navigatingUpgrade.current) { navigatingUpgrade.current = false; return; }
        if (wasPinnedGoal) {
          const goalButton = worldElement.current?.querySelector<HTMLElement>('[data-construction-goal-open]');
          if (goalButton) { goalButton.focus({ preventScroll: true }); return; }
        }
        const target = upgradeReturn.current?.dataset.constructionTarget;
        const trigger = target ? worldElement.current?.querySelector<HTMLElement>(`[data-construction-target="${target}"]`) : upgradeReturn.current;
        if (trigger?.isConnected) trigger.focus({ preventScroll: true });
        else if (quickFrame.current) quickFrame.current.focus({ preventScroll: true });
        else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="profile"]')?.focus({ preventScroll: true });
      }} />
    <Dialog open={panel !== null} onOpenChange={open => { if (!open) setPanel(null); }}>
      <DialogPortal>
      <DialogOverlay className={styles.sheetScrim} />
      <DialogPrimitive.Content ref={panelRoot} id={panel === "orders" ? "world-order-journal" : panel === "economy" && economyTab === "market" ? "world-player-market" : undefined} data-slot="dialog-content" className={styles.sheet} data-orders={panel === "orders" || undefined} data-help={panel === "help" || undefined} data-market={panel === "economy" && economyTab === "market" || undefined} data-book={panel === "collection" || undefined} data-shop={panel === "shop" || undefined}
        onEscapeKeyDown={event => { if (pauseFocusedGuide()) { event.preventDefault(); event.stopPropagation(); } }}
        onCloseAutoFocus={event => { event.preventDefault(); if (panelReturnOwner.current !== ownerPublicId) { navigatingHelp.current = false; return; } if (navigatingHelp.current) { navigatingHelp.current = false; return; } if (quickMenu) quickFrame.current?.focus({ preventScroll: true }); else if (selectedId.current) worldElement.current?.querySelector<HTMLElement>('[role="dialog"][data-place]')?.focus({ preventScroll: true }); else if (panelReturnOwner.current === ownerPublicId && panelReturn.current?.isConnected) panelReturn.current.focus({ preventScroll: true }); else worldElement.current?.querySelector<HTMLElement>(panelReturnKind.current === "orders" ? '[data-world-orders-entry]' : panelReturnKind.current === "economy" && economyTab === "market" ? '[data-world-quick="profile"]' : '[aria-label="Справка по игре"]')?.focus({ preventScroll: true }); }}>
        <div className={styles.sheetHeader}>
          <DialogTitle><SheetIcon size={20} aria-hidden="true" />{panel === "help" ? "Справка по игре" : panel === "orders" ? "Журнал заказов" : panel === "economy" ? economyTab === "market" ? "Рынок игроков" : economyTab === "buildings" ? "Развитие хозяйства" : economyTab === "production" ? "Производство" : "Хозяйство" : panel === "shop" ? "Магазин" : panel === "customize" ? "Украшения" : panel === "wardrobe" ? "Гардероб" : panel === "collection" ? "Книга находок" : "Путешествия"}</DialogTitle>
          <button type="button" onClick={() => setPanel(null)} aria-label={panel === "orders" ? "Закрыть журнал заказов" : "Закрыть панель"}><X size={21} aria-hidden="true" /></button>
        </div>
        <DialogDescription className={styles.sr}>{panel === "help" ? "Правила игры, управление картой и ответы на частые вопросы. Найдите короткий ответ через поиск или выберите раздел." : panel === "orders" ? "Просьбы жителей и путь хозяйства. Проверьте припасы и награду, затем отдайте выбранный заказ." : panel === "economy" && economyTab === "market" ? "Объявления других игроков и ваш прилавок. Покупка и продажа товаров между игроками." : panel === "shop" ? "Предварительная витрина жемчуга и золота. Покупки и обмен пока недоступны." : "Управление домом и путешествиями Мохлика"}</DialogDescription>
        {panel === "orders" && <div data-guide-coach-slot />}
        {open && panel === "orders" && <SectionGuide key={`${ownerPublicId}:orders`} owner={ownerPublicId} section="orders" enabled={sectionsReady && !mainCourseActive} targetRoot={panelRoot} />}
        {open && panel === "economy" && economyTab === "market" && <SectionGuide key={`${ownerPublicId}:market`} owner={ownerPublicId} section="market" enabled={sectionsReady && playerMarketUnlocked} targetRoot={panelRoot} />}
        <div className={styles.sheetBody}>
          {panel === "orders" && <WorldOrderJournal tutorialOnly={mainCourseActive} key={`${ownerPublicId}:${orderEntry.request}`} economy={economy} residentId={orderEntry.residentId} onNavigateExpeditions={openExpeditions} onNavigateStation={openStation} />}
          {panel === "help" && <WorldHelp key={`${ownerPublicId}:${helpEntry.request}`} economy={economy} world={world} presenceKey={`zhiv:mochlik:presence:${ownerPublicId}`} isOnline={isOnline} context={helpEntry.context} initialTopicId={helpEntry.topicId} onNavigate={navigateHelp} onReplayTutorial={replayOnboarding} />}
          {panel === "shop" && <CurrencyShopPanel key={`${ownerPublicId}:${shopPage}`} state={economy.snapshot} initialPage={shopPage} onRedeemed={economy.reconcile} />}
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
        {panel === "wardrobe" && <WorldWardrobe key={`wardrobe:${ownerPublicId}`} world={world} economy={economy} />}
        {panel === "collection" && <WorldCollections state={state} economy={economy.snapshot} gifts={snapshot.gifts} />}

          {panel !== "help" && panel !== "orders" && <WorldFeedback world={world} />}
        </div>
      </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
    <ForestSessionNotice presenceKey={`zhiv:mochlik:presence:${ownerPublicId}`} onExit={onClose} />
    <MarketUnlockOnboarding open={marketGuide.open} worldElement={worldElement}
      onOpenMarket={() => { marketGuide.complete(); openEconomy("market"); }} onDismiss={marketGuide.dismiss} />
    <MinerArrivalOnboarding open={minerArrival.open} arrived={minerArrival.seen} worldElement={worldElement}
      onMeet={() => { if (openResident("kamneshmyg")) minerArrival.dismiss(); }} onDismiss={minerArrival.dismiss} />
    <LeaftailArrivalOnboarding open={merchantArrival.open} arrived={merchantArrival.seen} worldElement={worldElement}
      onMeet={() => { if (leaftailAvailable) { openObject("leaftail-caravan"); merchantArrival.dismiss(); } }} onDismiss={merchantArrival.dismiss} />
    <WorldOnboardingReward key={`onboarding-reward:${ownerPublicId}`} owner={ownerPublicId} progress={onboarding.progress}
      economy={economy} isOnline={isOnline !== false} onSessionLost={onSessionLost} onAcknowledged={onboarding.acknowledgeReward}
      open={Boolean(open && !suspended && !panel && !quickMenu && !selection && !quickUpgrade && !residentOpen && !charactersOpen && !dailyOpen
        && !marketGuide.open && !minerArrival.open && !merchantArrival.open && observation?.memory.sync?.mode !== "other-device")} />
    <WorldOnboardingSession key={`world-onboarding:${ownerPublicId}`} presenceKey={`zhiv:mochlik:presence:${ownerPublicId}`} open={Boolean(open && economy.snapshot && onboarding.loaded && !onboarding.isPaused && !marketGuide.open && !minerArrival.open && !minerArrival.enabled && !merchantArrival.open && !merchantArrival.enabled)}
      modalBlocked={Boolean(panel && !(panel === "orders" && guideStep === "orders") || quickUpgrade || residentOpen || charactersOpen || dailyOpen || !mainCourseActive && (quickSection || selection))}
      progress={onboarding.progress} fishSaleOpen={Boolean(pantryFishSaleOpen)} worldElement={worldElement} economy={economy} quickMenu={quickMenu} helpOpen={panel === "help"} isOnline={isOnline}
      onStart={onboarding.start} onStep={onboarding.step} onCrop={onboarding.setCrop} onHarvest={onboarding.confirmHarvest}
      onSkip={onboarding.skip} onComplete={onboarding.complete} onOpenHelp={() => openContextHelp()} onPause={onboarding.pause}
      residentOpen={residentOpen ? residentId : null} charactersOpen={charactersOpen}
      ordersOpen={panel === "orders"} ordersElement={panelRoot}
      workshopOpen={quickUpgrade === "workshop" || selection?.place === "workshop"}
      onCloseSurface={() => { setPanel(null); setQuickMenu(null); clearObject(); }} />
  </section>;
}
