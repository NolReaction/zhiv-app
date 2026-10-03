"use client";
import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { ArrowLeft, BookOpen, Check, Compass, X, Feather, Gem, Hammer, House, Info, Leaf, LockKeyhole, MoreHorizontal, Shirt, Sparkles, Wind, Fish, Shell, FishingHook, Store } from "lucide-react";
import { GAME_ITEMS, naturalItems } from "@/features/game/game-rewards";
import { DecorationPreview } from "./decoration-preview";
import { formatDayCount } from "@/lib/daily-streak";
import type { WorldPortalProps } from "./world-portal";
import { GameLevelIcon } from "@/features/game/game-level-icon";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { WorldScene } from "./world-scene";
import { collectionCount, workshopLevel, worldCatalog as catalog } from "./model";
import type { MapObjectSelection, WorldPlace } from "./map-engine";
import styles from "./world.module.css";
import { WorldJourneys } from "./world-journeys";
import { WorldFeedback } from "./world-feedback";
import { EconomyBalances, EconomyPanel, type EconomyTab } from "@/features/economy/economy-panel";
import { economyBuildingDestination, economySceneJourney, economyWorldState } from "@/features/economy/world-adapter";
import { WORLD_PRESENTATION } from "./presentation";
import { WorldHelp } from "./world-help";
import { MochlikState } from "./mochlik-state";
import { WorldObjectMenu } from "@/features/economy/world-object-menu";

