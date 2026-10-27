"use client";

import { fishClassForItem } from "@/features/economy/domain/fishing";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { ArrowLeft, ArrowRight, Backpack, Check, Cherry, ChevronUp, Compass, CupSoda, Fence, Fish, Flame, Hammer, House, Leaf, LockKeyhole, Package, Pickaxe, RefreshCw, Sprout, TowerControl, Trees, X, type LucideIcon } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import type { MapObjectSelection, WorldPlace } from "@/features/world/scene/map-engine";
import type { WorldState } from "@/features/world/domain/model";
import type { WorldHelpContext } from "@/features/world/ui/help/world-help-types";
import { economyLocalSellPrice, economyLocalSaleMinimumQuantity, economyLocalSaleLimit } from "@/features/economy/domain/local-sale";
import { canStartTutorialWorkshop } from "@/features/economy/domain/workshop-starter";
import { recipeBuildingLevel } from "@/features/economy/domain/model";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { worldDuration, worldJobProgress, worldMenuDimensions, worldMenuPosition, worldStableMenuPosition, worldPlaceForStation, worldRequirements, worldRecipeAccessReason, worldStations, type WorldMenuBounds, type WorldRecipe } from "@/features/economy/ui/shared/world-stations";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { Requirements, Work, ProductIcon, stationIcons, stationName, number, type StationNavigation } from "@/features/economy/ui/shared/world-economy-parts";
import { WorldUpgradeDialog } from "@/features/economy/ui/construction/world-upgrade-dialog";
import { WorldStationSetup } from "@/features/economy/ui/construction/world-station-setup";
import { useGardenCollection } from "@/features/economy/integration/garden-collection-context";
import { WorldMiningProduction } from "@/features/economy/ui/expeditions/world-mining-production";
import { WorldLeaftailMarket } from "@/features/economy/ui/market/world-leaftail-market";
import { WorldProductionSlots } from "@/features/economy/ui/production/world-production-slots";
import { productionStationSupported } from "@/features/economy/domain/production-slots";
import type { ConstructionGoalController } from "@/features/economy/ui/construction/use-construction-goal";
import { ConstructionGoalSummary } from "@/features/economy/ui/construction/construction-goal-summary";
import { worldRecipeGroups } from "./world-recipe-groups";
import { WorldProductionCard } from "@/features/economy/ui/production/world-production-card";
import { campfireDurationFilters, campfireDurationMatches, campfireRecipeGroups, type CampfireDurationFilter } from "@/features/economy/ui/food/campfire-recipe-groups";
import styles from "./world-object-menu.module.css";

export type WorldObjectMenuProps = {
  guide?: ReactNode;
  /** The active main workshop lesson supplies the first construction button. */
  tutorialWorkshop?: boolean;
  /** Only the currently visible first-harvest lesson may request its one-time aid. */
  tutorialHarvestActive?: boolean;
  /** Confirmed house access and the completed introduction of this account. */
  leaftailAvailable?: boolean;
  appearance?: WorldState["equipment"];
  guideRoot?: RefObject<HTMLElement | null>;
  selection: MapObjectSelection;
  economy: EconomyController;
  onClose: () => void;
  onBack?: () => void;
  onReturnFocus?: () => void;
  /** Safe insets in CSS pixels, in the same map viewport as selection.x/y. */
  bounds?: WorldMenuBounds;
  onNavigate?: (place: WorldPlace, stationId?: string, recipeId?: string) => void;
  initialStationId?: string;
  initialRecipeId?: string;
  onExplore?: () => void;
  onOpenPantry?: () => void;
  constructionGoal?: ConstructionGoalController;
  onOpenGoal?: () => void;
  onOpenHelp?: (context: WorldHelpContext) => void;
  isOnline?: boolean;
  onHelpContextChange?: (context: WorldHelpContext) => void;
};
const placeIcons: Partial<Record<WorldPlace, LucideIcon>> = { house: House, garden: Sprout, campfire: Flame, workshop: Hammer, quarry: Pickaxe, woodlot: Trees, bridge: Fence, lighthouse: TowerControl,
  "leaftail-caravan": Leaf, "lopukh-home": House };

