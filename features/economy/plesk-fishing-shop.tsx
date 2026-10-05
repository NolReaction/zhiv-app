"use client";

import { useId, useRef, useState } from "react";
import { ArrowRight, BookOpen, Check, Fish, FishingRod, Package, RefreshCw, Shell } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { FishIcon } from "@/features/world/fish-icon";
import { FishingRodIcon } from "@/features/world/fishing-rod-icon";
import { fishSpeciesId } from "@/features/world/fish-species";
import { ECONOMY_MAX_BALANCE, type EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { fishingState } from "./fishing";
import { FishRarityBadge, FishRarityScale } from "./fish-rarity";
import { PantrySale } from "./world-pantry-menu";
import { itemName, number } from "./world-economy-parts";
import { useFishingCommand } from "./use-fishing-command";
import styles from "./plesk-fishing-shop.module.css";

type ReadyProps = { economy: EconomyController; state: EconomyView };
type FishingCatalog = NonNullable<EconomyView["catalog"]["fishing"]>;
type ShopTab = "fish" | "tackle" | "collection";
const tabs = [{ id: "fish", name: "Улов", icon: Fish }, { id: "tackle", name: "Снасти", icon: FishingRod }, { id: "collection", name: "Коллекция", icon: BookOpen }] as const;

function Price({ value }: { value: number }) {
  return <span className={styles.price}>{number(value)}<ItemIcon itemId="coins" size={16} /></span>;
}

export function fishingTradeLimits(state: EconomyView, itemId: string) {
  const fish = state.catalog.fishing?.fish.find(entry => entry.itemId === itemId);
  const item = state.catalog.items.find(entry => entry.id === itemId);
  if (!fish || !item) return { buy: 0, sell: 0, buyPrice: 0, sellPrice: 0 };
  return {
    buy: Math.max(0, Math.min(state.catalog.maxBatch, state.storage.available, Math.floor(state.wallet.coins / fish.buyPrice))),
    sell: item.tradable ? Math.max(0, Math.min(state.catalog.maxBatch, state.inventory[itemId] ?? 0, Math.floor((ECONOMY_MAX_BALANCE - state.wallet.coins) / item.baseSellPrice))) : 0,
    buyPrice: fish.buyPrice, sellPrice: item.baseSellPrice,
  };
}

export function PleskFishTrade({ economy, state, itemId }: ReadyProps & { itemId: string }) {
  const [quantityText, setQuantityText] = useState("1");
  const id = useId();
  const { blocked, send } = useFishingCommand({ economy, state });
  const limits = fishingTradeLimits(state, itemId);
  const quantity = Number(quantityText);
  const valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity > 0;
  const canBuy = valid && quantity <= limits.buy, canSell = valid && quantity <= limits.sell;
  const stock = state.inventory[itemId] ?? 0;
  return <section className={styles.trade} aria-label={`Торговля: ${itemName(state, itemId)}`}>
    <div className={styles.tradeHeading}><span>В запасе <strong>{number(stock)}</strong></span><span>Плёска платит <Price value={limits.sellPrice} /> за штуку</span></div>
    <div className={styles.quantity}><label htmlFor={id}>Количество</label><input id={id} type="number" inputMode="numeric" min={1} max={Math.max(1, limits.buy, limits.sell)} step={1} value={quantityText} disabled={blocked} onChange={event => setQuantityText(event.target.value)} /><button type="button" disabled={blocked || limits.sell === 0} onClick={() => setQuantityText(String(limits.sell))}>{limits.sell < stock ? `До ${number(limits.sell)}` : "Весь улов"}</button></div>
    <div className={styles.tradeButtons}>
      <button type="button" className={styles.primary} disabled={blocked || !canSell} onClick={() => send("sell_fish", itemId, quantity, 0, canSell)} aria-label={`Продать ${itemName(state, itemId)}: ${valid ? quantity : 0}`}><span>Продать</span>{canSell ? <Price value={quantity * limits.sellPrice} /> : <span>—</span>}</button>
      <button type="button" className={styles.secondary} disabled={blocked || !canBuy} onClick={() => send("buy_fishing_item", itemId, quantity, quantity * limits.buyPrice, canBuy)} aria-label={`Купить ${itemName(state, itemId)}: ${valid ? quantity : 0}`}><span>Купить</span>{valid ? <Price value={quantity * limits.buyPrice} /> : <span>—</span>}</button>
    </div>
    {!valid && <p className={styles.hint}>Введите целое количество от 1.</p>}
    {valid && !canBuy && <p className={styles.hint}>{quantity > state.catalog.maxBatch ? `За один раз — до ${state.catalog.maxBatch} штук.` : quantity > state.storage.available ? "Для покупки нужно освободить место в кладовой." : "Для покупки не хватает монет."}</p>}
    {valid && stock > 0 && !canSell && <p className={styles.hint}>{quantity > stock ? "Столько рыбы в запасе пока нет." : "Этот объём пока нельзя продать. Уменьшите количество."}</p>}
  </section>;
}

function FishCounter({ economy, state, catalog }: ReadyProps & { catalog: FishingCatalog }) {
  const [selection, setSelection] = useState(() => catalog.fish.find(fish => (state.inventory[fish.itemId] ?? 0) > 0)?.itemId ?? catalog.fish[0]?.itemId);
  const selected = catalog.fish.find(fish => fish.itemId === selection) ?? catalog.fish[0];
  return <>
    <p className={styles.intro}>«Улов куплю, а к ужину — выбирай рыбку с моего прилавка!»</p>
    <div className={styles.fishList} aria-label="Рыба на прилавке">{catalog.fish.map(fish => <button type="button" key={fish.itemId} className={styles.fishChoice} aria-pressed={fish === selected} onClick={() => setSelection(fish.itemId)}>
      <FishIcon species={fishSpeciesId(fish.itemId)} size={44} /><span><strong>{itemName(state, fish.itemId)}</strong><FishRarityBadge rarity={fish.rarity} /></span><span className={styles.stock}>×{number(state.inventory[fish.itemId] ?? 0)}</span>
    </button>)}</div>
    {selected && <><p className={styles.description}>{selected.description}</p><PleskFishTrade key={selected.itemId} economy={economy} state={state} itemId={selected.itemId} /></>}
    <FishRarityScale /><p className={styles.footnote}>Покупка пополняет кладовую. В коллекцию попадает только собственный полученный улов.</p>
  </>;
}

export function PleskRodOffer({ economy, state, rod }: ReadyProps & { rod: FishingCatalog["rods"][number] }) {
  const { blocked, send } = useFishingCommand({ economy, state });
  const fishing = fishingState(state);
  const owned = fishing.ownedRods.includes(rod.id);
  const equipped = fishing.equippedRodId === rod.id;
  const affordable = state.wallet.coins >= rod.price;
  return <article className={styles.gearCard} data-selected={equipped || undefined}>
    <div className={styles.gearHeading}><FishingRodIcon rodId={rod.id} size={48} /><div><h3>{rod.name}</h3><p>{equipped ? "Сейчас с собой" : owned ? "Есть в коллекции" : "Останется навсегда"}</p></div>{equipped && <Check size={17} aria-hidden="true" />}</div>
    <p className={styles.description}>{rod.description}</p>
    <button type="button" className={owned ? styles.secondary : styles.primary} disabled={blocked || equipped || !owned && !affordable} onClick={() => send(owned ? "equip_fishing_rod" : "buy_fishing_item", rod.id, 1, owned ? 0 : rod.price, !equipped && (owned || affordable))}>{equipped ? "Выбрана" : owned ? "Взять с собой" : <><span>Купить удочку</span><Price value={rod.price} /></>}</button>
    {!owned && !affordable && <p className={styles.hint}>Не хватает {number(rod.price - state.wallet.coins)} монет.</p>}
  </article>;
}

export function PleskBaitOffer({ economy, state, bait }: ReadyProps & { bait: FishingCatalog["baits"][number] }) {
  const { blocked, send } = useFishingCommand({ economy, state });
  const [quantityText, setQuantityText] = useState("1");
  const id = useId();
  const stock = state.inventory[bait.itemId] ?? 0;
  const selected = fishingState(state).equippedBaitId === bait.itemId;
  const maximum = Math.max(0, Math.min(state.catalog.maxBatch, state.storage.available, Math.floor(state.wallet.coins / bait.price)));
  const quantity = Number(quantityText), valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity >= 1 && quantity <= maximum;
  return <article className={styles.gearCard} data-selected={selected || undefined}>
    <div className={styles.gearHeading}><ItemIcon itemId={bait.itemId} size={40} /><div><h3>{itemName(state, bait.itemId)}</h3><p>В запасе {number(stock)}{selected ? " · Выбрана" : ""}</p></div></div>
    <p className={styles.description}>{bait.description}</p>
    <div className={styles.quantity}><label htmlFor={id}>Купить штук</label><input id={id} type="number" inputMode="numeric" min={1} max={Math.max(1, maximum)} step={1} value={quantityText} disabled={blocked} onChange={event => setQuantityText(event.target.value)} /></div>
    <button type="button" className={styles.primary} disabled={blocked || !valid} onClick={() => send("buy_fishing_item", bait.itemId, quantity, quantity * bait.price, valid)} aria-label={`Купить наживку: ${itemName(state, bait.itemId)}`}><span>Купить наживку</span>{Number.isSafeInteger(quantity) && quantity > 0 ? <Price value={quantity * bait.price} /> : <span>—</span>}</button>
    {stock > 0 && <div className={styles.equipRow}><span>На следующую рыбалку</span><button type="button" className={styles.secondary} disabled={blocked || selected} onClick={() => send("equip_fishing_bait", bait.itemId, 1, 0, !selected && stock > 0)}>{selected ? "Выбрана" : "Использовать"}</button></div>}
    {selected && stock === 0 && <p className={styles.hint}>Наживка закончилась. Пополните запас или выберите рыбалку без наживки.</p>}
    {maximum === 0 && <p className={styles.hint}>{state.storage.available === 0 ? "Кладовая заполнена." : "Для покупки не хватает монет."}</p>}
  </article>;
}

export function PleskTackleCounter({ economy, state, catalog, initialCategory = "rods" }: ReadyProps & { catalog: FishingCatalog; initialCategory?: "rods" | "baits" }) {
  const [category, setCategory] = useState(initialCategory);
  const [rodId, setRodId] = useState(() => fishingState(state).equippedRodId);
  const [baitId, setBaitId] = useState(() => fishingState(state).equippedBaitId ?? catalog.baits[0]?.itemId ?? "none");
  const id = useId(), buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const { blocked, send } = useFishingCommand({ economy, state });
  const gear = fishingState(state), noBait = !gear.equippedBaitId;
  const selectedRod = catalog.rods.find(rod => rod.id === rodId) ?? catalog.rods[0];
  const selectedBait = catalog.baits.find(bait => bait.itemId === baitId);
  const categories = [{ id: "rods", name: "Удочки" }, { id: "baits", name: "Наживка" }] as const;
  return <>
    <div className={styles.tackleTabs} role="tablist" aria-label="Виды снастей">{categories.map((entry, index) => <button key={entry.id} type="button" ref={node => { buttons.current[index] = node; }} role="tab" id={`${id}-${entry.id}`} aria-selected={category === entry.id} aria-controls={`${id}-detail`} tabIndex={category === entry.id ? 0 : -1} onClick={() => setCategory(entry.id)} onKeyDown={event => {
      const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowRight" ? 1 - index : -1;
      if (next < 0) return;
      event.preventDefault(); setCategory(categories[next].id); buttons.current[next]?.focus();
    }}>{entry.name}<span>{entry.id === "rods" ? catalog.rods.length : catalog.baits.length}</span></button>)}</div>
    <section className={styles.tacklePanel} id={`${id}-detail`} role="tabpanel" aria-labelledby={`${id}-${category}`} tabIndex={0}>
      {category === "rods" ? <>
        <div className={styles.gearChoices} role="group" aria-label="Выбрать удочку на прилавке">{catalog.rods.map(rod => <button type="button" key={rod.id} aria-pressed={selectedRod?.id === rod.id} onClick={() => setRodId(rod.id)}><FishingRodIcon rodId={rod.id} size={44} /><strong>{rod.name.replace(/ удочка$/, "")}</strong><small>{gear.equippedRodId === rod.id ? "С собой" : gear.ownedRods.includes(rod.id) ? "Куплена" : <Price value={rod.price} />}</small></button>)}</div>
        {selectedRod && <PleskRodOffer key={selectedRod.id} economy={economy} state={state} rod={selectedRod} />}
      </> : <>
        <div className={styles.gearChoices} role="group" aria-label="Выбрать наживку на прилавке">{catalog.baits.map(bait => <button type="button" key={bait.itemId} aria-pressed={selectedBait?.itemId === bait.itemId} onClick={() => setBaitId(bait.itemId)}><ItemIcon itemId={bait.itemId} size={35} /><strong>{itemName(state, bait.itemId)}</strong><small>×{number(state.inventory[bait.itemId] ?? 0)}</small></button>)}<button type="button" aria-pressed={baitId === "none"} onClick={() => setBaitId("none")}><Fish size={29} aria-hidden="true" /><strong>Без наживки</strong><small>{noBait ? "Выбрано" : "Без расхода"}</small></button></div>
        {selectedBait ? <PleskBaitOffer key={selectedBait.itemId} economy={economy} state={state} bait={selectedBait} /> : <div className={styles.gearCard}><p className={styles.description}>Рыбачить можно с одной удочкой.</p><button type="button" className={styles.secondary} disabled={blocked || noBait} onClick={() => send("equip_fishing_bait", "none", 1, 0, !noBait)}>{noBait ? "Без наживки · выбрано" : "Использовать без наживки"}</button></div>}
      </>}
    </section>
    <p className={styles.footnote}>Улучшенные снасти повышают шанс редкого вида для одной рыбы в улове. Размер партии задаёт маршрут. Снаряжение можно поменять перед отправлением.</p>
  </>;
}

export function PleskFishingCollection({ state, catalog }: { state: EconomyView; catalog: FishingCatalog }) {
  const { catches, ownedRods } = fishingState(state);
  const discovered = catalog.fish.filter(fish => (catches[fish.itemId] ?? 0) > 0).length;
  return <>
    <div className={styles.collectionHeading}><Shell size={24} aria-hidden="true" /><div><h2>Рыбацкая коллекция</h2><p>Виды рыб: {discovered} / {catalog.fish.length}</p></div></div>
    <p className={styles.description}>Забирайте добычу после рыбалки, чтобы открывать виды. Проданная рыба остаётся в коллекции.</p>
    <div className={styles.collection} aria-label="Пойманные виды рыб">{catalog.fish.map(fish => {
      const caught = catches[fish.itemId] ?? 0;
      return <article className={styles.specimen} key={fish.itemId} data-discovered={caught > 0}>
        <FishIcon species={fishSpeciesId(fish.itemId)} size={64} /><h3>{itemName(state, fish.itemId)}</h3><FishRarityBadge rarity={fish.rarity} /><p>{caught > 0 ? `Поймано: ${number(caught)}` : "Ещё не поймана"}</p>
      </article>;
    })}</div>
    <section className={styles.section} aria-label="Коллекция удочек"><h2>Удочки · {catalog.rods.filter(rod => ownedRods.includes(rod.id)).length} / {catalog.rods.length}</h2>{catalog.rods.map(rod => <div className={styles.collectedRod} key={rod.id}><FishingRodIcon rodId={rod.id} size={34} /><span>{rod.name}</span><small>{ownedRods.includes(rod.id) ? "В коллекции" : "У Плёски"}</small></div>)}</section>
  </>;
}

export type PleskFishingShopProps = { economy: EconomyController; onFishing: () => void; onOpenPantry: () => void };

export function PleskFishingShop({ economy, onFishing, onOpenPantry }: PleskFishingShopProps) {
  const [tab, setTab] = useState<ShopTab>("fish");
  const id = useId();
  const tabButtons = useRef<Array<HTMLButtonElement | null>>([]);
  const state = economy.snapshot, catalog = state?.catalog.fishing;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const fishing = state ? fishingState(state) : null;
  const activeRod = catalog?.rods.find(rod => rod.id === fishing?.equippedRodId);
  const activeBait = fishing?.equippedBaitId;
  const recovery = (economy.error || economy.uncertain) && <div className={styles.recovery} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Дождитесь подтверждения, прежде чем торговать снова." : economy.error}</p><button type="button" disabled={economy.busy || cooldown > 0} onClick={() => { if (!economy.busy && !cooldown) void economy.retry(); }}><RefreshCw size={14} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button></div>;
  return <div className={styles.shop} aria-busy={economy.busy || undefined}>
    {state && <div className={styles.wallet}><span>Лавка у пирса</span><span aria-label={`Монеты: ${number(state.wallet.coins)}`}><ItemIcon itemId="coins" size={19} /><strong>{number(state.wallet.coins)}</strong></span></div>}
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
    <div className={styles.departure}><button type="button" className={styles.fishingButton} onClick={onFishing}><FishingRod size={22} aria-hidden="true" /><span><strong>На рыбалку</strong><small>{activeRod ? `${activeRod.name} · ${activeBait && state ? itemName(state, activeBait) : "Без наживки"}` : "Выбрать маршрут у берега"}</small></span><ArrowRight size={18} aria-hidden="true" /></button><button type="button" className={styles.pantryLink} onClick={onOpenPantry}><Package size={15} aria-hidden="true" />Другие запасы<ArrowRight size={13} aria-hidden="true" /></button></div>
  </div>;
}