type Panel = "journeys" | "economy" | "customize" | "wardrobe" | "collection" | "stats" | "help";
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
  const [openObjectRequest, setOpenObjectRequest] = useState<{ id: number; place: WorldPlace }>();
  const [moreOpen, setMoreOpen] = useState(false);
  const [localNotice, setLocalNotice] = useState(0);
  const [menuBounds, setMenuBounds] = useState({ top: 144, bottom: 88, left: 12, right: 12 });
  const worldElement = useRef<HTMLElement>(null), moreElement = useRef<HTMLDivElement>(null);
  const moreButton = useRef<HTMLButtonElement>(null);
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
  useEffect(() => {
    if (!moreOpen) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !moreElement.current?.contains(event.target)) setMoreOpen(false); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [moreOpen]);
  const clearObject = useCallback(() => { selectedId.current = null; setSelection(null); }, []);
  const restoreObjectFocus = useCallback(() => {
    if (objectReturn.current?.isConnected) objectReturn.current.focus({ preventScroll: true });
  }, []);
  const closeObject = useCallback(() => {
    clearObject();
    restoreObjectFocus();
  }, [clearObject, restoreObjectFocus]);
  useEffect(() => {
    if (!escapeHandlerRef) return;
    // Radix handles Escape in document capture, before a popover's own key handler.
    escapeHandlerRef.current = () => {
      if (moreOpen) { setMoreOpen(false); moreButton.current?.focus(); return true; }
      if (selection) { closeObject(); return true; }
      return false;
    };
    return () => { escapeHandlerRef.current = null; };
  }, [escapeHandlerRef, moreOpen, selection, closeObject]);
  const onObjectSelection = useCallback((next: MapObjectSelection | null) => {
    if (next === null) { selectedId.current = null; setSelection(null); }
    else if (selectedId.current === next.objectId) setSelection(next);
  }, []);
  const openObject = useCallback((place: WorldPlace, stationId?: string) => {
    requestedStation.current = stationId;
    setPanel(null); setMoreOpen(false);
    setOpenObjectRequest(previous => ({ id: (previous?.id ?? 0) + 1, place }));
  }, []);
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
  const panelReturn = useRef<HTMLElement | null>(null);
  const openPanel = useCallback((next: Panel) => {
    if (!WORLD_PRESENTATION.streakDecor && next === "customize") return;
    if (panel === null) panelReturn.current = moreElement.current?.contains(document.activeElement) ? moreButton.current : document.activeElement instanceof HTMLElement ? document.activeElement : null;
    clearObject(); setMoreOpen(false);
    setPanel(next);
  }, [panel, clearObject]);
  const openEconomy = useCallback((tab: EconomyTab, focusId?: string) => {
    setEconomyTab(tab); setEconomyFocusId(focusId); openPanel("economy");
  }, [openPanel]);
  const onPlace = useCallback((place: WorldPlace, object?: MapObjectSelection) => {
    if (object) {
      if (!selectedId.current) objectReturn.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      selectedId.current = object.objectId; setObjectStation(requestedStation.current); requestedStation.current = undefined; setSelection(object); setPanel(null); setMoreOpen(false);
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
  const { snapshot, busy, uncertain, act } = world;
  if (!snapshot) return <section className={styles.loading} aria-live="polite"><button id="world-exit" onClick={onClose}><ArrowLeft size={18} />Назад</button><Compass size={32} /><h1>Лес Мохлика</h1>
    <p>{world.error ?? "Открываем вашу полянку…"}</p>{world.error && <button onClick={() => void world.retry()}>Попробовать ещё раз</button>}</section>;
  const state = renderedState ?? snapshot.state;
  const shopLevel = workshopLevel(state);
  const locked = busy || uncertain;
  const ownedGifts = new Set([...snapshot.gifts, ...(items ?? []), ...naturalItems(bestStreakDays)]);
  return <section ref={worldElement} className={styles.world} aria-label="Лес Мохлика">
    <WorldScene economyJourney={economicJourney} economyBuildings={economy.snapshot?.buildings} state={state} gifts={snapshot.gifts} items={items} owner={ownerPublicId} now={economy.snapshot ? economy.now : world.now} timeZone={timeZone}
      onPlace={onPlace} selectedObjectId={selection?.objectId ?? null} onObjectSelection={onObjectSelection} openObjectRequest={openObjectRequest}
      bestStreakDays={bestStreakDays} wakeSignal={wakeSignal + localNotice} topHud={topHud} bottomHud={bottomHud} />
    {WorldDevPanel && <WorldDevPanel world={world} worldView active={panel === null}
      presenceKey={`zhiv:mochlik:presence:${ownerPublicId}`}
      onOpenObject={openObject} onOpenWardrobe={() => openPanel("wardrobe")} onOpenCollection={() => openPanel("collection")} />}
    <header ref={topHud} className={styles.hud}>
      <div className={styles.playerBar}>
        <button id="world-exit" onClick={onClose} aria-label="Вернуться к отметке Я живой"><ArrowLeft size={22} /></button>
        <button className={styles.player} onClick={() => openPanel("stats")} aria-label={`Статистика Мохлика. ${displayName}, уровень ${level}`}>
          <GameLevelIcon level={level} size={23} /><span><strong>{displayName}</strong><small>Уровень {level}</small></span>
        </button>
        <button className={styles.helpButton} onClick={() => openPanel("help")} aria-label="Справка по игре" title="Справка по игре"><Info size={22} aria-hidden="true" /></button>
      </div>
      <div aria-live="polite">{economy.snapshot ? <EconomyBalances wallet={economy.snapshot.wallet} /> : <button onClick={() => openEconomy("overview")}>Хозяйство · {economy.error ? "повторить загрузку" : "загрузка…"}</button>}</div>
    </header>
    {panel === null && <WorldFeedback world={world} />}
    {panel === null && selection && <div className={styles.objectLayer}><WorldObjectMenu key={`${selection.objectId}:${objectStation ?? ""}`} initialStationId={objectStation} selection={selection} economy={economy} bounds={menuBounds} onClose={closeObject} onReturnFocus={restoreObjectFocus} onNavigate={openObject} onExplore={() => openEconomy("exploration")} /></div>}
    <div ref={bottomHud} className={styles.bottomHud}>
      <nav className={styles.gameDock} aria-label="Действия в игре">
        <MochlikState presenceKey={`zhiv:mochlik:presence:${ownerPublicId}`} onOpen={() => { clearObject(); setMoreOpen(false); }} onCall={() => setLocalNotice(value => value + 1)} />
        <button onClick={() => openEconomy("exploration")}><Compass size={20} /><span>В путь</span></button>
        <div ref={moreElement} className={styles.moreContainer}>
          <button ref={moreButton} aria-expanded={moreOpen} aria-controls="world-more-actions" onClick={() => { clearObject(); setMoreOpen(open => !open); }}><MoreHorizontal size={21} /><span>Ещё</span></button>
          {moreOpen && <div id="world-more-actions" className={styles.moreActions} aria-label="Другие действия">
            <button onClick={() => openEconomy("market")}><Store size={19} />Рынок</button>
            <button onClick={() => openPanel("wardrobe")}><Shirt size={19} />Гардероб</button>
            <button onClick={() => openPanel("collection")}><BookOpen size={19} />Коллекции</button>
            <button onClick={() => openEconomy("overview")}><Hammer size={19} />Обзор хозяйства</button>
            {state.journeys.length > 0 && <button onClick={() => openPanel("journeys")}><Compass size={19} />Старые походы</button>}
          </div>}
        </div>
      </nav>
    </div>
    <Dialog open={panel !== null} onOpenChange={open => { if (!open) setPanel(null); }}>
      <DialogPortal>
      <DialogOverlay className={styles.sheetScrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={styles.sheet}
        onCloseAutoFocus={event => { event.preventDefault(); if (selectedId.current) worldElement.current?.querySelector<HTMLElement>('[role="dialog"][data-place]')?.focus({ preventScroll: true }); else if (panelReturn.current?.isConnected) panelReturn.current.focus(); else document.getElementById("world-exit")?.focus(); }}>
        <div className={styles.sheetHeader}>
          <DialogTitle>{panel === "help" ? "Справка по игре" : panel === "economy" ? "Лесное хозяйство" : panel === "customize" ? "Украшения" : panel === "wardrobe" ? "Гардероб" : panel === "collection" ? "Коллекции" : panel === "stats" ? "Мой Мохлик" : "Путешествия"}</DialogTitle>
          <button onClick={() => setPanel(null)} aria-label="Закрыть панель"><X size={21} /></button>
        </div>
        <DialogDescription className={styles.sr}>{panel === "help" ? "Правила игры, управление картой и ответы на частые вопросы. Найдите тему через поиск или раскройте нужный раздел." : "Управление домом и путешествиями Мохлика"}</DialogDescription>
        <div className={styles.sheetBody}>
          {panel === "help" && <WorldHelp />}
          {panel === "economy" && <EconomyPanel key={`${economyTab}:${economyFocusId ?? ""}`} economy={economy} initialTab={economyTab} initialFocusId={economyFocusId} />}
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
        {panel === "stats" && <div className={styles.statsPanel}>
          <div className={styles.statsIdentity}><GameLevelIcon level={level} size={42} /><h2>{displayName}</h2><span>Уровень {level}</span></div>
          <dl><div><dt>Домик</dt><dd>{state.houseLevel} / 5</dd></div><div><dt>Мастерская</dt><dd>{state.workshop ? `${shopLevel} / ${economy.snapshot?.catalog.buildings.find(building => building.id === "workshop")?.levels.length ?? 5}` : "Не построена"}</dd></div>
          <div><dt>Исследования</dt><dd>{economy.snapshot?.completedExplorations ?? 0}</dd></div><div><dt>Прежние путешествия</dt><dd>{state.completedJourneys}</dd></div><div><dt>Находки</dt><dd>{collectionCount(state.collection)} / {catalog.finds.length}</dd></div>
          <div><dt>Гардероб</dt><dd>{state.inventory.length} вещей</dd></div><div><dt>Лучшая серия отметок</dt><dd>{bestStreakDays} дн.</dd></div></dl>
          <button onClick={() => openObject("house")}><House size={18} />Обустроить дом</button>
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
          {panel === "stats" && <p className={styles.hint}>Монеты можно получить за товары. Материалы нужны и для производства, и для строительства. Прежние искры переведены в ограниченный стартовый запас; игровые тапы продолжают повышать уровень Мохлика.</p>}
          <WorldFeedback world={world} />
        </div>
      </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  </section>;
}