function RecipeCatalog({ economy, recipes, focusedRecipeId, tutorialHarvestActive = false, onHelpContextChange }: { economy: ReadyEconomy; recipes: WorldRecipe[]; focusedRecipeId: string | null; tutorialHarvestActive?: boolean; onHelpContextChange?: (context: WorldHelpContext) => void }) {
  const availableKeys = new Set(worldRecipeGroups(economy.snapshot, recipes).map(group => group.key));
  const available = worldRecipeGroups(economy.snapshot, recipes, { includeFuture: true })
    .filter(group => availableKeys.has(group.key) || group.methods.some(recipe => recipe.id === focusedRecipeId));
  return available.length ? <section className={styles.recipeGroup} aria-label="Доступные рецепты">
    <h3>Что произвести?</h3>
    <div className={styles.recipeGrid}>{available.map(group => <WorldProductionCard key={group.key} economy={economy} recipe={group.recipe} tutorialHarvestActive={tutorialHarvestActive} focused={group.methods.some(recipe => recipe.id === focusedRecipeId)} onHelpContextChange={onHelpContextChange} />)}</div>
  </section> : <p className={styles.empty}>Сначала обустройте это место.</p>;
}

const cookingSectionIcons: Record<string, LucideIcon> = { fish: Fish, drinks: CupSoda, desserts: Cherry, provisions: Backpack };

export function CampfireRecipeCatalog({ economy, recipes, focusedRecipeId, onHelpContextChange }: { economy: ReadyEconomy; recipes: WorldRecipe[]; focusedRecipeId: string | null; onHelpContextChange?: (context: WorldHelpContext) => void }) {
  const [selection, setSelection] = useState<{ focus: string | null; filter: CampfireDurationFilter }>({ focus: focusedRecipeId, filter: "all" });
  const basicCampfire = !(economy.snapshot.buildings.dryer > 0);
  const visibleRecipes = basicCampfire ? recipes.filter(recipe => recipeBuildingLevel(recipe) === 0 || recipe.id === focusedRecipeId) : recipes;
  const available = worldRecipeGroups(economy.snapshot, visibleRecipes);
  const keys = new Set(available.map(product => product.key));
  const products = worldRecipeGroups(economy.snapshot, visibleRecipes, { includeFuture: true })
    .filter(product => keys.has(product.key) || product.methods.some(method => method.id === focusedRecipeId));
  const focusedProduct = products.find(product => product.methods.some(method => method.id === focusedRecipeId));
  // A new source/help target stays visible; choosing another filter is always read-only.
  const filter = basicCampfire || selection.focus !== focusedRecipeId && focusedProduct && !campfireDurationMatches(focusedProduct.recipe.seconds, selection.filter) ? "all" : selection.filter;
  const groups = campfireRecipeGroups(products, filter);
  if (economy.snapshot.jobs.some(job => job.kind === "construction" && job.targetId === "dryer")) return null;
  return <div className={styles.cookingCatalog} data-campfire-catalog>
    {basicCampfire ? <p className={styles.small}>На костре уже можно жарить рыбу. Улучшите костёр, чтобы открыть новые блюда и напитки.</p> : <div className={styles.cookingFilters} role="group" aria-label="Время приготовления">{campfireDurationFilters.map(entry => <button key={entry.id} type="button" aria-pressed={filter === entry.id} data-cooking-duration={entry.id} onClick={() => setSelection({ focus: focusedRecipeId, filter: entry.id })}>{entry.label}</button>)}</div>}
    {groups.map(group => {
      const SectionIcon = cookingSectionIcons[group.id] ?? Package;
      return <section key={group.id} className={styles.recipeGroup} data-cooking-group={group.id} aria-label={group.label}>
        <h3 className={styles.cookingHeading}><SectionIcon size={15} aria-hidden="true" />{group.label}</h3>
        <div className={styles.recipeGrid}>{group.recipes.map(product => <WorldProductionCard key={product.key} economy={economy} recipe={product.recipe} focused={product.methods.some(recipe => recipe.id === focusedRecipeId)} onHelpContextChange={onHelpContextChange} />)}</div>
      </section>;
    })}
    {!groups.length && <p className={styles.empty}>{products.length ? "Нет рецептов с таким временем. Выберите другой фильтр." : "Пока нет доступных рецептов."}</p>}
  </div>;
}

