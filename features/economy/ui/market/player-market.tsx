"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeftRight, ArrowRight, CircleHelp, LockKeyhole, Package, Plus, RefreshCw, ShoppingBasket, Store, X } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyMarketListing, EconomyView } from "@/features/economy/domain/model";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { fishClassForItem } from "@/features/economy/domain/fishing";
import { economyMarketUnlocked, marketDailyLimit, marketItemUnlocked, marketMinimumPrice, marketSaleFee, marketSlotCount } from "@/features/economy/domain/market-rules";
import { fishSelectionMatches, type FishSelection } from "@/features/economy/domain/fish-stock";
import { WorldFishSelection } from "@/features/economy/ui/fishing/world-fish-selection";
import { MarketRefreshProgress } from "@/features/economy/ui/shared/market-refresh-progress";
import { marketRefreshAvailable, watchMarketRefreshAvailability } from "@/features/economy/ui/shared/market-refresh-availability";
import { WorldMarketSlots } from "./world-market-slots";
import { MarketSaleCard } from "./market-sale-card";
import { neighborListingGuidance, suggestedMarketListing } from "./neighbor-listing-guidance";
import styles from "./player-market.module.css";

type Item = EconomyView["catalog"]["items"][number];
export type MarketNavigate = (tab: "barter" | "buildings" | "exploration" | "inventory", focusId?: string) => void;
type Navigate = MarketNavigate;
const number = (value: number) => value.toLocaleString("ru-RU");
const itemName = (state: EconomyView, id: string) => state.catalog.items.find(item => item.id === id)?.name ?? "Предмет";
const buildingName = (state: EconomyView, id: string) => state.catalog.buildings.find(building => building.id === id)?.name ?? "Постройка";
const canTrade = (state: EconomyView) => economyMarketUnlocked(state, state.catalog);
const duration = (seconds: number) => {
  const minutes = Math.max(1, Math.ceil(seconds / 60)), hours = Math.floor(minutes / 60);
  return hours ? `${hours} ч${minutes % 60 ? ` ${minutes % 60} мин` : ""}` : `${minutes} мин`;
};
function integer(value: string, maximum: number) {
  if (!/^\d+$/.test(value)) return null;
  const result = Number(value);
  return Number.isSafeInteger(result) && result >= 1 && result <= maximum ? result : null;
}

