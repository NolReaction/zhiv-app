"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowRight, Check, Clock3, PackageCheck, RefreshCw, Ship, TowerControl } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS, PEARL_DISPLAY_DIVISOR, formatPearls } from "@/features/economy/domain/money";
import { replaceableShipOrder, shipDepartureAt, shipOrdersConfig, shipOrdersState, shipOrdersUnlocked } from "@/features/economy/domain/ship-orders";
import { explorationActorId } from "@/features/economy/domain/actor-availability";
import { locked } from "@/features/economy/sync/controller-state";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { ItemIcon } from "@/features/items/item-icon";
import { ProductIcon, itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import { worldCountdown, worldMaterialSource } from "@/features/economy/ui/shared/world-stations";
import styles from "./world-ship-port.module.css";

type ShipOrder = NonNullable<EconomyView["ship"]["voyage"]>["orders"][number];
type PortNavigation = {
  onNavigateStation: (stationId: string, recipeId?: string) => void;
  onNavigateExpeditions: () => void;
};
const difficultyLabels = { easy: "Лёгкий", medium: "Средний", hard: "Сложный" } as const;

function materialDestination(state: EconomyView, itemId: string, navigation: PortNavigation) {
  const source = worldMaterialSource(state, itemId);
  if (source?.kind === "production") return () => navigation.onNavigateStation(source.stationId, source.targetId);
  if (source?.kind === "exploration") {
    const route = state.catalog.explorations.find(entry => entry.id === source.targetId);
    return route && explorationActorId(route) === "miner" ? () => navigation.onNavigateStation("quarry") : navigation.onNavigateExpeditions;
  }
  return null;
}

export function ShipOrderCard({ state, order, index, disabled, onLoad, onReplace, replacementAvailable, ...navigation }: PortNavigation & {
  state: EconomyView; order: ShipOrder; index: number; disabled: boolean;
  onLoad: (orderId: string, itemId: string, quantity: number) => void;
  onReplace?: (orderId: string) => void; replacementAvailable?: boolean;
}) {
  const delivered = Boolean(order.deliveredAt);
  const loaded = order.loadedItems ?? {};
  const difficulty = order.difficulty ?? "easy";
  const giftQuantity = Object.values(order.rewardItems ?? {}).reduce((sum, quantity) => sum + quantity, 0);
  const finishesWith = (itemId: string, quantity: number) => quantity > 0 && Object.entries(order.items)
    .every(([id, required]) => (loaded[id] ?? 0) + (id === itemId ? quantity : 0) >= required);
  const giftNeedsSpace = (quantity: number) => Boolean(state.storage && giftQuantity > quantity
    && state.storage.used + state.storage.reserved - quantity + giftQuantity > state.storage.capacity);
  const needsGiftSpace = !delivered && Object.entries(order.items).some(([id, required]) => {
    const quantity = Math.min(required - (loaded[id] ?? 0), state.inventory[id] ?? 0);
    return finishesWith(id, quantity) && giftNeedsSpace(quantity);
  });
  const otherOrdersDelivered = state.ship.voyage?.orders.every(entry => entry.id === order.id || entry.deliveredAt);
  const walletFull = state.wallet.coins + order.rewardCoins > ECONOMY_MAX_BALANCE;
  const pearlsFull = Boolean(otherOrdersDelivered && state.wallet.pearls + 10 * PEARL_DISPLAY_DIVISOR > ECONOMY_MAX_PEARLS);
  return <article className={styles.order} data-ship-order={order.id} data-delivered={delivered || undefined} aria-labelledby={`ship-order-${index}`}>
    <header className={styles.orderHeader}>
      <span className={styles.orderNumber} aria-hidden="true">{delivered ? <Check size={15} /> : index + 1}</span>
      <h3 id={`ship-order-${index}`}>{order.title}</h3>
      <span className={styles.difficulty} data-difficulty={difficulty}>{difficultyLabels[difficulty]}</span>
    </header>
    <ul className={styles.items} aria-label="Состав груза">{Object.entries(order.items).map(([id, required]) => {
      const amount = delivered ? required : Math.min(required, loaded[id] ?? 0);
      const remaining = required - amount, owned = state.inventory[id] ?? 0;
      const quantity = Math.min(remaining, owned), missing = Math.max(0, remaining - owned);
      const destination = missing > 0 ? materialDestination(state, id, navigation) : null;
      const finishesOrder = finishesWith(id, quantity);
      const storageFull = finishesOrder && giftNeedsSpace(quantity);
      const blocked = disabled || quantity === 0 || (finishesOrder && (walletFull || pearlsFull)) || storageFull;
      const name = itemName(state, id);
      return <li key={id} data-loaded={remaining === 0 || undefined}>
        <div className={styles.material}>
          <ProductIcon state={state} itemId={id} size={27} />
          <div className={styles.materialText}><span>{name}</span>
            <strong aria-label={`Загружено ${amount} из ${required}: ${name}`}>{number(amount)} / {number(required)}</strong>
          </div>
        </div>
        {remaining === 0 ? <span className={styles.loaded}><Check size={14} aria-hidden="true" />На борту</span>
          : quantity > 0 ? <button type="button" className={styles.load} disabled={blocked}
            aria-label={`Загрузить ${quantity}: ${name}`} aria-describedby={storageFull ? `ship-gift-space-${index}` : undefined} onClick={() => {
              if (!blocked) onLoad(order.id, id, quantity);
            }}>Загрузить <strong>+{number(quantity)}</strong></button>
            : destination ? <button type="button" className={styles.source} onClick={destination} aria-label={`Где получить: ${name}`}>
              Нужно {number(remaining)}<ArrowRight size={12} aria-hidden="true" />
            </button> : <span className={styles.shortfall}>Нужно ещё {number(remaining)}</span>}
      </li>;
    })}</ul>
    <footer className={styles.orderFooter}>
      <span className={styles.payment}><ItemIcon itemId="coins" size={17} /><strong>{number(order.rewardCoins)}</strong>
        {Object.entries(order.rewardItems ?? {}).map(([id, quantity]) => <span key={id} className={styles.rewardItem} title={itemName(state, id)}
          aria-label={`${itemName(state, id)}: ${quantity}`}><span aria-hidden="true">+</span><ProductIcon state={state} itemId={id} size={18} /><strong>×{number(quantity)}</strong></span>)}
      </span>
      <span className={styles.paymentStatus}>{delivered ? <><PackageCheck size={13} aria-hidden="true" />Получено</> : "За полный груз"}</span>
    </footer>
    {onReplace && !delivered && !Object.values(loaded).some(amount => amount > 0) && <button type="button" className={styles.replace}
      disabled={disabled || !replacementAvailable} onClick={() => onReplace(order.id)} aria-label={`Заменить заказ «${order.title}» бесплатно`}>
      <RefreshCw size={13} aria-hidden="true" />Заменить бесплатно
    </button>}
    {needsGiftSpace && <p id={`ship-gift-space-${index}`} className={styles.hint}>Освободите место в кладовой для подарка капитана.</p>}
    {!delivered && (walletFull || pearlsFull) && <p className={styles.hint}>Перед завершением груза потратьте часть {walletFull ? "монет" : "жемчуга"}, чтобы получить награду.</p>}
  </article>;
}

/** Server-owned cargo, free replacements and confirmed early departure. */
export function WorldShipPort({ economy, ...navigation }: PortNavigation & { economy: EconomyController }) {
  const pending = useRef(false);
  const confirmationPanel = useRef<HTMLElement>(null);
  const confirmationTrigger = useRef<HTMLElement | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: "skip" | "replace"; target: string; voyageId: string } | null>(null);
  const state = economy.snapshot;
  useEffect(() => {
    if (confirmation) confirmationPanel.current?.focus();
    else {
      confirmationTrigger.current?.focus();
      confirmationTrigger.current = null;
    }
  }, [confirmation]);
  const requestConfirmation = (next: NonNullable<typeof confirmation>) => {
    confirmationTrigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setConfirmation(next);
  };
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) pending.current = false;
  }, [economy.busy, economy.uncertain, economy.error, state?.revision]);
  const disabled = locked(economy) || !economy.snapshotConfirmed;
  const load = (orderId: string, itemId: string, quantity: number) => {
    const voyageId = state?.ship.voyage?.id;
    if (disabled || pending.current || !voyageId) return;
    pending.current = true;
    if (!economy.act("load_ship_cargo", orderId, quantity, 0, undefined, { voyageId, orderId, itemId })) pending.current = false;
  };
  const retrySeconds = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const failure = economy.syncError || economy.error;
  const recovery = (failure || economy.uncertain) && <div className={styles.recovery} role="alert">
    <p>{economy.uncertain ? "Проверяем действие. Дождитесь подтверждения." : failure}</p>
    <button type="button" disabled={economy.busy || retrySeconds > 0} onClick={() => {
      if (!economy.busy && retrySeconds <= 0) void economy.retry();
    }}><RefreshCw size={15} aria-hidden="true" />{retrySeconds ? `Повторить через ${retrySeconds} с` : "Проверить результат"}</button>
  </div>;
  if (!state) return <div className={styles.port} data-ship-port>{recovery || <p role="status">Загружаем заказы…</p>}</div>;
  if (!shipOrdersUnlocked(state)) return <div className={styles.port} data-ship-port="locked">
    <div className={styles.empty}><TowerControl size={28} aria-hidden="true" /><h3>Зажгите маяк</h3><p>Его свет приведёт корабль к вашему берегу.</p>
      <button type="button" className={styles.load} onClick={() => navigation.onNavigateStation("lighthouse")}>К маяку<ArrowRight size={15} aria-hidden="true" /></button></div>
  </div>;
  const ship = shipOrdersState(state, economy.now), voyage = ship.voyage;
  const delivered = voyage?.orders.filter(order => order.deliveredAt).length ?? 0;
  const seconds = ship.nextAvailableAt ? Math.max(0, Math.ceil((Date.parse(ship.nextAvailableAt) - economy.now) / 1000)) : 0;
  const freeReplacements = Math.max(0, shipOrdersConfig.freeReplacements - (voyage?.replacementsUsed ?? 0));
  const leaveSeconds = voyage ? Math.max(0, Math.ceil((shipDepartureAt(voyage) - economy.now) / 1000)) : 0;
  const resetSeconds = ship.resetAvailableAt ? Math.max(0, Math.ceil((Date.parse(ship.resetAvailableAt) - economy.now) / 1000)) : 0;
  const confirm = confirmation?.voyageId === voyage?.id ? confirmation : null;
  const submitConfirmed = () => {
    if (!confirm || disabled || pending.current) return;
    pending.current = true;
    const accepted = economy.act(confirm.kind === "skip" ? "skip_ship_voyage" : "replace_ship_order", confirm.target, 1,
      confirm.kind === "skip" ? shipOrdersConfig.resetPricePearls : 0);
    if (!accepted) pending.current = false;
    else setConfirmation(null);
  };
  return <div className={styles.port} data-ship-port aria-busy={economy.busy || undefined} onKeyDown={event => {
    if (event.key === "Escape" && confirm) { event.preventDefault(); event.stopPropagation(); setConfirmation(null); }
  }}>
    {recovery}
    {voyage ? <>
      <div className={styles.summary}><span>Рейс № {number(voyage.number)}</span><span>{delivered} / {voyage.orders.length} грузов</span></div>
      <div className={styles.timing}><span><Clock3 size={14} aria-hidden="true" />Уйдёт через <strong>{worldCountdown(leaveSeconds)}</strong></span>
        <span>Бесплатные замены: <strong>{freeReplacements} / 3</strong></span></div>
      {confirm && <section ref={confirmationPanel} tabIndex={-1} className={styles.confirmation} aria-label={confirm.kind === "skip" ? "Подтверждение отправки корабля" : "Подтверждение замены заказа"}>
        <strong>{confirm.kind === "skip" ? `Отправить за ${formatPearls(shipOrdersConfig.resetPricePearls)} жемчужин?` : "Заменить этот заказ бесплатно?"}</strong>
        <p>{confirm.kind === "skip" ? "Загруженные товары не вернутся. Полученные награды сохранятся, бонус за весь рейс не начислится. Новый корабль через 6 часов."
          : "Изменится только этот нетронутый груз. Сложность и срок стоянки сохранятся. Остальные грузы останутся на месте."}</p>
        <div><button type="button" disabled={disabled} onClick={() => setConfirmation(null)}>Оставить</button>
          <button type="button" disabled={disabled} onClick={submitConfirmed}>{confirm.kind === "skip" ? "Отправить корабль" : "Заменить заказ"}</button></div>
      </section>}
      <div className={styles.orders}>{voyage.orders.map((order, index) => <ShipOrderCard key={order.id} state={state} order={order} index={index} disabled={disabled}
        onLoad={load} onReplace={id => requestConfirmation({ kind: "replace", target: id, voyageId: voyage.id })}
        replacementAvailable={freeReplacements > 0 && Boolean(replaceableShipOrder(state, voyage, order))} {...navigation} />)}</div>
      <section className={styles.bonus} data-ship-bonus aria-label="Награда за все грузы">
        <ItemIcon itemId="pearls" size={24} /><strong>10</strong><span>За все три груза</span><span className={styles.bonusProgress}>{delivered} / 3</span>
      </section>
      <div className={styles.departure}><button type="button" className={styles.replace}
        disabled={disabled || resetSeconds > 0 || state.wallet.pearls < shipOrdersConfig.resetPricePearls}
        onClick={() => requestConfirmation({ kind: "skip", target: voyage.id, voyageId: voyage.id })}>
        <Ship size={15} aria-hidden="true" />Отправить раньше <ItemIcon itemId="pearls" size={16} />{formatPearls(shipOrdersConfig.resetPricePearls)}
      </button>{resetSeconds > 0 && <span>Доступно через {worldCountdown(resetSeconds)}</span>}</div>
      <p className={styles.hint}>После последнего груза или окончания суток корабль уйдёт. Следующий рейс через 6 часов. Заменять можно только ещё не загруженные заказы.</p>
    </> : <section className={styles.empty} data-ship-waiting={seconds > 0 || undefined}>
      <Ship size={28} aria-hidden="true" /><h3>{seconds > 0 ? "Корабль в пути" : "Корабль прибывает"}</h3>
      {seconds > 0 ? <p className={styles.countdown}><Clock3 size={16} aria-hidden="true" />Вернётся через <strong>{worldCountdown(seconds)}</strong></p>
        : <p role="status">Капитан везёт новые заказы.</p>}
    </section>}
  </div>;
}