export function WorldObjectSale({ economy, itemId, onCollapse }: { economy: ReadyEconomy; itemId: string; onCollapse: () => void }) {
  const state = economy.snapshot, buyer = state.catalog.localBuyer;
  const item = state.catalog.items.find(entry => entry.id === itemId);
  const minimum = item ? economyLocalSaleMinimumQuantity(item.baseSellPrice, buyer, item.id) : 1;
  const [quantityText, setQuantityText] = useState(() => String(minimum));
  const inputId = useId(), stock = state.inventory[itemId] ?? 0;
  if (!item) return null;
  const maximum = economyLocalSaleLimit(item.baseSellPrice, stock, state.wallet.coins, buyer, item.id);
  const quantity = Number(quantityText);
  const valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity >= minimum && quantity <= maximum;
  const total = valid ? economyLocalSellPrice(item.baseSellPrice, quantity, buyer, item.id) : 0;
  const fixedPrice = buyer?.unitPrices?.[item.id];
  const discount = fixedPrice !== undefined ? 0 : (10_000 - (buyer?.payoutBps ?? 10_000)) / 100;
  return <section className={styles.detail} aria-label={`Продажа: ${item.name}`}>
    <div className={styles.detailTitle}><h3>{item.name}</h3><button type="button" className={styles.iconButton} aria-label="Свернуть продажу" onClick={onCollapse}><ChevronUp size={16} aria-hidden="true" /></button></div>
    <p className={styles.small}>На складе {number(stock)} · {discount > 0 ? `быстрая продажа с уценкой ${number(discount)}%. Итог округляется вниз до целой монеты.` : `торговец даёт ${number(fixedPrice ?? item.baseSellPrice)} монет за штуку`}</p>
    {discount > 0 && fishClassForItem(item.id, state.catalog.fishing) && <p className={styles.hint}>Плёска купит дороже: {number(item.baseSellPrice)} монет за штуку. Её лавка открывается на карте.</p>}
    {item.tradable ? <div className={styles.sale}><label htmlFor={inputId}>Количество</label><input id={inputId} type="number" inputMode="numeric" min={minimum} max={Math.max(minimum, maximum)} step={1} value={quantityText} disabled={locked(economy) || maximum < minimum} onChange={event => setQuantityText(event.target.value)} /><button type="button" className={styles.primary} disabled={!valid || locked(economy)} onClick={() => { if (valid && !locked(economy)) void economy.act("sell", item.id, quantity, buyer ? total : 0); }}>Продать · {valid ? number(total) : "-"}<ItemIcon itemId="coins" size={16} /></button></div> : <p className={styles.hint}>Этот предмет нельзя продать торговцу.</p>}
    {item.tradable && maximum < minimum && <p className={styles.hint}>{stock < minimum ? `Для продажи нужно хотя бы ${number(minimum)} шт., чтобы получить целую монету.` : "В кошельке нет места для продажи."}</p>}
    {item.tradable && !valid && maximum >= minimum && <p className={styles.hint}>Укажите от {number(minimum)} до {number(maximum)}.</p>}
  </section>;
}

