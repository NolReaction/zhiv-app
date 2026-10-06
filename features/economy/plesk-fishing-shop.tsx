"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, BookOpen, Check, Clock3, Fish, FishingRod, Package, RefreshCw, Shell, Store } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { FishingRodIcon } from "@/features/world/fishing-rod-icon";
import { ECONOMY_MAX_BALANCE, type EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { fishingOdds, fishingState } from "./fishing";
import { canRefreshFishingShop } from "./fishing-shop";
import { fishDiscovered, HiddenFishIcon, PlayerItemIcon } from "./fish-discovery";
import { FishRarityBadge, FishRarityScale, FISH_RARITY_LEVELS } from "./fish-rarity";
import { PantrySale } from "./world-pantry-menu";
import { itemName, number } from "./world-economy-parts";
import { useFishingCommand } from "./use-fishing-command";
import styles from "./plesk-fishing-shop.module.css";

type ReadyProps = { economy: EconomyController; state: EconomyView };
type FishingCatalog = NonNullable<EconomyView["catalog"]["fishing"]>;
type Offer = NonNullable<EconomyView["fishingShop"]>["offers"][number];
type ShopTab = "tackle" | "fish" | "collection";
const tabs = [{ id: "tackle", name: "Лавка", icon: Store }, { id: "fish", name: "Улов", icon: Fish }, { id: "collection", name: "Книга", icon: BookOpen }] as const;

function Price({ value, pearls = false }: { value: number; pearls?: boolean }) {
  return <span className={styles.price}>{number(value)}<ItemIcon itemId={pearls ? "pearls" : "coins"} size={16} /></span>;
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
  const byRarity = FISH_RARITY_LEVELS.map(rarity => ({ rarity, probability: odds.filter(odd => catalog.fish.find(fish => fish.itemId === odd.itemId)!.rarity === rarity)
    .reduce((sum, odd) => sum + odd.probability, 0) }));
  return <section className={styles.odds} aria-label={preview ? "Шансы с выбранной снастью" : "Шансы текущих снастей"}>
    <p><span>{preview ? "С этой снастью" : "Шансы выбранных снастей"}</span><small>на один особый улов</small></p>
    <dl className={styles.rarityOdds} aria-label="Шансы по разрядам">{byRarity.map(({ rarity, probability }) => <div key={rarity}><dt><FishRarityBadge rarity={rarity} /></dt><dd>{percent(probability)}</dd></div>)}</dl>
    <details><summary>Шансы всех видов</summary><p className={styles.hint}>Каждый особый улов проверяется отдельно. Их количество зависит от длительности рыбалки; остальная партия — обычная рыба.</p>
      <dl className={styles.oddsList}>{odds.map(odd => {
        const fish = catalog.fish.find(entry => entry.itemId === odd.itemId)!;
        return <div key={odd.itemId} data-fish-odds={odd.itemId}><dt><span>{fishDiscovered(state, odd.itemId) ? itemName(state, odd.itemId) : "Неизвестная рыба"}</span><FishRarityBadge rarity={fish.rarity} />{odd.probability === 0 && <small>Нужен особый крючок</small>}</dt><dd>{percent(odd.probability)}</dd></div>;
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

export function PleskMerchantHeader({ economy, state }: ReadyProps) {
  const shop = state.fishingShop, { blocked, send } = useFishingCommand({ economy, state });
  const [confirm, setConfirm] = useState<string | null>(null), refreshed = useRef<string | null>(null);
  const confirmation = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null), wasConfirming = useRef(false);
  const confirming = !!shop && confirm === shop.id;
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
  if (!shop) return <p className={styles.hint} role="status">Плёска раскладывает товары…</p>;
  const time = `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  const canReplace = canRefreshFishingShop(state);
  const allowed = seconds > 0 && canReplace && state.wallet.pearls >= shop.refreshPricePearls;
  return <section className={styles.merchantHeader} aria-label="Обновление прилавка">
    <div><strong>Сегодня у Плёски</strong><span><Clock3 size={14} aria-hidden="true" />{seconds > 0 ? <>Новые товары через <time>{time}</time></> : "Открываем новые предложения…"}</span></div>
    {!canReplace && seconds > 0 && <p className={styles.restockHint}>Плёска ждёт новую поставку</p>}
    {confirming ? <div ref={confirmation} className={styles.refreshConfirm} role="group" tabIndex={-1} aria-label="Подтверждение обновления прилавка"><p>Заменить все товары на другие за <Price value={shop.refreshPricePearls} pearls />?</p><div><button type="button" className={styles.secondary} onClick={() => setConfirm(null)}>Оставить</button><button type="button" className={styles.primary} disabled={blocked || !allowed} onClick={() => { send("refresh_fishing_shop", shop.id, 1, shop.refreshPricePearls, allowed); setConfirm(null); }}>Обновить</button></div></div>
      : <button ref={trigger} type="button" className={styles.refreshOffers} disabled={blocked || !allowed} onClick={() => { if (!blocked && allowed) setConfirm(shop.id); }} aria-label={`Обновить предложения за ${shop.refreshPricePearls} жемчужин`}><RefreshCw size={14} aria-hidden="true" />Обновить<Price value={shop.refreshPricePearls} pearls /></button>}
  </section>;
}

function GearDetail({ economy, state, catalog, itemId }: ReadyProps & { catalog: FishingCatalog; itemId: string }) {
  const rod = catalog.rods.find(entry => entry.id === itemId), hook = catalog.hooks.find(entry => entry.id === itemId), bait = catalog.baits.find(entry => entry.itemId === itemId);
  return rod ? <PleskRodOffer economy={economy} state={state} rod={rod} /> : hook ? <PleskHookOffer economy={economy} state={state} hook={hook} /> : bait ? <PleskBaitOffer economy={economy} state={state} bait={bait} /> : null;
}

export function PleskTackleCounter({ economy, state, catalog }: ReadyProps & { catalog: FishingCatalog }) {
  const offers = state.fishingShop?.offers ?? [];
  const [selectedId, setSelectedId] = useState(() => offers[0]?.id);
  const selected = offers.find(offer => offer.id === selectedId) ?? offers[0];
  return <>
    <PleskMerchantHeader economy={economy} state={state} />
    <div className={styles.offerGrid} aria-label="Предложения Плёски">{offers.map(offer => {
      const entry = offer.kind === "rod" ? catalog.rods.find(rod => rod.id === offer.itemId) : offer.kind === "hook" ? catalog.hooks.find(hook => hook.id === offer.itemId) : catalog.baits.find(bait => bait.itemId === offer.itemId);
      if (!entry) return null;
      return <button type="button" key={offer.id} className={styles.offerTile} data-gear-rarity={entry.rarity} aria-pressed={selected?.id === offer.id} onClick={() => setSelectedId(offer.id)}>
        <span className={styles.offerArt}>{offer.kind === "rod" ? <FishingRodIcon rodId={offer.itemId} size={54} /> : <ItemIcon itemId={offer.itemId} size={44} />}</span>
        <strong>{"name" in entry ? entry.name : itemName(state, offer.itemId)}</strong><FishRarityBadge rarity={entry.rarity} />
        <span className={styles.offerBottom}>{offer.remaining > 0 ? <><Price value={offer.unitPrice} /><small>×{offer.remaining}</small></> : <small><Check size={12} aria-hidden="true" />Раскуплено</small>}</span>
      </button>;
    })}</div>
    {selected && <GearDetail key={selected.id} economy={economy} state={state} catalog={catalog} itemId={selected.itemId} />}

  </>;
}

export function PleskFishingCollection({ state, catalog }: { state: EconomyView; catalog: FishingCatalog }) {
  const { catches } = fishingState(state), discovered = catalog.fish.filter(fish => fishDiscovered(state, fish.itemId)).length;
  return <>
    <div className={styles.collectionHeading}><Shell size={24} aria-hidden="true" /><div><h2>Рыбацкая коллекция</h2><p>Виды рыб: {discovered} / {catalog.fish.length}</p></div></div>
    <p className={styles.description}>Забирайте добычу после рыбалки, чтобы открывать виды. Проданная рыба остаётся в коллекции.</p>
    <FishRarityScale />
    <div className={styles.collection} aria-label="Пойманные виды рыб">{catalog.fish.map(fish => {
      const caught = catches[fish.itemId] ?? 0;
      return <article className={styles.specimen} key={fish.itemId} data-discovered={caught > 0}>
        {caught > 0 ? <PlayerItemIcon state={state} itemId={fish.itemId} size={64} /> : <HiddenFishIcon size={64} />}<h3>{caught > 0 ? itemName(state, fish.itemId) : "Неизвестная рыба"}</h3><FishRarityBadge rarity={fish.rarity} /><p>{caught > 0 ? `Поймано: ${number(caught)}` : "Пока скрыта"}</p>
      </article>;
    })}</div>
  </>;
}

export type PleskFishingShopProps = { economy: EconomyController; onFishing: () => void; onOpenPantry: () => void };
export function PleskFishingShop({ economy, onFishing, onOpenPantry }: PleskFishingShopProps) {
  const [tab, setTab] = useState<ShopTab>("tackle"), id = useId(), tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const state = economy.snapshot, catalog = state?.catalog.fishing, cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const recovery = (economy.error || economy.uncertain) && <div className={styles.recovery} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Дождитесь подтверждения, прежде чем торговать снова." : economy.error}</p><button type="button" disabled={economy.busy || cooldown > 0} onClick={() => { if (!economy.busy && !cooldown) void economy.retry(); }}><RefreshCw size={14} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button></div>;
  return <div className={styles.shop} aria-busy={economy.busy || undefined}>
    {state && <div className={styles.wallet}><span>Лавка у пирса</span><span aria-label={`Монеты: ${number(state.wallet.coins)}. Жемчуг: ${number(state.wallet.pearls)}`}><Price value={state.wallet.coins} /><Price value={state.wallet.pearls} pearls /></span></div>}
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
        {tab === "fish" ? <FishCounter economy={economy} state={state} catalog={catalog} /> : tab === "tackle" ? <PleskTackleCounter economy={economy} state={state} catalog={catalog} /> : <PleskFishingCollection state={state} catalog={catalog} />}
      </div>
    </>}
    <div className={styles.departure}><button type="button" className={styles.fishingButton} onClick={onFishing}><FishingRod size={22} aria-hidden="true" /><span><strong>На рыбалку</strong><small>Выбрать маршрут и снасти</small></span><ArrowRight size={18} aria-hidden="true" /></button><button type="button" className={styles.pantryLink} onClick={onOpenPantry}><Package size={15} aria-hidden="true" />Другие запасы<ArrowRight size={13} aria-hidden="true" /></button></div>
  </div>;
}