export function OfferCard({ economy, offer, owned, navigate }: { economy: ReadyEconomy; offer: EconomyMarketListing; owned?: boolean; navigate: Navigate }) {
  const { snapshot: state, busy, uncertain } = economy;
  const [confirm, setConfirm] = useState(false);
  const confirmation = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), wasConfirming = useRef(false);
  useEffect(() => {
    if (confirm) confirmation.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) trigger.current?.focus({ preventScroll: true });
    wasConfirming.current = confirm;
  }, [confirm]);
  const enough = state.wallet.coins >= offer.totalPrice, unlocked = canTrade(state), room = offer.quantity <= state.storage.available;
  const itemUnlocked = marketItemUnlocked(state, offer.itemId, state.catalog);
  const minimum = marketMinimumPrice(offer.itemId, offer.quantity, state.catalog);
  const oldPrice = offer.totalPrice < minimum || offer.totalPrice > minimum * state.catalog.market.maxPriceMultiplier;
  const budget = economy.market?.tradeBudget;
  const dailyBlocked = !!budget && (economy.now >= Date.parse(budget.resetsAt) || budget.buysUsed + minimum > budget.limit);
  const expired = Boolean(economy.market?.showcase && economy.now >= Date.parse(economy.market.showcase.refreshAt));
  const disabled = busy || uncertain || (!owned && (!enough || !unlocked || !room || !itemUnlocked || oldPrice || expired || dailyBlocked));
  const label = `${itemName(state, offer.itemId)} × ${number(offer.quantity)}`;
  const actionLabel = owned ? "Вернуть на склад" : !unlocked ? "Рынок пока закрыт" : expired ? "Обновите витрину" : dailyBlocked ? "Дневной объём покупок" : !itemUnlocked ? "Товар ещё не открыт" : oldPrice ? "Предложение недоступно" : !room ? "Не хватает места на складе" : enough ? "Купить весь лот" : "Не хватает монет";
  return <article className={`${styles.card} ${styles.offerCard}`} role="listitem" aria-label={label} data-market-offer={offer.id}>
    <div className={styles.cardHeader}><span className={styles.iconTile}><ItemIcon itemId={offer.itemId} size={22} /></span><div><h3>{label}</h3><p className={styles.offerSeller}>{owned ? "Ваш прилавок" : `Продавец: ${offer.sellerName}`}</p></div></div>
    <div className={styles.offerMeta}><span className={styles.offerPrice}><ItemIcon itemId="coins" size={16} />{number(offer.totalPrice)}<span className={styles.sr}> монет</span></span><span className={styles.offerPriceLabel}>за весь лот</span></div>
    <p className={styles.offerUnit}>{(offer.totalPrice / offer.quantity).toLocaleString("ru-RU", { maximumFractionDigits: 2 })} за шт. · {itemUnlocked ? "Предмет открыт" : "Пока недоступен"}</p>
    {owned && <p className={styles.offerUnit}>После продажи: {number(offer.totalPrice - marketSaleFee(offer.totalPrice, offer.feeBps ?? 0))} монет{offer.feeBps ? ` · сбор ${offer.feeBps / 100}%` : " · без сбора"}</p>}
    {owned && minimum > marketDailyLimit(state.buildings.home ?? 1, state.catalog) && <p className={styles.hint}>Партия превышает дневной объём. Верните товар на склад и разделите на меньшие лоты.</p>}
    {owned && oldPrice && <p className={styles.hint}>Цена вне новых границ. Этот лот скрыт от покупателей: верните товар на склад и выставьте заново.</p>}
    {confirm ? <div ref={confirmation} className={styles.confirmation} role="group" tabIndex={-1} aria-label={`${owned ? "Возврат на склад" : "Подтверждение покупки"}: ${label}`}><p>{owned ? "Снять предложение и вернуть все предметы на склад?" : `Получите ${number(offer.quantity)} шт. за ${number(offer.totalPrice)} монет. Покупается весь лот.`}</p><div className={styles.actions}><button disabled={busy || uncertain} onClick={() => setConfirm(false)}>Назад</button><button className={styles.primary} disabled={disabled} aria-label={`${owned ? "Снять с продажи" : "Подтвердить покупку"}: ${label}${owned ? "" : ` за ${number(offer.totalPrice)} монет`}`} onClick={() => { if (disabled) return; if (owned) void economy.actMarket("cancel_listing", offer.id); else void economy.actMarket("buy_listing", offer.id, offer.quantity, offer.totalPrice); }}>{owned ? "Снять с продажи" : "Подтвердить покупку"}</button></div></div>
      : <button ref={trigger} disabled={disabled} aria-label={`${actionLabel}: ${label}${owned ? "" : ` за ${number(offer.totalPrice)} монет`}`} onClick={() => { if (!disabled) setConfirm(true); }}>{actionLabel}</button>}
    {!owned && !room && <div className={styles.hint}><Package size={15} aria-hidden /><div>Лот занимает {number(offer.quantity)} мест, свободно {number(state.storage.available)}.<br /><button className={styles.textButton} onClick={() => navigate("inventory")}>Освободить место<ArrowRight size={15} aria-hidden /></button></div></div>}
  </article>;
}

export function ListingForm({ economy }: { economy: ReadyEconomy }) {
  const { snapshot: state, busy, uncertain } = economy;
  const items = state.catalog.items.filter(item => item.tradable && (state.inventory[item.id] ?? 0) > 0 && marketItemUnlocked(state, item.id, state.catalog));
  const [selected, setSelected] = useState(items[0]?.id ?? "");
  const item = items.find(entry => entry.id === selected) ?? items[0];
  const itemId = useId();
  if (!item) return <div className={styles.empty}><ShoppingBasket size={32} aria-hidden /><h3>Пока нечего выставить</h3><p className={styles.muted}>Сначала заберите урожай или материалы. На прилавок попадут только выбранные вами товары.</p></div>;
  return <div className={styles.stack} data-guide-market-create><label className={styles.field} htmlFor={itemId}>Товар<select id={itemId} value={item.id} disabled={busy || uncertain} onChange={event => setSelected(event.target.value)}>{items.map(entry => <option key={entry.id} value={entry.id}>{entry.name} · есть {number(state.inventory[entry.id])}</option>)}</select></label>
    <ListingPriceForm key={item.id} economy={economy} item={item} />
  </div>;
}