function ObjectMenuBody({ appearance, guide, tutorialWorkshop = false, tutorialHarvestActive = false, leaftailAvailable = false, guideRoot: guideRootRef, selection, economy, isOnline, onClose, onBack, onReturnFocus, bounds, onNavigate, onExplore, onOpenPantry, initialStationId, initialRecipeId, constructionGoal, onOpenGoal, onOpenHelp, onHelpContextChange }: WorldObjectMenuProps) {
  const collection = useGardenCollection();
  const seenHarvest = useRef(collection?.request?.requestId);
  useEffect(() => {
    const fresh = collection?.request && collection.request.requestId !== seenHarvest.current;
    seenHarvest.current = collection?.request?.requestId;
    if (fresh && selection.place === "garden" && collection?.phase === "walking") onClose();
  }, [collection?.request, collection?.phase, selection.place, onClose]);
  const definition = worldStations[selection.place] ?? { label: selection.objectId, stationIds: [] };
  const unknownMerchant = selection.place === "leaftail-caravan" && !leaftailAvailable;
  const placeLabel = unknownMerchant ? "Домик путника" : definition.label;
  const placeStatus = unknownMerchant ? "Пока не знакомы" : definition.status;
  const initialStation = initialStationId && definition.stationIds.includes(initialStationId) ? initialStationId : definition.stationIds[0] ?? "";
  const [stationId, setStationId] = useState(initialStation);
  const [recipeId, setRecipeId] = useState<string | null>(initialRecipeId ?? null);
  const [saleItem, setSaleItem] = useState<string | null>(null);
  const [upgradeStation, setUpgradeStation] = useState<string | null>(initialStation === "home" ? "home" : null);
  const upgradeTrigger = useRef<HTMLElement | null>(null);
  const menuBody = useRef<HTMLDivElement>(null);
  const navigating = useRef(false);
  const completedUpgrade = useRef(false);
  const completions = economy.completedConstructions;
  const seenCompletions = useRef(new Set(completions?.map(event => event.id)));
  const [size, setSize] = useState({ width: 320, height: 214 });
  const panel = useRef<HTMLElement>(null);
  const headingId = useId();
  const state = economy.snapshot;
  const { width, maxHeight } = worldMenuDimensions(selection, bounds);
  const position = definition.future
    ? worldMenuPosition(selection, { width, height: Math.min(size.height, maxHeight) }, bounds)
    : worldStableMenuPosition(selection, bounds);
  const showMenu = stationId !== "home";
  const hasStationTabs = definition.stationIds.length > 1;
  const current = state?.buildings[stationId] ?? 0;
  const landmark = stationId === "bridge" || stationId === "lighthouse";
  const building = state?.catalog.buildings.find(entry => entry.id === stationId);
  const target = building?.levels.find(level => level.level === current + 1);
  const recipes = state?.catalog.recipes.filter(recipe => !recipe.retired && recipe.buildingId === stationId) ?? [];
  const focusedRecipe = state ? worldRecipeGroups(state, recipes, { includeFuture: true }).find(group => group.methods.some(recipe => recipe.id === recipeId))?.recipe : undefined;
  const focusedRecipeId = focusedRecipe?.id;
  const focusedAccessReason = state && focusedRecipe ? worldRecipeAccessReason(state, focusedRecipe) : null;
  const jobs = state?.jobs.filter(entry => ["production", "construction"].includes(entry.kind) && entry.targetId === stationId) ?? [];
  const construction = jobs.find(entry => entry.kind === "construction");
  const guidedWorkshopSetup = tutorialWorkshop && stationId === "workshop" && !current && state
    && canStartTutorialWorkshop(state);
  const needsSetup = stationId !== "dryer" && (productionStationSupported(stationId) || stationId === "quarry") && (!current || Boolean(construction));
  const fitOverview = position.side === "sheet" && (needsSetup || ["garden", "dryer", "woodlot", "workshop", "kiln", "quarry"].includes(stationId));
  const readyJobs = state ? jobs.filter(job => job.kind === "production" && worldJobProgress(state, job, economy.now).ready) : [];
  const runningJobs = state ? jobs.filter(job => job.kind === "production" && !worldJobProgress(state, job, economy.now).ready) : [];
  const Icon = placeIcons[selection.place] ?? Package;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));

  useEffect(() => {
    if (definition.future || !stationId) return;
    if (upgradeStation) onHelpContextChange?.({ stationId: upgradeStation, intent: "construction" });
    else if (focusedRecipeId) onHelpContextChange?.({ stationId, intent: "production", recipeId: focusedRecipeId, quantity: 1 });
    else onHelpContextChange?.({ stationId });
  }, [stationId, upgradeStation, focusedRecipeId, onHelpContextChange, definition.future]);

  useEffect(() => {
    const newlyCompleted = completions?.filter(event => !seenCompletions.current.has(event.id)) ?? [];
    seenCompletions.current = new Set(completions?.map(event => event.id));
    if (!upgradeStation && newlyCompleted.some(event => event.stationId === stationId)) {
      completedUpgrade.current = true;
      onClose();
    }
  }, [completions, upgradeStation, stationId, onClose]);

  useEffect(() => {
    const element = panel.current;
    if (!element || !showMenu) return;
    const previous = document.activeElement;
    const targetProduct = element.querySelector<HTMLButtonElement>("[data-recipe-focused=true]");
    (targetProduct ?? element).focus({ preventScroll: true });
    const observer = new ResizeObserver(() => {
      const next = { width: element.offsetWidth, height: element.offsetHeight };
      setSize(value => value.width === next.width && value.height === next.height ? value : next);
    });
    if (definition.future) observer.observe(element);
    return () => { observer.disconnect(); if (previous instanceof HTMLElement && previous.isConnected && element.contains(document.activeElement)) previous.focus({ preventScroll: true }); };
  }, [showMenu, definition.future]);

  function chooseStation(id: string) {
    if (id !== stationId) playUiCue(getAudioRuntime(), "ui.tab");
    setStationId(id); setRecipeId(null); setSaleItem(null); setUpgradeStation(id === "home" ? "home" : null);
    if (menuBody.current) menuBody.current.scrollTop = 0;
  }
  const openHelp = onOpenHelp ? (context: WorldHelpContext) => { navigating.current = true; setUpgradeStation(null); onOpenHelp(context); } : undefined;
  function openUpgrade() { upgradeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setUpgradeStation(stationId); }
  function closeUpgrade() { if (stationId === "home") onClose(); else setUpgradeStation(null); }
  function productContext(context: WorldHelpContext) {
    setRecipeId(context.recipeId ?? null);
    onHelpContextChange?.(context);
  }
  function openStation(id: string, targetRecipeId?: string) {
    if (id === stationId && targetRecipeId && targetRecipeId === recipeId) {
      panel.current?.querySelector<HTMLButtonElement>("[data-recipe-focused=true]")?.focus({ preventScroll: true });
      return;
    }
    if (id === "warehouse" && onOpenPantry) { navigating.current = true; setUpgradeStation(null); onOpenPantry(); }
    else if (definition.stationIds.includes(id)) { chooseStation(id); if (targetRecipeId) setRecipeId(targetRecipeId); }
    else { const place = worldPlaceForStation(id); if (place && onNavigate) { navigating.current = true; setUpgradeStation(null); onNavigate(place, id, targetRecipeId); } }
  }
  const navigation: StationNavigation = { open: openStation, canOpen: id => definition.stationIds.includes(id) || Boolean(onNavigate && worldPlaceForStation(id)), explore: onExplore ? () => { navigating.current = true; setUpgradeStation(null); onExplore(); } : undefined };
  const readyEconomy = state ? { ...economy, snapshot: state } : null;
  const ownedItems = state?.catalog.items.filter(item => (state.inventory[item.id] ?? 0) > 0) ?? [];
  const openPantry = onOpenPantry ?? (() => openStation("warehouse"));
  const openJobPantry = onOpenPantry ?? (selection.place === "house" ? () => chooseStation("warehouse") : onNavigate ? () => onNavigate("house", "warehouse") : undefined);

  return <>{showMenu && <section ref={element => { panel.current = element; if (guideRootRef) guideRootRef.current = element; }} className={styles.menu} role="dialog" aria-modal="false" aria-labelledby={hasStationTabs ? `${headingId}-${stationId}` : headingId} tabIndex={-1} data-place={selection.place} data-side={position.side} style={{ left: position.x, top: fitOverview ? undefined : position.y, bottom: fitOverview ? selection.viewportHeight - position.y - position.height : undefined, width, height: definition.future || fitOverview ? undefined : position.height, maxHeight, "--menu-anchor-x": `${position.anchorX}px`, "--menu-anchor-y": `${position.anchorY}px` } as CSSProperties} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className={`${styles.header} ${hasStationTabs ? styles.tabbedHeader : ""}`}>
      {onBack && <button type="button" className={styles.back} aria-label="Назад к персонажам" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" /></button>}
      {hasStationTabs ? <nav className={styles.stations} role="tablist" aria-label={`Оборудование: ${definition.label}`}>
        {definition.stationIds.map((id, index) => {
          const StationIcon = stationIcons[id] ?? Package;
          const level = state?.buildings[id] ?? 0;
          const title = id === "workshop" ? "Мастерская" : id === "kiln" ? "Печь" : id === "warehouse" ? "Кладовая" : state ? stationName(state, id) : definition.label;
          return <button key={id} id={`${headingId}-${id}`} type="button" role="tab" aria-selected={stationId === id} aria-controls={`${headingId}-content`} tabIndex={stationId === id ? 0 : -1} onClick={() => chooseStation(id)} onKeyDown={event => {
            const nextIndex = event.key === "ArrowRight" ? (index + 1) % definition.stationIds.length : event.key === "ArrowLeft" ? (index + definition.stationIds.length - 1) % definition.stationIds.length : event.key === "Home" ? 0 : event.key === "End" ? definition.stationIds.length - 1 : null;
            if (nextIndex === null) return;
            event.preventDefault();
            event.stopPropagation();
            chooseStation(definition.stationIds[nextIndex]);
            event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[nextIndex]?.focus({ preventScroll: true });
          }}><StationIcon size={15} aria-hidden="true" /><span>{title}<small>{level ? `ур. ${level}` : "закрыто"}</small></span></button>;
        })}
      </nav> : <><span className={styles.placeIcon}><Icon size={23} strokeWidth={1.8} aria-hidden="true" /></span><div><span>{placeStatus ?? (definition.future ? "Будущая ветка" : stationId === "warehouse" ? "Запасы дома" : landmark ? current ? "Восстановлено" : "Требует восстановления" : current || stationId === "dryer" ? `Уровень ${current}` : "Пока не обустроено")}</span><h2 id={headingId}>{stationId === "warehouse" ? "Кладовая" : placeLabel}</h2></div></>}
      {state && !definition.future && target && !guidedWorkshopSetup && <button type="button" data-guide-station-upgrade={stationId} className={styles.headerUpgrade} aria-haspopup="dialog" aria-label={`${construction ? "Ход улучшения" : landmark ? "Восстановить" : current || stationId === "dryer" ? stationId === "warehouse" ? "Расширить кладовую" : "Улучшить" : "Обустроить"}: ${current} → ${target.level} уровень`} onClick={openUpgrade}><Hammer size={17} aria-hidden="true" /><span>{construction ? "Стройка" : landmark ? "Восстановить" : current || stationId === "dryer" ? "Улучшить" : "Построить"}</span></button>}
      <button type="button" className={styles.close} aria-label="Закрыть меню объекта" onClick={onClose}><X size={17} aria-hidden="true" /></button>
    </header>
    <div data-guide-coach-slot />
    {guide}
    <div ref={menuBody} className={styles.body} id={hasStationTabs ? `${headingId}-content` : undefined} role={hasStationTabs ? "tabpanel" : undefined} aria-labelledby={hasStationTabs ? `${headingId}-${stationId}` : undefined}>
      {state && !definition.future && selection.place !== "leaftail-caravan" && constructionGoal && onOpenGoal && <ConstructionGoalSummary state={state} constructionGoal={constructionGoal} onOpenGoal={onOpenGoal} navigation={navigation} compact />}
      {selection.place === "leaftail-caravan" ? <WorldLeaftailMarket appearance={appearance} economy={economy} isOnline={isOnline !== false} introduced={leaftailAvailable} /> : definition.future ? <>
        <div className={styles.future}><LockKeyhole size={22} aria-hidden="true" /><p>{definition.future}</p></div>
      </> : !state ? <div className={styles.loading}><RefreshCw size={17} aria-hidden="true" /><p>{economy.error ?? "Открываем ваше хозяйство…"}</p>{economy.error && <button type="button" className={styles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}>{cooldown ? `Повторить через ${cooldown} с` : "Попробовать ещё раз"}</button>}</div> : <>
        {!economy.syncError && (economy.error || economy.uncertain) && <div className={styles.error} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Новые заказы доступны после подтверждения." : economy.error}</p><button type="button" className={styles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={12} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Повторить"}</button></div>}
        {needsSetup && focusedRecipe && focusedAccessReason && <p className={styles.hint} data-recipe-access>{focusedRecipe.name}. {focusedAccessReason}</p>}
        {readyEconomy && needsSetup ? !guidedWorkshopSetup && <WorldStationSetup economy={readyEconomy} stationId={stationId} onOpenConstruction={openUpgrade} onOpenPantry={openJobPantry} /> : <>
        {readyEconomy && construction && <Work economy={readyEconomy} job={construction} openPantry={openJobPantry} compact />}
        {readyEconomy && !productionStationSupported(stationId) && (readyJobs.length > 0 || runningJobs.length > 0) && <section className={styles.activeOrders} data-section-guide-target="workshop-queue" data-running-orders={runningJobs.length ? stationId : undefined} aria-label="Текущая работа">
          <h3>Сейчас <span>{readyJobs.length + runningJobs.length}</span></h3>
          {[...readyJobs, ...runningJobs].map(job => <Work key={job.id} economy={readyEconomy} job={job} openPantry={openJobPantry} compact />)}
        </section>}
        {readyEconomy && <WorldProductionSlots key={`${state.ownerPublicId}:${stationId}`} economy={readyEconomy} stationId={stationId} openPantry={openJobPantry} compact />}
        {stationId === "quarry" && <WorldMiningProduction economy={economy} isOnline={isOnline} onHelpContextChange={onHelpContextChange} initialRouteId={initialRecipeId} onOpenHelp={openHelp} onOpenPantry={openPantry} onNavigateStation={(id, targetRecipeId) => id === "quarry" ? openUpgrade() : openStation(id, targetRecipeId)} onCancellationComplete={() => panel.current?.focus({ preventScroll: true })} />}
        {landmark ? <section className={styles.recipeGroup} aria-label="Возможности постройки">
          <p className={styles.small}>{building?.description}</p>
          {!current && !construction && <p className={styles.empty}>{stationId === "bridge" ? "Восстановите мост, чтобы открыть рынок игроков." : "Восстановите маяк, чтобы зажечь свет у причала."}</p>}
          {current > 0 && <>
            {stationId === "bridge" && <>
              <h3>Рынок игроков</h3><p className={styles.small}>Мост восстановлен. Торговля с игроками открывается нажатием на рынок на карте.</p>
            </>}
            {stationId === "lighthouse" && <p className={styles.small}>Свет маяка отмечает причал. Пароход с крупными заказами появится в будущем обновлении.</p>}
            <h3>Маршруты экспедиций</h3>
            {state.catalog.explorations.filter(route => !route.retired && Boolean(route.requiredBuildings[stationId])).map(route => <section key={route.id} className={styles.detail}>
              <h4>{route.name}</h4><p className={styles.small}>{route.description} · {worldDuration(route.seconds)}</p>
              <Requirements state={state} required={worldRequirements(route)} navigation={navigation} />
            </section>)}
            {onExplore && <button type="button" className={styles.primary} onClick={() => { navigating.current = true; onExplore(); }}><Compass size={15} aria-hidden="true" />Выбрать экспедицию<ArrowRight size={13} aria-hidden="true" /></button>}
          </>}
        </section> : stationId === "warehouse" ? <><div className={styles.inventoryHeading}><span>Кладовая</span><strong>{number(state.storage.used + state.storage.reserved)} / {number(state.storage.capacity)}</strong></div>{ownedItems.length ? <div className={styles.products} aria-label="Предметы в кладовой">{ownedItems.map(item => <button key={item.id} type="button" className={styles.product} aria-pressed={saleItem === item.id} onClick={() => { setSaleItem(value => value === item.id ? null : item.id); setUpgradeStation(null); }}><ProductIcon state={state} itemId={item.id} /><strong>{item.name}</strong><span>×{number(state.inventory[item.id])}</span></button>)}</div> : <p className={styles.empty}>Пока пусто. Урожай и находки появятся здесь после получения.</p>}{readyEconomy && saleItem && <WorldObjectSale key={saleItem} economy={readyEconomy} itemId={saleItem} onCollapse={() => setSaleItem(null)} />}{state.storage.reserved > 0 && <p className={styles.small}>На рынке зарезервировано {number(state.storage.reserved)} мест.</p>}</> : stationId !== "quarry" ? <>
          <div className={styles.recipeCatalog} data-section-guide-target="workshop-recipes" aria-label={`Продукция: ${building?.name ?? definition.label}`}>{stationId === "dryer" ? <CampfireRecipeCatalog economy={readyEconomy!} recipes={recipes} focusedRecipeId={recipeId} onHelpContextChange={productContext} /> : <RecipeCatalog economy={readyEconomy!} recipes={recipes} focusedRecipeId={recipeId} tutorialHarvestActive={tutorialHarvestActive} onHelpContextChange={productContext} />}</div>
        </> : null}
        </>}
      </>}
    </div>
    {state && !definition.future && selection.place !== "leaftail-caravan" && !target && !jobs.length && !recipes.length && <footer className={styles.footer}><span className={styles.maximum}><Check size={12} aria-hidden="true" />{landmark ? "Восстановление завершено" : "Все уровни оборудования открыты"}</span></footer>}
  </section>}
    <WorldUpgradeDialog stationId={upgradeStation} economy={economy} isOnline={isOnline} onOpenHelp={openHelp} constructionGoal={constructionGoal} onClose={closeUpgrade} onCompleted={() => { completedUpgrade.current = true; onClose(); }} navigation={navigation}
      onOpenPantry={onOpenPantry ? () => { navigating.current = true; setUpgradeStation(null); onOpenPantry(); } : selection.place === "house" ? () => chooseStation("warehouse") : onNavigate ? () => { navigating.current = true; setUpgradeStation(null); onNavigate("house", "warehouse"); } : undefined}
      onCloseAutoFocus={event => {
        event.preventDefault();
        if (completedUpgrade.current) { onReturnFocus?.(); return; }
        if (navigating.current) { navigating.current = false; return; }
        if (upgradeTrigger.current?.isConnected) upgradeTrigger.current.focus({ preventScroll: true });
        else if (panel.current) panel.current.focus({ preventScroll: true });
        else onReturnFocus?.();
      }} />
  </>;
}

export function WorldObjectMenu(props: WorldObjectMenuProps) { return <ObjectMenuBody key={`${props.selection.objectId}:${props.initialStationId ?? ""}:${props.initialRecipeId ?? ""}`} {...props} />; }
export const ObjectMenu = WorldObjectMenu;
