"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronDown, ChevronUp, Clock3, Fence, Flame, Hammer, House, LockKeyhole, Minus, Package, Pickaxe, Plus, RefreshCw, Sprout, TowerControl, Trees, X, type LucideIcon } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { MapObjectSelection, WorldPlace } from "@/features/world/map-engine";
import type { EconomyView } from "./model";
import { economyLocalSellPrice, economyLocalSaleMinimumQuantity, economyLocalSaleLimit } from "./local-sale";
import type { EconomyController } from "./use-economy";
import { worldBatchLimit, worldDuration, worldJobProgress, worldMenuDimensions, worldMenuPosition, worldStableMenuPosition, worldMissingRequirements, worldPlaceForStation, worldProductionReason, worldRequirements, worldStations, type WorldMenuBounds, type WorldRecipe } from "./world-stations";
import { Cost, Requirements, Work, ProductIcon, stationIcons, itemName, stationName, locked, number, type ReadyEconomy, type StationNavigation } from "./world-economy-parts";
import { WorldUpgradeDialog } from "./world-upgrade-dialog";
import { useGardenCollection } from "./garden-collection-context";
import { WorldExpeditionsMenu } from "./world-expeditions-menu";
import { WorldProductionSlots } from "./world-production-slots";
import type { ConstructionGoalController } from "./use-construction-goal";
import { ConstructionGoalSummary } from "./construction-goal-summary";
import styles from "./world-object-menu.module.css";

export type WorldObjectMenuProps = {
  selection: MapObjectSelection;
  economy: EconomyController;
  onClose: () => void;
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
};
const placeIcons: Partial<Record<WorldPlace, LucideIcon>> = { house: House, garden: Sprout, campfire: Flame, workshop: Hammer, quarry: Pickaxe, woodlot: Trees, bridge: Fence, lighthouse: TowerControl };

function recipeTitle(state: EconomyView, recipe: WorldRecipe) {
  const outputs = Object.keys(recipe.rewards);
  return outputs.length === 1 ? itemName(state, outputs[0]) : recipe.name.split(" · ")[0];
}

function RecipeCard({ state, recipe, onChoose }: { state: EconomyView; recipe: WorldRecipe; onChoose: (id: string) => void }) {
  const missing = worldMissingRequirements(state, worldRequirements(recipe, recipe));
  const results = Object.entries(recipe.rewards);
  return <button type="button" className={`${styles.product} ${styles.recipeCard}`} data-recipe={recipe.id} data-locked={!!missing.length || undefined}
    aria-label={`${recipe.name}: ${results.map(([id, amount]) => `${itemName(state, id)} ×${number(amount)}`).join(", ")}, ${worldDuration(recipe.seconds)}${missing.length ? ", пока закрыто" : ""}`} onClick={() => onChoose(recipe.id)}>
    <span className={styles.recipeOutputs} aria-hidden="true">{results.map(([id, amount]) => <span key={id}><ProductIcon state={state} itemId={id} size={results.length > 1 ? 18 : 25} /><b>×{number(amount)}</b></span>)}</span>
    <strong>{recipeTitle(state, recipe)}</strong>
    <span className={styles.recipeTime}>{missing.length ? <LockKeyhole size={10} aria-hidden="true" /> : <Clock3 size={10} aria-hidden="true" />}{worldDuration(recipe.seconds)}</span>
  </button>;
}

function RecipeCatalog({ state, recipes, onChoose }: { state: EconomyView; recipes: WorldRecipe[]; onChoose: (id: string) => void }) {
  const available = recipes.filter(recipe => !worldMissingRequirements(state, worldRequirements(recipe, recipe)).length);
  const later = recipes.filter(recipe => worldMissingRequirements(state, worldRequirements(recipe, recipe)).length > 0);
  const ordinary = available.filter(recipe => recipe.seconds < 4 * 3600);
  const lengthy = available.filter(recipe => recipe.seconds >= 4 * 3600);
  return <>
    {[{ id: "ordinary", title: "Обычные заказы", recipes: ordinary }, { id: "lengthy", title: "На несколько часов", recipes: lengthy }].filter(group => group.recipes.length).map(group => <section key={group.id} className={styles.recipeGroup} aria-label={group.title}>
      <h3>{group.title}<span>{group.recipes.length}</span></h3>
      <div className={styles.products}>{group.recipes.map(recipe => <RecipeCard key={recipe.id} state={state} recipe={recipe} onChoose={onChoose} />)}</div>
    </section>)}
    {!available.length && <p className={styles.empty}>Сначала обустройте это место.</p>}
    {!!later.length && <details className={styles.laterRecipes}>
      <summary><LockKeyhole size={12} aria-hidden="true" /><span>Позже</span><small>{later.length}</small><ChevronDown size={13} aria-hidden="true" /></summary>
      <div className={styles.products}>{later.map(recipe => <RecipeCard key={recipe.id} state={state} recipe={recipe} onChoose={onChoose} />)}</div>
    </details>}
  </>;
}

