"use client";

import { fishClassForItem } from "@/features/economy/domain/fishing";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ClipboardList, Clock3, Fish, Hammer, Mail, RefreshCw, X } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { BuilderPortrait } from "@/features/world/characters/builder/builder-portrait";
import { PleskPortrait } from "@/features/world/characters/plesk/plesk-portrait";
import { residentOrderBoard, type ResidentOrderOffer } from "@/features/economy/domain/food";
import { isTutorialOrderId, tutorialOrderProgress, tutorialResidentOrder } from "@/features/economy/domain/tutorial-order";
import { isStageOrderId, stageOrderProgress, stageResidentOrder } from "@/features/economy/domain/stage-orders";
import { economyLocalSellPrice } from "@/features/economy/domain/local-sale";
import { explorationActorId } from "@/features/economy/domain/actor-availability";
import { ECONOMY_MAX_BALANCE, formatPearls } from "@/features/economy/domain/money";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { itemName, number, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration, worldMaterialSource } from "@/features/economy/ui/shared/world-stations";
import { fishSelectionMatches, fishStockRequirements, type FishSelection } from "@/features/economy/domain/fish-stock";
import { WorldFishSelection } from "@/features/economy/ui/fishing/world-fish-selection";
import { orderOfferReady } from "./order-journal-summary";
import styles from "./world-resident-order-board.module.css";

type ResidentId = ResidentOrderOffer["residentId"];
type Filter = "all" | ResidentId;
type BoardOrderOffer = ResidentOrderOffer & { intervalSeconds?: number; completionRewards?: Record<string, number>;
  requiredBuildings?: Record<string, number> | null; requiredExplorations?: Record<string, number> | null };
export type OrderNavigation = {
  onNavigateStation?: (stationId: string, recipeId?: string) => void;
  onNavigateExpeditions?: (sector?: "forest" | "shore" | "caves") => void;
};
export type ResidentOrderQuote = { owner: string; revision: number; offerId: string; price: number };
const residents = {
  plesk: { name: "Плёска", role: "Рыба и припасы для рыбалки", Portrait: PleskPortrait },
  builder: { name: "Шишколап", role: "Материалы и инструменты", Portrait: BuilderPortrait },
};
const remaining = (at: string, now: number) => Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
const waiting = (seconds: number) => seconds < 60 ? `${seconds} с` : worldDuration(seconds);

/** The comparison uses actual NPC proceeds, including stack rounding for the local buyer. */
export function residentOrderSaleValue(economy: ReadyEconomy, offer: ResidentOrderOffer): number | null {
  const catalog = economy.snapshot.catalog;
  let total = 0;
  for (const [id, quantity] of Object.entries(offer.items)) {
    const item = catalog.items.find(entry => entry.id === id);
    if (!item?.tradable || item.category === "special") return null;
    total += fishClassForItem(id, catalog.fishing) ? item.baseSellPrice * quantity
      : economyLocalSellPrice(item.baseSellPrice, quantity, catalog.localBuyer, id);
  }
  return total;
}

function materialAction(economy: ReadyEconomy, itemId: string, navigation: OrderNavigation): (() => void) | null {
  const state = economy.snapshot;
  if (fishClassForItem(itemId, state.catalog.fishing)) {
    return navigation.onNavigateExpeditions ? () => navigation.onNavigateExpeditions?.("shore") : null;
  }
  const source = worldMaterialSource(state, itemId);
  if (source?.kind === "production" && navigation.onNavigateStation) return () => navigation.onNavigateStation?.(source.stationId, source.targetId);
  if (source?.kind === "exploration" && navigation.onNavigateStation
    && state.catalog.explorations.some(route => route.id === source.targetId && explorationActorId(route) === "miner"))
    return () => navigation.onNavigateStation?.("quarry");
  if (source?.kind === "exploration" && navigation.onNavigateExpeditions) {
    const sector = /shore|coastal/.test(source.targetId) ? "shore" : /cave|quarry/.test(source.targetId) ? "caves" : "forest";
    return () => navigation.onNavigateExpeditions?.(sector);
  }
  return null;
}

