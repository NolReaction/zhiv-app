"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, ChevronUp, Clock3, Compass, Hammer, Package, RefreshCw, Store } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { economyLocalSellPrice, economyLocalSaleMinimumQuantity, economyLocalSaleLimit } from "./local-sale";
import type { EconomyController } from "./use-economy";
import { ProductIcon, locked, number, type ReadyEconomy } from "./world-economy-parts";
import { worldDuration, worldJobProgress } from "./world-stations";
import styles from "./world-pantry-menu.module.css";

export type WorldPantryMenuProps = {
  economy: EconomyController;
  onUpgrade: () => void;
  onExplore: () => void;
  onOpenMarket?: () => void;
  onOpenFishingShop?: () => void;
};

export function PantrySale({ economy, itemId, onClose, onOpenFishingShop }: { economy: ReadyEconomy; itemId: string; onClose?: () => void; onOpenFishingShop?: () => void }) {
  const state = economy.snapshot, buyer = state.catalog.localBuyer;
  const item = state.catalog.items.find(entry => entry.id === itemId);
  const minimum = item ? economyLocalSaleMinimumQuantity(item.baseSellPrice, buyer) : 1;
  const [quantityText, setQuantityText] = useState(() => String(minimum));
  const inputId = useId();
  const sale = useRef<HTMLElement>(null);
  useEffect(() => {
    // A selected item may be below the fold in a long inventory. Keep its sale
    // controls visible without moving the menu again when a server snapshot arrives.
    sale.current?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [itemId]);
  if (!item) return null;
  const stock = state.inventory[itemId] ?? 0;
  const maximum = economyLocalSaleLimit(item.baseSellPrice, stock, state.wallet.coins, buyer);
  const discount = (10_000 - (buyer?.payoutBps ?? 10_000)) / 100;
  const betterFishPrice = discount > 0 && state.catalog.fishing?.fish.some(fish => fish.itemId === itemId);
  const quantity = Number(quantityText);
  const valid = /^\d+$/.test(quantityText) && Number.isSafeInteger(quantity) && quantity >= minimum && quantity <= maximum;
  const total = valid ? economyLocalSellPrice(item.baseSellPrice, quantity, buyer) : 0;
  return <section ref={sale} className={`${styles.pantry} ${styles.sale}`} aria-label={`Продажа: ${item.name}`}>
    <div className={styles.saleHeading}>
      <ProductIcon itemId={item.id} size={18} />
      <h3>{item.name}</h3>
      {onClose && <button type="button" className={styles.iconButton} onClick={onClose} aria-label="Свернуть продажу"><ChevronUp size={16} aria-hidden="true" /></button>}
    </div>
    <p className={styles.muted}>В запасе {number(stock)} · {discount > 0 ? `Быстрая продажа с уценкой ${number(discount)}%` : `${number(item.baseSellPrice)} монет за штуку`}</p>
    {discount > 0 && <p className={styles.muted}>Сумма за всё количество округляется вниз до целой монеты.</p>}
    {betterFishPrice && <p className={styles.fishBuyer}>Плёска купит дороже: {number(item.baseSellPrice)} монет за штуку.{onOpenFishingShop && <button type="button" className={styles.textButton} onClick={onOpenFishingShop}>К Плёске<ArrowRight size={13} aria-hidden="true" /></button>}</p>}
    {item.tradable ? <>
      <div className={styles.saleControls}>
        <label htmlFor={inputId}>Количество</label>
        <input id={inputId} type="number" inputMode="numeric" min={minimum} max={Math.max(minimum, maximum)} step={1} value={quantityText} disabled={locked(economy) || maximum < minimum} onChange={event => setQuantityText(event.target.value)} />
        <button type="button" className={styles.textButton} disabled={locked(economy) || maximum < minimum} onClick={() => setQuantityText(String(maximum))}>{maximum < stock ? `До ${number(maximum)}` : "Всё"}</button>
      </div>
      <button type="button" className={styles.sellButton} disabled={!valid || locked(economy)} onClick={() => { if (valid && !locked(economy)) void economy.act("sell", item.id, quantity, buyer ? total : 0); }}>Продать торговцу · {valid ? number(total) : "—"}<ItemIcon itemId="coins" size={16} /></button>
      {maximum < minimum && <p className={styles.hint}>{stock === 0 ? "Эти запасы уже закончились." : stock < minimum ? `Для продажи нужно хотя бы ${number(minimum)} шт., чтобы получить целую монету.` : "В кошельке нет места для продажи."}</p>}
      {!valid && maximum >= minimum && <p className={styles.hint}>Укажите от {number(minimum)} до {number(maximum)}.</p>}
    </> : <p className={styles.hint}>Этот предмет нельзя продать торговцу.</p>}
  </section>;
}

/** Content only: the map provides the shared menu frame, heading and focus handling. */
export function WorldPantryMenu({ economy, onUpgrade, onExplore, onOpenMarket, onOpenFishingShop }: WorldPantryMenuProps) {
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
  const ownedItems = state.catalog.items.filter(item => (state.inventory[item.id] ?? 0) > 0);
  const level = state.buildings.warehouse ?? 1;
  const target = state.catalog.buildings.find(building => building.id === "warehouse")?.levels.find(entry => entry.level === level + 1);
  const job = state.jobs.find(entry => entry.kind === "construction" && entry.targetId === "warehouse");
  const progress = job ? worldJobProgress(state, job, economy.now) : null;
  const marketAvailable = onOpenMarket && (state.buildings.home ?? 1) >= state.catalog.market.requiredHomeLevel && state.completedExplorations >= state.catalog.market.requiredExplorations;
  const readyEconomy = { ...economy, snapshot: state };
  return <div className={styles.pantry} aria-busy={economy.busy || undefined}>
    {recovery}
    <div className={styles.capacity} data-full={available === 0 || undefined}>
      <div><span className={styles.capacityLabel}><Package size={17} aria-hidden="true" />Занято мест</span><strong>{number(occupied)} <span>/ {number(capacity)}</span></strong></div>
      <progress value={Math.min(capacity, occupied)} max={Math.max(1, capacity)} aria-label={`Кладовая: занято ${occupied} из ${capacity} мест`} />
      <p className={styles.muted}>{available > 0 ? `Свободно ${number(available)}` : "Все места заняты"}{reserved > 0 && ` · На рынке ${number(reserved)}`}</p>
    </div>
    {overflow > 0 && <p className={styles.hint}>Сверх вместимости: {number(overflow)}. Запасы сохранены. Продайте или используйте часть вещей, чтобы получать новые.</p>}
    {reserved > 0 && <p className={styles.muted}>Товары на рынке тоже занимают место до продажи.</p>}

    {selectedItemId && <PantrySale key={selectedItemId} economy={readyEconomy} itemId={selectedItemId} onClose={() => setSelectedItemId(null)} onOpenFishingShop={onOpenFishingShop} />}
    {ownedItems.length > 0 ? <>
      <div className={styles.items} aria-label="Предметы в кладовой">
        {ownedItems.map(item => <button key={item.id} type="button" className={styles.item} aria-label={`${item.name}: ${number(state.inventory[item.id])}`} aria-pressed={selectedItemId === item.id} onClick={() => setSelectedItemId(current => current === item.id ? null : item.id)}>
          <ProductIcon itemId={item.id} size={20} />
          <span>{item.name}</span>
          <strong>×{number(state.inventory[item.id])}</strong>
        </button>)}
      </div>
      {!selectedItemId && <p className={styles.muted}>Выберите предмет, чтобы продать торговцу.</p>}
    </> : <div className={styles.empty}><Package size={23} aria-hidden="true" /><p>{reserved > 0 ? "Все запасы сейчас на рынке." : "Здесь будут урожай, материалы и находки."}</p>{reserved === 0 && <button type="button" className={styles.textButton} onClick={onExplore}><Compass size={14} aria-hidden="true" />Отправиться за находками<ArrowRight size={13} aria-hidden="true" /></button>}</div>}

    <div className={styles.footer}>
      {job && progress ? <button type="button" className={styles.expand} onClick={onUpgrade} aria-haspopup="dialog"><span className={styles.expandIcon}>{progress.ready ? <Check size={16} aria-hidden="true" /> : <Clock3 size={16} aria-hidden="true" />}</span><span><strong>{progress.ready ? "Расширение готово" : "Кладовая расширяется"}</strong><small>{progress.ready ? `Можно получить уровень ${job.targetLevel}` : `Ещё ${progress.seconds < 60 ? `${progress.seconds} с` : worldDuration(progress.seconds)}`}</small></span><ArrowRight size={15} aria-hidden="true" /></button>
        : target ? <button type="button" className={styles.expand} onClick={onUpgrade} aria-haspopup="dialog"><span className={styles.expandIcon}><Hammer size={16} aria-hidden="true" /></span><span><strong>Расширить кладовую</strong><small>Ур. {level} → {target.level}{target.warehouseCapacity ? ` · ${number(target.warehouseCapacity)} мест` : ""}</small></span><ArrowRight size={15} aria-hidden="true" /></button>
          : <p className={styles.maximum}><Check size={13} aria-hidden="true" />Ур. {level} · Максимальная вместимость</p>}
      {marketAvailable && <button type="button" className={styles.market} onClick={onOpenMarket}><Store size={14} aria-hidden="true" />Рынок игроков<ArrowRight size={13} aria-hidden="true" /></button>}
    </div>
  </div>;
}
