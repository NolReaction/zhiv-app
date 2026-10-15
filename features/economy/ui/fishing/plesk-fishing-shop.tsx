"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Anchor, ArrowRight, BookOpen, Bug, Check, Clock3, Fish, FishingRod, Package, RefreshCw, Store } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import { FishingRodIcon } from "@/features/world/activities/fishing/fishing-rod-icon";
import { ECONOMY_MAX_BALANCE, type EconomyView } from "@/features/economy/domain/model";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { fishClassForItem, fishClassInventory, fishingClassOdds, fishingState } from "@/features/economy/domain/fishing";
import { fishSelectionMatches, fishStockEntries, type FishSelection } from "@/features/economy/domain/fish-stock";
import { canRefreshFishingShop, fishingShopRefreshPrice } from "@/features/economy/domain/fishing-shop";
import { formatPearls } from "@/features/economy/domain/money";
import { residentOrderBoard } from "@/features/economy/domain/food";
import { FishRarityBadge, FISH_RARITY_NAMES, type FishRarity } from "./fish-rarity";
import { PantrySale } from "@/features/economy/ui/inventory/world-pantry-menu";
import { locked } from "@/features/economy/sync/controller-state";
import { listenForSectionGuideNavigation } from "@/features/onboarding/section-guide-navigation";
import { itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import { useFishingCommand } from "./use-fishing-command";
import { PleskFishingCollection } from "./plesk-fishing-book";
import { WorldFishStockList } from "./world-fish-stock-list";
import { WorldFishSelection } from "./world-fish-selection";
import styles from "./plesk-fishing-shop.module.css";
export { PleskFishingCollection } from "./plesk-fishing-book";

type ReadyProps = { economy: EconomyController; state: EconomyView };
type FishingCatalog = NonNullable<EconomyView["catalog"]["fishing"]>;
type Offer = NonNullable<EconomyView["fishingShop"]>["offers"][number];
type ShopTab = "tackle" | "fish" | "collection";
const tabs = [{ id: "tackle", name: "Лавка", icon: Store }, { id: "fish", name: "Улов", icon: Fish }, { id: "collection", name: "Книга", icon: BookOpen }] as const;

function Price({ value, pearls = false }: { value: number; pearls?: boolean }) {
  return <span className={styles.price}>{pearls ? formatPearls(value) : number(value)}<ItemIcon itemId={pearls ? "pearls" : "coins"} size={16} /></span>;
}
const probabilityFormat = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 });
const percent = (probability: number) => `${probabilityFormat.format(probability * 100)}%`;
function offerFor(state: EconomyView, itemId: string) { return state.fishingShop?.offers.find(offer => offer.itemId === itemId); }
function offerLive(state: EconomyView, now: number, offer?: Offer) {
  return !!offer && offer.remaining > 0 && Date.parse(state.fishingShop?.refreshAt ?? "") > now;
}

/** Class probabilities describe every fish; species remain a separate collection. */
export function PleskCatchOdds({ state, catalog, override, preview = false, targetRarity }: { state: EconomyView; catalog: FishingCatalog;
  override?: Parameters<typeof fishingClassOdds>[2]; preview?: boolean; targetRarity?: FishRarity }) {
  const odds = fishingClassOdds(state, catalog, override);
  const currentOdds = preview ? fishingClassOdds(state, catalog) : odds;
  return <section className={styles.odds} data-guide-plesk-odds aria-label={preview ? "Шансы с выбранной снастью" : "Шансы текущих снастей"}>
    <div className={styles.oddsHeading}><strong>Шансы улова</strong><small>{preview ? "Сейчас → с этой снастью" : "На одну рыбу"}</small></div>
    <dl className={styles.rarityOdds} aria-label="Шансы по классам">{odds.map(({ rarity, itemId, probability }) => {
      const current = currentOdds.find(odd => odd.rarity === rarity)?.probability ?? probability;
      const changed = preview && Math.abs(current - probability) > 1e-10;
      const description = changed ? `Сейчас ${percent(current)} → с этой снастью ${percent(probability)}` : percent(probability);
      return <div key={rarity} data-fish-class-odds={itemId} data-target={rarity === targetRarity || undefined}
        data-fishing-target={rarity === targetRarity ? itemId : undefined} data-odds-change={changed ? probability > current ? "increase" : "decrease" : undefined}>
        <dt><ItemIcon itemId={itemId} size={24} /><FishRarityBadge rarity={rarity} /></dt>
        <dd aria-label={`${FISH_RARITY_NAMES[rarity]} рыба: ${description}`}>
          {changed && <span className={styles.previousOdds} aria-hidden="true">{percent(current)}<ArrowRight size={12} /></span>}
          <strong data-catch-probability={itemId} aria-hidden="true">{percent(probability)}</strong>
        </dd>
      </div>;
    })}</dl>
  </section>;
}