/** Fish orders keep the same class requirements, with one explicit species choice. */
export function FishOrderAction({ economy, offer, disabled, onSubmit }: {
  economy: ReadyEconomy; offer: ResidentOrderOffer; disabled: boolean; onSubmit: (selection: FishSelection) => boolean;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const focusOrigin = useRef<{ element: HTMLButtonElement | null; owner: string; offerId: string } | null>(null);
  const latest = useRef({ economy, offerId: offer.id });
  useLayoutEffect(() => { latest.current = { economy, offerId: offer.id }; }, [economy, offer.id]);
  return <>
    <button ref={trigger} type="button" className={styles.primary} data-guide-order-submit disabled={disabled} onClick={() => {
      if (!disabled && !locked(economy)) {
        focusOrigin.current = { element: trigger.current, owner: economy.snapshot.ownerPublicId, offerId: offer.id };
        setOpen(true);
      }
    }}>Отдать заказ</button>
    {open && <WorldFishSelection economy={economy} requiredItems={offer.items} contextId={`order:${offer.id}`} confirmLabel="Отдать заказ"
      onClose={() => setOpen(false)} onConfirm={selection => {
        if (disabled || !fishSelectionMatches(economy.snapshot, offer.items, selection) || !onSubmit(selection)) return false;
        setOpen(false); return true;
      }} onCloseAutoFocus={event => {
        event.preventDefault();
        const origin = focusOrigin.current, current = latest.current;
        focusOrigin.current = null;
        if (origin?.element && origin.element === trigger.current && origin.element.isConnected && !origin.element.disabled
          && origin.owner === current.economy.snapshot.ownerPublicId && origin.offerId === current.offerId) origin.element.focus({ preventScroll: true });
      }} />}
  </>;
}

export function ResidentOrderCard({ economy, offer, onComplete, onReplace, confirmation, ...navigation }: OrderNavigation & {
  economy: ReadyEconomy;
  offer: BoardOrderOffer;
  onComplete?: (offer: ResidentOrderOffer, fishSelection?: FishSelection) => boolean | void;
  onReplace?: (offer: ResidentOrderOffer) => void;
  confirmation?: ReactNode;
}) {
  const state = economy.snapshot, board = residentOrderBoard(state, economy.now, state.catalog);
  const price = board.replacementPricePearls;
  const missing = Object.entries(offer.items).some(([id, quantity]) => (state.inventory[id] ?? 0) < quantity);
  const requiredBuildings = Object.entries(offer.requiredBuildings ?? {}).filter(([id, level]) => (state.buildings[id] ?? 0) < level);
  const requiredExplorations = Object.entries(offer.requiredExplorations ?? {}).filter(([id, count]) => (state.progression?.routes[id] ?? 0) < count);
  const walletFull = state.wallet.coins > ECONOMY_MAX_BALANCE - offer.coins;
  const tutorial = isTutorialOrderId(offer.id, state.catalog);
  const stageOrder = isStageOrderId(offer.id, state.catalog);
  const permanent = tutorial || stageOrder;
  const practice = tutorialOrderProgress(state);
  const stage = stageOrderProgress(state);
  const stageTotal = state.catalog.stageOrders?.find(course => course.homeLevel === (state.buildings.home ?? 1))?.orders.length ?? 0;
  const waitSeconds = stageOrder ? remaining(offer.availableAt, economy.now) : 0;
  const intervalSeconds = offer.intervalSeconds ?? 0;
  const completionRewards = stageOrder ? Object.entries(offer.completionRewards ?? {}) : [];
  const consumed = Object.values(offer.items).reduce((total, amount) => total + amount, 0);
  const rewardUnits = completionRewards.reduce((total, [, amount]) => total + amount, 0);
  const rewardRoom = rewardUnits === 0 || state.storage.used + state.storage.reserved - consumed + rewardUnits <= state.storage.capacity;
  const current = (): BoardOrderOffer | null | undefined => tutorial ? tutorialOrderProgress(economy.snapshot).ingredientsClaimed ? tutorialResidentOrder(economy.snapshot) : null
    : stageOrder ? stageResidentOrder(economy.snapshot)
    : residentOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog).offers.find(order => order.id === offer.id);
  const resident = residents[offer.residentId], sale = residentOrderSaleValue(economy, offer);
  const bonus = sale === null ? 0 : offer.coins - sale;
  const currentOffer = current()?.id === offer.id;
  const hasFish = Object.keys(fishStockRequirements(offer.items, state.catalog.fishing)).length > 0;
  const submitDisabled = locked(economy) || missing || requiredBuildings.length > 0 || requiredExplorations.length > 0 || walletFull || !rewardRoom || waitSeconds > 0 || !currentOffer;
  const acceptedOwner = state.ownerPublicId, acceptedRevision = state.revision;
  const complete = (selection?: FishSelection): boolean => {
    const active = current(), latest = economy.snapshot;
    if (latest.ownerPublicId !== acceptedOwner || latest.revision !== acceptedRevision || locked(economy) || !active || active.id !== offer.id || Date.parse(active.availableAt) > economy.now
      || Object.entries(active.items).some(([id, amount]) => (latest.inventory[id] ?? 0) < amount)
      || latest.wallet.coins > ECONOMY_MAX_BALANCE - active.coins) return false;
    if (stageOrder && Object.entries(stageResidentOrder(latest)?.requiredBuildings ?? {}).some(([id, level]) => (latest.buildings[id] ?? 0) < level)) return false;
    if (stageOrder && Object.entries(stageResidentOrder(latest)?.requiredExplorations ?? {}).some(([id, count]) => (latest.progression?.routes[id] ?? 0) < count)) return false;
    const rewards = Object.values(active.completionRewards ?? {}).reduce((total, amount) => total + amount, 0);
    const items = Object.values(active.items).reduce((total, amount) => total + amount, 0);
    if (rewards > 0 && latest.storage.used + latest.storage.reserved - items + rewards > latest.storage.capacity) return false;
    if (selection && !fishSelectionMatches(latest, active.items, selection) || hasFish && !selection) return false;
    return (onComplete ? onComplete(active, selection) : selection ? economy.act("complete_resident_order", active.id, 1, 0, selection)
      : economy.act("complete_resident_order", active.id, 1, 0)) !== false;
  };
  return <article className={styles.order} data-order-letter data-order-id={offer.id} data-resident={offer.residentId} data-tutorial-order={tutorial || undefined} data-stage-order={stageOrder || undefined} data-order-ready={orderOfferReady(state, offer, economy.now) || undefined}>
    {tutorial && <p className={styles.tutorialLabel}>Учебный заказ · {practice.version === 2 ? `${practice.step + 1} / 4` : "один раз"}</p>}
    {stageOrder && <p className={styles.tutorialLabel}>К дому {(state.buildings.home ?? 2) + 1} · {stage.step + 1} / {stageTotal}</p>}
    <div className={styles.letterLayout}>
      <div className={styles.letterMessage}>
        <header className={styles.heading}>
          <resident.Portrait className={styles.portrait} />
          <div className={styles.title}><span>От: {resident.name}</span><h3>{offer.name}</h3></div>
          <strong className={styles.payout} data-guide-order-reward aria-label={`Награда: ${number(offer.coins)} монет`}><ItemIcon itemId="coins" size={19} />{number(offer.coins)}</strong>
        </header>
        {orderOfferReady(state, offer, economy.now) && <p className={styles.ready}><Check size={13} aria-hidden="true" />Можно сдать</p>}
        {offer.description && <p className={styles.description}>{offer.description}</p>}
        {waitSeconds > 0 && <p className={styles.wait} data-stage-order-wait><Clock3 size={15} aria-hidden="true" /><span>Следующая поставка через <strong>{waiting(waitSeconds)}</strong>. Материалы можно подготовить заранее.</span></p>}
        {stageOrder && intervalSeconds > 0 && stage.step + 1 < stageTotal && <p className={styles.description}>После сдачи этой поставки до следующей пройдёт {waiting(intervalSeconds)}. Жемчуг не сокращает этот срок.</p>}
      </div>
      <div className={styles.letterContents}>
        {requiredBuildings.length > 0 && <ul className={styles.ingredients} aria-label="Условия поставки">{requiredBuildings.map(([id, level]) => <li key={id} data-missing><div><span>{state.catalog.buildings.find(building => building.id === id)?.name ?? id} · нужен ур. {level}</span>{navigation.onNavigateStation && <button type="button" onClick={() => navigation.onNavigateStation?.(id)}>К постройке</button>}</div></li>)}</ul>}
        {requiredExplorations.length > 0 && <ul className={styles.ingredients} aria-label="Нужные экспедиции">{requiredExplorations.map(([id, count]) => <li key={id} data-missing><div><span>{state.catalog.explorations.find(route => route.id === id)?.name ?? id}: забрано {number(state.progression?.routes[id] ?? 0)} / {number(count)}</span>{navigation.onNavigateExpeditions && <button type="button" onClick={() => navigation.onNavigateExpeditions?.("forest")}>В путь</button>}</div></li>)}</ul>}
        <ul className={styles.ingredients} data-guide-order-requirements aria-label="Для заказа">{Object.entries(offer.items).map(([id, quantity]) => {
          const owned = state.inventory[id] ?? 0, short = owned < quantity;
          const source = short ? materialAction(economy, id, navigation) : null;
          const label = <><ProductIcon state={state} itemId={id} size={23} /><span>{itemName(state, id)}</span><strong>{number(owned)} / {number(quantity)}</strong></>;
          return <li key={id} data-missing={short || undefined}>{source ? <button type="button" aria-label={`Где получить для заказа: ${itemName(state, id)}`} onClick={source}>{label}</button> : <div>{label}</div>}</li>;
        })}</ul>
        {completionRewards.length > 0 && <div className={styles.completionReward}><p>Награда за завершение этапа</p><ul aria-label="Дополнительная награда за этап">{completionRewards.map(([id, amount]) => <li key={id}><ProductIcon state={state} itemId={id} size={21} /><span>{itemName(state, id)} × {number(amount)}</span></li>)}</ul></div>}
      </div>
    </div>
    {bonus > 0 && !permanent && <p className={styles.premium} title="Рыбу можно продать Плёске, другие товары местному скупщику.">На {number(bonus)} монет больше продажи</p>}
    {confirmation ?? <div className={styles.actions}>
      {hasFish ? <FishOrderAction economy={economy} offer={offer} disabled={submitDisabled} onSubmit={complete} />
        : <button type="button" className={styles.primary} data-guide-order-submit disabled={submitDisabled} onClick={() => complete()}>{waitSeconds > 0 ? `Доступно через ${waiting(waitSeconds)}` : "Отдать заказ"}</button>}
      {!permanent && <button type="button" className={styles.replace} disabled={locked(economy) || !currentOffer || price > state.wallet.pearls || (price > 0 && !onReplace)}
        aria-label={`Заменить заказ: ${offer.name}${price > 0 ? `, за ${formatPearls(price)} жемчужин` : ", бесплатно"}`} onClick={() => {
          if (locked(economy) || current()?.id !== offer.id || price > state.wallet.pearls) return;
          if (onReplace) onReplace(offer); else if (price === 0) void economy.act("replace_resident_order", offer.id, 1, 0);
        }}><RefreshCw size={14} aria-hidden="true" /><span>Заменить</span>{price > 0 && <span className={styles.price}><ItemIcon itemId="pearls" size={16} />{formatPearls(price)}</span>}</button>}
    </div>}
    {walletFull && <p className={styles.warning}>В кошельке нет места для награды.</p>}
    {!rewardRoom && <p className={styles.warning}>Освободите место в кладовой для награды за этап.</p>}
  </article>;
}

