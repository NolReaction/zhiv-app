"use client";

import { fishClassForItem, fishClassInventory } from "@/features/economy/domain/fishing";

import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { ChevronLeft, ChevronRight, ChevronUp, Compass, Fish, Gift, Package, RefreshCw, Snowflake, Store, Sparkles, X } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { FISH_SPECIES_IDS } from "@/features/world/activities/fishing/fish-species";
import { fishSelectionMatches, fishStockEntries, type FishSelection } from "@/features/economy/domain/fish-stock";
import { WorldFishSelection } from "@/features/economy/ui/fishing/world-fish-selection";
import { FishTapFeedbackArt, FishTapFeedbackQuantity, useFishTapFeedback } from "@/features/economy/ui/fishing/fish-tap-feedback";
import { economyLocalSellPrice, economyLocalSaleMinimumQuantity, economyLocalSaleLimit } from "@/features/economy/domain/local-sale";
import { economyMarketUnlocked } from "@/features/economy/domain/market-rules";
import type { EconomyView } from "@/features/economy/domain/model";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { ProductIcon, number, type StationNavigation } from "@/features/economy/ui/shared/world-economy-parts";
import type { ConstructionGoalController } from "@/features/economy/ui/construction/use-construction-goal";
import { ConstructionGoalSummary } from "@/features/economy/ui/construction/construction-goal-summary";
import { groupPantryItems, pantryItemRarity, pantryRarities, pantryRarityNames } from "./pantry-item-presentation";
import styles from "./world-pantry-menu.module.css";

export type WorldPantryMenuProps = {
  economy: EconomyController;
  onExplore: () => void;
  onOpenMarket?: () => void;
  onOpenFishingShop?: () => void;
  constructionGoal?: ConstructionGoalController;
  onOpenGoal?: () => void;
  navigation?: StationNavigation;
  onReturnToGift?: () => void;
  initialTab?: "supplies" | "fridge" | "relics";
  onFishSaleOpenChange?: (open: boolean) => void;
};

type SaleQuantityMode = "manual" | "excess";
type SaleQuantityControl = { text: string; mode: SaleQuantityMode; isCurrent: () => boolean; onChange: (text: string, mode: SaleQuantityMode) => void };
type TapFeedback = ReturnType<typeof useFishTapFeedback>["feedback"];

