"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Anchor, ArrowRight, BookOpen, Bug, Check, Clock3, Fish, FishingRod, Package, RefreshCw, Store } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { FishingRodIcon } from "@/features/world/fishing-rod-icon";
import { ECONOMY_MAX_BALANCE, type EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { fishingIneligibility, fishingOdds, fishingState } from "./fishing";
import { canRefreshFishingShop, fishingShopRefreshPrice } from "./fishing-shop";
import { formatPearls } from "./money";
import { residentOrderBoard } from "./food";
import { fishDiscovered, PlayerItemIcon } from "./fish-discovery";
import { FishRarityBadge, FISH_RARITY_LEVELS } from "./fish-rarity";
import { PantrySale } from "./world-pantry-menu";
import { itemName, locked, number } from "./world-economy-parts";
import { useFishingCommand } from "./use-fishing-command";
import { PleskFishingCollection } from "./plesk-fishing-book";
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

/** The names and drawings of undiscovered species stay sealed; probabilities remain inspectable. */
export function PleskCatchOdds({ state, catalog, override, preview = false }: { state: EconomyView; catalog: FishingCatalog;
  override?: Parameters<typeof fishingOdds>[2]; preview?: boolean }) {
  const odds = fishingOdds(state, catalog, override);
  const gear = fishingState(state);
  const byRarity = FISH_RARITY_LEVELS.map(rarity => ({ rarity, probability: odds.filter(odd => catalog.fish.find(fish => fish.itemId === odd.itemId)!.rarity === rarity)
    .reduce((sum, odd) => sum + odd.probability, 0) }));
  return <section className={styles.odds} aria-label={preview ? "Шансы с выбранной снастью" : "Шансы текущих снастей"}>
    <p><span>{preview ? "С этой снастью" : "Шансы выбранных снастей"}</span><small>на один особый улов</small></p>
    <dl className={styles.rarityOdds} aria-label="Шансы по разрядам">{byRarity.map(({ rarity, probability }) => <div key={rarity}><dt><FishRarityBadge rarity={rarity} /></dt><dd>{percent(probability)}</dd></div>)}</dl>
    <details><summary>Шансы всех видов</summary><p className={styles.hint}>Каждый особый улов проверяется отдельно. Их количество зависит от длительности рыбалки; остальная партия — обычная рыба.</p>
      <dl className={styles.oddsList}>{odds.map(odd => {
        const fish = catalog.fish.find(entry => entry.itemId === odd.itemId)!;
        const reason = fishingIneligibility(fish, override?.rodId ?? gear.equippedRodId, override?.hookId ?? gear.equippedHookId, catalog);
        return <div key={odd.itemId} data-fish-odds={odd.itemId}><dt><span>{fishDiscovered(state, odd.itemId) ? itemName(state, odd.itemId) : "Неизвестная рыба"}</span><FishRarityBadge rarity={fish.rarity} />{reason && <small>{reason === "legendary_tackle" ? "Нужны легендарные удочка и крючок" : "Нужен особый крючок"}</small>}</dt><dd>{percent(odd.probability)}</dd></div>;
      })}</dl>
    </details>
    {preview && <small>Эти шансы будут после выбора снасти перед отправлением.</small>}
  </section>;
}

export function fishingTradeLimits(state: EconomyView, itemId: string) {
  const fish = state.catalog.fishing?.fish.find(entry => entry.itemId === itemId), item = state.catalog.items.find(entry => entry.id === itemId);
  if (!fish || !item) return { buy: 0, sell: 0, buyPrice: 0, sellPrice: 0 };
  return { buy: 0, buyPrice: 0,
    sell: item.tradable ? Math.max(0, Math.min(state.catalog.maxBatch, state.inventory[itemId] ?? 0, Math.floor((ECONOMY_MAX_BALANCE - state.wallet.coins) / item.baseSellPrice))) : 0,
    sellPrice: item.baseSellPrice };
}

export function PleskFishTrade({ economy, state, itemId }: ReadyProps & { itemId: string }) {
  const [quantityText, setQuantityText] = useState("1"), id = useId();
  const { blocked, send } = useFishingCommand({ economy, state });
  const limits = fishingTradeLimits(state, itemId), quantity = Number(quantityText), stock = state.inventory[itemId] ?? 0;
  const valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity > 0, canSell = valid && quantity <= limits.sell;
  return <section className={styles.trade} aria-label={`Продажа: ${itemName(state, itemId)}`}>
    <div className={styles.tradeHeading}><span>В запасе <strong>{number(stock)}</strong></span><span>За штуку <Price value={limits.sellPrice} /></span></div>
    <div className={styles.quantity}><label htmlFor={id}>Количество</label><input id={id} type="number" inputMode="numeric" min={1} max={Math.max(1, limits.sell)} step={1} value={quantityText} disabled={blocked} onChange={event => setQuantityText(event.target.value)} /><button type="button" disabled={blocked || limits.sell === 0} onClick={() => setQuantityText(String(limits.sell))}>{limits.sell < stock ? `До ${number(limits.sell)}` : "Весь улов"}</button></div>
    <button type="button" className={styles.primary} disabled={blocked || !canSell} onClick={() => send("sell_fish", itemId, quantity, 0, canSell)} aria-label={`Продать ${itemName(state, itemId)}: ${valid ? quantity : 0}`}><span>Продать</span>{canSell ? <Price value={quantity * limits.sellPrice} /> : <span>—</span>}</button>
    {!valid && <p className={styles.hint}>Введите целое количество от 1.</p>}
    {valid && stock > 0 && !canSell && <p className={styles.hint}>{quantity > stock ? "Столько рыбы в запасе пока нет." : "Этот объём пока нельзя продать. Уменьшите количество."}</p>}
  </section>;
}

export function FishCounter({ economy, state, catalog }: ReadyProps & { catalog: FishingCatalog }) {
  const available = catalog.fish.filter(fish => (state.inventory[fish.itemId] ?? 0) > 0);
  const [selection, setSelection] = useState(() => available[0]?.itemId);
  const selected = available.find(fish => fish.itemId === selection) ?? available[0];
  return <>
    <p className={styles.intro}>«Принесёшь улов — с радостью куплю!»</p>
    {available.length ? <div className={styles.fishList} aria-label="Рыба в вашей кладовой">{available.map(fish => <button type="button" key={fish.itemId} className={styles.fishChoice} aria-pressed={fish === selected} onClick={() => setSelection(fish.itemId)}>
      <PlayerItemIcon state={state} itemId={fish.itemId} size={40} /><span><strong>{itemName(state, fish.itemId)}</strong><FishRarityBadge rarity={fish.rarity} /></span><span className={styles.stock}>×{number(state.inventory[fish.itemId])}</span>
    </button>)}</div> : <div className={styles.emptyCatch}><Fish size={32} aria-hidden="true" /><strong>Улов ещё впереди</strong><p>Заберите рыбу после вылазки — она появится здесь.</p></div>}
    {selected && <PleskFishTrade key={selected.itemId} economy={economy} state={state} itemId={selected.itemId} />}
  </>;
}

export function PleskRodOffer({ economy, state, rod }: ReadyProps & { rod: FishingCatalog["rods"][number] }) {
  const { blocked, send } = useFishingCommand({ economy, state }), gear = fishingState(state);
  const owned = gear.ownedRods.includes(rod.id), equipped = gear.equippedRodId === rod.id, offer = offerFor(state, rod.id);
  const price = offer?.unitPrice ?? rod.price, live = offerLive(state, economy.now, offer), affordable = state.wallet.coins >= price;
  const allowed = !owned && live && affordable;
  return <article className={styles.gearCard} data-gear-rarity={rod.rarity}>
    <div className={styles.gearHeading}><FishingRodIcon rodId={rod.id} size={48} /><div><h3>{rod.name}</h3><FishRarityBadge rarity={rod.rarity} /><p>{owned ? "Уже куплена" : "Останется навсегда"}</p></div>{owned && <Check size={17} aria-hidden="true" />}</div>
    <p className={styles.description}>{rod.description}</p>
    <PleskCatchOdds state={state} catalog={state.catalog.fishing!} override={{ rodId: rod.id }} preview={!equipped} />
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
    <p className={styles.description}>{hook.description}</p>
    <PleskCatchOdds state={state} catalog={state.catalog.fishing!} override={{ hookId: hook.id }} preview={!equipped} />
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
    <p className={styles.description}>{bait.description}</p>
    <PleskCatchOdds state={state} catalog={state.catalog.fishing!} override={{ baitId: bait.itemId }} preview />
    {live && <><div className={styles.quantity}><label htmlFor={id}>Купить штук</label><input id={id} type="number" inputMode="numeric" min={1} max={Math.max(1, maximum)} step={1} value={quantityText} disabled={blocked} onChange={event => setQuantityText(event.target.value)} /><small>На прилавке {offer!.remaining}</small></div>
      <button type="button" className={styles.primary} disabled={blocked || !valid} onClick={() => send("buy_fishing_item", offer!.id, quantity, quantity * price, valid)} aria-label={`Купить наживку: ${itemName(state, bait.itemId)}`}><span>Купить наживку</span>{Number.isSafeInteger(quantity) && quantity > 0 ? <Price value={quantity * price} /> : <span>—</span>}</button></>}
    {live && maximum === 0 && <p className={styles.hint}>{state.storage.available === 0 ? "Кладовая заполнена." : "Для покупки не хватает монет."}</p>}
    {!live && <p className={styles.hint}>Сегодня на прилавке закончилась.</p>}
  </article>;
}

export function PleskFishOffer({ economy, state, fish, onOpenOrders }: ReadyProps & { fish: FishingCatalog["fish"][number]; onOpenOrders?: () => void }) {
  const { blocked, send } = useFishingCommand({ economy, state }), [quantityText, setQuantityText] = useState("1"), id = useId();
  const offer = offerFor(state, fish.itemId), live = offerLive(state, economy.now, offer), price = offer?.unitPrice ?? fish.buyPrice;
  const maximum = live ? Math.max(0, Math.min(offer!.remaining, state.catalog.maxBatch, state.storage.available, Math.floor(state.wallet.coins / price))) : 0;
  const quantity = Number(quantityText), valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= maximum;
  const name = itemName(state, fish.itemId);
  const order = residentOrderBoard(state, economy.now, state.catalog).offers.find(entry => entry.residentId === "plesk" && (entry.items[fish.itemId] ?? 0) > 0);
  return <article className={styles.gearCard} data-gear-rarity={fish.rarity}>
    <div className={styles.gearHeading}><ItemIcon itemId={fish.itemId} size={48} /><div><h3>{name}</h3><FishRarityBadge rarity={fish.rarity} /><p>В запасе {number(state.inventory[fish.itemId] ?? 0)}</p></div></div>
    <p className={styles.description}>Для готовки и заказов. В книгу попадёт только ваш собственный улов.</p>
    <div className={styles.discountPrice}>{price < fish.buyPrice && <del aria-label={`Обычная цена: ${number(fish.buyPrice)} монет`}><Price value={fish.buyPrice} /></del>}<Price value={price} /><span>за штуку</span></div>
    {live ? <><div className={styles.quantity}><label htmlFor={id}>Купить штук</label><input id={id} type="number" inputMode="numeric" min={1} max={Math.max(1, maximum)} step={1} value={quantityText} disabled={blocked} onChange={event => setQuantityText(event.target.value)} /><small>На прилавке {offer!.remaining}</small></div>
      <button type="button" className={styles.primary} disabled={blocked || !valid} onClick={() => send("buy_fishing_item", offer!.id, quantity, quantity * price, valid)} aria-label={`Купить рыбу: ${name}`}><span>Купить рыбу</span>{Number.isSafeInteger(quantity) && quantity > 0 ? <Price value={quantity * price} /> : <span>—</span>}</button></>
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
  const rod = catalog.rods.find(entry => entry.id === itemId), hook = catalog.hooks.find(entry => entry.id === itemId), bait = catalog.baits.find(entry => entry.itemId === itemId), fish = catalog.fish.find(entry => entry.itemId === itemId);
  return rod ? <PleskRodOffer economy={economy} state={state} rod={rod} /> : hook ? <PleskHookOffer economy={economy} state={state} hook={hook} /> : bait ? <PleskBaitOffer economy={economy} state={state} bait={bait} /> : fish ? <PleskFishOffer economy={economy} state={state} fish={fish} onOpenOrders={onOpenOrders} /> : null;
}

const merchantSlots = [{ kind: "rod", name: "Удочки", icon: FishingRod }, { kind: "hook", name: "Крючки", icon: Anchor }, { kind: "bait", name: "Наживки", icon: Bug }, { kind: "fish", name: "Рыба дня", icon: Fish }] as const;
export function PleskTackleCounter({ economy, state, catalog, onOpenOrders }: ReadyProps & { catalog: FishingCatalog; onOpenOrders?: () => void }) {
  const offers = state.fishingShop?.offers ?? [];
  const previousStock = offers.filter(offer => offers.find(entry => entry.kind === offer.kind)?.id !== offer.id);
  const [selectedId, setSelectedId] = useState(() => offers[0]?.id);
  const selected = offers.find(offer => offer.id === selectedId) ?? offers[0];
  const scrollPosition = useRef<{ body: HTMLElement; top: number } | null>(null);
  useLayoutEffect(() => {
    // Keyed descriptions replace their scroll anchors; keep the reader's position.
    const position = scrollPosition.current;
    scrollPosition.current = null;
    if (position?.body.isConnected) position.body.scrollTop = position.top;
  }, [selected?.id]);
  const selectOffer = (offerId: string, button: HTMLButtonElement) => {
    const body = button.closest<HTMLElement>("[data-slot='dialog-content']");
    scrollPosition.current = body && offerId !== selected?.id ? { body, top: body.scrollTop } : null;
    button.focus({ preventScroll: true });
    setSelectedId(offerId);
  };
  return <>
    <PleskMerchantHeader economy={economy} state={state} />
    <div className={styles.offerGrid} aria-label="Предложения Плёски">{merchantSlots.map(slot => {
      const offer = offers.find(entry => entry.kind === slot.kind);
      if (!offer) return <div key={slot.kind} className={styles.emptyOffer}><slot.icon size={26} aria-hidden="true" /><strong>{slot.name}</strong><span>Ждём поставку</span></div>;
      const entry = offer.kind === "rod" ? catalog.rods.find(rod => rod.id === offer.itemId) : offer.kind === "hook" ? catalog.hooks.find(hook => hook.id === offer.itemId) : offer.kind === "fish" ? catalog.fish.find(fish => fish.itemId === offer.itemId) : catalog.baits.find(bait => bait.itemId === offer.itemId);
      if (!entry) return null;
      const name = "name" in entry ? entry.name : itemName(state, offer.itemId);
      const discount = "buyPrice" in entry ? Math.max(0, Math.round((1 - offer.unitPrice / entry.buyPrice) * 100)) : 0;
      return <button type="button" key={offer.id} className={styles.offerTile} data-gear-rarity={entry.rarity} aria-pressed={selected?.id === offer.id} onPointerDown={event => { if (event.button === 0) event.currentTarget.focus({ preventScroll: true }); }} onClick={event => selectOffer(offer.id, event.currentTarget)}>
        <small className={styles.offerKind}>{slot.name}{discount > 0 && <span>−{discount}%</span>}</small>
        <span className={styles.offerArt}>{offer.kind === "rod" ? <FishingRodIcon rodId={offer.itemId} size={44} /> : <ItemIcon itemId={offer.itemId} size={36} />}</span>
        <strong>{name}</strong><FishRarityBadge rarity={entry.rarity} />
        <span className={styles.offerBottom}>{offer.remaining > 0 ? <><Price value={offer.unitPrice} /><small>×{offer.remaining}</small></> : <small><Check size={12} aria-hidden="true" />Раскуплено</small>}</span>
      </button>;
    })}</div>
    {previousStock.length > 0 && <details className={styles.previousStock}><summary>Остатки прежней поставки · {previousStock.length}</summary><div>{previousStock.map(offer => <button key={offer.id} type="button" aria-pressed={selected?.id === offer.id} onPointerDown={event => { if (event.button === 0) event.currentTarget.focus({ preventScroll: true }); }} onClick={event => selectOffer(offer.id, event.currentTarget)}>
      <span>{catalog.rods.find(rod => rod.id === offer.itemId)?.name ?? catalog.hooks.find(hook => hook.id === offer.itemId)?.name ?? itemName(state, offer.itemId)}</span>
      {offer.remaining > 0 ? <Price value={offer.unitPrice} /> : <span>Раскуплено</span>}
    </button>)}</div></details>}
    {selected && <GearDetail key={selected.id} economy={economy} state={state} catalog={catalog} itemId={selected.itemId} onOpenOrders={onOpenOrders} />}

  </>;
}

export type PleskFishingShopProps = { economy: EconomyController; onFishing: () => void; onOpenPantry: () => void; onOpenOrders?: () => void };
export function PleskFishingShop({ economy, onFishing, onOpenPantry, onOpenOrders }: PleskFishingShopProps) {
  const [tab, setTab] = useState<ShopTab>("tackle"), id = useId(), tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const state = economy.snapshot, catalog = state?.catalog.fishing, cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const recovery = (economy.error || economy.uncertain) && <div className={styles.recovery} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Дождитесь подтверждения, прежде чем торговать снова." : economy.error}</p><button type="button" disabled={economy.busy || cooldown > 0} onClick={() => { if (!economy.busy && !cooldown) void economy.retry(); }}><RefreshCw size={14} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button></div>;
  return <div className={styles.shop} aria-busy={economy.busy || undefined}>
    {state && <div className={styles.wallet}><span>Лавка у пирса</span><span aria-label={`Монеты: ${number(state.wallet.coins)}. Жемчуг: ${formatPearls(state.wallet.pearls)}`}><Price value={state.wallet.coins} /><Price value={state.wallet.pearls} pearls /></span></div>}
    {recovery}
    {!state ? <p className={styles.hint} role="status">Проверяем ваши запасы…</p> : !catalog ? <><p className={styles.intro}>«Принесёшь речную рыбу — куплю!»</p>{(state.inventory.fish ?? 0) > 0 ? <PantrySale economy={{ ...economy, snapshot: state }} itemId="fish" /> : <p className={styles.hint}>В вашей кладовой пока нет речной рыбы.</p>}</> : <>
      <div className={styles.tabs} role="tablist" aria-label="Лавка Плёски">{tabs.map((entry, index) => <button key={entry.id} ref={node => { tabButtons.current[index] = node; }} type="button" role="tab" id={`${id}-${entry.id}`} aria-selected={tab === entry.id} aria-controls={`${id}-panel`} tabIndex={tab === entry.id ? 0 : -1} onClick={() => setTab(entry.id)} onKeyDown={event => {
        let next = index;
        if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
        else if (event.key === "ArrowLeft") next = (index + tabs.length - 1) % tabs.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = tabs.length - 1;
        else return;
        event.preventDefault(); setTab(tabs[next].id); tabButtons.current[next]?.focus();
      }}><entry.icon size={17} aria-hidden="true" />{entry.name}</button>)}</div>
      <div key={state.ownerPublicId} className={styles.panel} role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`} tabIndex={0}>
        {tab === "fish" ? <FishCounter economy={economy} state={state} catalog={catalog} /> : tab === "tackle" ? <PleskTackleCounter economy={economy} state={state} catalog={catalog} onOpenOrders={onOpenOrders} /> : <PleskFishingCollection state={state} catalog={catalog} />}
      </div>
    </>}
    <div className={styles.departure}><button type="button" className={styles.fishingButton} onClick={onFishing}><FishingRod size={22} aria-hidden="true" /><span><strong>На рыбалку</strong><small>Выбрать маршрут и снасти</small></span><ArrowRight size={18} aria-hidden="true" /></button><button type="button" className={styles.pantryLink} onClick={onOpenPantry}><Package size={15} aria-hidden="true" />Другие запасы<ArrowRight size={13} aria-hidden="true" /></button></div>
  </div>;
}