export function WorldRecipeDetail({ economy, recipe, navigation, onCollapse }: { economy: ReadyEconomy; recipe: WorldRecipe; navigation?: StationNavigation; onCollapse: () => void }) {
  const [requestedQuantity, setQuantity] = useState(1);
  const backButton = useRef<HTMLButtonElement>(null);
  const maximum = worldBatchLimit(economy.snapshot, recipe);
  const quantity = Math.max(1, Math.min(requestedQuantity, maximum));
  const reason = worldProductionReason(economy.snapshot, recipe, quantity);
  const missingRequirements = worldMissingRequirements(economy.snapshot, worldRequirements(recipe, recipe));
  const output = Object.values(recipe.rewards).reduce((sum, amount) => sum + amount, 0) * quantity;
  const quantityId = useId();
  useEffect(() => { backButton.current?.focus({ preventScroll: true }); backButton.current?.scrollIntoView({ block: "start" }); }, []);
  return <section className={styles.recipeDetail} aria-label={recipe.name}>
    <button ref={backButton} type="button" className={styles.recipeBack} onClick={onCollapse}><ArrowLeft size={14} aria-hidden="true" />Все рецепты</button>
    <div className={styles.resultCards} aria-label="Результат">{Object.entries(recipe.rewards).map(([id, amount]) => <div key={id}><span><ProductIcon state={economy.snapshot} itemId={id} size={24} /></span><strong>{itemName(economy.snapshot, id)}</strong><b>×{number(amount * quantity)}</b></div>)}</div>
    <div className={styles.recipeIngredients}><h3>Понадобится</h3><Cost state={economy.snapshot} cost={recipe.cost} quantity={quantity} navigation={navigation} /></div>
    <Requirements state={economy.snapshot} required={worldRequirements(recipe, recipe)} navigation={navigation} />
    <div className={styles.order}><label htmlFor={quantityId}>Партий</label><div className={styles.stepper}><button type="button" disabled={quantity <= 1 || locked(economy)} onClick={() => setQuantity(quantity - 1)} aria-label="Уменьшить партию"><Minus size={14} aria-hidden="true" /></button><output id={quantityId} aria-live="polite">{quantity}</output><button type="button" disabled={quantity >= maximum || locked(economy)} onClick={() => setQuantity(quantity + 1)} aria-label="Увеличить партию"><Plus size={14} aria-hidden="true" /></button></div><button type="button" className={styles.primary} disabled={Boolean(reason) || locked(economy)} onClick={() => { if (!reason && !locked(economy)) void economy.act("start_production", recipe.id, quantity); }}>Начать · {worldDuration(recipe.seconds * quantity)}</button></div>
    {reason && !missingRequirements.length && <p className={styles.hint}>{reason}</p>}
    {output > economy.snapshot.storage.available && !missingRequirements.length && <p className={styles.hint}>Для получения понадобится {number(output)} мест · свободно {number(economy.snapshot.storage.available)}.</p>}
  </section>;
}