export function fishingTradeLimits(state: EconomyView, itemId: string) {
  const fish = fishClassForItem(itemId, state.catalog.fishing), item = state.catalog.items.find(entry => entry.id === fish?.itemId);
  if (!fish || !item) return { buy: 0, sell: 0, buyPrice: 0, sellPrice: 0 };
  return { buy: 0, buyPrice: 0,
    sell: item.tradable ? Math.max(0, Math.min(state.catalog.maxBatch, fishClassInventory(state.inventory, state.catalog.fishing)[fish.itemId] ?? 0, Math.floor((ECONOMY_MAX_BALANCE - state.wallet.coins) / item.baseSellPrice))) : 0,
    sellPrice: item.baseSellPrice };
}

export function PleskFishTrade({ economy, state, itemId, fishItemId }: ReadyProps & { itemId: string; fishItemId?: string }) {
  const [quantityText, setQuantityText] = useState("1"), id = useId();
  const [choosingFish, setChoosingFish] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const { blocked, send } = useFishingCommand({ economy, state });
  const classId = fishClassForItem(itemId, state.catalog.fishing)?.itemId ?? itemId;
  const limits = fishingTradeLimits(state, classId), quantity = Number(quantityText);
  const stock = fishItemId !== undefined ? fishStockEntries(state, classId).find(entry => entry.itemId === fishItemId)?.quantity ?? 0
    : fishClassInventory(state.inventory, state.catalog.fishing)[classId] ?? 0;
  const maximum = Math.min(limits.sell, stock), owner = state.ownerPublicId, revision = state.revision;
  const name = fishItemId === classId ? "Без указания вида" : itemName(state, fishItemId ?? classId);
  const valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity > 0, canSell = valid && quantity <= maximum;
  const total = canSell ? quantity * limits.sellPrice : 0;
  const latest = useRef({ economy, state, itemId, fishItemId, quantityText, quantity, total, choosingFish });
  useLayoutEffect(() => { latest.current = { economy, state, itemId, fishItemId, quantityText, quantity, total, choosingFish }; },
    [economy, state, itemId, fishItemId, quantityText, quantity, total, choosingFish]);
  function sell(selection?: FishSelection): boolean {
    const current = latest.current, snapshot = current.economy.snapshot;
    if (blocked || !canSell || !snapshot || locked(current.economy) || snapshot.ownerPublicId !== owner || snapshot.revision !== revision
      || current.itemId !== itemId || current.fishItemId !== fishItemId || current.quantityText !== quantityText
      || current.quantity !== quantity || current.total !== total || selection && !current.choosingFish) return false;
    const currentLimits = fishingTradeLimits(snapshot, classId);
    if (currentLimits.sell < quantity || currentLimits.sellPrice !== limits.sellPrice) return false;
    const chosen = selection ?? (fishItemId !== undefined ? { [fishItemId]: quantity } : undefined);
    if (!chosen) { setChoosingFish(true); return false; }
    if (!fishSelectionMatches(snapshot, { [classId]: quantity }, chosen)) return false;
    if (!send("sell_fish", classId, quantity, 0, true, chosen)) return false;
    setChoosingFish(false); return true;
  }
  return <section className={styles.trade} data-guide-plesk-sale data-fish-sale-item={fishItemId} aria-label={`Продажа: ${name}`}>
    {fishItemId !== undefined && <div className={styles.selectedFishHeading}><ItemIcon itemId={fishItemId} size={24} /><strong>{name}</strong></div>}
    <div className={styles.tradeHeading}><span>В запасе <strong>{number(stock)}</strong></span><span>За штуку <Price value={limits.sellPrice} /></span></div>
    <div className={styles.quantity}>
      <label htmlFor={id}>Количество</label>
      <input id={id} type="number" inputMode="numeric" min={1} max={Math.max(1, maximum)} step={1} value={quantityText} disabled={blocked} onChange={event => setQuantityText(event.target.value)} />
      <button type="button" disabled={blocked || maximum === 0} onClick={() => setQuantityText(String(maximum))}>{maximum < stock ? `До ${number(maximum)}` : fishItemId !== undefined ? "Все" : "Весь улов"}</button>
    </div>
    <button ref={trigger} type="button" className={styles.primary} disabled={blocked || !canSell} onClick={() => sell()} aria-label={`Продать ${name}: ${valid ? quantity : 0}`}><span>Продать</span>{canSell ? <Price value={quantity * limits.sellPrice} /> : <span>-</span>}</button>
    {!valid && <p className={styles.hint}>Введите целое количество от 1.</p>}
    {valid && stock > 0 && !canSell && <p className={styles.hint}>{quantity > stock ? "Столько рыбы в запасе пока нет." : "Этот объём пока нельзя продать. Уменьшите количество."}</p>}
    {choosingFish && economy.snapshot && <WorldFishSelection economy={{ ...economy, snapshot: economy.snapshot }} requiredItems={{ [classId]: quantity }} contextId={`plesk-sale:${classId}`} confirmLabel="Продать"
      summary={`${number(quantity)} шт. · ${number(quantity * limits.sellPrice)} монет`}
      onConfirm={sell} onClose={() => setChoosingFish(false)} onCloseAutoFocus={event => {
        event.preventDefault();
        const current = latest.current;
        if (current.itemId === itemId && current.economy.snapshot?.ownerPublicId === owner && trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus({ preventScroll: true });
      }} />}
  </section>;
}

export function FishCounter({ economy, state, catalog }: ReadyProps & { catalog: FishingCatalog }) {
  const inventory = fishClassInventory(state.inventory, catalog);
  const available = catalog.classes.filter(fish => (inventory[fish.itemId] ?? 0) > 0);
  const [selection, setSelection] = useState<string | null>(() => available[0]?.itemId ?? null);
  const [selectedFishId, setSelectedFishId] = useState<string | null>(null);
  const selected = available.find(fish => fish.itemId === selection);
  const stockId = useId();
  return <>
    <p className={styles.intro}>«Приноси улов, с радостью куплю!»</p>
    {available.length ? <div className={styles.fishList} aria-label="Рыба в вашей кладовой">{available.map(fish => {
      const expanded = fish === selected, entries = fishStockEntries(state, fish.itemId);
      const selectedFish = entries.find(entry => entry.itemId === selectedFishId)?.itemId ?? (entries.length === 1 ? entries[0].itemId : undefined);
      return <div key={fish.itemId} className={styles.fishGroup}><button type="button" className={styles.fishChoice} aria-pressed={expanded} aria-expanded={expanded}
        aria-controls={`${stockId}-${fish.itemId}`} onClick={() => { setSelection(current => current === fish.itemId ? null : fish.itemId); setSelectedFishId(null); }}>
      <ItemIcon itemId={fish.itemId} size={40} /><span><strong>{itemName(state, fish.itemId)}</strong><FishRarityBadge rarity={fish.rarity} /></span><span className={styles.stock}>×{number(inventory[fish.itemId])}</span>
      </button>{expanded && <div className={styles.fishDisclosure} id={`${stockId}-${fish.itemId}`} data-plesk-fish-stock={fish.itemId}>
        <WorldFishStockList state={state} classId={fish.itemId} selectedItemId={selectedFish} onSelect={setSelectedFishId} disabled={locked(economy)} />
        <PleskFishTrade key={`${fish.itemId}:${selectedFish ?? "all"}`} economy={economy} state={state} itemId={fish.itemId} fishItemId={selectedFish} />
      </div>}</div>;
    })}</div> : <div className={styles.emptyCatch}><Fish size={32} aria-hidden="true" /><strong>Улов ещё впереди</strong><p>Заберите рыбу после вылазки, и она появится здесь.</p></div>}
  </>;
}

export function PleskRodOffer({ economy, state, rod }: ReadyProps & { rod: FishingCatalog["rods"][number] }) {
  const { blocked, send } = useFishingCommand({ economy, state }), gear = fishingState(state);
  const owned = gear.ownedRods.includes(rod.id), equipped = gear.equippedRodId === rod.id, offer = offerFor(state, rod.id);
  const price = offer?.unitPrice ?? rod.price, live = offerLive(state, economy.now, offer), affordable = state.wallet.coins >= price;
  const allowed = !owned && live && affordable;
  return <article className={styles.gearCard} data-gear-rarity={rod.rarity}>
    <div className={styles.gearHeading}><FishingRodIcon rodId={rod.id} size={48} /><div><h3>{rod.name}</h3><FishRarityBadge rarity={rod.rarity} /><p>{owned ? "Уже куплена" : "Останется навсегда"}</p></div>{owned && <Check size={17} aria-hidden="true" />}</div>
    <PleskCatchOdds state={state} catalog={state.catalog.fishing!} override={{ rodId: rod.id }} targetRarity={rod.rarity} preview={!equipped} />
    <button type="button" className={styles.primary} disabled={blocked || !allowed} onClick={() => send("buy_fishing_item", offer?.id ?? "", 1, price, allowed)}>{owned ? "Куплено" : !live ? "Нет на прилавке" : <><span>Купить удочку</span><Price value={price} /></>}</button>
    {!owned && live && !affordable && <p className={styles.hint}>Не хватает {number(price - state.wallet.coins)} монет.</p>}
  </article>;
}

export function PleskHookOffer({ economy, state, hook }: ReadyProps & { hook: FishingCatalog["hooks"][number] }) {
  const { blocked, send } = useFishingCommand({ economy, state }), gear = fishingState(state);
  const owned = gear.ownedHooks.includes(hook.id), equipped = gear.equippedHookId === hook.id, offer = offerFor(state, hook.id);
  const price = offer?.unitPrice ?? hook.price, live = offerLive(state, economy.now, offer), affordable = state.wallet.coins >= price;
  const allowed = !owned && live && affordable;
  return <article className={styles.gearCard} data-gear-rarity={hook.rarity}>
    <div className={styles.gearHeading}><ItemIcon itemId={hook.id} size={48} /><div><h3>{hook.name}</h3><FishRarityBadge rarity={hook.rarity} /><p>{owned ? "Уже куплен" : "Останется навсегда"}</p></div>{owned && <Check size={17} aria-hidden="true" />}</div>
    <PleskCatchOdds state={state} catalog={state.catalog.fishing!} override={{ hookId: hook.id }} targetRarity={hook.rarity} preview={!equipped} />
    <button type="button" className={styles.primary} disabled={blocked || !allowed} onClick={() => send("buy_fishing_item", offer?.id ?? "", 1, price, allowed)}>{owned ? "Куплено" : !live ? "Нет на прилавке" : <><span>Купить крючок</span><Price value={price} /></>}</button>
    {!owned && live && !affordable && <p className={styles.hint}>Не хватает {number(price - state.wallet.coins)} монет.</p>}
    <p className={styles.footnote}>Не расходуется и не занимает место в кладовой.</p>
  </article>;
}

export function PleskBaitOffer({ economy, state, bait }: ReadyProps & { bait: FishingCatalog["baits"][number] }) {
  const { blocked, send } = useFishingCommand({ economy, state }), [quantityText, setQuantityText] = useState("1"), id = useId();
  const stock = state.inventory[bait.itemId] ?? 0, offer = offerFor(state, bait.itemId);
  const price = offer?.unitPrice ?? bait.price, live = offerLive(state, economy.now, offer);
  const maximum = live ? Math.max(0, Math.min(offer!.remaining, state.catalog.maxBatch, state.storage.available, Math.floor(state.wallet.coins / price))) : 0;
  const quantity = Number(quantityText), valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= maximum;
  return <article className={styles.gearCard} data-gear-rarity={bait.rarity}>
    <div className={styles.gearHeading}><ItemIcon itemId={bait.itemId} size={40} /><div><h3>{itemName(state, bait.itemId)}</h3><FishRarityBadge rarity={bait.rarity} /><p>В запасе {number(stock)}</p></div></div>
    <PleskCatchOdds state={state} catalog={state.catalog.fishing!} override={{ baitId: bait.itemId }} targetRarity={bait.rarity} preview />
    {live && <><div className={styles.quantity}><label htmlFor={id}>Купить штук</label><input id={id} type="number" inputMode="numeric" min={1} max={Math.max(1, maximum)} step={1} value={quantityText} disabled={blocked} onChange={event => setQuantityText(event.target.value)} /><small>На прилавке {offer!.remaining}</small></div>
      <button type="button" className={styles.primary} disabled={blocked || !valid} onClick={() => send("buy_fishing_item", offer!.id, quantity, quantity * price, valid)} aria-label={`Купить наживку: ${itemName(state, bait.itemId)}`}><span>Купить наживку</span>{Number.isSafeInteger(quantity) && quantity > 0 ? <Price value={quantity * price} /> : <span>-</span>}</button></>}
    {live && maximum === 0 && <p className={styles.hint}>{state.storage.available === 0 ? "Кладовая заполнена." : "Для покупки не хватает монет."}</p>}
    {!live && <p className={styles.hint}>Сегодня на прилавке закончилась.</p>}
  </article>;
}

export function PleskFishOffer({ economy, state, fish, selectedOffer, onOpenOrders }: ReadyProps & { fish: FishingCatalog["classes"][number]; selectedOffer?: Offer; onOpenOrders?: () => void }) {
  const { blocked, send } = useFishingCommand({ economy, state }), [quantityText, setQuantityText] = useState("1"), id = useId();
  const offer = selectedOffer ?? offerFor(state, fish.itemId), live = offerLive(state, economy.now, offer), price = offer?.unitPrice ?? fish.buyPrice;
  const maximum = live ? Math.max(0, Math.min(offer!.remaining, state.catalog.maxBatch, state.storage.available, Math.floor(state.wallet.coins / price))) : 0;
  const quantity = Number(quantityText), valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= maximum;
  const name = itemName(state, fish.itemId);
  const order = residentOrderBoard(state, economy.now, state.catalog).offers.find(entry => entry.residentId === "plesk" && (entry.items[fish.itemId] ?? 0) > 0);
  return <article className={styles.gearCard} data-gear-rarity={fish.rarity}>
    <div className={styles.gearHeading}><ItemIcon itemId={fish.itemId} size={48} /><div><h3>{name}</h3><FishRarityBadge rarity={fish.rarity} /><p>В запасе {number(fishClassInventory(state.inventory, state.catalog.fishing)[fish.itemId] ?? 0)}</p></div></div>
    <p className={styles.description}>Любой вид этого класса подходит для готовки и заказов. Покупка не открывает виды в книге.</p>
    <div className={styles.discountPrice}>{price < fish.buyPrice && <del aria-label={`Обычная цена: ${number(fish.buyPrice)} монет`}><Price value={fish.buyPrice} /></del>}<Price value={price} /><span>за штуку</span></div>
    {live ? <><div className={styles.quantity}><label htmlFor={id}>Купить штук</label><input id={id} type="number" inputMode="numeric" min={1} max={Math.max(1, maximum)} step={1} value={quantityText} disabled={blocked} onChange={event => setQuantityText(event.target.value)} /><small>На прилавке {offer!.remaining}</small></div>
      <button type="button" className={styles.primary} disabled={blocked || !valid} onClick={() => send("buy_fishing_item", offer!.id, quantity, quantity * price, valid)} aria-label={`Купить рыбу: ${name}`}><span>Купить рыбу</span>{Number.isSafeInteger(quantity) && quantity > 0 ? <Price value={quantity * price} /> : <span>-</span>}</button></>
      : <p className={styles.hint}>Сегодня на прилавке закончилась.</p>}
    {live && maximum === 0 && <p className={styles.hint}>{state.storage.available === 0 ? "Кладовая заполнена." : "Для покупки не хватает монет."}</p>}
    {order && <div className={styles.fishOrder}><p>Плёске нужно ×{number(order.items[fish.itemId])}: «{order.name}»</p>{onOpenOrders && <button type="button" className={styles.secondary} onClick={onOpenOrders}>К заказам<ArrowRight size={14} aria-hidden="true" /></button>}</div>}
  </article>;
}

export function PleskMerchantHeader({ economy, state }: ReadyProps) {
  const shop = state.fishingShop, { blocked, send } = useFishingCommand({ economy, state }), reasonId = useId();
  const [confirm, setConfirm] = useState<{ shopId: string; owner: string; revision: number; price: number } | null>(null);
  const refreshed = useRef<string | null>(null), latest = useRef({ economy, state, confirm, send });
  useLayoutEffect(() => { latest.current = { economy, state, confirm, send }; }, [economy, state, confirm, send]);
  const confirmation = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), wasConfirming = useRef(false);
  const price = shop ? fishingShopRefreshPrice(shop, economy.now, state.catalog.fishing?.shop) : 0;
  const confirming = !!shop && confirm?.shopId === shop.id && price > 0;
  const quoteChanged = confirming && (confirm.owner !== state.ownerPublicId || confirm.revision !== state.revision);
  const priceChanged = confirming && price > confirm.price;
  useEffect(() => {
    if (confirming) confirmation.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) trigger.current?.focus({ preventScroll: true });
    wasConfirming.current = confirming;
  }, [confirming]);
  const seconds = Math.max(0, Math.ceil((Date.parse(shop?.refreshAt ?? "") - economy.now) / 1000));
  useEffect(() => {
    if (!shop || seconds > 0 || blocked || refreshed.current === shop.id) return;
    refreshed.current = shop.id;
    void economy.refresh();
  }, [shop, seconds, blocked, economy]);
  function confirmRefresh() {
    const current = latest.current, snapshot = current.economy.snapshot;
    if (!confirm || current.confirm !== confirm || locked(current.economy) || !snapshot) return;
    if (snapshot.ownerPublicId !== confirm.owner || snapshot.revision !== confirm.revision
      || current.state.ownerPublicId !== confirm.owner || current.state.revision !== confirm.revision) return;
    const active = snapshot.fishingShop;
    if (!active || active.id !== confirm.shopId || !canRefreshFishingShop(snapshot)) return;
    const amount = fishingShopRefreshPrice(active, current.economy.now, snapshot.catalog.fishing?.shop);
    if (amount <= 0 || amount > confirm.price || amount > snapshot.wallet.pearls) return;
    current.send("refresh_fishing_shop", active.id, 1, amount);
    setConfirm(null);
  }
  if (!shop) return <p className={styles.hint} role="status">Плёска раскладывает товары…</p>;
  const time = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const canReplace = canRefreshFishingShop(state);
  const shortfall = Math.max(0, price - state.wallet.pearls);
  const allowed = price > 0 && canReplace && shortfall === 0 && !quoteChanged && !priceChanged;
  const reason = economy.uncertain ? "Проверяем последнее действие. Дождитесь подтверждения."
    : economy.busy ? "Дождитесь завершения текущего действия."
      : blocked ? "Обновляем данные лавки. Попробуйте после проверки."
        : quoteChanged ? "Данные обновились. Проверьте стоимость ещё раз."
          : priceChanged ? "Цена изменилась. Проверьте её ещё раз."
            : seconds <= 0 ? "Открываем новую поставку. Обновление за жемчуг пока не требуется."
              : !canReplace ? "Пока не все товары можно заменить на другие. Дождитесь новой поставки."
                : shortfall > 0 ? `Не хватает ${formatPearls(shortfall)} жемчужин для обновления.` : null;
  return <section className={styles.merchantHeader} aria-label="Обновление прилавка">
    <div><strong>Сегодня у Плёски</strong><span><Clock3 size={14} aria-hidden="true" />{seconds > 0 ? <>Новые товары через <time>{time}</time></> : "Открываем новые предложения…"}</span></div>
    {reason && <p id={reasonId} className={styles.restockHint} role="status">{reason}</p>}
    {confirming ? <div ref={confirmation} className={styles.refreshConfirm} role="group" tabIndex={-1} aria-label="Подтверждение обновления прилавка"><p>Заменить все товары на другие за <Price value={price} pearls />?</p><div><button type="button" className={styles.secondary} onClick={() => setConfirm(null)}>Оставить</button><button type="button" className={styles.primary} disabled={blocked || !allowed} aria-describedby={reason ? reasonId : undefined} onClick={confirmRefresh}>Обновить</button></div></div>
      : <button ref={trigger} type="button" className={styles.refreshOffers} disabled={blocked || !allowed} onClick={() => { if (!blocked && allowed) setConfirm({ shopId: shop.id, owner: state.ownerPublicId, revision: state.revision, price }); }} aria-describedby={reason ? reasonId : undefined} aria-label={`Обновить предложения за ${formatPearls(price)} жемчужин`}><RefreshCw size={14} aria-hidden="true" />Обновить<Price value={price} pearls /></button>}
  </section>;
}

