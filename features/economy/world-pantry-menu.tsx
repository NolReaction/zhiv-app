"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Check, ChevronUp, Clock3, Compass, Fish, Gift, Hammer, Package, RefreshCw, Snowflake, Store, Sparkles } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { FISH_SPECIES_IDS } from "@/features/world/fish-species";
import { FishRarityBadge } from "./fish-rarity";
import { economyLocalSellPrice, economyLocalSaleMinimumQuantity, economyLocalSaleLimit } from "./local-sale";
import type { EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { ProductIcon, locked, number, type ReadyEconomy, type StationNavigation } from "./world-economy-parts";
import { worldDuration, worldJobProgress } from "./world-stations";
import type { ConstructionGoalController } from "./use-construction-goal";
import { ConstructionGoalSummary } from "./construction-goal-summary";
import styles from "./world-pantry-menu.module.css";

export type WorldPantryMenuProps = {
  economy: EconomyController;
  onUpgrade: () => void;
  onExplore: () => void;
  onOpenMarket?: () => void;
  onOpenFishingShop?: () => void;
  constructionGoal?: ConstructionGoalController;
  onOpenGoal?: () => void;
  navigation?: StationNavigation;
  onReturnToGift?: () => void;
  initialTab?: "supplies" | "fridge" | "relics";
};

export function PantrySale({ economy, itemId, onClose, onOpenFishingShop, constructionGoal }: { economy: ReadyEconomy; itemId: string; onClose?: () => void; onOpenFishingShop?: () => void; constructionGoal?: ConstructionGoalController }) {
  const state = economy.snapshot, buyer = state.catalog.localBuyer;
  const item = state.catalog.items.find(entry => entry.id === itemId);
  const minimum = item && item.category !== "special" && item.baseSellPrice > 0 ? economyLocalSaleMinimumQuantity(item.baseSellPrice, buyer) : 1;
  const [quantityText, setQuantityText] = useState(() => String(minimum));
  const [quantityMode, setQuantityMode] = useState<"manual" | "excess">("manual");
  const inputId = useId();
  const sale = useRef<HTMLElement>(null);
  useEffect(() => {
    // A selected item may be below the fold in a long inventory. Keep its sale
    // controls visible without moving the menu again when a server snapshot arrives.
    sale.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [itemId]);
  if (!item) return null;
  if (item.category === "special") return <section ref={sale} className={styles.relicGuard} aria-label={item.name}><ItemIcon itemId={item.id} size={30} /><div><h3>{item.name}</h3><p>Можно обменять с другими игроками.</p></div></section>;
  const stock = state.inventory[itemId] ?? 0;
  const maximum = economyLocalSaleLimit(item.baseSellPrice, stock, state.wallet.coins, buyer);
  const discount = (10_000 - (buyer?.payoutBps ?? 10_000)) / 100;
  const betterFishPrice = discount > 0 && state.catalog.fishing?.fish.some(fish => fish.itemId === itemId);
  const goal = constructionGoal?.details;
  const needed = goal?.keepItems[itemId] ?? 0;
  const excess = goal ? Math.min(maximum, goal.excessItems[itemId] ?? 0) : 0;
  const quantity = quantityMode === "excess" ? excess : Number(quantityText);
  const valid = (quantityMode === "excess" || /^\d+$/.test(quantityText)) && Number.isSafeInteger(quantity) && quantity >= minimum && quantity <= maximum;
  const total = valid ? economyLocalSellPrice(item.baseSellPrice, quantity, buyer) : 0;
  return <section ref={sale} className={`${styles.pantry} ${styles.sale}`} aria-label={`Продажа: ${item.name}`}>
    <div className={styles.saleHeading}>
      <ProductIcon state={state} itemId={item.id} size={18} />
      <h3>{item.name}</h3>
      {onClose && <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Свернуть продажу"><ChevronUp size={16} aria-hidden="true" /></button>}
    </div>
    <p className={styles.muted}>В запасе {number(stock)} · {discount > 0 ? `Быстрая продажа с уценкой ${number(discount)}%` : `${number(item.baseSellPrice)} монет за штуку`}</p>
    {discount > 0 && <p className={styles.muted}>Сумма за всё количество округляется вниз до целой монеты.</p>}
    {betterFishPrice && <p className={styles.fishBuyer}>Плёска купит дороже: {number(item.baseSellPrice)} монет за штуку.{onOpenFishingShop && <button type="button" className={styles.textButton} onClick={onOpenFishingShop}>К Плёске<ArrowRight size={13} aria-hidden="true" /></button>}</p>}
    {goal && needed > 0 && <p className={styles.goalNote}>Для цели «{goal.name}» нужно оставить {number(Math.min(stock, needed))} шт., включая сырьё для изготовления.</p>}
    {item.tradable ? <>
      <div className={styles.saleControls}>
        <label htmlFor={inputId}>Количество</label>
        <input id={inputId} type="number" inputMode="numeric" min={minimum} max={Math.max(minimum, maximum)} step={1} value={quantityMode === "excess" ? excess : quantityText} disabled={locked(economy) || maximum < minimum} onChange={event => { setQuantityMode("manual"); setQuantityText(event.target.value); }} />
        <button type="button" className={styles.textButton} disabled={locked(economy) || maximum < minimum} onClick={() => { setQuantityMode("manual"); setQuantityText(String(maximum)); }}>{maximum < stock ? `До ${number(maximum)}` : "Всё"}</button>
      </div>
      {goal && <button type="button" className={styles.excessButton} aria-pressed={quantityMode === "excess"} disabled={locked(economy) || excess < minimum} onClick={() => setQuantityMode("excess")}>Только излишек · {number(excess)} шт.</button>}
      {goal && valid && quantity > excess && needed > 0 && <p className={styles.hint} role="status">В продажу попадут материалы для цели «{goal.name}».</p>}
      <button type="button" className={styles.sellButton} disabled={!valid || locked(economy)} onClick={() => { if (valid && !locked(economy)) void economy.act("sell", item.id, quantity, buyer ? total : 0); }}>{quantityMode === "excess" ? "Продать излишек" : "Продать торговцу"} · {valid ? number(total) : "—"}<ItemIcon itemId="coins" size={16} /></button>
      {maximum < minimum && <p className={styles.hint}>{stock === 0 ? "Эти запасы уже закончились." : stock < minimum ? `Для продажи нужно хотя бы ${number(minimum)} шт., чтобы получить целую монету.` : "В кошельке нет места для продажи."}</p>}
      {!valid && maximum >= minimum && <p className={styles.hint}>Укажите от {number(minimum)} до {number(maximum)}.</p>}
    </> : <p className={styles.hint}>Этот предмет нельзя продать торговцу.</p>}
  </section>;
}

export function RelicPantrySection({ state, onExplore, onOpenMarket }: { state: EconomyView; onExplore: () => void; onOpenMarket?: () => void }) {
  const items = state.catalog.items.filter(item => item.category === "special");
  const requiredHome = state.catalog.rareDrops?.requiredHomeLevel;
  return <section className={styles.relics} aria-label="Реликвии в кладовой">
    <div className={styles.relicList}>{items.map(item => {
      const stock = state.inventory[item.id] ?? 0;
      return <article className={styles.relicCard} key={item.id} data-relic={item.id} data-owned={stock > 0}>
        <div className={styles.relicHeading}><span className={styles.relicArt}><ItemIcon itemId={item.id} size={48} /></span><div><h3>{item.name}</h3></div><strong aria-label={`В наличии: ${number(stock)}`}>×{number(stock)}</strong></div>
      </article>;
    })}</div>
    {items.length === 0 ? <p className={styles.muted}>Реликвии появятся вместе с новыми маршрутами.</p> : <><p className={styles.muted}>{requiredHome ? `Находки в вылазках с домом ур. ${requiredHome}. ` : "Находки из вылазок. "}Их также можно получить по обмену с другими игроками.</p><div className={styles.relicActions}><button type="button" className={styles.textButton} onClick={onExplore}><Compass size={14} aria-hidden="true" />В путь<ArrowRight size={13} aria-hidden="true" /></button>{onOpenMarket && <button type="button" className={styles.textButton} onClick={onOpenMarket}><Store size={14} aria-hidden="true" />Лавки игроков<ArrowRight size={13} aria-hidden="true" /></button>}</div></>}
  </section>;
}

/** Content only: the map provides the shared menu frame, heading and focus handling. */
export function WorldPantryMenu({ economy, onUpgrade, onExplore, onOpenMarket, onOpenFishingShop, constructionGoal, onOpenGoal, navigation, onReturnToGift, initialTab = "supplies" }: WorldPantryMenuProps) {
  const [tab, setTab] = useState(initialTab);
  const tabId = useId(), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const state = economy.snapshot;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const recovery = (economy.error || economy.uncertain) && <div className={styles.error} role="alert">
    <p>{economy.uncertain ? "Проверяем последнее действие. Продажа станет доступна после подтверждения." : economy.error}</p>
    <button type="button" className={styles.textButton} disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={12} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button>
  </div>;
  if (!state) return <div className={styles.pantry} aria-busy={economy.busy || undefined}>{recovery || <p className={styles.loading} role="status"><RefreshCw size={16} aria-hidden="true" />Открываем кладовую…</p>}</div>;

  const { used, reserved, capacity, available, overflow } = state.storage;
  const occupied = used + reserved;
  // This is a view of the same inventory, not another capacity or reward store.
  const fishIds = new Set<string>([...FISH_SPECIES_IDS, ...(state.catalog.fishing?.fish.map(fish => fish.itemId) ?? [])]);
  const ownedItems = state.catalog.items.filter(item => item.category !== "special" && (state.inventory[item.id] ?? 0) > 0);
  const supplies = ownedItems.filter(item => !fishIds.has(item.id));
  const fishItems = ownedItems.filter(item => fishIds.has(item.id));
  const visibleItems = tab === "fridge" ? fishItems : supplies;
  const relics = state.catalog.items.filter(item => item.category === "special");
  const relicCount = relics.reduce((total, item) => total + (state.inventory[item.id] ?? 0), 0);
  const sections = [
    { id: "supplies", name: "Запасы", count: supplies.length, icon: Package },
    { id: "fridge", name: "Холодильник", count: fishItems.reduce((total, item) => total + state.inventory[item.id], 0), icon: Snowflake },
    { id: "relics", name: "Реликвии", count: relicCount, icon: Sparkles },
  ] as const;
  const level = state.buildings.warehouse ?? 1;
  const target = state.catalog.buildings.find(building => building.id === "warehouse")?.levels.find(entry => entry.level === level + 1);
  const expansionRelics = Object.entries(target?.cost.items ?? {}).filter(([id]) => relics.some(item => item.id === id));
  const job = state.jobs.find(entry => entry.kind === "construction" && entry.targetId === "warehouse");
  const progress = job ? worldJobProgress(state, job, economy.now) : null;
  const marketAvailable = onOpenMarket && (state.buildings.home ?? 1) >= state.catalog.market.requiredHomeLevel && state.completedExplorations >= state.catalog.market.requiredExplorations;
  const readyEconomy = { ...economy, snapshot: state };
  return <div className={styles.pantry} aria-busy={economy.busy || undefined}>
    {recovery}
    {onReturnToGift && <button type="button" className={styles.giftReturn} onClick={onReturnToGift}><ArrowLeft size={15} aria-hidden="true" /><Gift size={17} aria-hidden="true" />Вернуться к подарку</button>}
    {constructionGoal && onOpenGoal && <ConstructionGoalSummary state={state} constructionGoal={constructionGoal} onOpenGoal={onOpenGoal} navigation={navigation} />}
    <div className={styles.capacity} data-full={available === 0 || undefined}>
      <div><span className={styles.capacityLabel}><Package size={17} aria-hidden="true" />Занято мест</span><strong>{number(occupied)} <span>/ {number(capacity)}</span></strong></div>
      <progress value={Math.min(capacity, occupied)} max={Math.max(1, capacity)} aria-label={`Кладовая: занято ${occupied} из ${capacity} мест`} />
      <p className={styles.muted}>{available > 0 ? `Свободно ${number(available)}` : "Все места заняты"}{reserved > 0 && ` · На рынке ${number(reserved)}`}</p>
    </div>
    {overflow > 0 && <p className={styles.hint}>Сверх вместимости: {number(overflow)}. Запасы сохранены. Продайте или используйте часть вещей, чтобы получать новые.</p>}
    {reserved > 0 && <p className={styles.muted}>Товары на рынке тоже занимают место до продажи.</p>}

    <div className={styles.pantryTabs} role="tablist" aria-label="Разделы кладовой">{sections.map((entry, index) => <button key={entry.id} type="button" ref={node => { tabs.current[index] = node; }}
      role="tab" id={`${tabId}-${entry.id}`} aria-selected={tab === entry.id} aria-controls={`${tabId}-panel`} tabIndex={tab === entry.id ? 0 : -1}
      onClick={() => { setTab(entry.id); setSelectedItemId(null); }} onKeyDown={event => {
        const next = event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length : event.key === "ArrowRight" ? (index + 1) % sections.length : -1;
        if (next < 0) return;
        event.preventDefault(); setTab(sections[next].id); setSelectedItemId(null); tabs.current[next]?.focus();
      }}><entry.icon size={16} aria-hidden="true" /><small>{number(entry.count)}</small><span>{entry.name}</span></button>)}</div>
    <div role="tabpanel" className={styles.pantryPanel} id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
      {tab === "relics" ? <RelicPantrySection state={state} onExplore={onExplore} onOpenMarket={marketAvailable ? onOpenMarket : undefined} /> : <>
    {tab === "fridge" && <div className={styles.fridgeHeading}><span><Snowflake size={16} aria-hidden="true" />Улов и рыба для готовки</span><small>Места общие с кладовой</small></div>}
    {selectedItemId && <PantrySale key={selectedItemId} economy={readyEconomy} itemId={selectedItemId} constructionGoal={constructionGoal} onClose={() => setSelectedItemId(null)} onOpenFishingShop={onOpenFishingShop} />}
    {visibleItems.length > 0 ? <>
      <div className={`${styles.items} ${tab === "fridge" ? styles.fishItems : ""}`} aria-label={tab === "fridge" ? "Рыба в холодильнике" : "Предметы в кладовой"}>
        {visibleItems.map(item => {
          const fish = state.catalog.fishing?.fish.find(entry => entry.itemId === item.id);
          return <button key={item.id} type="button" className={styles.item} aria-label={`${item.name}: ${number(state.inventory[item.id])}`} aria-pressed={selectedItemId === item.id} onClick={() => setSelectedItemId(current => current === item.id ? null : item.id)}>
          <ProductIcon state={state} itemId={item.id} size={20} />
          <span>{item.name}</span>
          <strong>×{number(state.inventory[item.id])}</strong>
          {(constructionGoal?.details?.keepItems[item.id] ?? 0) > 0 && <small className={styles.goalItem}>Для цели: {number(Math.min(state.inventory[item.id], constructionGoal!.details!.keepItems[item.id]))}</small>}
          {fish && <FishRarityBadge className={styles.itemRarity} rarity={fish.rarity} />}
        </button>; })}
      </div>
      {!selectedItemId && <p className={styles.muted}>Выберите предмет, чтобы продать торговцу.</p>}
    </> : <div className={styles.empty}>{tab === "fridge" ? <Fish size={25} aria-hidden="true" /> : <Package size={23} aria-hidden="true" />}<p>{tab === "fridge" ? "Здесь будет рыба с берега и из лавки Плёски." : reserved > 0 && !ownedItems.length ? "Все запасы сейчас на рынке." : "Здесь будут урожай, материалы и находки."}</p>{(tab === "fridge" || reserved === 0) && <button type="button" className={styles.textButton} onClick={onExplore}><Compass size={14} aria-hidden="true" />{tab === "fridge" ? "Выбрать вылазку" : "Отправиться за находками"}<ArrowRight size={13} aria-hidden="true" /></button>}</div>}

      </>}
    </div>

    <div className={styles.footer}>
      {job && progress ? <button type="button" className={styles.expand} onClick={onUpgrade} aria-haspopup="dialog"><span className={styles.expandIcon}>{progress.ready ? <Check size={16} aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />}</span><span><strong>{progress.ready ? "Расширение готово" : "Кладовая расширяется"}</strong><small>{progress.ready ? `Можно получить уровень ${job.targetLevel}` : `Ещё ${progress.seconds < 60 ? `${progress.seconds} с` : worldDuration(progress.seconds)}`}</small></span><ArrowRight size={15} aria-hidden="true" /></button>
        : target ? <div className={styles.expansion}><button type="button" className={styles.expand} onClick={onUpgrade} aria-haspopup="dialog"><span className={styles.expandIcon}><Hammer size={16} aria-hidden="true" /></span><span><strong>Расширить кладовую</strong><small>Ур. {level} → {target.level}{target.warehouseCapacity ? ` · ${number(capacity)} → ${number(target.warehouseCapacity)} мест` : ""}</small></span><ArrowRight size={15} aria-hidden="true" /></button>
          {expansionRelics.length > 0 && <ul className={styles.expansionRelics} aria-label="Реликвии для следующего расширения">{expansionRelics.map(([id, required]) => {
            const stock = state.inventory[id] ?? 0;
            const name = relics.find(item => item.id === id)!.name;
            return <li key={id} data-relic={id} data-missing={stock < required || undefined} title={name} aria-label={`${name}: есть ${number(stock)}, нужно ${number(required)}`}><ItemIcon itemId={id} size={23} /><strong>{number(stock)}<span> / {number(required)}</span></strong></li>;
          })}</ul>}
        </div>
          : <p className={styles.maximum}><Check size={13} aria-hidden="true" />Ур. {level} · Максимальная вместимость</p>}
      {marketAvailable && <button type="button" className={styles.market} onClick={onOpenMarket}><Store size={14} aria-hidden="true" />Рынок игроков<ArrowRight size={13} aria-hidden="true" /></button>}
    </div>
  </div>;
}
