"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, BookOpen, Check, CircleHelp, Clock3, Fish, FishingRod, Package, RefreshCw, Shell, Store } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { FishingRodIcon } from "@/features/world/fishing-rod-icon";
import { ECONOMY_MAX_BALANCE, type EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { fishingOdds, fishingState } from "./fishing";
import { fishDiscovered, PlayerItemIcon } from "./fish-discovery";
import { FishRarityBadge, FishRarityScale } from "./fish-rarity";
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
const percent = (probability: number) => `${new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 4 }).format(probability * 100)}%`;
function offerFor(state: EconomyView, itemId: string) { return state.fishingShop?.offers.find(offer => offer.itemId === itemId); }
function offerLive(state: EconomyView, now: number, offer?: Offer) {
  return !!offer && offer.remaining > 0 && Date.parse(state.fishingShop?.refreshAt ?? "") > now;
}

/** The names and drawings of undiscovered species stay sealed; probabilities remain inspectable. */
export function PleskCatchOdds({ state, catalog, override, preview = false }: { state: EconomyView; catalog: FishingCatalog;
  override?: Parameters<typeof fishingOdds>[2]; preview?: boolean }) {
  const odds = fishingOdds(state, catalog, override);
  const valuable = odds.filter(odd => ["rare", "epic", "legendary"].includes(catalog.fish.find(fish => fish.itemId === odd.itemId)!.rarity))
    .reduce((sum, odd) => sum + odd.probability, 0);
  return <section className={styles.odds} aria-label={preview ? "Шансы с выбранной снастью" : "Шансы текущих снастей"}>
    <p><span>{preview ? "С этой снастью · редкая и выше" : "Редкая и выше"}</span><strong>{percent(valuable)}</strong></p>
    <details><summary>Шансы всех видов</summary><p className={styles.hint}>Шансы одного особого улова за вылазку. Остальные рыбы в партии — обычная рыба.</p>
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
  const allowed = !equipped && (owned || live && affordable);
  return <article className={styles.gearCard} data-selected={equipped || undefined} data-gear-rarity={rod.rarity}>
    <div className={styles.gearHeading}><FishingRodIcon rodId={rod.id} size={48} /><div><h3>{rod.name}</h3><FishRarityBadge rarity={rod.rarity} /><p>{equipped ? "Сейчас с собой" : owned ? "В ваших снастях" : "Останется навсегда"}</p></div>{equipped && <Check size={17} aria-hidden="true" />}</div>
    <p className={styles.description}>{rod.description}</p>
    <PleskCatchOdds state={state} catalog={state.catalog.fishing!} override={{ rodId: rod.id }} preview={!equipped} />
    <button type="button" className={owned ? styles.secondary : styles.primary} disabled={blocked || !allowed} onClick={() => send(owned ? "equip_fishing_rod" : "buy_fishing_item", owned ? rod.id : offer?.id ?? "", 1, owned ? 0 : price, allowed)}>{equipped ? "Выбрана" : owned ? "Взять с собой" : !live ? "Нет на прилавке" : <><span>Купить удочку</span><Price value={price} /></>}</button>
    {!owned && live && !affordable && <p className={styles.hint}>Не хватает {number(price - state.wallet.coins)} монет.</p>}
  </article>;
}

export function PleskHookOffer({ economy, state, hook }: ReadyProps & { hook: FishingCatalog["hooks"][number] }) {
  const { blocked, send } = useFishingCommand({ economy, state }), gear = fishingState(state);
  const owned = gear.ownedHooks.includes(hook.id), equipped = gear.equippedHookId === hook.id, offer = offerFor(state, hook.id);
  const price = offer?.unitPrice ?? hook.price, live = offerLive(state, economy.now, offer), affordable = state.wallet.coins >= price;
  const allowed = !equipped && (owned || live && affordable);
  return <article className={styles.gearCard} data-selected={equipped || undefined} data-gear-rarity={hook.rarity}>
    <div className={styles.gearHeading}><ItemIcon itemId={hook.id} size={48} /><div><h3>{hook.name}</h3><FishRarityBadge rarity={hook.rarity} /><p>{equipped ? "Сейчас с собой" : owned ? "В ваших снастях" : "Останется навсегда"}</p></div>{equipped && <Check size={17} aria-hidden="true" />}</div>
    <p className={styles.description}>{hook.description}</p>
    <PleskCatchOdds state={state} catalog={state.catalog.fishing!} override={{ hookId: hook.id }} preview={!equipped} />
    <button type="button" className={owned ? styles.secondary : styles.primary} disabled={blocked || !allowed} onClick={() => send(owned ? "equip_fishing_hook" : "buy_fishing_item", owned ? hook.id : offer?.id ?? "", 1, owned ? 0 : price, allowed)}>{equipped ? "Выбран" : owned ? "Взять с собой" : !live ? "Нет на прилавке" : <><span>Купить крючок</span><Price value={price} /></>}</button>
    {!owned && live && !affordable && <p className={styles.hint}>Не хватает {number(price - state.wallet.coins)} монет.</p>}
    <p className={styles.footnote}>Не расходуется и не занимает место в кладовой.</p>
  </article>;
}

export function PleskBaitOffer({ economy, state, bait }: ReadyProps & { bait: FishingCatalog["baits"][number] }) {
  const { blocked, send } = useFishingCommand({ economy, state }), [quantityText, setQuantityText] = useState("1"), id = useId();
  const stock = state.inventory[bait.itemId] ?? 0, selected = fishingState(state).equippedBaitId === bait.itemId, offer = offerFor(state, bait.itemId);
  const price = offer?.unitPrice ?? bait.price, live = offerLive(state, economy.now, offer);
  const maximum = live ? Math.max(0, Math.min(offer!.remaining, state.catalog.maxBatch, state.storage.available, Math.floor(state.wallet.coins / price))) : 0;
  const quantity = Number(quantityText), valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= maximum;
  return <article className={styles.gearCard} data-selected={selected || undefined} data-gear-rarity={bait.rarity}>
    <div className={styles.gearHeading}><ItemIcon itemId={bait.itemId} size={40} /><div><h3>{itemName(state, bait.itemId)}</h3><FishRarityBadge rarity={bait.rarity} /><p>В запасе {number(stock)}{selected ? " · Выбрана" : ""}</p></div></div>
    <p className={styles.description}>{bait.description}</p>
    <PleskCatchOdds state={state} catalog={state.catalog.fishing!} override={{ baitId: bait.itemId }} preview={!selected} />
    {live && <><div className={styles.quantity}><label htmlFor={id}>Купить штук</label><input id={id} type="number" inputMode="numeric" min={1} max={Math.max(1, maximum)} step={1} value={quantityText} disabled={blocked} onChange={event => setQuantityText(event.target.value)} /><small>На прилавке {offer!.remaining}</small></div>
      <button type="button" className={styles.primary} disabled={blocked || !valid} onClick={() => send("buy_fishing_item", offer!.id, quantity, quantity * price, valid)} aria-label={`Купить наживку: ${itemName(state, bait.itemId)}`}><span>Купить наживку</span>{Number.isSafeInteger(quantity) && quantity > 0 ? <Price value={quantity * price} /> : <span>—</span>}</button></>}
    {stock > 0 && <div className={styles.equipRow}><span>На следующую рыбалку</span><button type="button" className={styles.secondary} disabled={blocked || selected} onClick={() => send("equip_fishing_bait", bait.itemId, 1, 0, !selected && stock > 0)}>{selected ? "Выбрана" : "Использовать"}</button></div>}
    {selected && stock === 0 && <p className={styles.hint}>Наживка закончилась. Пополните запас или выберите рыбалку без наживки.</p>}
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
  const allowed = seconds > 0 && state.wallet.pearls >= shop.refreshPricePearls;
  return <section className={styles.merchantHeader} aria-label="Обновление прилавка">
    <div><strong>Сегодня у Плёски</strong><span><Clock3 size={14} aria-hidden="true" />{seconds > 0 ? <>Новые товары через <time>{time}</time></> : "Открываем новые предложения…"}</span></div>
    {confirming ? <div ref={confirmation} className={styles.refreshConfirm} role="group" tabIndex={-1} aria-label="Подтверждение обновления прилавка"><p>Привезти новые товары за <Price value={shop.refreshPricePearls} pearls />?</p><div><button type="button" className={styles.secondary} onClick={() => setConfirm(null)}>Оставить</button><button type="button" className={styles.primary} disabled={blocked || !allowed} onClick={() => { send("refresh_fishing_shop", shop.id, 1, shop.refreshPricePearls, allowed); setConfirm(null); }}>Обновить</button></div></div>
      : <button ref={trigger} type="button" className={styles.refreshOffers} disabled={blocked || !allowed} onClick={() => { if (!blocked && allowed) setConfirm(shop.id); }} aria-label={`Обновить предложения за ${shop.refreshPricePearls} жемчужин`}><RefreshCw size={14} aria-hidden="true" />Обновить<Price value={shop.refreshPricePearls} pearls /></button>}
  </section>;
}

function GearDetail({ economy, state, catalog, itemId }: ReadyProps & { catalog: FishingCatalog; itemId: string }) {
  const rod = catalog.rods.find(entry => entry.id === itemId), hook = catalog.hooks.find(entry => entry.id === itemId), bait = catalog.baits.find(entry => entry.itemId === itemId);
  return rod ? <PleskRodOffer economy={economy} state={state} rod={rod} /> : hook ? <PleskHookOffer economy={economy} state={state} hook={hook} /> : bait ? <PleskBaitOffer economy={economy} state={state} bait={bait} /> : null;
}

export function PleskTackleCounter({ economy, state, catalog, initialCategory = "rods" }: ReadyProps & { catalog: FishingCatalog; initialCategory?: "rods" | "hooks" | "baits" }) {
  const offers = state.fishingShop?.offers ?? [], gear = fishingState(state);
  const [selectedId, setSelectedId] = useState(() => offers[0]?.id), [category, setCategory] = useState(initialCategory);
  const [ownedId, setOwnedId] = useState<string | null>(null);
  const selected = offers.find(offer => offer.id === selectedId) ?? offers[0];
  const ownedRods = catalog.rods.filter(rod => gear.ownedRods.includes(rod.id)), ownedHooks = catalog.hooks.filter(hook => gear.ownedHooks.includes(hook.id));
  const ownedBaits = catalog.baits.filter(bait => (state.inventory[bait.itemId] ?? 0) > 0 || gear.equippedBaitId === bait.itemId);
  const owned = category === "rods" ? ownedRods.map(rod => ({ id: rod.id, name: rod.name, selected: gear.equippedRodId === rod.id }))
    : category === "hooks" ? ownedHooks.map(hook => ({ id: hook.id, name: hook.name, selected: gear.equippedHookId === hook.id }))
      : ownedBaits.map(bait => ({ id: bait.itemId, name: itemName(state, bait.itemId), selected: gear.equippedBaitId === bait.itemId }));
  const activeOwned = owned.find(entry => entry.id === ownedId) ?? owned.find(entry => entry.selected) ?? owned[0];
  const { blocked, send } = useFishingCommand({ economy, state });
  const id = useId(), buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const categories = [{ id: "rods", name: "Удочки", count: ownedRods.length }, { id: "hooks", name: "Крючки", count: ownedHooks.length }, { id: "baits", name: "Наживка", count: ownedBaits.length }] as const;
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
    <details className={styles.ownedTackle}><summary><FishingRod size={18} aria-hidden="true" />Мои снасти<span>{ownedRods.length + ownedHooks.length}</span></summary>
      <div className={styles.tackleTabs} role="tablist" aria-label="Виды ваших снастей">{categories.map((entry, index) => <button key={entry.id} type="button" ref={node => { buttons.current[index] = node; }} role="tab" id={`${id}-${entry.id}`} aria-selected={category === entry.id} aria-controls={`${id}-detail`} tabIndex={category === entry.id ? 0 : -1} onClick={() => { setCategory(entry.id); setOwnedId(null); }} onKeyDown={event => {
        const next = event.key === "Home" ? 0 : event.key === "End" ? categories.length - 1 : event.key === "ArrowLeft" ? (index + categories.length - 1) % categories.length : event.key === "ArrowRight" ? (index + 1) % categories.length : -1;
        if (next < 0) return;
        event.preventDefault(); setCategory(categories[next].id); setOwnedId(null); buttons.current[next]?.focus();
      }}>{entry.name}<span>{entry.count}</span></button>)}</div>
      <section className={styles.tacklePanel} id={`${id}-detail`} role="tabpanel" aria-labelledby={`${id}-${category}`} tabIndex={0}>
        <div className={styles.gearChoices} aria-label="Ваши снасти">{owned.map(entry => <button type="button" key={entry.id} aria-pressed={activeOwned?.id === entry.id} onClick={() => setOwnedId(entry.id)}>{category === "rods" ? <FishingRodIcon rodId={entry.id} size={40} /> : <ItemIcon itemId={entry.id} size={36} />}<strong>{entry.name}</strong><small>{entry.selected ? "С собой" : category === "baits" ? `×${number(state.inventory[entry.id] ?? 0)}` : "Куплено"}</small></button>)}</div>
        {activeOwned && <GearDetail key={activeOwned.id} economy={economy} state={state} catalog={catalog} itemId={activeOwned.id} />}
        {category === "baits" && <button type="button" className={styles.secondary} disabled={blocked || !gear.equippedBaitId} onClick={() => send("equip_fishing_bait", "none", 1, 0, !!gear.equippedBaitId)}>{gear.equippedBaitId ? "Рыбачить без наживки" : "Без наживки · выбрано"}</button>}
      </section>
    </details>
  </>;
}

export function PleskFishingCollection({ state, catalog }: { state: EconomyView; catalog: FishingCatalog }) {
  const { catches, ownedRods, ownedHooks } = fishingState(state), discovered = catalog.fish.filter(fish => fishDiscovered(state, fish.itemId)).length;
  return <>
    <div className={styles.collectionHeading}><Shell size={24} aria-hidden="true" /><div><h2>Рыбацкая коллекция</h2><p>Виды рыб: {discovered} / {catalog.fish.length}</p></div></div>
    <p className={styles.description}>Забирайте добычу после рыбалки, чтобы открывать виды. Проданная рыба остаётся в коллекции.</p>
    <FishRarityScale />
    <div className={styles.collection} aria-label="Пойманные виды рыб">{catalog.fish.map(fish => {
      const caught = catches[fish.itemId] ?? 0;
      return <article className={styles.specimen} key={fish.itemId} data-discovered={caught > 0}>
        <PlayerItemIcon state={state} itemId={fish.itemId} size={64} /><h3>{caught > 0 ? itemName(state, fish.itemId) : "Неизвестная рыба"}</h3><FishRarityBadge rarity={fish.rarity} /><p>{caught > 0 ? `Поймано: ${number(caught)}` : "Пока скрыта"}</p>
      </article>;
    })}</div>
    <section className={styles.section} aria-label="Коллекция удочек"><h2>Удочки · {catalog.rods.filter(rod => ownedRods.includes(rod.id)).length} / {catalog.rods.length}</h2>{catalog.rods.map(rod => <div className={styles.collectedRod} key={rod.id}>{ownedRods.includes(rod.id) ? <FishingRodIcon rodId={rod.id} size={34} /> : <CircleHelp size={28} aria-hidden="true" />}<span>{ownedRods.includes(rod.id) ? rod.name : "Неизвестная удочка"}</span><small>{ownedRods.includes(rod.id) ? "В коллекции" : "В будущих предложениях"}</small></div>)}</section>
    <section className={styles.section} aria-label="Коллекция крючков"><h2>Крючки · {catalog.hooks.filter(hook => ownedHooks.includes(hook.id)).length} / {catalog.hooks.length}</h2>{catalog.hooks.map(hook => <div className={styles.collectedRod} key={hook.id}>{ownedHooks.includes(hook.id) ? <ItemIcon itemId={hook.id} size={34} /> : <CircleHelp size={28} aria-hidden="true" />}<span>{ownedHooks.includes(hook.id) ? hook.name : "Неизвестный крючок"}</span><small>{ownedHooks.includes(hook.id) ? "Есть у вас" : "В будущих предложениях"}</small></div>)}</section>
  </>;
}

export type PleskFishingShopProps = { economy: EconomyController; onFishing: () => void; onOpenPantry: () => void };
export function PleskFishingShop({ economy, onFishing, onOpenPantry }: PleskFishingShopProps) {
  const [tab, setTab] = useState<ShopTab>("tackle"), id = useId(), tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const state = economy.snapshot, catalog = state?.catalog.fishing, cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const fishing = state ? fishingState(state) : null, activeRod = catalog?.rods.find(rod => rod.id === fishing?.equippedRodId), activeHook = catalog?.hooks.find(hook => hook.id === fishing?.equippedHookId), activeBait = fishing?.equippedBaitId;
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
    <div className={styles.departure}><button type="button" className={styles.fishingButton} onClick={onFishing}><FishingRod size={22} aria-hidden="true" /><span><strong>На рыбалку</strong><small>{activeRod ? [activeRod.name, activeHook?.name, activeBait && state ? itemName(state, activeBait) : "Без наживки"].filter(Boolean).join(" · ") : "Выбрать маршрут у берега"}</small></span><ArrowRight size={18} aria-hidden="true" /></button><button type="button" className={styles.pantryLink} onClick={onOpenPantry}><Package size={15} aria-hidden="true" />Другие запасы<ArrowRight size={13} aria-hidden="true" /></button></div>
  </div>;
}