export function PantrySale({ economy, itemId, fishItemId, compact = false, onClose, onOpenFishingShop, constructionGoal, onFishPickerOpenChange, quantityControl, tapFeedback }: { economy: ReadyEconomy; itemId: string; fishItemId?: string; compact?: boolean; onClose?: () => void; onOpenFishingShop?: () => void; constructionGoal?: ConstructionGoalController; onFishPickerOpenChange?: (open: boolean) => void; quantityControl?: SaleQuantityControl; tapFeedback?: TapFeedback }) {
  const state = economy.snapshot, buyer = state.catalog.localBuyer;
  const item = state.catalog.items.find(entry => entry.id === itemId);
  const fishClass = fishClassForItem(itemId, state.catalog.fishing);
  const minimum = item && item.category !== "special" && item.baseSellPrice > 0 ? economyLocalSaleMinimumQuantity(item.baseSellPrice, buyer, item.id) : 1;
  const [draftQuantityText, setDraftQuantityText] = useState(() => String(minimum));
  const [draftQuantityMode, setDraftQuantityMode] = useState<SaleQuantityMode>("manual");
  const quantityText = quantityControl?.text ?? draftQuantityText, quantityMode = quantityControl?.mode ?? draftQuantityMode;
  const changeQuantity = (text: string, mode: SaleQuantityMode = "manual") => {
    if (quantityControl) quantityControl.onChange(text, mode);
    else { setDraftQuantityText(text); setDraftQuantityMode(mode); }
  };
  const [choosingFish, setChoosingFish] = useState(false);
  const inputId = useId();
  const sale = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null), sent = useRef(false);
  const owner = state.ownerPublicId, revision = state.revision;
  useEffect(() => { if (!economy.busy && !economy.uncertain) sent.current = false; }, [economy.busy, economy.uncertain, economy.error, owner, revision]);
  useEffect(() => {
    // A selected item may be below the fold in a long inventory. Keep its sale
    // controls visible without moving the menu again when a server snapshot arrives.
    if (!compact) sale.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [itemId, compact]);
  const exactFish = fishClass && fishItemId !== undefined;
  const stock = exactFish ? fishStockEntries(state, fishClass.itemId).find(entry => entry.itemId === fishItemId)?.quantity ?? 0 : state.inventory[itemId] ?? 0;
  const displayName = exactFish ? fishItemId === fishClass.itemId ? "Без указания вида" : state.catalog.items.find(entry => entry.id === fishItemId)?.name ?? fishItemId : item?.name ?? itemId;
  const maximum = item ? economyLocalSaleLimit(item.baseSellPrice, stock, state.wallet.coins, buyer, item.id) : 0;
  const fixedPrice = buyer?.unitPrices?.[itemId];
  const discount = fixedPrice !== undefined ? 0 : (10_000 - (buyer?.payoutBps ?? 10_000)) / 100;
  const betterFishPrice = discount > 0 && fishClassForItem(itemId, state.catalog.fishing);
  const goal = constructionGoal?.details;
  const needed = goal?.keepItems[itemId] ?? 0;
  const excess = goal ? Math.min(maximum, goal.excessItems[itemId] ?? 0) : 0;
  const quantity = quantityMode === "excess" ? excess : Number(quantityText);
  const valid = (quantityMode === "excess" || /^\d+$/.test(quantityText)) && Number.isSafeInteger(quantity) && quantity >= minimum && quantity <= maximum;
  const total = valid && item ? economyLocalSellPrice(item.baseSellPrice, quantity, buyer, item.id) : 0;
  const latest = useRef({ economy, itemId, fishItemId, quantityText, quantityMode, quantity, total, choosingFish });
  useLayoutEffect(() => { latest.current = { economy, itemId, fishItemId, quantityText, quantityMode, quantity, total, choosingFish }; },
    [economy, itemId, fishItemId, quantityText, quantityMode, quantity, total, choosingFish]);
  if (!item) return null;
  if (item.category === "special") return <section ref={sale} className={styles.relicGuard} aria-label={item.name}><ItemIcon itemId={item.id} size={30} /><div><h3>{item.name}</h3><p>Можно обменять с другими игроками.</p></div></section>;
  function sell(selection?: FishSelection): boolean {
    const current = latest.current, snapshot = current.economy.snapshot;
    if (sent.current || quantityControl && !quantityControl.isCurrent() || locked(current.economy) || snapshot.ownerPublicId !== owner || snapshot.revision !== revision
      || current.itemId !== itemId || current.fishItemId !== fishItemId || !valid || current.quantityText !== quantityText
      || current.quantityMode !== quantityMode || current.quantity !== quantity || current.total !== total || selection && !current.choosingFish) return false;
    const currentItem = snapshot.catalog.items.find(entry => entry.id === itemId), currentBuyer = snapshot.catalog.localBuyer;
    if (!currentItem?.tradable || currentItem.category === "special") return false;
    const currentStock = exactFish && fishClass ? fishStockEntries(snapshot, fishClass.itemId).find(entry => entry.itemId === fishItemId)?.quantity ?? 0 : snapshot.inventory[itemId] ?? 0;
    if (quantity < economyLocalSaleMinimumQuantity(currentItem.baseSellPrice, currentBuyer, currentItem.id)
      || quantity > economyLocalSaleLimit(currentItem.baseSellPrice, currentStock, snapshot.wallet.coins, currentBuyer, currentItem.id)
      || economyLocalSellPrice(currentItem.baseSellPrice, quantity, currentBuyer, currentItem.id) !== total) return false;
    const fishSelection = selection ?? (exactFish ? { [fishItemId]: quantity } : undefined);
    if (fishClass && !fishSelection) { onFishPickerOpenChange?.(true); setChoosingFish(true); return false; }
    if (fishClass && fishSelection && !fishSelectionMatches(snapshot, { [fishClass.itemId]: quantity }, fishSelection)) return false;
    sent.current = true;
    const accepted = fishSelection ? current.economy.act("sell", currentItem.id, quantity, currentBuyer ? total : 0, fishSelection)
      : current.economy.act("sell", currentItem.id, quantity, currentBuyer ? total : 0);
    if (accepted === false) { sent.current = false; return false; }
    onFishPickerOpenChange?.(false); setChoosingFish(false); return true;
  }
  return <section ref={sale} className={`${styles.pantry} ${styles.sale} ${compact ? styles.compactSale : ""}`} data-guide-pantry-sale data-pantry-sale-compact={compact || undefined} data-fish-sale-item={fishItemId} aria-label={`Продажа: ${displayName}`}>
    {(!compact || exactFish) && <div className={styles.saleHeading}>
      {exactFish ? <ItemIcon itemId={fishItemId} size={22} /> : <ProductIcon state={state} itemId={item.id} size={18} />}
      <h3>{displayName}</h3>
      {onClose && <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Свернуть продажу"><ChevronUp size={16} aria-hidden="true" /></button>}
    </div>}
    <p className={styles.muted}>В запасе {number(stock)} · {compact ? `${number(economyLocalSellPrice(item.baseSellPrice, 1, buyer, item.id))} монет/шт.` : discount > 0 ? `Быстрая продажа с уценкой ${number(discount)}%` : `${number(fixedPrice ?? item.baseSellPrice)} монет за штуку`}</p>
    {!compact && discount > 0 && <p className={styles.muted}>Сумма за всё количество округляется вниз до целой монеты.</p>}
    {betterFishPrice && (!compact || onOpenFishingShop) && <p className={styles.fishBuyer}>{!compact && <>Плёска купит дороже: {number(item.baseSellPrice)} монет за штуку.</>}{onOpenFishingShop && <button type="button" className={styles.textButton} onClick={onOpenFishingShop}>{compact ? `Плёска · ${number(item.baseSellPrice)} монет/шт.` : "К Плёске"}</button>}</p>}
    {goal && needed > 0 && <p className={styles.goalNote}>Для цели «{goal.name}» нужно оставить {number(Math.min(stock, needed))} шт., включая сырьё для изготовления.</p>}
    {item.tradable ? <>
      <div className={styles.saleControls}>
        <label htmlFor={inputId}>Количество</label>
        <FishTapFeedbackQuantity feedback={tapFeedback} itemId={fishItemId ?? itemId}><input id={inputId} type="number" inputMode="numeric" min={minimum} max={Math.max(minimum, maximum)} step={1} value={quantityMode === "excess" ? excess : quantityText} disabled={locked(economy) || maximum < minimum} onChange={event => changeQuantity(event.target.value)} /></FishTapFeedbackQuantity>
        <button type="button" className={styles.textButton} disabled={locked(economy) || maximum < minimum} onClick={() => changeQuantity(String(maximum))}>{maximum < stock ? `До ${number(maximum)}` : "Всё"}</button>
      </div>
      {goal && <button type="button" className={styles.excessButton} aria-pressed={quantityMode === "excess"} disabled={locked(economy) || excess < minimum} onClick={() => changeQuantity(String(excess), "excess")}>Только излишек · {number(excess)} шт.</button>}
      {goal && valid && quantity > excess && needed > 0 && <p className={styles.hint} role="status">В продажу попадут материалы для цели «{goal.name}».</p>}
      <button ref={trigger} type="button" className={styles.sellButton} disabled={!valid || locked(economy)} onClick={() => sell()}>{quantityMode === "excess" ? "Продать излишек" : compact ? "Продать" : "Продать торговцу"} · {valid ? number(total) : "-"}<ItemIcon itemId="coins" size={16} /></button>
      {maximum < minimum && <p className={styles.hint}>{stock === 0 ? "Эти запасы уже закончились." : stock < minimum ? `Для продажи нужно хотя бы ${number(minimum)} шт., чтобы получить целую монету.` : "В кошельке нет места для продажи."}</p>}
      {!valid && maximum >= minimum && <p className={styles.hint}>Укажите от {number(minimum)} до {number(maximum)}.</p>}
    </> : <p className={styles.hint}>Этот предмет нельзя продать торговцу.</p>}
    {choosingFish && fishClass && <WorldFishSelection economy={economy} requiredItems={{ [fishClass.itemId]: quantity }} contextId={`pantry-sale:${itemId}`} confirmLabel="Продать"
      summary={`${number(quantity)} шт. · ${number(total)} монет`}
      onConfirm={sell} onClose={() => { onFishPickerOpenChange?.(false); setChoosingFish(false); }} onCloseAutoFocus={event => {
        event.preventDefault();
        const current = latest.current;
        if (current.itemId === itemId && current.economy.snapshot.ownerPublicId === owner && trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus({ preventScroll: true });
      }} />}
  </section>;
}

type FishSaleChoice = { owner: string; classId: string; fishId: string; text: string; mode: SaleQuantityMode; session: number; element: HTMLButtonElement };
type FishRailSelection = { selectedFishId?: string; saleId?: string; onFocusSale?: () => void; onSelectFish: (classId: string, fishId: string, element: HTMLButtonElement) => void; feedback: TapFeedback };

/** One nonmodal layer keeps every stock card available for switching or adding fish. */
export function PantryFishPopover({ economy, classIds, constructionGoal, onOpenFishingShop, onFishSaleOpenChange }: {
  economy: ReadyEconomy; classIds: string[]; constructionGoal?: ConstructionGoalController;
  onOpenFishingShop?: () => void; onFishSaleOpenChange?: (open: boolean) => void;
}) {
  const state = economy.snapshot, acceptedOwner = state.ownerPublicId, acceptedRevision = state.revision;
  const [choice, setChoice] = useState<FishSaleChoice | null>(null);
  const host = useRef<HTMLDivElement>(null), close = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const origin = useRef<FishSaleChoice | null>(null), nestedPickerOpen = useRef(false), sequence = useRef(0);
  const latest = useRef({ economy, choice, constructionGoal });
  const taps = useFishTapFeedback(`pantry:${state.ownerPublicId}`);
  const headingId = useId(), notify = useRef(onFishSaleOpenChange);
  useLayoutEffect(() => { latest.current = { economy, choice, constructionGoal }; notify.current = onFishSaleOpenChange; }, [economy, choice, constructionGoal, onFishSaleOpenChange]);
  const open = choice !== null && choice.owner === state.ownerPublicId && fishStockEntries(state, choice.classId).some(entry => entry.itemId === choice.fishId && entry.quantity > 0);
  if (choice && !open) setChoice(null);
  useEffect(() => { notify.current?.(open); }, [open, state.ownerPublicId]);
  useEffect(() => () => notify.current?.(false), []);
  function choose(classId: string, fishId: string, element: HTMLButtonElement) {
    const current = latest.current, snapshot = current.economy.snapshot;
    if (locked(current.economy) || snapshot.ownerPublicId !== acceptedOwner || snapshot.revision !== acceptedRevision) return;
    const item = snapshot.catalog.items.find(entry => entry.id === classId);
    const stock = fishStockEntries(snapshot, classId).find(entry => entry.itemId === fishId)?.quantity ?? 0;
    if (!item || stock === 0) return;
    const maximum = economyLocalSaleLimit(item.baseSellPrice, stock, snapshot.wallet.coins, snapshot.catalog.localBuyer, classId);
    const previous = current.choice;
    const same = previous?.owner === snapshot.ownerPublicId && previous.classId === classId && previous.fishId === fishId;
    const oldQuantity = same ? previous.mode === "excess" ? Math.min(maximum, current.constructionGoal?.details?.excessItems[classId] ?? 0) : Number(previous.text) : 0;
    const safeQuantity = Number.isSafeInteger(oldQuantity) && oldQuantity >= 0 ? oldQuantity : 0;
    const quantity = Math.min(maximum, safeQuantity + 1);
    const next: FishSaleChoice = { owner: snapshot.ownerPublicId, classId, fishId, text: String(quantity), mode: "manual",
      session: same ? previous.session : ++sequence.current, element };
    origin.current = next;
    latest.current = { ...current, choice: next };
    nestedPickerOpen.current = false;
    setChoice(next);
    taps.show(fishId, quantity > safeQuantity ? "added" : "limit", quantity);
  }
  function changeQuantity(text: string, mode: SaleQuantityMode) {
    const current = latest.current;
    if (!choice || current.choice?.session !== choice.session || current.choice.owner !== state.ownerPublicId
      || current.choice.fishId !== choice.fishId || current.economy.snapshot.ownerPublicId !== choice.owner) return;
    const next = { ...current.choice, text, mode };
    latest.current = { ...current, choice: next }; setChoice(next); taps.clear();
  }
  return <Popover.Root modal={false} open={open} onOpenChange={value => { if (!value) { latest.current = { ...latest.current, choice: null }; setChoice(null); taps.clear(); } }}>
    <Popover.Anchor virtualRef={{ current: open ? choice.element : null }} />
    <div ref={host} className={styles.fridgeFish} data-pantry-fish-session aria-label="Рыба и еда в холодильнике">
      {classIds.map(classId => <PantryFishClassRow key={classId} economy={economy} classId={classId} selectedFishId={open ? choice.fishId : undefined}
        saleId={open ? `${headingId}-sale` : undefined} onFocusSale={() => {
          if (latest.current.choice?.owner === latest.current.economy.snapshot.ownerPublicId) panel.current?.querySelector<HTMLInputElement>("input")?.focus({ preventScroll: true });
        }} onSelectFish={choose} feedback={taps.feedback} />)}
    </div>
    {open && <Popover.Portal><Popover.Content ref={panel} id={`${headingId}-sale`} className={`${styles.pantry} ${styles.fishPopover}`} side="top" align="center" sideOffset={8} collisionPadding={12}
      aria-labelledby={headingId} data-pantry-sale-popover data-pantry-fish-popover={choice.classId} data-pantry-fish-owner={choice.owner} data-pantry-fish-species={choice.fishId}
      onOpenAutoFocus={event => event.preventDefault()}
      onEscapeKeyDown={event => { event.stopPropagation(); if (nestedPickerOpen.current) event.preventDefault(); }} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()}
      onInteractOutside={event => {
        const target = event.target as HTMLElement | null;
        if (nestedPickerOpen.current || target?.closest?.("[data-pantry-fish-card]") && host.current?.contains(target)) event.preventDefault();
      }} onCloseAutoFocus={event => {
        event.preventDefault();
        const source = origin.current, current = latest.current;
        origin.current = null;
        if (source?.element.isConnected && !source.element.disabled && host.current?.isConnected
          && source.owner === current.economy.snapshot.ownerPublicId) source.element.focus({ preventScroll: true });
      }}>
      <header className={styles.fishPopoverHeading}><strong id={headingId}>{state.catalog.items.find(item => item.id === choice.classId)?.name ?? choice.classId}</strong>
        <Popover.Close asChild><button ref={close} type="button" data-pantry-fish-close aria-label="Закрыть выбор рыбы"><X size={16} aria-hidden="true" /></button></Popover.Close>
      </header>
      <div className={styles.fishPopoverBody}>
        <PantrySale key={`${choice.owner}:${choice.classId}:${choice.fishId}:${choice.session}`} compact economy={economy} itemId={choice.classId} fishItemId={choice.fishId} constructionGoal={constructionGoal}
          quantityControl={{ text: choice.text, mode: choice.mode, onChange: changeQuantity, isCurrent: () => {
            const current = latest.current.choice;
            return current?.owner === choice.owner && current.session === choice.session && current.fishId === choice.fishId && current.text === choice.text && current.mode === choice.mode
              && fishStockEntries(latest.current.economy.snapshot, choice.classId).some(entry => entry.itemId === choice.fishId && entry.quantity > 0);
          } }} tapFeedback={taps.feedback}
          onOpenFishingShop={onOpenFishingShop} onFishPickerOpenChange={value => { nestedPickerOpen.current = value; }} />
      </div>
    </Popover.Content></Popover.Portal>}
  </Popover.Root>;
}

/** A native horizontal rail leaves vertical page scrolling and inventory counts alone. */
export function PantryFishClassRow({ economy, classId, selectedFishId, onSelectFish, feedback, saleId, onFocusSale }: {
  economy: ReadyEconomy; classId: string; selectedFishId?: string; saleId?: string; onFocusSale?: () => void; onSelectFish?: FishRailSelection["onSelectFish"]; feedback?: TapFeedback;
}) {
  const state = economy.snapshot, entries = fishStockEntries(state, classId), headingId = useId();
  const rail = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const contentKey = entries.map(entry => `${entry.itemId}:${entry.quantity}`).join(":");
  useLayoutEffect(() => {
    const element = rail.current;
    if (!element) return;
    const measure = () => {
      const left = element.scrollLeft > 1, right = element.scrollWidth - element.clientWidth - element.scrollLeft > 1;
      setEdges(previous => previous.left === left && previous.right === right ? previous : { left, right });
    };
    measure();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    return () => observer?.disconnect();
  }, [classId, contentKey]);
  if (!entries.length) return null;
  const name = state.catalog.items.find(item => item.id === classId)?.name ?? classId;
  const rarity = fishClassForItem(classId, state.catalog.fishing)?.rarity ?? "common";
  const rarityDescription = `Редкость: ${pantryRarityNames[rarity]}`;
  const total = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  return <section className={styles.fishClassRow} data-pantry-fish-class={classId} data-fish-rarity={fishClassForItem(classId, state.catalog.fishing)?.rarity}
    aria-label={`${name}: ${number(total)}`}>
    <header className={styles.fishClassHeading}><span className={styles.fishClassArt}><ItemIcon itemId={classId} size={32} /></span><h3 id={headingId}>{name}</h3><strong aria-label={`Всего: ${number(total)}`}>×{number(total)}</strong></header>
    <span hidden id={`${headingId}-rarity`}>{rarityDescription}</span>
    <div className={styles.fishRailFrame}>
      <div ref={rail} className={styles.fishRail} role="group" aria-labelledby={headingId} data-pantry-fish-rail={classId} onScroll={event => {
        const element = event.currentTarget, left = element.scrollLeft > 1, right = element.scrollWidth - element.clientWidth - element.scrollLeft > 1;
        setEdges(previous => previous.left === left && previous.right === right ? previous : { left, right });
      }}>
        {entries.map(entry => {
          const fishName = entry.itemId === classId ? "Без указания вида" : state.catalog.items.find(item => item.id === entry.itemId)?.name ?? entry.itemId;
          const card = <button type="button" className={styles.fishCard} data-guide-pantry-item={entry.itemId} data-pantry-fish-card={entry.itemId}
            data-item-rarity={rarity} aria-describedby={`${headingId}-rarity`} data-state={selectedFishId === entry.itemId ? "open" : "closed"} aria-expanded={selectedFishId === entry.itemId} aria-controls={selectedFishId === entry.itemId ? saleId : undefined} aria-haspopup="dialog"
            aria-label={`${fishName}: ${number(entry.quantity)}`} title={`${fishName} · ${rarityDescription}`} onClick={event => onSelectFish?.(classId, entry.itemId, event.currentTarget)} onKeyDown={event => {
              if (event.key === "ArrowDown" && selectedFishId === entry.itemId) { event.preventDefault(); onFocusSale?.(); }
            }}>
            <FishTapFeedbackArt feedback={feedback} itemId={entry.itemId}><ItemIcon itemId={entry.itemId} size={28} /></FishTapFeedbackArt><span>{fishName}</span><strong>×{number(entry.quantity)}</strong>
          </button>;
          return <span key={entry.itemId} style={{ display: "contents" }}>{card}</span>;
        })}
      </div>
      {edges.left && <span className={`${styles.railHint} ${styles.railHintLeft}`} data-rail-edge="left" aria-hidden="true"><ChevronLeft size={14} /></span>}
      {edges.right && <span className={styles.railHint} data-rail-edge="right" aria-hidden="true"><ChevronRight size={14} /></span>}
    </div>
  </section>;
}

export function RelicPantrySection({ state, onExplore, onOpenMarket, rarityDescriptionId }: { state: EconomyView; onExplore: () => void; onOpenMarket?: () => void; rarityDescriptionId?: string }) {
  const items = state.catalog.items.filter(item => item.category === "special");
  const requiredHome = state.catalog.rareDrops?.requiredHomeLevel;
  return <section className={styles.relics} data-guide-pantry-relics aria-label="Реликвии в кладовой">
    <div className={styles.relicList}>{items.map(item => {
      const stock = state.inventory[item.id] ?? 0;
      const rarity = pantryItemRarity(item, state.catalog), description = `Редкость: ${pantryRarityNames[rarity]}`;
      return <article className={styles.relicCard} key={item.id} data-relic={item.id} data-owned={stock > 0} data-item-rarity={rarity} title={`${item.name} · ${description}`} aria-describedby={rarityDescriptionId}>
        <div className={styles.relicHeading}><span className={styles.relicArt}><ItemIcon itemId={item.id} size={48} /></span><div><h3>{item.name}</h3></div><strong aria-label={`В наличии: ${number(stock)}`}>×{number(stock)}</strong></div>
      </article>;
    })}</div>
    {items.length === 0 ? <p className={styles.muted}>Реликвии появятся вместе с новыми маршрутами.</p> : <><p className={styles.muted}>{requiredHome ? `Находки в вылазках с домом ур. ${requiredHome}. ` : "Находки из вылазок. "}Их также можно получить по обмену с другими игроками.</p><div className={styles.relicActions}><button type="button" className={styles.textButton} onClick={onExplore}><Compass size={14} aria-hidden="true" />В путь</button>{onOpenMarket && <button type="button" className={styles.textButton} onClick={onOpenMarket}><Store size={14} aria-hidden="true" />Лавки игроков</button>}</div></>}
  </section>;
}

/** Content only: the map provides the shared menu frame, heading and focus handling. */
export function WorldPantryMenu({ economy, onExplore, onOpenMarket, onOpenFishingShop, constructionGoal, onOpenGoal, navigation, onReturnToGift, onFishSaleOpenChange, initialTab = "supplies" }: WorldPantryMenuProps) {
  const [tab, setTab] = useState(initialTab);
  const tabId = useId(), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const changeTab = (next: NonNullable<WorldPantryMenuProps["initialTab"]>) => {
    if (next !== tab) playUiCue(getAudioRuntime(), "ui.tab");
    setTab(next); setSelectedItemId(null);
  };
  const state = economy.snapshot ? { ...economy.snapshot, inventory: fishClassInventory(economy.snapshot.inventory, economy.snapshot.catalog.fishing) } : null;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const recovery = (economy.error || economy.uncertain) && <div className={styles.error} role="alert">
    <p>{economy.uncertain ? "Проверяем последнее действие. Продажа станет доступна после подтверждения." : economy.error}</p>
    <button type="button" className={styles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={12} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button>
  </div>;
  if (!state) return <div className={styles.pantry} aria-busy={economy.busy || undefined}>{recovery || <p className={styles.loading} role="status"><RefreshCw size={16} aria-hidden="true" />Открываем кладовую…</p>}</div>;

  const { used, reserved, capacity, available, overflow } = state.storage;
  const occupied = used + reserved;
  // This is a view of the same inventory, not another capacity or reward store.
  const fishIds = new Set<string>([...FISH_SPECIES_IDS, ...(state.catalog.fishing?.classes.map(fish => fish.itemId) ?? []), ...(state.catalog.food?.meals.map(meal => meal.itemId) ?? []), ...state.catalog.items.filter(item => item.category === "provisions").map(item => item.id)]);
  const ownedItems = state.catalog.items.filter(item => item.category !== "special" && (state.inventory[item.id] ?? 0) > 0);
  const supplies = ownedItems.filter(item => !fishIds.has(item.id));
  const fishItems = ownedItems.filter(item => fishIds.has(item.id));
  const preparedMeals = fishItems.filter(item => !fishClassForItem(item.id, state.catalog.fishing));
  const fishClasses = state.catalog.fishing?.classes.filter(fish => (state.inventory[fish.itemId] ?? 0) > 0) ?? [];
  const visibleItems = tab === "fridge" ? preparedMeals : supplies;
  const itemGroups = groupPantryItems(visibleItems, state.catalog);
  const relics = state.catalog.items.filter(item => item.category === "special");
  const relicCount = relics.reduce((total, item) => total + (state.inventory[item.id] ?? 0), 0);
  const sections = [
    { id: "supplies", name: "Запасы", count: supplies.length, icon: Package },
    { id: "fridge", name: "Холодильник", count: fishItems.reduce((total, item) => total + state.inventory[item.id], 0), icon: Snowflake },
    { id: "relics", name: "Реликвии", count: relicCount, icon: Sparkles },
  ] as const;
  const marketAvailable = onOpenMarket && economyMarketUnlocked(state, state.catalog);
  const readyEconomy = { ...economy, snapshot: state };
  return <div className={styles.pantry} aria-busy={economy.busy || undefined}>
    {pantryRarities.map(rarity => <span key={rarity} hidden id={`${tabId}-rarity-${rarity}`}>Редкость: {pantryRarityNames[rarity]}</span>)}
    {recovery}
    {onReturnToGift && <button type="button" className={styles.giftReturn} onClick={onReturnToGift}><Gift size={17} aria-hidden="true" />Вернуться к подарку</button>}
    {constructionGoal && onOpenGoal && <ConstructionGoalSummary state={state} constructionGoal={constructionGoal} onOpenGoal={onOpenGoal} navigation={navigation} />}
    <div className={styles.capacity} data-guide-pantry-capacity data-full={available === 0 || undefined}>
      <div><span className={styles.capacityLabel}><Package size={14} aria-hidden="true" />Занято <strong>{number(occupied)} <span>/ {number(capacity)}</span></strong></span><span>{available > 0 ? `Свободно ${number(available)}` : "Все места заняты"}</span></div>
      <progress value={Math.min(capacity, occupied)} max={Math.max(1, capacity)} aria-label={`Кладовая: занято ${occupied} из ${capacity} мест`} />
      {reserved > 0 && <p className={styles.muted}>На рынке {number(reserved)}</p>}
    </div>
    {overflow > 0 && <p className={styles.hint}>Сверх вместимости: {number(overflow)}. Запасы сохранены. Продайте или используйте часть вещей, чтобы получать новые.</p>}
    {reserved > 0 && <p className={styles.muted}>Товары на рынке тоже занимают место до продажи.</p>}

    <div className={styles.pantryTabs} role="tablist" aria-label="Разделы кладовой">{sections.map((entry, index) => <button key={entry.id} type="button" ref={node => { tabs.current[index] = node; }}
      role="tab" id={`${tabId}-${entry.id}`} aria-selected={tab === entry.id} aria-controls={`${tabId}-panel`} tabIndex={tab === entry.id ? 0 : -1}
      onClick={() => changeTab(entry.id)} onKeyDown={event => {
        const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length : event.key === "ArrowRight" ? (index + 1) % sections.length : -1;
        if (next < 0) return;
        event.preventDefault(); changeTab(sections[next].id); tabs.current[next]?.focus();
      }}><entry.icon size={14} aria-hidden="true" /><small>{number(entry.count)}</small><span>{entry.name}</span></button>)}</div>
    <div role="tabpanel" className={styles.pantryPanel} id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
      {tab === "relics" ? <RelicPantrySection state={state} rarityDescriptionId={`${tabId}-rarity-epic`} onExplore={onExplore} onOpenMarket={marketAvailable ? onOpenMarket : undefined} /> : <>
    {tab === "fridge" && <div className={styles.fridgeHeading}><span><Snowflake size={16} aria-hidden="true" />Рыба и готовая еда</span><small>Места общие с кладовой</small></div>}
    {selectedItemId && !fishClassForItem(selectedItemId, state.catalog.fishing) && <PantrySale key={selectedItemId} economy={readyEconomy} itemId={selectedItemId} constructionGoal={constructionGoal} onClose={() => setSelectedItemId(null)} onOpenFishingShop={onOpenFishingShop} />}
    {visibleItems.length > 0 || tab === "fridge" && fishClasses.length > 0 ? <>
      {tab === "fridge" && <PantryFishPopover economy={readyEconomy} classIds={fishClasses.map(fish => fish.itemId)} constructionGoal={constructionGoal}
        onOpenFishingShop={onOpenFishingShop} onFishSaleOpenChange={onFishSaleOpenChange} />}
      {visibleItems.length > 0 && <div className={tab === "fridge" ? styles.preparedMeals : undefined}>
      {tab === "fridge" && <h3>Готовая еда</h3>}
      <div className={styles.itemSections} aria-label={tab === "fridge" ? "Готовая еда в холодильнике" : "Предметы в кладовой"}>
        {itemGroups.map(group => <section key={group.id} className={styles.itemSection} data-pantry-item-group={group.id} aria-label={group.name}>
          {tab === "fridge" ? <h4>{group.name}</h4> : <h3>{group.name}</h3>}
          <div className={styles.items}>{group.items.map(item => {
            const rarity = pantryItemRarity(item, state.catalog), description = `Редкость: ${pantryRarityNames[rarity]}`;
            return <div key={item.id} className={styles.itemGroup}><button type="button" className={styles.item} data-guide-pantry-item={item.id}
              data-item-rarity={rarity} title={`${item.name} · ${description}`} aria-describedby={`${tabId}-rarity-${rarity}`}
              aria-label={`${item.name}: ${number(state.inventory[item.id])}`} aria-pressed={selectedItemId === item.id}
              onClick={() => setSelectedItemId(current => current === item.id ? null : item.id)}>
              <ProductIcon state={state} itemId={item.id} size={20} />
              <span>{item.name}</span>
              <span className={styles.itemStock}><strong>×{number(state.inventory[item.id])}</strong>
              {(constructionGoal?.details?.keepItems[item.id] ?? 0) > 0 && <small className={styles.goalItem}>Для цели: {number(Math.min(state.inventory[item.id], constructionGoal!.details!.keepItems[item.id]))}</small>}</span>
            </button></div>;
          })}</div>
        </section>)}
      </div>
      </div>}
    </> : <div className={styles.empty}>{tab === "fridge" ? <Fish size={25} aria-hidden="true" /> : <Package size={23} aria-hidden="true" />}<p>{tab === "fridge" ? "Здесь будут рыба и готовые блюда." : reserved > 0 && !ownedItems.length ? "Все запасы сейчас на рынке." : "Здесь будут урожай, материалы и находки."}</p>{(tab === "fridge" || reserved === 0) && <button type="button" className={styles.textButton} onClick={onExplore}><Compass size={14} aria-hidden="true" />{tab === "fridge" ? "Выбрать вылазку" : "Отправиться за находками"}</button>}</div>}

      </>}
    </div>

    {marketAvailable && <button type="button" className={styles.market} data-guide-pantry-market onClick={onOpenMarket}><Store size={14} aria-hidden="true" />Рынок игроков</button>}
  </div>;
}