export function ListingPriceForm({ economy, item }: { economy: ReadyEconomy; item: Item }) {
  const { snapshot: state, busy, uncertain } = economy;
  const suggested = suggestedMarketListing(item.id, state.inventory[item.id] ?? 0, state.catalog);
  const firstQuantity = suggested.minimumQuantity;
  const [amount, setAmount] = useState(String(suggested.quantity)), [price, setPrice] = useState(String(suggested.price));
  const [choosingFish, setChoosingFish] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusOrigin = useRef<{ element: HTMLButtonElement | null; owner: string; itemId: string } | null>(null);
  const pending = useRef<{ owner: string; revision: number; busySeen: boolean; previousError: string | null } | null>(null);
  const quantityId = useId(), priceId = useId();
  const limits = state.catalog.market;
  const quantityMax = Math.min(limits.maxLotQuantity, state.inventory[item.id] ?? 0, Math.floor(marketDailyLimit(state.buildings.home ?? 1, state.catalog) / item.baseSellPrice));
  const quantity = integer(amount, quantityMax);
  const quantum = state.catalog.currencyScale;
  const maximum = quantity ? Math.floor(item.baseSellPrice * limits.maxPriceMultiplier * quantity / quantum) * quantum : 0;
  const totalPrice = integer(price, maximum);
  const rawMinimum = quantity ? marketMinimumPrice(item.id, quantity, state.catalog) : item.baseSellPrice;
  const minimum = Math.ceil(rawMinimum / quantum) * quantum;
  const valid = Boolean(quantity && totalPrice && totalPrice >= minimum && totalPrice % quantum === 0);
  const neighborHint = neighborListingGuidance(economy.neighbor, state.ownerPublicId, item.id, quantity, totalPrice, economy.now, state.catalog);
  const slots = marketSlotCount(state, state.catalog);
  const full = (economy.market?.mine.length ?? 0) >= slots;
  const disabled = !valid || full || busy || uncertain || economy.retryAt > economy.now || !canTrade(state) || !marketItemUnlocked(state, item.id, state.catalog);
  const fishClass = fishClassForItem(item.id, state.catalog.fishing);
  const latest = useRef({ economy, item, quantity, totalPrice, disabled });
  useEffect(() => {
    latest.current = { economy, item, quantity, totalPrice, disabled };
    const request = pending.current;
    if (!request) return;
    if (request.owner !== state.ownerPublicId || request.revision !== state.revision || request.busySeen && !busy && !uncertain
      || economy.error && economy.error !== request.previousError) pending.current = null;
    else if (busy || uncertain) request.busySeen = true;
  }, [economy, item, quantity, totalPrice, disabled, state.ownerPublicId, state.revision, busy, uncertain]);
  const acceptedOwner = state.ownerPublicId, acceptedRevision = state.revision;
  function submit(selection?: FishSelection): boolean {
    const current = latest.current, snapshot = current.economy.snapshot;
    const currentItem = snapshot.catalog.items.find(entry => entry.id === item.id), currentLimits = snapshot.catalog.market;
    const scale = snapshot.catalog.currencyScale;
    const currentMinimum = quantity ? Math.ceil(marketMinimumPrice(item.id, quantity, snapshot.catalog) / scale) * scale : 0;
    const currentMaximum = quantity && currentItem ? Math.floor(currentItem.baseSellPrice * currentLimits.maxPriceMultiplier * quantity / scale) * scale : 0;
    if (current.economy !== economy || current.item.id !== item.id || current.quantity !== quantity || current.totalPrice !== totalPrice
      || snapshot.ownerPublicId !== acceptedOwner || snapshot.revision !== acceptedRevision || current.disabled || pending.current
      || current.economy.busy || current.economy.uncertain || current.economy.retryAt > current.economy.now || !quantity || !totalPrice
      || !currentItem?.tradable || !canTrade(snapshot) || !marketItemUnlocked(snapshot, item.id, snapshot.catalog)
      || (snapshot.inventory[item.id] ?? 0) < quantity || quantity > currentLimits.maxLotQuantity
      || quantity * currentItem.baseSellPrice > marketDailyLimit(snapshot.buildings.home ?? 1, snapshot.catalog)
      || totalPrice < currentMinimum || totalPrice > currentMaximum || totalPrice % scale !== 0
      || (current.economy.market?.mine.length ?? 0) >= marketSlotCount(snapshot, snapshot.catalog)) return false;
    if (fishClass && (!selection || !fishSelectionMatches(snapshot, { [fishClass.itemId]: quantity }, selection))) return false;
    const accepted = selection ? current.economy.actMarket("create_listing", item.id, quantity, totalPrice, selection)
      : current.economy.actMarket("create_listing", item.id, quantity, totalPrice);
    if (accepted === false) return false;
    pending.current = { owner: snapshot.ownerPublicId, revision: snapshot.revision, busySeen: false, previousError: current.economy.error };
    setChoosingFish(false);
    return true;
  }
  return <div className={styles.card}>
    <div className={styles.fields}>
      <label className={styles.field} htmlFor={quantityId}>Количество<input id={quantityId} type="number" inputMode="numeric" min={1} max={quantityMax} step={1} value={amount} disabled={busy || uncertain || choosingFish} onChange={event => {
        setAmount(event.target.value);
        const nextQuantity = integer(event.target.value, quantityMax), currentPrice = Number(price);
        if (nextQuantity && Number.isSafeInteger(currentPrice) && currentPrice > 0 && currentPrice % quantum === 0) {
          const floor = Math.ceil(marketMinimumPrice(item.id, nextQuantity, state.catalog) / quantum) * quantum;
          const ceiling = Math.floor(item.baseSellPrice * limits.maxPriceMultiplier * nextQuantity / quantum) * quantum;
          setPrice(String(Math.max(floor, Math.min(ceiling, currentPrice))));
        }
      }} /></label>
      <label className={styles.field} htmlFor={priceId}>Цена всего лота<input id={priceId} type="number" inputMode="numeric" min={minimum} max={maximum || undefined} step={quantum} value={price} disabled={busy || uncertain || choosingFish} onChange={event => setPrice(event.target.value)} /></label>
    </div>
    <p className={styles.muted}>{minimum > maximum && quantity
      ? `Для продажи на рынке соберите не меньше ${number(firstQuantity)} шт. этого товара.`
      : quantity ? `Допустимая цена: ${number(minimum)}–${number(maximum)} монет за ${number(quantity)} шт.` : `До ${quantityMax} предметов в этом предложении.`}</p>
    {valid && <p className={styles.muted}>Получите {number(totalPrice! - marketSaleFee(totalPrice!, limits.feeBps))} монет после сбора {limits.feeBps / 100}%. Заберите их здесь после продажи.</p>}
    {neighborHint && <div className={styles.neighborHint} data-neighbor-listing-hint>
      <p>{neighborHint.reason ?? `${neighborHint.name} может купить этот лот не раньше чем через ${duration(neighborHint.seconds)}${neighborHint.firstSale ? " — первая продажа" : ""}. На момент покупки проверяются свободный бюджет и условия выкупа.`}</p>
      <p>Сегодня осталось до {number(neighborHint.remaining)} монет на выкуп; для этой партии — до {number(neighborHint.ceiling)}.</p>
      {neighborHint.canAdjustPrice && <button type="button" className={styles.textButton} disabled={busy || uncertain || choosingFish}
        onClick={() => setPrice(String(neighborHint.ceiling))}>Поставить {number(neighborHint.ceiling)} монет</button>}
    </div>}
    <details className={styles.marketRules}><summary>Что происходит с товаром?</summary><p>Предметы ждут покупателя на прилавке и занимают место в кладовой. При отмене они вернутся. После продажи заберите монеты, чтобы освободить прилавок.</p></details>
    <button ref={trigger} className={styles.primary} disabled={disabled} onClick={() => {
      if (disabled || pending.current) return;
      if (fishClass) {
        focusOrigin.current = { element: trigger.current, owner: state.ownerPublicId, itemId: item.id };
        setChoosingFish(true);
      } else submit();
    }}><Store size={17} aria-hidden />{full ? `Все ${slots} мест заняты` : fishClass ? "Выбрать рыбу для продажи" : `Выставить за ${valid ? number(totalPrice!) : "-"} монет`}</button>
    {choosingFish && fishClass && quantity && totalPrice && <WorldFishSelection economy={economy} requiredItems={{ [fishClass.itemId]: quantity }}
      contextId={`listing:${item.id}:${quantity}:${totalPrice}`} confirmLabel="Выставить лот" summary={`${number(quantity)} шт. · ${number(totalPrice)} монет`}
      onClose={() => setChoosingFish(false)} onConfirm={submit}
      onCloseAutoFocus={event => {
        event.preventDefault();
        const origin = focusOrigin.current, current = latest.current;
        focusOrigin.current = null;
        if (origin?.element && origin.element === trigger.current && origin.element.isConnected && !origin.element.disabled
          && origin.owner === current.economy.snapshot.ownerPublicId && origin.itemId === current.item.id) origin.element.focus({ preventScroll: true });
      }} />}
  </div>;
}


