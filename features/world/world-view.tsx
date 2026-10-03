"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type RefObject } from "react";
import { ArrowLeft, BookOpen, Check, Coins, Compass, X, Feather, Gem, Info, Leaf, LockKeyhole, MoreHorizontal, Package, Shirt, Sparkles, Wind, Fish, Shell, FishingHook, Store } from "lucide-react";
import { GAME_ITEMS, naturalItems } from "@/features/game/game-rewards";
import { DecorationPreview } from "./decoration-preview";
import { formatDayCount } from "@/lib/daily-streak";
import type { WorldPortalProps } from "./world-portal";
import { GameLevelIcon } from "@/features/game/game-level-icon";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { WorldScene } from "./world-scene";
import { collectionCount, worldCatalog as catalog } from "./model";
import type { MapObjectSelection, WorldPlace } from "./map-engine";
import styles from "./world.module.css";
import { WorldJourneys } from "./world-journeys";
import { WorldFeedback } from "./world-feedback";
import { EconomyPanel, type EconomyTab } from "@/features/economy/economy-panel";
import { economyBuildingDestination, economySceneJourney, economyWorldState } from "@/features/economy/world-adapter";
import { WORLD_PRESENTATION } from "./presentation";
import { WorldHelp } from "./world-help";
import { WorldProfileMenu } from "./world-profile-menu";
import { WorldPantryMenu } from "@/features/economy/world-pantry-menu";
import { WorldExpeditionsMenu } from "@/features/economy/world-expeditions-menu";
import { WorldUpgradeDialog } from "@/features/economy/world-upgrade-dialog";
import { worldPlaceForStation } from "@/features/economy/world-stations";
import { WorldConstructionStatus } from "./world-construction-status";
import hudStyles from "./world-map-hud.module.css";
import { WorldObjectMenu } from "@/features/economy/world-object-menu";

type Panel = "journeys" | "economy" | "customize" | "wardrobe" | "collection" | "help";
type QuickMenu = "profile" | "pantry" | "expeditions" | "more";
const WorldDevPanel = process.env.NODE_ENV === "development"
  ? dynamic(() => import("./dev/world-dev-panel"), { ssr: false }) : null;