/** Recheck the exact offered goods, owner, revision and accepted price immediately before debit. */
export function residentOrderQuoteReason(economy: ReadyEconomy, quote: ResidentOrderQuote): string | null {
  if (locked(economy)) return economy.uncertain ? "Проверяем последнее действие." : "Дождитесь подтверждения действия.";
  const state = economy.snapshot, board = residentOrderBoard(state, economy.now, state.catalog);
  if (state.ownerPublicId !== quote.owner || state.revision !== quote.revision || !board.offers.some(offer => offer.id === quote.offerId))
    return "Заказы обновились. Вернитесь и выберите заказ ещё раз.";
  if (board.replacementPricePearls > quote.price) return "Цена изменилась. Проверьте её ещё раз.";
  if (board.replacementPricePearls > state.wallet.pearls) return `Не хватает жемчужин: ${formatPearls(board.replacementPricePearls - state.wallet.pearls)}.`;
  return null;
}

export function ResidentOrderReplacement({ economy, quote, offer, headingRef, onCancel, onConfirm }: {
  economy: ReadyEconomy; quote: ResidentOrderQuote; offer: ResidentOrderOffer;
  headingRef?: RefObject<HTMLHeadingElement | null>; onCancel: () => void; onConfirm: () => void;
}) {
  const board = residentOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog);
  const price = board.replacementPricePearls, reason = residentOrderQuoteReason(economy, quote);
  return <section className={styles.confirmation} aria-label={`Подтверждение замены: ${offer.name}`}>
    <h4 ref={headingRef} tabIndex={-1}>Заменить за {formatPearls(price)} жемчужин?</h4>
    <p>Текущая просьба исчезнет. Новая появится сразу.</p>
    <p className={styles.balance}>Жемчужины: {formatPearls(economy.snapshot.wallet.pearls)} → {formatPearls(Math.max(0, economy.snapshot.wallet.pearls - price))}</p>
    {reason && <p className={styles.warning} role="status">{reason}</p>}
    <div className={styles.actions}><button type="button" className={styles.replace} onClick={onCancel}>Оставить</button><button type="button" className={styles.primary} disabled={Boolean(reason)} onClick={onConfirm} aria-label={`Подтвердить замену за ${formatPearls(price)} жемчужин`}><RefreshCw size={14} aria-hidden="true" />Заменить <ItemIcon itemId="pearls" size={16} />{formatPearls(price)}</button></div>
  </section>;
}