/** One storefront owns active lots, pending sales and a compact new-batch composer. */
export function Market({ economy, navigate, onOpenNeighbor }: { economy: ReadyEconomy; navigate: Navigate; onOpenNeighbor?: () => void }) {
  const [section, setSection] = useState<"browse" | "mine">("mine");
  const [composing, setComposing] = useState(false);
  const composer = useRef<HTMLHeadingElement>(null), composeTrigger = useRef<HTMLButtonElement>(null), wasComposing = useRef(false);
  useEffect(() => {
    if (composing) composer.current?.focus({ preventScroll: true });
    else if (wasComposing.current) composeTrigger.current?.focus({ preventScroll: true });
    wasComposing.current = composing;
  }, [composing]);
  const { snapshot: state, market, marketError, busy, uncertain } = economy;
  const unlocked = canTrade(state), limits = state.catalog.market;
  const showcase = market?.showcase, budget = market?.tradeBudget;
  const mine = market?.mine ?? [], pending = mine.filter(offer => offer.status === "sold" && offer.sale?.claimedAt === null);
  const active = mine.filter(offer => offer.status !== "sold" && offer.status !== "cancelled");
  const occupied = active.length + pending.length, capacity = marketSlotCount(state, state.catalog), full = occupied >= capacity;
  const listings = unlocked ? market?.listings.filter(offer => marketItemUnlocked(state, offer.itemId, state.catalog)) ?? [] : [];
  const missingBuilding = Object.entries(limits.requiredBuildings).find(([id, level]) => (state.buildings[id] ?? 0) < level);
  const refreshIn = showcase ? Math.max(0, Math.ceil((Date.parse(showcase.refreshAt) - economy.now) / 1000)) : null;
  const refreshLabel = refreshIn === 0 ? "Обновить витрину" : "Проверить наличие";
  const refreshMarket = economy.refreshMarket, refreshNeighbor = economy.refreshNeighbor, requestedShowcase = useRef<string | null>(null);
  useEffect(() => { if (unlocked) void refreshNeighbor?.(); }, [unlocked, state.ownerPublicId, refreshNeighbor]);
  useEffect(() => {
    // A reset or a closed bridge cannot hide earned sales that still need collecting.
    if (marketRefreshAvailable()) void refreshMarket();
    return watchMarketRefreshAvailability(refreshMarket);
  }, [refreshMarket]);
  useEffect(() => {
    if (!unlocked || section !== "browse" || !showcase || refreshIn !== 0 || busy || uncertain || !marketRefreshAvailable()) return;
    const key = `${state.ownerPublicId}:${showcase.refreshAt}`;
    if (requestedShowcase.current === key) return;
    requestedShowcase.current = key;
    void refreshMarket();
  }, [unlocked, section, showcase, refreshIn, busy, uncertain, state.ownerPublicId, refreshMarket]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const interval = window.setInterval(() => {
      if (!busy && !uncertain && marketRefreshAvailable()) { void refreshMarket(); if (unlocked) void refreshNeighbor?.(); }
    }, 15_000);
    return () => window.clearInterval(interval);
  }, [busy, uncertain, refreshMarket, refreshNeighbor, unlocked]);
  const offers = <div className={styles.shopGrid} role="list" aria-label="Ваши предложения">
    {[...pending, ...active].map(offer => offer.status === "sold" ? <MarketSaleCard key={offer.id} economy={economy} offer={offer} /> : <OfferCard key={offer.id} economy={economy} offer={offer} navigate={navigate} owned />)}
  </div>;
  if (!unlocked) {
    const bridgeJob = state.jobs?.find(job => job.kind === "construction" && job.targetId === "bridge");
    const bridgeReady = bridgeJob && Date.parse(bridgeJob.finishesAt) <= economy.now;
    const bridgeMissing = (state.buildings.bridge ?? 0) < (limits.requiredBuildings.bridge ?? 1), homeMissing = (state.buildings.home ?? 1) < limits.requiredHomeLevel;
    const bridgeMessage = !bridgeMissing
      ? homeMissing ? `Мост восстановлен. Для торговли нужен дом уровня ${limits.requiredHomeLevel}.` : "Выполните условия открытия торговли между игроками."
      : bridgeJob ? bridgeReady ? "Мост готов. Получите результат стройки, чтобы открыть торговлю между игроками." : "Мост восстанавливается. Дождитесь окончания стройки и получите результат."
      : "Восстановите мост и получите результат стройки, чтобы открыть торговлю между игроками.";
    const destination = homeMissing ? "home" : bridgeMissing ? "bridge" : missingBuilding?.[0];
    return <div className={`${styles.stack} ${styles.market}`} aria-label="Рынок игроков" data-market-closed>
      <div className={styles.empty}><LockKeyhole size={32} aria-hidden /><h3>Рынок закрыт</h3><p className={styles.muted}>{bridgeMessage}</p>
        <p className={styles.muted}>Дом: {state.buildings.home ?? 1} / {limits.requiredHomeLevel} ур.{Object.entries(limits.requiredBuildings).map(([id, level]) => <span key={id}> · {buildingName(state, id)}: {state.buildings[id] ?? 0} / {level}</span>)}</p>
        <button type="button" onClick={() => destination ? navigate("buildings", destination) : navigate("exploration")}>{destination === "home" ? "Улучшить дом" : bridgeReady ? "Получить мост" : bridgeJob ? "К стройке моста" : "Восстановить мост"}<ArrowRight size={15} aria-hidden /></button>
      </div>
      {occupied > 0 && <section className={styles.stack} aria-label="Прежние товары и продажи"><h3>{pending.length ? "Ваши продажи сохранены" : "Ваши прежние лоты"}</h3><p className={styles.muted}>Заберите монеты за проданное или верните непроданные вещи в кладовую.</p>{offers}</section>}
      {marketError && <p role="alert" className={styles.notice}>{marketError}</p>}
    </div>;
  }
  return <div className={`${styles.stack} ${styles.market}`} aria-label="Рынок игроков">
    {onOpenNeighbor && <button type="button" className={styles.neighborEntry} data-neighbor-market-entry aria-haspopup="dialog" onClick={onOpenNeighbor}><Store size={20} aria-hidden="true" /><span><strong>В гости к соседу</strong><small>Персонаж мира · полянка и дневная лавка</small></span><ArrowRight size={18} aria-hidden="true" /></button>}
    <header className={styles.marketSign}><span className={styles.signIcon}><Store size={25} aria-hidden /></span><div><span className={styles.eyebrow}>Соседская торговля</span><strong>Лавки соседей</strong></div><span className={styles.wallet}><ItemIcon itemId="coins" size={20} /><b>{number(state.wallet.coins)}</b><span className={styles.sr}> монет</span></span></header>
    <nav className={styles.subnav} aria-label="Раздел рынка">
      <button type="button" data-guide-market-tab="buy" aria-pressed={section === "browse"} onClick={() => setSection("browse")}><ShoppingBasket size={18} aria-hidden /><span>Купить</span></button>
      <button type="button" data-guide-market-tab="mine" aria-pressed={section === "mine"} onClick={() => setSection("mine")}><Store size={18} aria-hidden /><span>Моя лавка</span>{pending.length > 0 && <b className={styles.badge} aria-label={`Продажи к сбору: ${pending.length}`}>{pending.length}</b>}</button>
      <button type="button" className={styles.barterTab} onClick={() => navigate("barter")}><ArrowLeftRight size={18} aria-hidden /><span>Обмен</span></button>
    </nav>
    {marketError && !economy.marketSyncError && <div role="alert" className={styles.notice} data-kind="error"><CircleHelp size={18} aria-hidden /><div><p>{marketError}</p><button disabled={busy || uncertain} onClick={() => void refreshMarket()}>Обновить рынок</button></div></div>}
    {!market && !marketError && <p className={styles.muted} role="status">Открываем прилавки…</p>}
    {market && section === "browse" && <>
      <div className={styles.showcaseCard}><div className={styles.showcaseInfo}><div><strong>На прилавках · {listings.length}</strong><span>Новая подборка каждые {duration(showcase?.refreshSeconds ?? limits.showcaseRefreshSeconds)}</span></div><button type="button" disabled={busy || uncertain} aria-label={refreshLabel} onClick={() => void refreshMarket()}><RefreshCw size={15} aria-hidden />{refreshIn === 0 ? "Обновить" : "Проверить"}</button></div>{showcase && <MarketRefreshProgress refreshAt={showcase.refreshAt} refreshSeconds={showcase.refreshSeconds} now={economy.now} />}</div>
      <div className={styles.storageLine}><span><Package size={14} aria-hidden />Свободно {number(state.storage.available)} мест</span><button type="button" onClick={() => navigate("inventory")}>Кладовая<ArrowRight size={13} aria-hidden /></button></div>
      {listings.length ? <div className={styles.shopGrid} role="list" aria-label="Предложения игроков">{listings.map(offer => <OfferCard key={offer.id} economy={economy} offer={offer} navigate={navigate} />)}</div>
        : <div className={styles.empty}><Store size={34} aria-hidden /><h3>Прилавки пока свободны</h3><p className={styles.muted}>Соседи ещё собирают товары. Откройте свою лавку первыми.</p><button type="button" onClick={() => setSection("mine")}>В свою лавку<ArrowRight size={15} aria-hidden /></button></div>}
    </>}
    {market && section === "mine" && <>
      <div className={styles.shopHeading}><div><strong>Ваш прилавок</strong><p>{active.length} в продаже{pending.length ? ` · ${pending.length} ждут сбора` : ""}</p></div><button ref={composeTrigger} type="button" className={styles.newBatch} data-guide-market-tab="sell" data-guide-market-compose disabled={busy || uncertain || full} aria-expanded={composing} onClick={() => setComposing(value => !value)}><Plus size={16} aria-hidden />Новая партия</button></div>
      {pending.length > 0 && <p className={styles.saleSummary} role="status"><ItemIcon itemId="coins" size={20} /><span>Продано! <strong>Заберите монеты</strong> ниже.</span></p>}
      {composing && <section className={styles.composer} aria-label="Новая партия для продажи"><header><h3 ref={composer} tabIndex={-1}>Новая партия</h3><button type="button" aria-label="Свернуть новую партию" onClick={() => setComposing(false)}><X size={17} aria-hidden /></button></header><ListingForm economy={economy} /></section>}
      {occupied > 0 ? offers : !composing && <button type="button" className={styles.emptyStall} data-guide-market-create onClick={() => setComposing(true)}><span><Plus size={26} aria-hidden /></span><strong>Прилавок свободен</strong><small>Выберите товар из кладовой и назначьте цену</small></button>}
      {full && <p className={styles.muted}>{pending.length ? "Заберите монеты за проданное, чтобы выставить новую партию." : "Все места заняты. Снимите лот или дождитесь покупателя."}</p>}
      <details className={styles.capacityDetails}><summary><Store size={15} aria-hidden />Места лавки · {occupied} / {capacity}<span>Расширить</span></summary><WorldMarketSlots economy={economy} used={occupied} /></details>
      <p className={styles.marketNote}>Новые партии попадут в витрину соседей при её обновлении. Друзья видят товары сразу в вашем мире.</p>
    </>}
    {market && <details className={styles.marketRules}><summary>Правила торговли и дневной объём</summary><p>Единый рынок для домов 2–5. Покупать можно открытые вам товары. Цена партии: 1–{limits.maxPriceMultiplier} базовых стоимости. Сбор с новых продаж: {limits.feeBps / 100}%. Монеты за проданное забирайте в своей лавке. Быстрая продажа торговцу - в кладовой.</p>{budget && <><p>Покупки: {number(budget.buysUsed)} / {number(budget.limit)}. Продажи: {number(budget.salesUsed)} / {number(budget.limit)}.</p><p>Объём считается по базовой стоимости предметов. Обновление через {duration(Math.max(0, Math.ceil((Date.parse(budget.resetsAt) - economy.now) / 1000)))}.</p></>}<p>В подборке до {showcase?.maxPerSeller ?? limits.showcasePerSeller} лотов одной лавки. Купленные и снятые лоты заменяются в следующей подборке.</p></details>}
  </div>;
}