const findIcons = { leaf: Leaf, feather: Feather, sparkles: Sparkles, gem: Gem, wind: Wind, shell: Shell, float: FishingHook };
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
  const [quickUpgrade, setQuickUpgrade] = useState<string | null>(null);
  const quickFrame = useRef<HTMLElement>(null);
  const panelReturn = useRef<HTMLElement | null>(null);
  const quickReturn = useRef<HTMLElement | null>(null);
  const upgradeReturn = useRef<HTMLElement | null>(null);
  const navigatingUpgrade = useRef(false);
  const [localNotice, setLocalNotice] = useState(0);
  const [menuBounds, setMenuBounds] = useState({ top: 144, bottom: 88, left: 12, right: 12 });
  const worldElement = useRef<HTMLElement>(null);
  const economicJourney = useMemo(() => economySceneJourney(economy.snapshot), [economy.snapshot]);
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
    setQuickMenu(null);
    if (quickReturn.current?.isConnected) quickReturn.current.focus({ preventScroll: true });
  }, []);
  const openQuick = useCallback((next: QuickMenu) => {
    quickReturn.current = worldElement.current?.querySelector<HTMLElement>(`[data-world-quick="${next}"]`) ?? null;
    clearObject(); setPanel(null); setQuickMenu(next);
  }, [clearObject]);
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
  const locked = busy || uncertain;
  const ownedGifts = new Set([...snapshot.gifts, ...(items ?? []), ...naturalItems(bestStreakDays)]);
  const quickTitle = quickMenu === "profile" ? "Мой Мохлик" : quickMenu === "pantry" ? "Кладовая" : quickMenu === "expeditions" ? "Вылазки" : "Ещё";
  const QuickIcon = quickMenu === "profile" ? Leaf : quickMenu === "pantry" ? Package : quickMenu === "expeditions" ? Compass : MoreHorizontal;
  return <section ref={worldElement} className={styles.world} aria-label="Лес Мохлика" data-quick-open={quickMenu ?? undefined} style={{ "--quick-top": `${menuBounds.top + 6}px`, "--quick-bottom": `${menuBounds.bottom + 6}px` } as CSSProperties}>
    <WorldScene economyJourney={economicJourney} economyBuildings={economy.snapshot?.buildings} state={state} gifts={snapshot.gifts} items={items} owner={ownerPublicId} now={economy.snapshot ? economy.now : world.now} timeZone={timeZone}
      hideJourneyStatus hideMapControls={quickMenu !== null || selection !== null} onPlace={onPlace} selectedObjectId={selection?.objectId ?? null} onObjectSelection={onObjectSelection} openObjectRequest={openObjectRequest}
      bestStreakDays={bestStreakDays} wakeSignal={wakeSignal + localNotice} topHud={topHud} bottomHud={bottomHud} />
    {WorldDevPanel && <WorldDevPanel world={world} economy={economy} worldView active={panel === null && quickMenu === null && quickUpgrade === null}
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
          {economy.snapshot ? <dl className={hudStyles.wallet} aria-label="Ваши валюты">
            <div><dt><Coins size={15} aria-hidden="true" /><span className={styles.sr}>Монеты</span></dt><dd>{economy.snapshot.wallet.coins.toLocaleString("ru-RU")}</dd></div>
            <div><dt><Shell size={15} aria-hidden="true" /><span className={styles.sr}>Жемчуг</span></dt><dd>{economy.snapshot.wallet.pearls.toLocaleString("ru-RU")}</dd></div>
          </dl> : <button className={hudStyles.loadingWallet} onClick={() => void economy.retry()} disabled={economy.busy || economy.retryAt > economy.now}>{economy.error ? "Повторить загрузку" : "Загрузка…"}</button>}
          <button className={hudStyles.iconButton} onClick={() => openPanel("help")} aria-label="Справка по игре" title="Справка по игре"><Info size={20} aria-hidden="true" /></button>
        </div>
      </div>
      <WorldConstructionStatus economy={economy} onOpen={stationId => { clearObject(); setPanel(null); setQuickMenu(null); openUpgrade(stationId); }} />
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
        <button data-world-quick="expeditions" aria-haspopup="dialog" aria-expanded={quickMenu === "expeditions"} aria-controls={quickMenu === "expeditions" ? "world-quick-menu" : undefined} onClick={() => toggleQuick("expeditions")}>
          <Compass size={18} aria-hidden="true" /><span>В путь</span>{economicJourney && <span className={hudStyles.journeyDot} data-ready={economy.now >= Date.parse(economicJourney.finishesAt) || undefined} aria-label={economy.now >= Date.parse(economicJourney.finishesAt) ? "Вылазка завершена" : "Мохлик в пути"} />}
        </button>
        <button data-world-quick="more" aria-haspopup="dialog" aria-expanded={quickMenu === "more"} aria-controls={quickMenu === "more" ? "world-quick-menu" : undefined} onClick={() => toggleQuick("more")}><MoreHorizontal size={19} aria-hidden="true" /><span>Ещё</span></button>
      </nav>
    </div>
    {quickMenu && <section ref={quickFrame} id="world-quick-menu" className={hudStyles.quickMenu} data-kind={quickMenu} role="dialog" aria-modal="false" aria-labelledby="world-quick-title" tabIndex={-1}
      onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeQuick(); } }}>
      <header className={hudStyles.quickHeader}><h2 id="world-quick-title"><QuickIcon size={17} aria-hidden="true" />{quickTitle}</h2><button type="button" aria-label={`Закрыть: ${quickTitle}`} onClick={closeQuick}><X size={18} aria-hidden="true" /></button></header>
      <div className={hudStyles.quickBody}>
        {quickMenu === "profile" && <WorldProfileMenu world={world} economy={economy} presenceKey={`zhiv:mochlik:presence:${ownerPublicId}`} displayName={displayName} level={level} bestStreakDays={bestStreakDays} onCall={() => { setLocalNotice(value => value + 1); closeQuick(); }} />}
        {quickMenu === "pantry" && <WorldPantryMenu economy={economy} onUpgrade={() => openUpgrade("warehouse")} onExplore={() => openQuick("expeditions")} onOpenMarket={() => openEconomy("market")} />}
        {quickMenu === "expeditions" && <WorldExpeditionsMenu economy={economy} onOpenPantry={() => openQuick("pantry")} onNavigateStation={openStation} />}
        {quickMenu === "more" && <div className={hudStyles.moreActions}>
          <button onClick={() => openEconomy("market")}><Store size={18} aria-hidden="true" />Рынок</button>
          <button onClick={() => openPanel("wardrobe")}><Shirt size={18} aria-hidden="true" />Гардероб</button>
          <button onClick={() => openPanel("collection")}><BookOpen size={18} aria-hidden="true" />Коллекции</button>
          {state.journeys.length > 0 && <button onClick={() => openPanel("journeys")}><Compass size={18} aria-hidden="true" />Старые походы</button>}
        </div>}
      </div>
    </section>}
    <WorldUpgradeDialog stationId={quickUpgrade} economy={economy} onClose={() => setQuickUpgrade(null)}
      navigation={{ canOpen: id => Boolean(worldPlaceForStation(id)), open: id => leaveUpgrade(() => openStation(id)), explore: () => leaveUpgrade(() => openQuick("expeditions")) }}
      onOpenPantry={() => leaveUpgrade(() => openQuick("pantry"))}
      onCloseAutoFocus={event => { event.preventDefault(); if (navigatingUpgrade.current) { navigatingUpgrade.current = false; return; } if (upgradeReturn.current?.isConnected) upgradeReturn.current.focus({ preventScroll: true }); else if (quickFrame.current) quickFrame.current.focus({ preventScroll: true }); else worldElement.current?.querySelector<HTMLElement>('[data-world-quick="profile"]')?.focus({ preventScroll: true }); }} />
    <Dialog open={panel !== null} onOpenChange={open => { if (!open) setPanel(null); }}>
      <DialogPortal>
      <DialogOverlay className={styles.sheetScrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={styles.sheet}
        onCloseAutoFocus={event => { event.preventDefault(); if (quickMenu) quickFrame.current?.focus({ preventScroll: true }); else if (selectedId.current) worldElement.current?.querySelector<HTMLElement>('[role="dialog"][data-place]')?.focus({ preventScroll: true }); else if (panelReturn.current?.isConnected) panelReturn.current.focus(); else document.getElementById("world-exit")?.focus(); }}>
        <div className={styles.sheetHeader}>
          <DialogTitle>{panel === "help" ? "Справка по игре" : panel === "economy" ? "Рынок" : panel === "customize" ? "Украшения" : panel === "wardrobe" ? "Гардероб" : panel === "collection" ? "Коллекции" : "Путешествия"}</DialogTitle>
          <button onClick={() => setPanel(null)} aria-label="Закрыть панель"><X size={21} /></button>
        </div>
        <DialogDescription className={styles.sr}>{panel === "help" ? "Правила игры, управление картой и ответы на частые вопросы. Найдите тему через поиск или раскройте нужный раздел." : "Управление домом и путешествиями Мохлика"}</DialogDescription>
        <div className={styles.sheetBody}>
          {panel === "help" && <WorldHelp />}
          {panel === "economy" && <EconomyPanel key={`${economyTab}:${economyFocusId ?? ""}`} economy={economy} initialTab={economyTab} initialFocusId={economyFocusId} standalone onNavigate={openEconomy} />}
          {WORLD_PRESENTATION.streakDecor && panel === "customize" && <div className={styles.panel}>
            <div className={styles.panelHeading}><span className={styles.eyebrow}>ДОМИК ПО ТВОЕМУ ВКУСУ</span><h2>Украшения</h2><p>Выбирай, что оставить у дома. Подарки сохраняются, даже когда выключены.</p></div>
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
        {panel === "wardrobe" && <div className={styles.panel}><div className={styles.panelHeading}><span className={styles.eyebrow}>ХАРАКТЕР В ДЕТАЛЯХ</span><h2>Твой Мохлик</h2><p>Одежда и оттенки мха видны и здесь, и в круглой кнопке.</p></div>
          <div className={styles.wardrobe}>{catalog.items.map(item => {
            const owned = state.inventory.includes(item.id), equipped = Object.values(state.equipment).includes(item.id);
            return <article key={item.id} className={styles.item} data-owned={owned}><span className={styles.itemSwatch} style={{ background: item.color }}><span>{item.slot === "palette" ? <Leaf /> : item.slot === "head" ? <Compass /> : item.slot === "rod" ? <FishingHook /> : <Shirt />}</span></span>
              <div><h3>{item.name}</h3><p>{item.slot === "palette" ? "Цвет мха" : item.slot === "head" ? "Головной убор" : item.slot === "rod" ? "Снаряжение для рыбалки" : "Шарф"}</p></div>
              {owned ? <button disabled={locked || equipped && item.slot === "palette"} onClick={() => act("equip", equipped ? `remove_${item.slot}` : item.id)}>{equipped ? item.slot === "palette" ? "Выбран" : item.slot === "rod" ? "Убрать" : "Снять" : item.slot === "rod" ? "Взять" : "Надеть"}</button>
                : item.id === "explorer_cap" || item.id === "willow_rod" ? <span className={styles.kicker}><LockKeyhole size={13} />{item.id === "willow_rod" ? "За коллекцию рыбалки" : "За лесной альбом"}</span>
                  : <span className={styles.kicker}>Новые рецепты появятся позже</span>}
            </article>;
          })}</div>
        </div>}
        {panel === "collection" && <div className={styles.panel}><div className={styles.panelHeading}><span className={styles.eyebrow}>ПАМЯТЬ О ПУТЕШЕСТВИЯХ</span><h2>Коллекции <small>{collectionCount(state.collection)}/{catalog.finds.length}</small></h2><p>Здесь сохранены находки из прежних путешествий. Незавершённые походы доступны через «Старые походы». Новые исследования приносят предметы на склад; пополнение альбомов появится отдельно.</p></div>
          {(["forest", "fishing"] as const).map(group => {
            const finds = catalog.finds.filter(find => find.group === group);
            const reward = group === "forest" ? "explorer_cap" : "willow_rod";
            return <section key={group} className={styles.panel}>
              <h3 className={styles.albumHeading}>{group === "forest" ? "Лесной альбом" : "Находки рыболова"}<small>{finds.filter(find => state.collection.includes(find.id)).length}/6</small></h3>
              <p className={styles.albumReward}>{state.inventory.includes(reward) ? <Check size={16} /> : group === "forest" ? <Compass size={16} /> : <FishingHook size={16} />}{group === "forest" ? "Шляпа следопыта" : "Ивовая удочка"}{state.inventory.includes(reward) ? " · получена" : " · за все 6 находок"}</p>
              <div className={styles.collection}>{finds.map(find => {
                const owned = state.collection.includes(find.id), Icon = findIcons[find.symbol as keyof typeof findIcons] ?? Leaf;
                const fishing = catalog.routes.some(route => route.id.startsWith("fishing_") && route.finds.includes(find.id));
                return <article key={find.id} className={styles.find} data-owned={owned}><Icon size={32} /><h3>{find.name}</h3><p>{find.description}</p><span className={styles.kicker}>{owned ? <><Check size={13} />В альбоме</> : fishing ? <><Fish size={13} />{WORLD_PRESENTATION.rebuilding ? "Рыбалка · новые выходы закрыты" : "На рыбалке · любой режим"}</> : WORLD_PRESENTATION.rebuilding ? "Прогулка · новые выходы закрыты" : "На лесной прогулке · 5 или 10 мин"}</span></article>;
              })}</div>
            </section>;
          })}
          <p className={styles.hint}>Завершено путешествий: {state.completedJourneys}. Находки остаются навсегда.</p>
          {WORLD_PRESENTATION.streakDecor && <details className={styles.details}><summary>Подарки Мохлику · {snapshot.gifts.length}/{GAME_ITEMS.length}</summary>
            <div className={styles.collection}>{GAME_ITEMS.map(item => <article className={styles.find} data-owned={snapshot.gifts.includes(item.id)} key={item.id}>
              <h3>{item.title}</h3><span className={styles.kicker}>{snapshot.gifts.includes(item.id) ? (state.hiddenGifts ?? []).includes(item.id) ? "Хранится в коллекции" : "Украшает домик" : `За ${item.days} дней отметок подряд`}</span>
            </article>)}</div>
          </details>}
        </div>}

          <WorldFeedback world={world} />
        </div>
      </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  </section>;
}
