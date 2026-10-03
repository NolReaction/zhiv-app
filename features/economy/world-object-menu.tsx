"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Apple, ArrowRight, Blocks, Box, BrickWall, Cable, Check, ChevronDown, ChevronUp, CircleDot, Clock3, Cog, Coins, Combine, CookingPot, Droplets, Fence, Fish, Flame, Gem, Hammer, House, Hourglass, Layers, LockKeyhole, Logs, Minus, Package, Pickaxe, Plus, RectangleHorizontal, RefreshCw, Shirt, Sprout, SquareStack, TowerControl, Trees, Wheat, Wrench, X, type LucideIcon } from "lucide-react";
import type { MapObjectSelection, WorldPlace } from "@/features/world/map-engine";
import { ECONOMY_MAX_BALANCE, type EconomyCost, type EconomyJob, type EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { worldBatchLimit, worldConstructionReason, worldDuration, worldJobProgress, worldMaterialSource, worldMenuDimensions, worldMenuPosition, worldMissingRequirements, worldPlaceForStation, worldProductionReason, worldRequirements, worldStations, type WorldBuildingLevel, type WorldMenuBounds, type WorldRecipe } from "./world-stations";
import styles from "./world-object-menu.module.css";

export type WorldObjectMenuProps = {
  selection: MapObjectSelection;
  economy: EconomyController;
  onClose: () => void;
  /** Safe insets in CSS pixels, in the same map viewport as selection.x/y. */
  bounds?: WorldMenuBounds;
  onNavigate?: (place: WorldPlace) => void;
  onExplore?: () => void;
};
type ReadyEconomy = EconomyController & { snapshot: EconomyView };
type StationNavigation = { open: (id: string) => void; canOpen: (id: string) => boolean; explore?: () => void };
const number = (value: number) => value.toLocaleString("ru-RU");
const itemIcons: Record<string, LucideIcon> = { berries: Apple, wood: Logs, stone: CircleDot, ore: Pickaxe, fiber: Wheat, fish: Fish, planks: Layers, rope: Cable, metal_parts: Cog, dried_berries: Apple, smoked_fish: Fish, clay: CookingPot, sand: Hourglass, charcoal: Flame, iron_ingot: RectangleHorizontal, bricks: BrickWall, glass: Gem, hardwood: Trees, resin: Droplets, cloth: Shirt, beams: Blocks, tools: Wrench, reinforced_parts: Combine, cut_stone: SquareStack };
const stationIcons: Record<string, LucideIcon> = { home: House, warehouse: Package, garden: Sprout, dryer: CookingPot, workshop: Hammer, kiln: Flame, quarry: Pickaxe, woodlot: Trees };
const placeIcons: Partial<Record<WorldPlace, LucideIcon>> = { house: House, garden: Sprout, campfire: Flame, workshop: Hammer, quarry: Pickaxe, woodlot: Trees, bridge: Fence, lighthouse: TowerControl };
const itemName = (state: EconomyView, id: string) => state.catalog.items.find(item => item.id === id)?.name ?? id;
const stationName = (state: EconomyView, id: string) => state.catalog.buildings.find(building => building.id === id)?.name ?? id;
const locked = (economy: EconomyController) => economy.busy || economy.uncertain || economy.retryAt > economy.now;

function ProductIcon({ itemId, size = 24 }: { itemId: string; size?: number }) {
  const Icon = itemIcons[itemId] ?? Box;
  return <Icon size={size} strokeWidth={1.8} aria-hidden="true" />;
}
function Rewards({ state, rewards, quantity = 1 }: { state: EconomyView; rewards: Record<string, number>; quantity?: number }) {
  return <ul className={styles.rewards} aria-label="Результат">{Object.entries(rewards).map(([id, amount]) => <li key={id}><ProductIcon itemId={id} size={16} /><span>{itemName(state, id)}</span><strong>×{number(amount * quantity)}</strong></li>)}</ul>;
}
function Cost({ state, cost, quantity = 1, navigation }: { state: EconomyView; cost: EconomyCost; quantity?: number; navigation?: StationNavigation }) {
  if (!cost.coins && !Object.keys(cost.items).length) return <p className={styles.free}><Sprout size={13} aria-hidden="true" />Без затрат</p>;
  return <ul className={styles.cost} aria-label="Стоимость">{cost.coins > 0 && <li data-missing={state.wallet.coins < cost.coins * quantity || undefined}><Coins size={14} aria-hidden="true" /><span>Монеты</span><strong>{number(state.wallet.coins)} / {number(cost.coins * quantity)}</strong></li>}{Object.entries(cost.items).map(([id, amount]) => {
    const missing = (state.inventory[id] ?? 0) < amount * quantity;
    const source = missing ? worldMaterialSource(state, id) : null;
    const openSource = source?.kind === "production" && navigation?.canOpen(source.stationId) ? () => navigation.open(source.stationId) : source?.kind === "exploration" ? navigation?.explore : undefined;
    return <li key={id} data-missing={missing || undefined}><ProductIcon itemId={id} size={14} /><span>{openSource ? <button type="button" className={styles.textButton} aria-label={`Где получить: ${itemName(state, id)}${source?.kind === "exploration" ? ", В путь" : ""}`} onClick={openSource}>{itemName(state, id)}<ArrowRight size={11} aria-hidden="true" /></button> : itemName(state, id)}</span><strong>{number(state.inventory[id] ?? 0)} / {number(amount * quantity)}</strong></li>;
  })}</ul>;
}
function Requirements({ state, required, navigation }: { state: EconomyView; required: Record<string, number>; navigation?: StationNavigation }) {
  const missing = worldMissingRequirements(state, required);
  if (!missing.length) return null;
  return <ul className={styles.requirements} aria-label="Недостающие условия">{missing.map(({ id, level, current }) => <li key={id}><LockKeyhole size={13} aria-hidden="true" />{navigation?.canOpen(id) ? <button type="button" onClick={() => navigation.open(id)}>{stationName(state, id)} <span>{current}/{level}</span><ArrowRight size={12} aria-hidden="true" /></button> : <span>{stationName(state, id)} · нужен ур. {level} (сейчас {current})</span>}</li>)}</ul>;
}

function Work({ economy, job, openPantry }: { economy: ReadyEconomy; job: EconomyJob; openPantry?: () => void }) {
  const status = worldJobProgress(economy.snapshot, job, economy.now);
  const title = job.kind === "construction" ? `Обустройство · ур. ${job.targetLevel}` : economy.snapshot.catalog.recipes.find(recipe => recipe.id === job.recipeId)?.name ?? "Производство";
  const itemId = Object.keys(job.rewards)[0];
  return <div className={styles.work} data-ready={status.ready || undefined}>
    <div className={styles.workTop}><span className={styles.workIcon}>{job.kind === "construction" ? <Hammer size={21} aria-hidden="true" /> : <ProductIcon itemId={itemId ?? ""} size={22} />}</span><div><strong>{title}</strong><span>{status.ready ? "Готово к получению" : `Осталось ${status.seconds < 60 ? `${status.seconds} с` : worldDuration(status.seconds)}`}</span></div><button type="button" className={styles.claim} disabled={locked(economy) || !status.ready || status.storageShortfall > 0} onClick={() => void economy.act("claim_job", job.id)} aria-label={`${job.kind === "construction" ? "Завершить" : "Забрать"}: ${title}`}>{status.ready ? <Check size={15} aria-hidden="true" /> : <Clock3 size={15} aria-hidden="true" />}{status.ready ? job.kind === "construction" ? "Завершить" : "Забрать" : "В работе"}</button></div>
    <progress className={styles.progress} value={status.progress} max={1} aria-label={`Готовность: ${title}`} />
    {status.storageShortfall > 0 && status.ready && <p className={styles.hint}>Нужно освободить {number(status.storageShortfall)} мест.{openPantry && <button type="button" className={styles.textButton} onClick={openPantry}>К кладовой<ArrowRight size={12} aria-hidden="true" /></button>}</p>}
  </div>;
}

function RecipeDetail({ economy, recipe, navigation, onCollapse }: { economy: ReadyEconomy; recipe: WorldRecipe; navigation?: StationNavigation; onCollapse: () => void }) {
  const [requestedQuantity, setQuantity] = useState(1);
  const maximum = worldBatchLimit(economy.snapshot, recipe);
  const quantity = Math.max(1, Math.min(requestedQuantity, maximum));
  const reason = worldProductionReason(economy.snapshot, recipe, quantity);
  const output = Object.values(recipe.rewards).reduce((sum, amount) => sum + amount, 0) * quantity;
  const quantityId = useId();
  return <section className={styles.detail} aria-label={recipe.name}>
    <div className={styles.detailTitle}><h3>{recipe.name}</h3><button type="button" className={styles.iconButton} aria-label="Свернуть рецепт" onClick={onCollapse}><ChevronUp size={16} aria-hidden="true" /></button></div>
    <Rewards state={economy.snapshot} rewards={recipe.rewards} quantity={quantity} />
    <Cost state={economy.snapshot} cost={recipe.cost} quantity={quantity} navigation={navigation} />
    <Requirements state={economy.snapshot} required={worldRequirements(recipe, recipe)} navigation={navigation} />
    <div className={styles.order}><label htmlFor={quantityId}>Партий</label><div className={styles.stepper}><button type="button" disabled={quantity <= 1 || locked(economy)} onClick={() => setQuantity(quantity - 1)} aria-label="Уменьшить партию"><Minus size={14} aria-hidden="true" /></button><output id={quantityId} aria-live="polite">{quantity}</output><button type="button" disabled={quantity >= maximum || locked(economy)} onClick={() => setQuantity(quantity + 1)} aria-label="Увеличить партию"><Plus size={14} aria-hidden="true" /></button></div><button type="button" className={styles.primary} disabled={Boolean(reason) || locked(economy)} onClick={() => void economy.act("start_production", recipe.id, quantity)}>Начать · {worldDuration(recipe.seconds * quantity)}</button></div>
    {reason ? <p className={styles.hint}>{reason}</p> : <p className={styles.small}>Результат: {number(output)} мест · свободно {number(economy.snapshot.storage.available)}. Место понадобится при получении.</p>}
  </section>;
}

function ConstructionDetail({ economy, stationId, target, navigation, pickRecipe }: { economy: ReadyEconomy; stationId: string; target: WorldBuildingLevel; navigation?: StationNavigation; pickRecipe: (id: string) => void }) {
  const reason = worldConstructionReason(economy.snapshot, stationId, target);
  const current = economy.snapshot.buildings[stationId] ?? 0;
  const newRecipes = economy.snapshot.catalog.recipes.filter(recipe => recipe.buildingId === stationId && recipe.buildingLevel === target.level);
  return <section className={styles.detail} aria-label={`Обустройство: ${stationName(economy.snapshot, stationId)}`}>
    <div className={styles.upgradeTitle}><Hammer size={16} aria-hidden="true" /><h3>{current ? `Оборудование · уровень ${target.level}` : "Обустройство места"}</h3><span><Clock3 size={12} aria-hidden="true" />{worldDuration(target.seconds)}</span></div>
    <Cost state={economy.snapshot} cost={target.cost} navigation={navigation} />
    <Requirements state={economy.snapshot} required={worldRequirements(target)} navigation={navigation} />
    {!!target.warehouseCapacity && <p className={styles.small}>Вместимость: {number(target.warehouseCapacity)} предметов</p>}
    {!!newRecipes.length && <div className={styles.newRecipes}><span>Откроет</span>{newRecipes.map(recipe => <button key={recipe.id} type="button" className={styles.textButton} onClick={() => pickRecipe(recipe.id)}>{recipe.name}<ArrowRight size={11} aria-hidden="true" /></button>)}</div>}
    <button type="button" className={styles.primary} disabled={Boolean(reason) || locked(economy)} onClick={() => void economy.act("start_construction", stationId)}>{current ? `Улучшить до ур. ${target.level}` : "Начать обустройство"}</button>
    {reason && <p className={styles.hint}>{reason}</p>}
  </section>;
}

function Sale({ economy, itemId, onCollapse }: { economy: ReadyEconomy; itemId: string; onCollapse: () => void }) {
  const [quantityText, setQuantityText] = useState("1");
  const inputId = useId();
  const item = economy.snapshot.catalog.items.find(entry => entry.id === itemId);
  const stock = economy.snapshot.inventory[itemId] ?? 0;
  if (!item) return null;
  const maximum = Math.max(0, Math.min(stock, 10_000, Math.floor((ECONOMY_MAX_BALANCE - economy.snapshot.wallet.coins) / item.baseSellPrice)));
  const quantity = Number(quantityText);
  const valid = Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= maximum;
  return <section className={styles.detail} aria-label={`Продажа: ${item.name}`}><div className={styles.detailTitle}><h3>{item.name}</h3><button type="button" className={styles.iconButton} aria-label="Свернуть продажу" onClick={onCollapse}><ChevronUp size={16} aria-hidden="true" /></button></div><p className={styles.small}>На складе {number(stock)} · торговец даёт {number(item.baseSellPrice)} монет за штуку</p>{item.tradable ? <div className={styles.sale}><label htmlFor={inputId}>Количество</label><input id={inputId} type="number" inputMode="numeric" min={1} max={maximum} step={1} value={quantityText} disabled={locked(economy)} onChange={event => setQuantityText(event.target.value)} /><button type="button" className={styles.primary} disabled={!valid || locked(economy)} onClick={() => void economy.act("sell", item.id, quantity)}>Продать · {valid ? number(quantity * item.baseSellPrice) : "—"}<Coins size={13} aria-hidden="true" /></button></div> : <p className={styles.hint}>Этот предмет нельзя продать торговцу.</p>}</section>;
}

function ObjectMenuBody({ selection, economy, onClose, bounds, onNavigate, onExplore }: WorldObjectMenuProps) {
  const definition = worldStations[selection.place] ?? { label: selection.objectId, stationIds: [] };
  const [stationId, setStationId] = useState(definition.stationIds[0] ?? "");
  const [recipeId, setRecipeId] = useState<string | null>(null);
  const [saleItem, setSaleItem] = useState<string | null>(null);
  const [upgradeOpen, setUpgradeOpen] = useState(false);
  const [size, setSize] = useState({ width: 320, height: 214 });
  const panel = useRef<HTMLElement>(null);
  const headingId = useId();
  const state = economy.snapshot;
  const { width, maxHeight } = worldMenuDimensions(selection, bounds);
  const position = worldMenuPosition(selection, { width, height: Math.min(size.height, maxHeight) }, bounds);
  const current = state?.buildings[stationId] ?? 0;
  const building = state?.catalog.buildings.find(entry => entry.id === stationId);
  const target = building?.levels.find(level => level.level === current + 1);
  const recipes = state?.catalog.recipes.filter(recipe => recipe.buildingId === stationId && recipe.buildingLevel <= Math.max(1, current)) ?? [];
  const selectedRecipe = state?.catalog.recipes.find(recipe => recipe.id === recipeId && recipe.buildingId === stationId);
  const job = state?.jobs.find(entry => ["production", "construction"].includes(entry.kind) && entry.targetId === stationId);
  const Icon = placeIcons[selection.place] ?? Package;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));

  useEffect(() => {
    const element = panel.current;
    if (!element) return;
    const previous = document.activeElement;
    element.focus({ preventScroll: true });
    const observer = new ResizeObserver(() => {
      const next = { width: element.offsetWidth, height: element.offsetHeight };
      setSize(value => value.width === next.width && value.height === next.height ? value : next);
    });
    observer.observe(element);
    return () => { observer.disconnect(); if (previous instanceof HTMLElement && previous.isConnected && element.contains(document.activeElement)) previous.focus({ preventScroll: true }); };
  }, []);

  function chooseStation(id: string) { setStationId(id); setRecipeId(null); setSaleItem(null); setUpgradeOpen(false); }
  function openStation(id: string) {
    if (definition.stationIds.includes(id)) chooseStation(id);
    else { const place = worldPlaceForStation(id); if (place) onNavigate?.(place); }
  }
  function chooseRecipe(id: string) { setRecipeId(value => value === id ? null : id); setUpgradeOpen(false); }
  const navigation: StationNavigation = { open: openStation, canOpen: id => definition.stationIds.includes(id) || Boolean(onNavigate && worldPlaceForStation(id)), explore: onExplore };
  const readyEconomy = state ? { ...economy, snapshot: state } : null;
  const ownedItems = state?.catalog.items.filter(item => (state.inventory[item.id] ?? 0) > 0) ?? [];

  return <section ref={panel} className={styles.menu} role="dialog" aria-modal="false" aria-labelledby={headingId} tabIndex={-1} data-place={selection.place} data-side={position.side} style={{ left: position.x, top: position.y, width, maxHeight, "--menu-anchor-x": `${position.anchorX}px`, "--menu-anchor-y": `${position.anchorY}px` } as CSSProperties} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className={styles.header}><span className={styles.placeIcon}><Icon size={23} strokeWidth={1.8} aria-hidden="true" /></span><div><span>{definition.future ? "Будущая ветка" : stationId === "warehouse" ? "Запасы дома" : current ? `Уровень ${current}` : "Пока не обустроено"}</span><h2 id={headingId}>{definition.label}</h2></div>{state && !definition.future && <span className={styles.coins} aria-label={`${number(state.wallet.coins)} монет`}><Coins size={13} aria-hidden="true" />{number(state.wallet.coins)}</span>}<button type="button" className={styles.close} aria-label="Закрыть меню объекта" onClick={onClose}><X size={17} aria-hidden="true" /></button></header>
    {definition.stationIds.length > 1 && <nav className={styles.stations} aria-label={`Оборудование: ${definition.label}`}>{definition.stationIds.map(id => { const StationIcon = stationIcons[id] ?? Package; return <button key={id} type="button" aria-pressed={stationId === id} onClick={() => chooseStation(id)}><StationIcon size={15} aria-hidden="true" />{id === "workshop" ? "Верстак" : state ? stationName(state, id) : id === "warehouse" ? "Кладовая" : id === "kiln" ? "Печь" : definition.label}</button>; })}</nav>}
    <div className={styles.body}>
      {definition.future ? <div className={styles.future}><LockKeyhole size={22} aria-hidden="true" /><p>{definition.future}</p></div> : !state ? <div className={styles.loading}><RefreshCw size={17} aria-hidden="true" /><p>{economy.error ?? "Открываем ваше хозяйство…"}</p>{economy.error && <button type="button" className={styles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}>{cooldown ? `Повторить через ${cooldown} с` : "Попробовать ещё раз"}</button>}</div> : <>
        {(economy.error || economy.uncertain) && <div className={styles.error} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Новые заказы доступны после подтверждения." : economy.error}</p><button type="button" className={styles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={12} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Повторить"}</button></div>}
        {economy.notice && <p className={styles.notice} role="status"><Check size={12} aria-hidden="true" />{economy.notice}</p>}
        {readyEconomy && job && <Work economy={readyEconomy} job={job} openPantry={selection.place === "house" ? () => chooseStation("warehouse") : onNavigate ? () => onNavigate("house") : undefined} />}
        {stationId === "warehouse" ? <><div className={styles.inventoryHeading}><span>Кладовая</span><strong>{number(state.storage.used + state.storage.reserved)} / {number(state.storage.capacity)}</strong></div>{ownedItems.length ? <div className={styles.products} aria-label="Предметы в кладовой">{ownedItems.map(item => <button key={item.id} type="button" className={styles.product} aria-pressed={saleItem === item.id} onClick={() => { setSaleItem(value => value === item.id ? null : item.id); setUpgradeOpen(false); }}><ProductIcon itemId={item.id} /><strong>{item.name}</strong><span>×{number(state.inventory[item.id])}</span></button>)}</div> : <p className={styles.empty}>Пока пусто. Урожай и находки появятся здесь после получения.</p>}{readyEconomy && saleItem && <Sale key={saleItem} economy={readyEconomy} itemId={saleItem} onCollapse={() => setSaleItem(null)} />}{state.storage.reserved > 0 && <p className={styles.small}>На рынке зарезервировано {number(state.storage.reserved)} мест.</p>}</> : stationId === "home" ? <div className={styles.homePeek}><House size={28} aria-hidden="true" /><div><strong>{building?.name}</strong><p>Следующий уровень открывает новое оборудование и маршруты.</p></div></div> : <>{!!recipes.length && <div className={styles.products} aria-label={`Продукция: ${building?.name ?? definition.label}`}>{recipes.map(recipe => { const outputs = Object.keys(recipe.rewards); const blocked = worldMissingRequirements(state, worldRequirements(recipe, recipe)).length > 0; return <button key={recipe.id} type="button" className={styles.product} aria-pressed={recipeId === recipe.id} data-locked={blocked || undefined} aria-label={`${recipe.name}, ${worldDuration(recipe.seconds)}${blocked ? ", пока закрыто" : ""}`} onClick={() => chooseRecipe(recipe.id)}>{outputs.length === 1 ? <ProductIcon itemId={outputs[0]} /> : <Package size={24} strokeWidth={1.8} aria-hidden="true" />}<strong>{outputs.length === 1 ? itemName(state, outputs[0]) : recipe.name}</strong><span>{blocked && <LockKeyhole size={10} aria-hidden="true" />}{worldDuration(recipe.seconds)}</span></button>; })}</div>}{readyEconomy && selectedRecipe && <RecipeDetail key={selectedRecipe.id} economy={readyEconomy} recipe={selectedRecipe} navigation={navigation} onCollapse={() => setRecipeId(null)} />}</>}
        {readyEconomy && target && (upgradeOpen || !current && !recipeId && !job) && <ConstructionDetail economy={readyEconomy} stationId={stationId} target={target} navigation={navigation} pickRecipe={chooseRecipe} />}
      </>}
    </div>
    {state && !definition.future && target && current > 0 && !job && <footer className={styles.footer}><button type="button" className={styles.upgradeToggle} aria-expanded={upgradeOpen} onClick={() => { setUpgradeOpen(value => !value); setRecipeId(null); setSaleItem(null); }}><Hammer size={14} aria-hidden="true" />{stationId === "home" ? "Развить дом" : stationId === "warehouse" ? "Расширить кладовую" : "Улучшить оборудование"}<span>ур. {target.level}</span>{upgradeOpen ? <ChevronUp size={13} aria-hidden="true" /> : <ChevronDown size={13} aria-hidden="true" />}</button></footer>}
    {state && !definition.future && !target && !job && <footer className={styles.footer}><span className={styles.maximum}><Check size={12} aria-hidden="true" />Все уровни оборудования открыты</span></footer>}
  </section>;
}

export function WorldObjectMenu(props: WorldObjectMenuProps) { return <ObjectMenuBody key={props.selection.objectId} {...props} />; }
export const ObjectMenu = WorldObjectMenu;