function GearDetail({ economy, state, catalog, itemId, onOpenOrders }: ReadyProps & { catalog: FishingCatalog; itemId: string; onOpenOrders?: () => void }) {
  const rod = catalog.rods.find(entry => entry.id === itemId), hook = catalog.hooks.find(entry => entry.id === itemId), bait = catalog.baits.find(entry => entry.itemId === itemId), fish = fishClassForItem(itemId, catalog);
  return rod ? <PleskRodOffer economy={economy} state={state} rod={rod} /> : hook ? <PleskHookOffer economy={economy} state={state} hook={hook} /> : bait ? <PleskBaitOffer economy={economy} state={state} bait={bait} /> : fish ? <PleskFishOffer economy={economy} state={state} fish={fish} selectedOffer={offerFor(state, itemId)} onOpenOrders={onOpenOrders} /> : null;
}

const merchantSlots = [{ kind: "rod", name: "Удочки", icon: FishingRod }, { kind: "hook", name: "Крючки", icon: Anchor }, { kind: "bait", name: "Наживки", icon: Bug }, { kind: "fish", name: "Рыба дня", icon: Fish }] as const;
export function PleskTackleCounter({ economy, state, catalog, onOpenOrders, guideKind }: ReadyProps & { catalog: FishingCatalog; onOpenOrders?: () => void; guideKind?: "rod" | "bait" }) {
  const offers = state.fishingShop?.offers ?? [];
  const previousStock = offers.filter(offer => offers.find(entry => entry.kind === offer.kind)?.id !== offer.id);
  const [selectedId, setSelectedId] = useState(() => guideKind ? offers.find(offer => offer.kind === guideKind)?.id : offers[0]?.id);
  const selected = offers.find(offer => offer.id === selectedId) ?? (guideKind ? offers.find(offer => offer.kind === guideKind) : offers[0]);
  // A sold-out gear category must not derail the odds lesson. Inspect owned
  // equipment or an already unlocked bait without offering a phantom purchase.
  const gear = fishingState(state);
  const guideRod = !selected && guideKind === "rod" ? catalog.rods.find(rod => rod.id === gear.equippedRodId)
    ?? catalog.rods.find(rod => gear.ownedRods.includes(rod.id)) : undefined;
  const guideBait = !selected && guideKind === "bait" ? catalog.baits.find(bait => bait.itemId === gear.equippedBaitId)
    ?? catalog.baits.find(bait => (state.inventory[bait.itemId] ?? 0) > 0 || bait.requiredHomeLevel <= (state.buildings.home ?? 1)) : undefined;
  const detailKind = guideRod ? "rod" : guideBait ? "bait" : selected?.kind;
  const detail = useRef<HTMLDivElement>(null);
  const guideShown = useRef(false);
  useLayoutEffect(() => {
    if (!guideKind || guideShown.current) return;
    if (detailKind !== guideKind) {
      const offer = detail.current?.parentElement?.querySelector<HTMLElement>(`[data-guide-plesk-offer="${guideKind}"]`);
      if (offer) { offer.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" }); guideShown.current = true; }
      return;
    }
    const odds = detail.current?.querySelector<HTMLElement>("[data-guide-plesk-odds]");
    // The actual odds are lower than the offer grid. Reveal them without buying
    // or equipping the preview, and keep the guide outside the scroll area.
    if (odds) { odds.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" }); guideShown.current = true; }
  }, [guideKind, detailKind]);
  const scrollPosition = useRef<{ body: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    // Keyed descriptions replace their scroll anchors; keep the reader's position.
    const position = scrollPosition.current;
    scrollPosition.current = null;
    if (position?.body.isConnected) position.body.scrollTop = position.top;
  }, [selected?.id]);
  const selectOffer = (offerId: string, button: HTMLButtonElement) => {
    const body = button.closest<HTMLElement>("[data-resident-scroll]") ?? button.closest<HTMLElement>("[data-slot='dialog-content']");
    scrollPosition.current = body && offerId !== selected?.id ? { body, top: body.scrollTop } : null;
    button.focus({ preventScroll: true });
    setSelectedId(offerId);
  };
  return <>
    <PleskMerchantHeader economy={economy} state={state} />
    <div className={styles.offerGrid} aria-label="Предложения Плёски">{merchantSlots.map(slot => {
      const offer = offers.find(entry => entry.kind === slot.kind);
      if (!offer) return <div key={slot.kind} className={styles.emptyOffer} data-guide-plesk-offer={slot.kind}><slot.icon size={26} aria-hidden="true" /><strong>{slot.name}</strong><span>Ждём поставку</span></div>;
      const entry = offer.kind === "rod" ? catalog.rods.find(rod => rod.id === offer.itemId) : offer.kind === "hook" ? catalog.hooks.find(hook => hook.id === offer.itemId) : offer.kind === "fish" ? fishClassForItem(offer.itemId, catalog) : catalog.baits.find(bait => bait.itemId === offer.itemId);
      if (!entry) return null;
      const stockItemId = offer.kind === "fish" ? fishClassForItem(offer.itemId, catalog)?.itemId ?? offer.itemId : offer.itemId;
      const name = "name" in entry ? entry.name : itemName(state, stockItemId);
      const discount = "buyPrice" in entry ? Math.max(0, Math.round((1 - offer.unitPrice / entry.buyPrice) * 100)) : 0;
      return <button type="button" key={offer.id} className={styles.offerTile} data-guide-plesk-offer={offer.kind} data-gear-rarity={entry.rarity} aria-pressed={selected?.id === offer.id} onPointerDown={event => { if (event.button === 0) event.currentTarget.focus({ preventScroll: true }); }} onClick={event => selectOffer(offer.id, event.currentTarget)}>
        <small className={styles.offerKind}>{slot.name}{discount > 0 && <span>−{discount}%</span>}</small>
        <span className={styles.offerArt}>{offer.kind === "rod" ? <FishingRodIcon rodId={offer.itemId} size={44} /> : <ItemIcon itemId={stockItemId} size={36} />}</span>
        <strong>{name}</strong><FishRarityBadge rarity={entry.rarity} />
        <span className={styles.offerBottom}>{offer.remaining > 0 ? <><Price value={offer.unitPrice} /><small>×{offer.remaining}</small></> : <small><Check size={12} aria-hidden="true" />Раскуплено</small>}</span>
      </button>;
    })}</div>
    {previousStock.length > 0 && <details className={styles.previousStock}><summary>Остатки прежней поставки · {previousStock.length}</summary><div>{previousStock.map(offer => <button key={offer.id} type="button" aria-pressed={selected?.id === offer.id} onPointerDown={event => { if (event.button === 0) event.currentTarget.focus({ preventScroll: true }); }} onClick={event => selectOffer(offer.id, event.currentTarget)}>
      <span>{catalog.rods.find(rod => rod.id === offer.itemId)?.name ?? catalog.hooks.find(hook => hook.id === offer.itemId)?.name ?? itemName(state, fishClassForItem(offer.itemId, catalog)?.itemId ?? offer.itemId)}</span>
      {offer.remaining > 0 ? <Price value={offer.unitPrice} /> : <span>Раскуплено</span>}
    </button>)}</div></details>}
    {selected ? <div ref={detail} data-guide-plesk-detail={selected.kind}><GearDetail key={selected.id} economy={economy} state={state} catalog={catalog} itemId={selected.itemId} onOpenOrders={onOpenOrders} /></div>
      : (guideRod || guideBait) && <div ref={detail} data-guide-plesk-detail={detailKind}><section className={styles.gearCard} aria-label="Снасть для знакомства">
        <div className={styles.gearHeading}>{guideRod ? <FishingRodIcon rodId={guideRod.id} size={48} /> : <ItemIcon itemId={guideBait!.itemId} size={40} />}<div><h3>{guideRod?.name ?? itemName(state, guideBait!.itemId)}</h3><p>{guideRod ? "Твоя удочка" : "Знакомство с наживкой"}</p></div></div>
        <p className={styles.description}>{guideRod ? "Эту удочку можно взять на рыбалку. Сравни её шансы с другими снастями." : "На прилавке сейчас нет наживки. Посмотри, как она меняет шансы; ловить можно и без неё."}</p>
        <PleskCatchOdds state={state} catalog={catalog} override={guideRod ? { rodId: guideRod.id } : { baitId: guideBait!.itemId }} preview={Boolean(guideBait)} />
      </section></div>}

  </>;
}

export type PleskFishingShopProps = { economy: EconomyController; onFishing: () => void; onOpenPantry: () => void; onOpenOrders?: () => void };
export function PleskFishingShop({ economy, onFishing, onOpenPantry, onOpenOrders }: PleskFishingShopProps) {
  const [tab, setTab] = useState<ShopTab>("tackle"), id = useId(), tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  function changeTab(next: ShopTab) {
    if (next === tab) return;
    playUiCue(getAudioRuntime(), "ui.tab");
    setTab(next);
    setGuideRequest(null);
  }
  const shop = useRef<HTMLDivElement>(null);
  const [guideRequest, setGuideRequest] = useState<{ stepId: "rod-intro" | "hook-intro" | "bait-intro" | "rods" | "bait" | "catch"; sequence: number } | null>(null);
  const state = economy.snapshot, catalog = state?.catalog.fishing, cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  useEffect(() => {
    if (!shop.current || !catalog) return;
    return listenForSectionGuideNavigation(shop.current, "plesk", stepId => {
      if (stepId !== "rod-intro" && stepId !== "hook-intro" && stepId !== "bait-intro" && stepId !== "rods" && stepId !== "bait" && stepId !== "catch") return false;
      // Navigation only. The ordinary purchase, equip and sale handlers remain
      // the only places that send economic commands.
      setTab(stepId === "catch" ? "fish" : "tackle");
      setGuideRequest(previous => ({ stepId, sequence: (previous?.sequence ?? 0) + 1 }));
      return true;
    });
  }, [catalog]);
  useLayoutEffect(() => {
    const kind = guideRequest?.stepId === "rod-intro" ? "rod" : guideRequest?.stepId === "hook-intro" ? "hook" : guideRequest?.stepId === "bait-intro" ? "bait" : null;
    if (kind && tab === "tackle") {
      shop.current?.querySelector<HTMLElement>(`[data-guide-plesk-offer="${kind}"]`)?.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "auto" });
      return;
    }
    if (guideRequest?.stepId !== "catch" || tab !== "fish") return;
    const target = shop.current?.querySelector<HTMLElement>("[data-guide-plesk-sale]")
      ?? shop.current?.querySelector<HTMLElement>('[data-guide-plesk-panel="fish"]');
    target?.scrollIntoView({ block: "start", inline: "nearest", behavior: "auto" });
  }, [guideRequest, tab]);
  const recovery = (economy.error || economy.uncertain) && <div className={styles.recovery} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Дождитесь подтверждения, прежде чем торговать снова." : economy.error}</p><button type="button" disabled={economy.busy || cooldown > 0} onClick={() => { if (!economy.busy && !cooldown) void economy.retry(); }}><RefreshCw size={14} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button></div>;
  return <div ref={shop} className={styles.shop} data-section-guide-content="plesk" aria-busy={economy.busy || undefined}>
    {state && <div className={styles.wallet}><span>Лавка у пирса</span><span aria-label={`Монеты: ${number(state.wallet.coins)}. Жемчуг: ${formatPearls(state.wallet.pearls)}`}><Price value={state.wallet.coins} /><Price value={state.wallet.pearls} pearls /></span></div>}
    {recovery}
    {!state ? <p className={styles.hint} role="status">Проверяем ваши запасы…</p> : !catalog ? <><p className={styles.intro}>«Приноси речную рыбу, куплю!»</p>{(state.inventory.fish ?? 0) > 0 ? <PantrySale economy={{ ...economy, snapshot: state }} itemId="fish" /> : <p className={styles.hint}>В вашей кладовой пока нет речной рыбы.</p>}</> : <>
      <div className={styles.tabs} role="tablist" aria-label="Лавка Плёски">{tabs.map((entry, index) => <button key={entry.id} ref={node => { tabButtons.current[index] = node; }} type="button" role="tab" data-guide-plesk-tab={entry.id} id={`${id}-${entry.id}`} aria-selected={tab === entry.id} aria-controls={`${id}-panel`} tabIndex={tab === entry.id ? 0 : -1} onClick={() => changeTab(entry.id)} onKeyDown={event => {
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault(); changeTab(tabs[next].id); tabButtons.current[next]?.focus();
      }}><entry.icon size={17} aria-hidden="true" />{entry.name}</button>)}</div>
      <div key={state.ownerPublicId} className={styles.panel} data-guide-plesk-panel={tab} role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} tabIndex={0}>
        {tab === "fish" ? <FishCounter economy={economy} state={state} catalog={catalog} /> : tab === "tackle" ? <PleskTackleCounter key={guideRequest?.sequence ?? 0} economy={economy} state={state} catalog={catalog} onOpenOrders={onOpenOrders} guideKind={guideRequest?.stepId === "rods" ? "rod" : guideRequest?.stepId === "bait" ? "bait" : undefined} /> : <PleskFishingCollection state={state} catalog={catalog} />}
      </div>
    </>}
    <div className={styles.departure}><button type="button" className={styles.fishingButton} onClick={onFishing}><FishingRod size={22} aria-hidden="true" /><span><strong>На рыбалку</strong><small>Выбрать маршрут и снасти</small></span><ArrowRight size={18} aria-hidden="true" /></button><button type="button" className={styles.pantryLink} onClick={onOpenPantry}><Package size={15} aria-hidden="true" />Другие запасы<ArrowRight size={13} aria-hidden="true" /></button></div>
  </div>;
}