export function WorldObjectSale({ economy, itemId, onCollapse }: { economy: ReadyEconomy; itemId: string; onCollapse: () => void }) {
  const state = economy.snapshot, buyer = state.catalog.localBuyer;
  const item = state.catalog.items.find(entry => entry.id === itemId);
  const minimum = item ? economyLocalSaleMinimumQuantity(item.baseSellPrice, buyer) : 1;
  const [quantityText, setQuantityText] = useState(() => String(minimum));
  const inputId = useId(), stock = state.inventory[itemId] ?? 0;
  if (!item) return null;
  const maximum = economyLocalSaleLimit(item.baseSellPrice, stock, state.wallet.coins, buyer);
  const quantity = Number(quantityText);
  const valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity >= minimum && quantity <= maximum;
  const total = valid ? economyLocalSellPrice(item.baseSellPrice, quantity, buyer) : 0;
  const discount = (10_000 - (buyer?.payoutBps ?? 10_000)) / 100;
  return <section className={styles.detail} aria-label={`Продажа: ${item.name}`}>
    <div className={styles.detailTitle}><h3>{item.name}</h3><button type="button" className={styles.iconButton} aria-label="Свернуть продажу" onClick={onCollapse}><ChevronUp size={16} aria-hidden="true" /></button></div>
    <p className={styles.small}>На складе {number(stock)} · {discount > 0 ? `быстрая продажа с уценкой ${number(discount)}%. Итог округляется вниз до целой монеты.` : `торговец даёт ${number(item.baseSellPrice)} монет за штуку`}</p>
    {discount > 0 && state.catalog.fishing?.fish.some(fish => fish.itemId === item.id) && <p className={styles.hint}>Плёска купит дороже: {number(item.baseSellPrice)} монет за штуку. Её лавка открывается на карте.</p>}
    {item.tradable ? <div className={styles.sale}><label htmlFor={inputId}>Количество</label><input id={inputId} type="number" inputMode="numeric" min={minimum} max={Math.max(minimum, maximum)} step={1} value={quantityText} disabled={locked(economy) || maximum < minimum} onChange={event => setQuantityText(event.target.value)} /><button type="button" className={styles.primary} disabled={!valid || locked(economy)} onClick={() => { if (valid && !locked(economy)) void economy.act("sell", item.id, quantity, buyer ? total : 0); }}>Продать · {valid ? number(total) : "—"}<ItemIcon itemId="coins" size={16} /></button></div> : <p className={styles.hint}>Этот предмет нельзя продать торговцу.</p>}
    {item.tradable && maximum < minimum && <p className={styles.hint}>{stock < minimum ? `Для продажи нужно хотя бы ${number(minimum)} шт., чтобы получить целую монету.` : "В кошельке нет места для продажи."}</p>}
    {item.tradable && !valid && maximum >= minimum && <p className={styles.hint}>Укажите от {number(minimum)} до {number(maximum)}.</p>}
  </section>;
}