type Attempt = { owner: string; revision: number; offerId: string; action: "complete_resident_order" | "replace_resident_order"; coins: number; completed: number; tutorialStep: number; stageHome: number; stageStep: number; completionRewards: Record<string, number> };
export function ResidentOrderBoard({ economy, residentId, onFilterChange, ...navigation }: OrderNavigation & { economy: ReadyEconomy; residentId?: ResidentId; onFilterChange?: (residentId?: ResidentId) => void }) {
  const [filter, setFilter] = useState<Filter>(residentId ?? "all");
  const [quote, setQuote] = useState<ResidentOrderQuote | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const latest = useRef({ economy, quote });
  useLayoutEffect(() => { latest.current = { economy, quote }; }, [economy, quote]);
  const sent = useRef(false), heading = useRef<HTMLHeadingElement>(null), container = useRef<HTMLDivElement>(null), success = useRef<HTMLParagraphElement>(null);
  const board = residentOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog);
  const tutorial = tutorialOrderProgress(economy.snapshot).ingredientsClaimed ? tutorialResidentOrder(economy.snapshot) : null;
  const tutorialVisible = Boolean(tutorial && (filter === "all" || filter === tutorial.residentId));
  const stage = stageResidentOrder(economy.snapshot);
  const stageVisible = Boolean(stage && (filter === "all" || filter === stage.residentId));
  const permanentOffers = [tutorial, stage].filter((entry): entry is ResidentOrderOffer => Boolean(entry));
  const offers = [...permanentOffers, ...board.offers];
  const config = economy.snapshot.catalog.food!.orders;
  const matching = board.offers.filter(offer => filter === "all" || offer.residentId === filter);
  const quoteOffer = quote && board.offers.find(offer => offer.id === quote.offerId);
  const confirming = Boolean(quoteOffer);
  const headingId = useId();
  const changeFilter = (value: Filter) => { setFilter(value); setQuote(null); onFilterChange?.(value === "all" ? undefined : value); };
  useEffect(() => {
    if (confirming) heading.current?.focus({ preventScroll: true });
  }, [confirming]);
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) sent.current = false;
  }, [economy.busy, economy.uncertain, economy.error, economy.snapshot.ownerPublicId, economy.snapshot.revision]);

  const send = (offer: ResidentOrderOffer, action: Attempt["action"], price: number, selection?: FishSelection): boolean => {
    const current = latest.current.economy;
    if (sent.current || locked(current)) return false;
    const currentBoard = residentOrderBoard(current.snapshot, current.now, current.snapshot.catalog);
    const active: BoardOrderOffer | null | undefined = isTutorialOrderId(offer.id, current.snapshot.catalog) && action === "complete_resident_order" && tutorialOrderProgress(current.snapshot).ingredientsClaimed
      ? tutorialResidentOrder(current.snapshot) : isStageOrderId(offer.id, current.snapshot.catalog) && action === "complete_resident_order"
        ? stageResidentOrder(current.snapshot) : currentBoard.offers.find(entry => entry.id === offer.id);
    if (!active || active.id !== offer.id || current.snapshot.ownerPublicId !== economy.snapshot.ownerPublicId) return false;
    if (action === "complete_resident_order" && (Object.entries(active.items).some(([id, count]) => (current.snapshot.inventory[id] ?? 0) < count)
      || current.snapshot.wallet.coins > ECONOMY_MAX_BALANCE - active.coins || Date.parse(active.availableAt) > current.now)) return false;
    if (action === "complete_resident_order" && selection && !fishSelectionMatches(current.snapshot, active.items, selection)) return false;
    const rewardUnits = Object.values(active.completionRewards ?? {}).reduce((total, count) => total + count, 0);
    const consumed = Object.values(active.items).reduce((total, count) => total + count, 0);
    if (action === "complete_resident_order" && rewardUnits > 0
      && current.snapshot.storage.used + current.snapshot.storage.reserved - consumed + rewardUnits > current.snapshot.storage.capacity) return false;
    if (action === "replace_resident_order" && (currentBoard.replacementPricePearls > price || currentBoard.replacementPricePearls > current.snapshot.wallet.pearls)) return false;
    sent.current = true;
    setAttempt({ owner: current.snapshot.ownerPublicId, revision: current.snapshot.revision, offerId: active.id, action, coins: active.coins, completed: currentBoard.completed,
      tutorialStep: tutorialOrderProgress(current.snapshot).step, stageHome: current.snapshot.buildings.home ?? 1, stageStep: stageOrderProgress(current.snapshot).step,
      completionRewards: { ...active.completionRewards } });
    const accepted = selection ? current.act(action, active.id, 1, price, selection) : current.act(action, active.id, 1, price);
    if (accepted === false) { sent.current = false; setAttempt(null); return false; }
    return true;
  };
  const replace = (offer: ResidentOrderOffer) => {
    const current = latest.current.economy;
    if (locked(current) || sent.current) return;
    const fresh = residentOrderBoard(current.snapshot, current.now, current.snapshot.catalog);
    if (!fresh.offers.some(entry => entry.id === offer.id) || fresh.replacementPricePearls > current.snapshot.wallet.pearls) return;
    if (fresh.replacementPricePearls === 0) send(offer, "replace_resident_order", 0);
    else {
      setAttempt(null);
      setQuote({ owner: current.snapshot.ownerPublicId, revision: current.snapshot.revision, offerId: offer.id, price: fresh.replacementPricePearls });
    }
  };
  const cancel = () => {
    const id = quote?.offerId;
    setQuote(null);
    container.current?.ownerDocument.defaultView?.requestAnimationFrame(() => {
      const cards = container.current?.querySelectorAll<HTMLElement>("[data-order-id]");
      const card = Array.from(cards ?? []).find(element => element.dataset.orderId === id);
      card?.querySelector<HTMLButtonElement>("button[aria-label^='Заменить заказ:']")?.focus({ preventScroll: true });
    });
  };
  const confirm = () => {
    const current = latest.current.economy, accepted = latest.current.quote;
    if (!quote || accepted !== quote || residentOrderQuoteReason(current, quote)) return;
    const offer = residentOrderBoard(current.snapshot, current.now, current.snapshot.catalog).offers.find(entry => entry.id === quote.offerId);
    if (offer) send(offer, "replace_resident_order", quote.price);
  };
  const confirmed = attempt && attempt.owner === economy.snapshot.ownerPublicId && economy.snapshot.revision > attempt.revision
    && !economy.busy && !economy.uncertain && !economy.error && Boolean(economy.notice)
    && (isTutorialOrderId(attempt.offerId, economy.snapshot.catalog) ? tutorialOrderProgress(economy.snapshot).completed
      || tutorialOrderProgress(economy.snapshot).step > attempt.tutorialStep
      : isStageOrderId(attempt.offerId, economy.snapshot.catalog) ? stageOrderProgress(economy.snapshot, attempt.stageHome).completed
        || stageOrderProgress(economy.snapshot, attempt.stageHome).step > attempt.stageStep
      : !board.offers.some(offer => offer.id === attempt.offerId)
        && (attempt.action !== "complete_resident_order" || board.completed > attempt.completed));
  useEffect(() => { if (confirmed) success.current?.focus({ preventScroll: true }); }, [confirmed]);
  const acceptedStage = attempt ? stageOrderProgress(economy.snapshot, attempt.stageHome) : null;
  const nextStageWait = acceptedStage?.availableAt ? remaining(acceptedStage.availableAt, economy.now) : 0;
  return <div className={styles.board} ref={container}>
    <div className={styles.filters} role="group" aria-label="Заказчик">{(["all", "plesk", "builder"] as const).map(value => <button key={value} type="button" data-order-filter={value} aria-pressed={filter === value} onClick={() => changeFilter(value)}>{value === "all" ? <Mail size={15} aria-hidden="true" /> : value === "plesk" ? <Fish size={15} aria-hidden="true" /> : <Hammer size={15} aria-hidden="true" />}{value === "all" ? "Все" : residents[value].name}<span>{value === "all" ? offers.length : offers.filter(offer => offer.residentId === value).length}</span></button>)}</div>
    <p className={styles.lore}>{filter === "all" ? "Помогай соседям, получай монеты и готовь припасы к новым просьбам." : residents[filter].role}</p>
    {confirmed && <p className={styles.success} role="status" ref={success} tabIndex={-1}><Check size={15} aria-hidden="true" /><span>{isTutorialOrderId(attempt.offerId, economy.snapshot.catalog) ? `Учебный заказ выполнен · +${number(attempt.coins)} монет. ${tutorialOrderProgress(economy.snapshot).completed ? "Все учебные просьбы выполнены." : "Следующая учебная просьба уже на доске."}`
      : isStageOrderId(attempt.offerId, economy.snapshot.catalog) ? `Заказ этапа выполнен · +${number(attempt.coins)} монет. ${acceptedStage?.completed ? "Все просьбы этого этапа выполнены." : nextStageWait > 0 ? `Следующая поставка через ${waiting(nextStageWait)}.` : "Следующая просьба уже на доске."}${Object.entries(attempt.completionRewards).map(([id, count]) => ` Получено: ${itemName(economy.snapshot, id)} × ${number(count)}.`).join("")}`
      : attempt.action === "complete_resident_order" ? `Заказ выполнен · +${number(attempt.coins)} монет. Новая просьба уже на доске.` : "Заказ заменён. Новая просьба уже на доске."}</span><button type="button" aria-label="Скрыть результат заказа" onClick={() => setAttempt(null)}><X size={14} aria-hidden="true" /></button></p>}
    {(tutorialVisible || stageVisible) && <section className={styles.chapter} data-order-chapter="progression" aria-labelledby={`${headingId}-progression`}>
      <header className={styles.chapterHeading}><span className={styles.chapterNumber} aria-hidden="true">I</span><div><h3 id={`${headingId}-progression`}>Путь хозяйства</h3><p>Особые просьбы для следующего шага</p></div></header>
      <div className={styles.permanentCards}>
        {tutorialVisible && tutorial && <ResidentOrderCard economy={economy} offer={tutorial} {...navigation} onComplete={(entry, selection) => send(entry, "complete_resident_order", 0, selection)} />}
        {stageVisible && stage && <ResidentOrderCard economy={economy} offer={stage} {...navigation} onComplete={(entry, selection) => send(entry, "complete_resident_order", 0, selection)} />}
      </div>
    </section>}
    <section className={styles.chapter} data-order-chapter="repeatable" aria-labelledby={headingId}>
      <header className={styles.chapterHeading}><span className={styles.chapterNumber} aria-hidden="true">{tutorialVisible || stageVisible ? "II" : "I"}</span><div><h3 id={headingId}>Просьбы жителей</h3><p>После сдачи появится новая просьба</p></div><span className={styles.chapterCount}>{matching.length}</span></header>
      <div className={styles.boardSummary}><p><Clock3 size={13} aria-hidden="true" />Обновление через <strong>{waiting(remaining(board.refreshAt, economy.now))}</strong></p><p>Бесплатных замен: <strong>{board.freeReplacementsRemaining} / {config.freeReplacements}</strong></p></div>
      {board.replacementPricePearls > economy.snapshot.wallet.pearls && <p className={styles.warning}>На замену не хватает {formatPearls(board.replacementPricePearls - economy.snapshot.wallet.pearls)} жемчужин.</p>}
      <div className={styles.orders}>{matching.map(offer => <ResidentOrderCard key={offer.id} economy={economy} offer={offer} {...navigation} onComplete={(entry, selection) => send(entry, "complete_resident_order", 0, selection)} onReplace={replace}
        confirmation={quoteOffer?.id === offer.id && quote ? <ResidentOrderReplacement economy={economy} quote={quote} offer={offer} headingRef={heading} onCancel={cancel} onConfirm={confirm} /> : undefined} />)}</div>
      {!matching.length && <p className={styles.repeatableEmpty}>У этого жителя пока нет новых просьб.</p>}
    </section>
    {!matching.length && !tutorialVisible && !stageVisible && <p className={styles.empty}><ClipboardList size={20} aria-hidden="true" />{offers.length ? "Сейчас просьб от этого жителя нет. Посмотрите все заказы." : "Просьбы жителей пока недоступны."}{offers.length > 0 && <button type="button" onClick={() => changeFilter("all")}>Все заказы</button>}</p>}
    <details className={styles.rules}><summary>Обновление и замена просьб</summary><p className={styles.footnote}>После сдачи обычной просьбы новый заказ появится сразу. Ещё {board.freeReplacementsRemaining} замен бесплатно, затем {formatPearls(config.replacementPricePearls)} жемчужин за замену. Бесплатные замены восстановятся через {waiting(remaining(board.replacementsResetAt, economy.now))}.</p></details>
  </div>;
}
