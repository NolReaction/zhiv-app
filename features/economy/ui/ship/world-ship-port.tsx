"use client";

import { useEffect, useRef, useState } from "react";
import { Anchor, ArrowRight, Check, Clock3, PackageCheck, RefreshCw, Ship, TowerControl } from "lucide-react";
import type { EconomyCommand, EconomyView } from "@/features/economy/domain/model";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS, formatPearls } from "@/features/economy/domain/money";
import { shipOrdersConfig, shipOrdersUnlocked } from "@/features/economy/domain/ship-orders";
import { explorationActorId } from "@/features/economy/domain/actor-availability";
import { locked } from "@/features/economy/sync/controller-state";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { ItemIcon } from "@/features/items/item-icon";
import { ProductIcon, itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import { worldCountdown, worldDuration, worldMaterialSource } from "@/features/economy/ui/shared/world-stations";
import styles from "./world-ship-port.module.css";

type ShipOrder = NonNullable<EconomyView["ship"]["voyage"]>["orders"][number];
type PortNavigation = {
  onNavigateStation: (stationId: string, recipeId?: string) => void;
  onNavigateExpeditions: () => void;
};

function materialDestination(state: EconomyView, itemId: string, navigation: PortNavigation) {
  const source = worldMaterialSource(state, itemId);
  if (source?.kind === "production") return () => navigation.onNavigateStation(source.stationId, source.targetId);
  if (source?.kind === "exploration") {
    const route = state.catalog.explorations.find(entry => entry.id === source.targetId);
    return route && explorationActorId(route) === "miner" ? () => navigation.onNavigateStation("quarry") : navigation.onNavigateExpeditions;
  }
  return null;
}

export function ShipOrderCard({ state, order, index, disabled, onDeliver, ...navigation }: PortNavigation & {
  state: EconomyView; order: ShipOrder; index: number; disabled: boolean; onDeliver: (id: string) => void;
}) {
  const delivered = Boolean(order.deliveredAt);
  const ready = Object.entries(order.items).every(([id, quantity]) => (state.inventory[id] ?? 0) >= quantity);
  const walletFull = state.wallet.coins + order.rewardCoins > ECONOMY_MAX_BALANCE;
  return <article className={styles.order} data-ship-order={order.id} data-delivered={delivered || undefined} aria-labelledby={`ship-order-${index}`}>
    <header className={styles.orderHeader}><span className={styles.orderNumber} aria-hidden="true">{delivered ? <Check size={17} /> : index + 1}</span>
      <div><h3 id={`ship-order-${index}`}>{order.title}</h3><p>{delivered ? "Груз принят и оплачен" : ready ? "Всё собрано" : "Соберите груз"}</p></div>
    </header>
    <ul className={styles.items} aria-label="Состав груза">{Object.entries(order.items).map(([id, quantity]) => {
      const owned = state.inventory[id] ?? 0, missing = !delivered && owned < quantity;
      const destination = missing ? materialDestination(state, id, navigation) : null;
      return <li key={id} data-missing={missing || undefined}>
        <ProductIcon state={state} itemId={id} size={28} />
        <div><span>{itemName(state, id)}</span>{destination && <button type="button" onClick={destination} aria-label={`Где получить: ${itemName(state, id)}`}>Не хватает {number(quantity - owned)}<ArrowRight size={12} aria-hidden="true" /></button>}</div>
        <strong aria-label={delivered ? `Отгружено: ${quantity}` : `В наличии ${owned}, нужно ${quantity}`}>{delivered ? `×${number(quantity)}` : `${number(owned)} / ${number(quantity)}`}</strong>
      </li>;
    })}</ul>
    <footer className={styles.orderFooter}>
      <span className={styles.payment}><ItemIcon itemId="coins" size={20} /><strong>{number(order.rewardCoins)}</strong><small>{delivered ? "получено" : "за груз"}</small></span>
      {delivered ? <span className={styles.delivered}><PackageCheck size={16} aria-hidden="true" />Отгружено</span>
        : <button type="button" className={styles.primary} disabled={disabled || !ready || walletFull} onClick={() => {
          if (!disabled && ready && !walletFull) onDeliver(order.id);
        }} aria-label={`Отгрузить: ${order.title}`}>Отгрузить<ArrowRight size={15} aria-hidden="true" /></button>}
    </footer>
    {!delivered && walletFull && <p className={styles.hint}>Сначала потратьте часть монет, чтобы принять оплату.</p>}
  </article>;
}

/** All terms and progress come from the account snapshot; opening this UI is read-only. */
export function WorldShipPort({ economy, ...navigation }: PortNavigation & { economy: EconomyController }) {
  const [declining, setDeclining] = useState<string | null>(null);
  const declineHeading = useRef<HTMLHeadingElement>(null), declineTrigger = useRef<HTMLButtonElement>(null);
  const wasDeclining = useRef(false);
  const pending = useRef(false);
  const state = economy.snapshot;
  const confirming = Boolean(declining && declining === state?.ship.voyage?.id);
  useEffect(() => {
    if (confirming) declineHeading.current?.focus({ preventScroll: true });
    else if (wasDeclining.current) declineTrigger.current?.focus({ preventScroll: true });
    wasDeclining.current = confirming;
  }, [confirming]);
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) pending.current = false;
  }, [economy.busy, economy.uncertain, economy.error, state?.revision]);
  const disabled = locked(economy) || !economy.snapshotConfirmed;
  const send = (action: EconomyCommand["action"], targetId: string) => {
    if (disabled || pending.current) return;
    pending.current = true;
    if (!economy.act(action, targetId)) pending.current = false;
    else setDeclining(null);
  };
  const retrySeconds = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const failure = economy.syncError || economy.error;
  const recovery = (failure || economy.uncertain) && <div className={styles.recovery} role="alert">
    <p>{economy.uncertain ? "Проверяем отгрузку. Оплата появится после подтверждения." : failure}</p>
    <button type="button" disabled={economy.busy || retrySeconds > 0} onClick={() => {
      if (!economy.busy && retrySeconds <= 0) void economy.retry();
    }}><RefreshCw size={15} aria-hidden="true" />{retrySeconds ? `Повторить через ${retrySeconds} с` : "Проверить результат"}</button>
  </div>;
  if (!state) return <div className={styles.port} data-ship-port>{recovery || <p role="status">Открываем порт…</p>}</div>;
  if (!shipOrdersUnlocked(state)) return <div className={styles.port} data-ship-port="locked">
    <div className={styles.locked}><TowerControl size={32} aria-hidden="true" /><h3>Зажгите маяк</h3><p>Восстановите маяк и получите готовую стройку. Его свет приведёт корабль к вашему берегу.</p>
      <button type="button" className={styles.primary} onClick={() => navigation.onNavigateStation("lighthouse")}>К маяку<ArrowRight size={15} aria-hidden="true" /></button></div>
  </div>;
  const ship = state.ship, voyage = ship.voyage;
  const delivered = voyage?.orders.filter(order => order.deliveredAt).length ?? 0;
  const complete = Boolean(voyage && delivered === voyage.orders.length);
  const seconds = ship.nextAvailableAt ? Math.max(0, Math.ceil((Date.parse(ship.nextAvailableAt) - economy.now) / 1000)) : 0;
  const pearlsFull = Boolean(voyage && state.wallet.pearls + voyage.rewardPearls > ECONOMY_MAX_PEARLS);
  return <div className={styles.port} data-ship-port aria-busy={economy.busy || undefined}>
    <header className={styles.cover}>
      <div className={styles.shipArt} role="img" aria-label="Торговый пароход у причала" />
      <div className={styles.coverText}><p><Anchor size={13} aria-hidden="true" />Южная бухта</p><h3>{voyage ? `Поставка № ${number(voyage.number)}` : "Корабль у причала"}</h3>
        <span>{voyage ? `${delivered} из ${voyage.orders.length} грузов отгружено` : `Выполнено поставок: ${number(ship.completedVoyages)}`}</span></div>
    </header>
    {recovery}
    {voyage ? <>
      <p className={styles.intro}>Три заказа для вашего хозяйства. Отгружайте в любом порядке: каждая партия оплачивается сразу.</p>
      <div className={styles.orders}>{voyage.orders.map((order, index) => <ShipOrderCard key={order.id} state={state} order={order} index={index} disabled={disabled}
        onDeliver={id => send("complete_ship_order", id)} {...navigation} />)}</div>
      <section className={styles.bonus} data-ship-bonus data-ready={complete || undefined} aria-label="Награда за поставку">
        <span className={styles.bonusIcon}><ItemIcon itemId="pearls" size={30} /></span>
        <div><h3>Награда капитана</h3><p>Жемчуг за все три груза: <strong>{formatPearls(voyage.rewardPearls)}</strong></p></div>
        {complete ? <button type="button" className={styles.primary} disabled={disabled || pearlsFull} onClick={() => {
          if (!pearlsFull) send("claim_ship_voyage", voyage.id);
        }}>Забрать награду<Check size={15} aria-hidden="true" /></button> : <span className={styles.bonusProgress}>{delivered} / {voyage.orders.length}</span>}
        {pearlsFull && <p className={styles.hint}>Сначала потратьте часть жемчуга. Награда дождётся вас.</p>}
      </section>
      <p className={styles.hint}><Clock3 size={14} aria-hidden="true" />Заказы не сгорают. Следующая партия {seconds > 0 ? `будет доступна через ${worldCountdown(seconds)}` : "уже доступна после закрытия этой поставки"}.</p>
      {!complete && (confirming ? <section className={styles.confirmation} aria-label="Отказ от оставшихся заказов">
        <h3 ref={declineHeading} tabIndex={-1}>Отказаться от оставшихся?</h3><p>Отгруженные товары уже оплачены. Монеты останутся у вас, оставшиеся вещи не спишутся. Награда капитана за эту поставку не выдаётся.</p>
        <p>{seconds > 0 ? `Новая партия через ${worldCountdown(seconds)}. Отказ не ускоряет её.` : "После отказа можно принять новую партию."}</p>
        <div><button type="button" className={styles.secondary} onClick={() => setDeclining(null)}>Продолжить сбор</button><button type="button" className={styles.decline} disabled={disabled} onClick={() => send("skip_ship_voyage", voyage.id)}>Подтвердить отказ</button></div>
      </section> : <button ref={declineTrigger} type="button" className={styles.textButton} disabled={disabled} onClick={() => setDeclining(voyage.id)}>Отказаться от оставшихся</button>)}
    </> : <section className={styles.empty} data-ship-waiting={seconds > 0 || undefined}>
      <Ship size={28} aria-hidden="true" /><h3>{seconds > 0 ? "Капитан готовит новые заказы" : "Новая партия заказов"}</h3>
      <p>Три груза из доступных вам товаров. Монеты за каждый заказ и от {formatPearls(shipOrdersConfig.rewardPearls)} жемчужин за полную поставку. Точная награда зависит от стоимости груза.</p>
      {seconds > 0 ? <p className={styles.countdown}><Clock3 size={17} aria-hidden="true" />Через <strong>{worldCountdown(seconds)}</strong></p>
        : <button type="button" className={styles.primary} disabled={disabled} onClick={() => send("open_ship_voyage", "port")}>Принять заказы<ArrowRight size={16} aria-hidden="true" /></button>}
      <small>Новая партия раз в {worldDuration(shipOrdersConfig.intervalSeconds)}. Принятые заказы ждут столько, сколько нужно.</small>
    </section>}
    {economy.notice && !failure && !economy.uncertain && <p className={styles.notice} role="status">{economy.notice}</p>}
  </div>;
}