function ObjectMenuBody({ selection, economy, onClose, onReturnFocus, bounds, onNavigate, onExplore, onOpenPantry, initialStationId, initialRecipeId, constructionGoal, onOpenGoal }: WorldObjectMenuProps) {
  const collection = useGardenCollection();
  const seenHarvest = useRef(collection?.request?.requestId);
  useEffect(() => {
    const fresh = collection?.request && collection.request.requestId !== seenHarvest.current;
    seenHarvest.current = collection?.request?.requestId;
    if (fresh && selection.place === "garden" && collection?.phase === "walking") onClose();
  }, [collection?.request, collection?.phase, selection.place, onClose]);
  const definition = worldStations[selection.place] ?? { label: selection.objectId, stationIds: [] };
  const initialStation = initialStationId && definition.stationIds.includes(initialStationId) ? initialStationId : definition.stationIds[0] ?? "";
  const [stationId, setStationId] = useState(initialStation);
  const [recipeId, setRecipeId] = useState<string | null>(initialRecipeId ?? null);
  const [saleItem, setSaleItem] = useState<string | null>(null);
  const [upgradeStation, setUpgradeStation] = useState<string | null>(initialStation === "home" ? "home" : null);
  const upgradeTrigger = useRef<HTMLElement | null>(null);
  const recipeTrigger = useRef<HTMLElement | null>(null);
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
  const current = state?.buildings[stationId] ?? 0;
  const building = state?.catalog.buildings.find(entry => entry.id === stationId);
  const target = building?.levels.find(level => level.level === current + 1);
  const recipes = state?.catalog.recipes.filter(recipe => recipe.buildingId === stationId) ?? [];
  const selectedRecipe = state?.catalog.recipes.find(recipe => recipe.id === recipeId && recipe.buildingId === stationId);
  const jobs = state?.jobs.filter(entry => ["production", "construction"].includes(entry.kind) && entry.targetId === stationId) ?? [];
  const construction = jobs.find(entry => entry.kind === "construction");
  const readyJobs = state ? jobs.filter(job => job.kind === "production" && worldJobProgress(state, job, economy.now).ready) : [];
  const runningJobs = state ? jobs.filter(job => job.kind === "production" && !worldJobProgress(state, job, economy.now).ready) : [];
  const nextOrderSeconds = state && runningJobs.length ? Math.min(...runningJobs.map(job => worldJobProgress(state, job, economy.now).seconds)) : 0;
  const Icon = placeIcons[selection.place] ?? Package;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));

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
    element.focus({ preventScroll: true });
    const observer = new ResizeObserver(() => {
      const next = { width: element.offsetWidth, height: element.offsetHeight };
      setSize(value => value.width === next.width && value.height === next.height ? value : next);
    });
    if (definition.future) observer.observe(element);
    return () => { observer.disconnect(); if (previous instanceof HTMLElement && previous.isConnected && element.contains(document.activeElement)) previous.focus({ preventScroll: true }); };
  }, [showMenu, definition.future]);

  function chooseStation(id: string) { setStationId(id); setRecipeId(null); setSaleItem(null); setUpgradeStation(id === "home" ? "home" : null); }
  function openUpgrade() { upgradeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; setUpgradeStation(stationId); }
  function closeUpgrade() { if (stationId === "home") onClose(); else setUpgradeStation(null); }
  function openStation(id: string, targetRecipeId?: string) {
    if (id === stationId && targetRecipeId && targetRecipeId === recipeId) {
      const back = menuBody.current?.querySelector<HTMLButtonElement>(`.${styles.recipeBack}`);
      back?.focus({ preventScroll: true }); back?.scrollIntoView({ block: "start" });
      return;
    }
    if (id === "warehouse" && onOpenPantry) { navigating.current = true; setUpgradeStation(null); onOpenPantry(); }
    else if (definition.stationIds.includes(id)) { chooseStation(id); if (targetRecipeId) setRecipeId(targetRecipeId); }
    else { const place = worldPlaceForStation(id); if (place && onNavigate) { navigating.current = true; setUpgradeStation(null); onNavigate(place, id, targetRecipeId); } }
  }
  function chooseRecipe(id: string) {
    recipeTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setRecipeId(id); setUpgradeStation(null);
    if (menuBody.current) menuBody.current.scrollTop = 0;
  }
  function closeRecipe() {
    setRecipeId(null);
    requestAnimationFrame(() => { if (recipeTrigger.current?.isConnected) recipeTrigger.current.focus(); else panel.current?.focus({ preventScroll: true }); });
  }
  const navigation: StationNavigation = { open: openStation, canOpen: id => definition.stationIds.includes(id) || Boolean(onNavigate && worldPlaceForStation(id)), explore: onExplore ? () => { navigating.current = true; setUpgradeStation(null); onExplore(); } : undefined };
  const readyEconomy = state ? { ...economy, snapshot: state } : null;
  const ownedItems = state?.catalog.items.filter(item => (state.inventory[item.id] ?? 0) > 0) ?? [];
  const openPantry = onOpenPantry ?? (() => openStation("warehouse"));
  const openJobPantry = onOpenPantry ?? (selection.place === "house" ? () => chooseStation("warehouse") : onNavigate ? () => onNavigate("house", "warehouse") : undefined);

  return <>{showMenu && <section ref={panel} className={styles.menu} role="dialog" aria-modal="false" aria-labelledby={headingId} tabIndex={-1} data-place={selection.place} data-side={position.side} style={{ left: position.x, top: position.y, width, height: definition.future ? undefined : position.height, maxHeight, "--menu-anchor-x": `${position.anchorX}px`, "--menu-anchor-y": `${position.anchorY}px` } as CSSProperties} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className={styles.header}><span className={styles.placeIcon}><Icon size={23} strokeWidth={1.8} aria-hidden="true" /></span><div><span>{definition.future ? "Будущая ветка" : stationId === "warehouse" ? "Запасы дома" : current ? `Уровень ${current}` : "Пока не обустроено"}</span><h2 id={headingId}>{stationId === "warehouse" ? "Кладовая" : definition.label}</h2></div><button type="button" className={styles.close} aria-label="Закрыть меню объекта" onClick={onClose}><X size={17} aria-hidden="true" /></button></header>
    {definition.stationIds.length > 1 && <nav className={styles.stations} aria-label={`Оборудование: ${definition.label}`}>{definition.stationIds.map(id => { const StationIcon = stationIcons[id] ?? Package; return <button key={id} type="button" aria-pressed={stationId === id} onClick={() => chooseStation(id)}><StationIcon size={15} aria-hidden="true" />{id === "workshop" ? "Верстак" : state ? stationName(state, id) : id === "warehouse" ? "Кладовая" : id === "kiln" ? "Печь" : definition.label}</button>; })}</nav>}
    <div ref={menuBody} className={styles.body}>
      {state && constructionGoal && onOpenGoal && <ConstructionGoalSummary state={state} constructionGoal={constructionGoal} onOpenGoal={onOpenGoal} navigation={navigation} compact />}
      {definition.future ? <div className={styles.future}><LockKeyhole size={22} aria-hidden="true" /><p>{definition.future}</p></div> : !state ? <div className={styles.loading}><RefreshCw size={17} aria-hidden="true" /><p>{economy.error ?? "Открываем ваше хозяйство…"}</p>{economy.error && <button type="button" className={styles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}>{cooldown ? `Повторить через ${cooldown} с` : "Попробовать ещё раз"}</button>}</div> : <>
        {(economy.error || economy.uncertain) && <div className={styles.error} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Новые заказы доступны после подтверждения." : economy.error}</p><button type="button" className={styles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={12} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Повторить"}</button></div>}
        {readyEconomy && <WorldProductionSlots economy={readyEconomy} stationId={stationId} />}
        {readyEconomy && jobs.filter(job => job.kind === "construction").map(job => <Work key={job.id} economy={readyEconomy} job={job} openPantry={openJobPantry} />)}
        {readyEconomy && readyJobs.map(job => <Work key={job.id} economy={readyEconomy} job={job} openPantry={openJobPantry} />)}
        {readyEconomy && runningJobs.length > 0 && <details key={stationId} className={styles.runningOrders} data-running-orders={stationId}>
          <summary><Clock3 size={13} aria-hidden="true" /><strong>В работе · {runningJobs.length}</strong><span>Ещё {nextOrderSeconds < 60 ? `${nextOrderSeconds} с` : worldDuration(nextOrderSeconds)}</span><ChevronDown size={13} aria-hidden="true" /></summary>
          <div>{runningJobs.map(job => <Work key={job.id} economy={readyEconomy} job={job} openPantry={openJobPantry} />)}</div>
        </details>}
        {stationId === "quarry" && <WorldExpeditionsMenu economy={economy} embeddedCaves onOpenPantry={openPantry} onNavigateStation={id => id === "quarry" ? openUpgrade() : openStation(id)} onCancellationComplete={() => panel.current?.focus({ preventScroll: true })} />}
        {stationId === "warehouse" ? <><div className={styles.inventoryHeading}><span>Кладовая</span><strong>{number(state.storage.used + state.storage.reserved)} / {number(state.storage.capacity)}</strong></div>{ownedItems.length ? <div className={styles.products} aria-label="Предметы в кладовой">{ownedItems.map(item => <button key={item.id} type="button" className={styles.product} aria-pressed={saleItem === item.id} onClick={() => { setSaleItem(value => value === item.id ? null : item.id); setUpgradeStation(null); }}><ProductIcon state={state} itemId={item.id} /><strong>{item.name}</strong><span>×{number(state.inventory[item.id])}</span></button>)}</div> : <p className={styles.empty}>Пока пусто. Урожай и находки появятся здесь после получения.</p>}{readyEconomy && saleItem && <WorldObjectSale key={saleItem} economy={readyEconomy} itemId={saleItem} onCollapse={() => setSaleItem(null)} />}{state.storage.reserved > 0 && <p className={styles.small}>На рынке зарезервировано {number(state.storage.reserved)} мест.</p>}</> : stationId !== "quarry" ? <>
          <div className={styles.recipeCatalog} hidden={Boolean(selectedRecipe)} aria-label={`Продукция: ${building?.name ?? definition.label}`}><RecipeCatalog state={state} recipes={recipes} onChoose={chooseRecipe} /></div>
          {readyEconomy && selectedRecipe && <WorldRecipeDetail key={selectedRecipe.id} economy={readyEconomy} recipe={selectedRecipe} navigation={navigation} onCollapse={closeRecipe} />}
        </> : null}
      </>}
    </div>
    {state && !definition.future && target && <footer className={styles.footer}><button type="button" className={styles.upgradeAction} aria-haspopup="dialog" onClick={openUpgrade}><Hammer size={15} aria-hidden="true" /><span>{construction ? "Ход улучшения" : current ? stationId === "warehouse" ? "Расширить кладовую" : "Улучшить" : "Обустроить"}<small>{current ? `${current} → ${target.level} уровень` : "Первый уровень"}</small></span><ArrowRight size={16} aria-hidden="true" /></button></footer>}
    {state && !definition.future && !target && !jobs.length && !recipes.length && <footer className={styles.footer}><span className={styles.maximum}><Check size={12} aria-hidden="true" />Все уровни оборудования открыты</span></footer>}
  </section>}
    <WorldUpgradeDialog stationId={upgradeStation} economy={economy} constructionGoal={constructionGoal} onClose={closeUpgrade} onCompleted={() => { completedUpgrade.current = true; onClose(); }} navigation={navigation}
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
