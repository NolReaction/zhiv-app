"use client";

import { fishClassForItem } from "@/features/economy/domain/fishing";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { CalendarDays, Check, ClipboardList, Clock3, HeartHandshake, RefreshCw, X } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { residentOrderBoard, type ResidentOrderOffer } from "@/features/economy/domain/food";
import { isTutorialOrderId, tutorialOrderProgress, tutorialResidentOrder } from "@/features/economy/domain/tutorial-order";
import { isStageOrderId, stageOrderProgress, stageResidentOrder } from "@/features/economy/domain/stage-orders";
import { economyLocalSellPrice } from "@/features/economy/domain/local-sale";
import { explorationActorId } from "@/features/economy/domain/actor-availability";
import { ECONOMY_MAX_BALANCE, formatPearls } from "@/features/economy/domain/money";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { itemName, number, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration, worldMaterialSource, worldMaterialAccessReason } from "@/features/economy/ui/shared/world-stations";
import { fishSelectionMatches, fishStockRequirements, type FishSelection } from "@/features/economy/domain/fish-stock";
import { WorldFishSelection } from "@/features/economy/ui/fishing/world-fish-selection";
import { tradeRelationProgress, tradeRelationsState, tradeResidentAvailable, weeklyOrderBoard } from "@/features/economy/domain/trade-relations";
import { orderDifficulty, orderDifficultyNames } from "@/features/economy/domain/order-difficulty";
import { orderOfferReady } from "./order-journal-summary";
import { OrderResidentTabs } from "./order-resident-tabs";
import { OrderResidentRelations } from "./order-resident-relations";
import { OrderWeeklyChooser } from "./order-weekly-chooser";
import { orderReputationPresentation } from "./order-reputation-presentation";
import { orderResidentIds, orderResidents, type OrderResidentId } from "./order-residents";
import styles from "./world-resident-order-board.module.css";
import theme from "./order-resident-theme.module.css";

type ResidentId = OrderResidentId;
type Filter = "all" | ResidentId;
type BoardOrderOffer = ResidentOrderOffer & { intervalSeconds?: number; completionRewards?: Record<string, number>;
  requiredBuildings?: Record<string, number> | null; requiredExplorations?: Record<string, number> | null;
  pearls?: number; weekly?: boolean; stage?: number; stages?: number; expiresAt?: string;
  reputationXp?: number; effortSeconds?: number; manufacturingSeconds?: number; fishingUncertain?: boolean };
export type OrderNavigation = {
  onNavigateStation?: (stationId: string, recipeId?: string) => void;
  onNavigateExpeditions?: (sector?: "forest" | "shore" | "caves") => void;
};
export type ResidentOrderQuote = { owner: string; revision: number; offerId: string; price: number };
const residents = orderResidents;
const remaining = (at: string, now: number) => Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
const waiting = (seconds: number) => seconds < 60 ? `${seconds} с` : worldDuration(seconds);

/** A retained duplicate request can be retired freely after the board upgrade. */
export function residentOrderReplacementTerms(economy: ReadyEconomy, offer: ResidentOrderOffer,
  board = residentOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog)): { price: number; retiring: boolean } {
  const active = board.offers.find(entry => entry.id === offer.id);
  const retiring = Boolean(economy.snapshot.catalog.tradeRelations && active
    && board.offers.some(entry => entry.id !== active.id && entry.residentId === active.residentId));
  return { price: retiring ? 0 : board.replacementPricePearls, retiring };
}

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
  const replacement = residentOrderReplacementTerms(economy, offer, board), price = replacement.price;
  const missing = Object.entries(offer.items).some(([id, quantity]) => (state.inventory[id] ?? 0) < quantity);
  const requiredBuildings = Object.entries(offer.requiredBuildings ?? {}).filter(([id, level]) => (state.buildings[id] ?? 0) < level);
  const requiredExplorations = Object.entries(offer.requiredExplorations ?? {}).filter(([id, count]) => (state.progression?.routes[id] ?? 0) < count);
  const walletFull = state.wallet.coins > ECONOMY_MAX_BALANCE - offer.coins;
  const tutorial = isTutorialOrderId(offer.id, state.catalog);
  const stageOrder = isStageOrderId(offer.id, state.catalog);
  const weekly = offer.weekly === true;
  const permanent = tutorial || stageOrder || weekly;
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
    : weekly ? weeklyOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog).active
    : residentOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog).offers.find(order => order.id === offer.id);
  const resident = residents[offer.residentId], sale = residentOrderSaleValue(economy, offer);
  const bonus = sale === null ? 0 : offer.coins - sale;
  const currentOffer = current()?.id === offer.id;
  const hasFish = Object.keys(fishStockRequirements(offer.items, state.catalog.fishing)).length > 0;
  const expired = Boolean(weekly && offer.expiresAt && Date.parse(offer.expiresAt) <= economy.now);
  const xpRemaining = !permanent && state.catalog.tradeRelations ? tradeRelationProgress(state, offer.residentId, state.catalog, economy.now).dailyOrderXpRemaining : 0;
  const promisedXp = !tutorial && !stageOrder ? offer.reputationXp ?? 0 : 0;
  const reputationXp = weekly ? promisedXp : Math.min(promisedXp, xpRemaining);
  const difficultyEffort = weekly ? tradeRelationsState(state).weekly?.stages.reduce((sum, stage) => sum + (stage.effortSeconds ?? 0), 0)
    ?? offer.effortSeconds ?? 0 : offer.effortSeconds ?? 0;
  const difficulty = orderDifficulty(difficultyEffort, weekly);
  const submitDisabled = locked(economy) || missing || requiredBuildings.length > 0 || requiredExplorations.length > 0 || walletFull || !rewardRoom || waitSeconds > 0 || expired || !currentOffer;
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
  return <article className={styles.order} data-order-letter data-order-id={offer.id} data-resident={offer.residentId} data-tutorial-order={tutorial || undefined} data-stage-order={stageOrder || undefined} data-weekly-order={weekly || undefined} data-order-ready={orderOfferReady(state, offer, economy.now) || undefined}>
    {tutorial && <p className={styles.tutorialLabel}>Учебный заказ · знакомство</p>}
    {stageOrder && <p className={styles.tutorialLabel}>К дому {(state.buildings.home ?? 2) + 1} · {stage.step + 1} / {stageTotal}</p>}
    {weekly && <p className={styles.tutorialLabel}><CalendarDays size={12} aria-hidden="true" />Большое поручение · этап {(offer.stage ?? 0) + 1} / {offer.stages ?? 3}</p>}
    <div className={styles.letterLayout}>
      <div className={styles.letterMessage}>
        <header className={styles.heading}>
          <resident.Portrait className={styles.portrait} />
          <div className={styles.title}><span>От: {resident.name}</span><h3>{offer.name}</h3></div>
          <strong className={styles.payout} data-guide-order-reward aria-label={`Награда: ${number(offer.coins)} монет`}><ItemIcon itemId="coins" size={19} />{number(offer.coins)}</strong>
        </header>
        {orderOfferReady(state, offer, economy.now) && <p className={styles.ready}><Check size={13} aria-hidden="true" />Можно сдать</p>}
        {offer.description && <p className={styles.description}>{offer.description}</p>}
        {!tutorial && !stageOrder && <div className={styles.orderDetails}>
          {promisedXp > 0 && <p className={styles.reputationReward} data-order-reputation-reward><HeartHandshake size={13} aria-hidden="true" />{reputationXp > 0 ? <>+{number(reputationXp)} репутации{reputationXp < promisedXp && <span> · дневной остаток</span>}</> : "Репутация за обычные просьбы на сегодня получена"}</p>}
          {offer.effortSeconds !== undefined && <p className={styles.effort} data-order-preparation data-order-difficulty={difficulty}><Clock3 size={13} aria-hidden="true" />{orderDifficultyNames[difficulty]}{weekly ? " поручение · этот этап:" : " ·"} около {worldDuration(offer.effortSeconds)} работы с нуля{offer.fishingUncertain ? " · улов случаен" : ""}</p>}
        </div>}
        {weekly && offer.expiresAt && <p className={styles.deadline} data-weekly-deadline>{expired ? "Срок поручения закончился" : <>На поручение осталось <strong>{waiting(remaining(offer.expiresAt, economy.now))}</strong></>}</p>}
        {waitSeconds > 0 && <p className={styles.wait} data-stage-order-wait><Clock3 size={15} aria-hidden="true" /><span>Следующая поставка через <strong>{waiting(waitSeconds)}</strong>. Материалы можно подготовить заранее.</span></p>}
        {stageOrder && intervalSeconds > 0 && stage.step + 1 < stageTotal && <p className={styles.description}>После сдачи этой поставки до следующей пройдёт {waiting(intervalSeconds)}. Жемчуг не сокращает этот срок.</p>}
      </div>
      <div className={styles.letterContents}>
        {requiredBuildings.length > 0 && <ul className={styles.ingredients} aria-label="Условия поставки">{requiredBuildings.map(([id, level]) => <li key={id} data-missing><div><span>{state.catalog.buildings.find(building => building.id === id)?.name ?? id} · нужен ур. {level}</span>{navigation.onNavigateStation && <button type="button" onClick={() => navigation.onNavigateStation?.(id)}>К постройке</button>}</div></li>)}</ul>}
        {requiredExplorations.length > 0 && <ul className={styles.ingredients} aria-label="Нужные экспедиции">{requiredExplorations.map(([id, count]) => <li key={id} data-missing><div><span>{state.catalog.explorations.find(route => route.id === id)?.name ?? id}: забрано {number(state.progression?.routes[id] ?? 0)} / {number(count)}</span>{navigation.onNavigateExpeditions && <button type="button" onClick={() => navigation.onNavigateExpeditions?.("forest")}>В путь</button>}</div></li>)}</ul>}
        <ul className={styles.ingredients} data-guide-order-requirements aria-label="Для заказа">{Object.entries(offer.items).map(([id, quantity]) => {
          const owned = state.inventory[id] ?? 0, short = owned < quantity;
          const source = short ? materialAction(economy, id, navigation) : null;
          const accessReason = short ? worldMaterialAccessReason(state, id) : null;
          const label = <><ProductIcon state={state} itemId={id} size={23} /><span>{itemName(state, id)}{accessReason && <small className={styles.accessReason}>{accessReason}</small>}</span><strong>{number(owned)} / {number(quantity)}</strong></>;
          return <li key={id} data-missing={short || undefined}>{source ? <button type="button" aria-label={`Где получить для заказа: ${itemName(state, id)}`} onClick={source}>{label}</button> : <div>{label}</div>}</li>;
        })}</ul>
        {completionRewards.length > 0 && <div className={styles.completionReward}><p>Награда за завершение этапа</p><ul aria-label="Дополнительная награда за этап">{completionRewards.map(([id, amount]) => <li key={id}><ProductIcon state={state} itemId={id} size={21} /><span>{itemName(state, id)} × {number(amount)}</span></li>)}</ul></div>}
      </div>
    </div>
    {(offer.pearls ?? 0) > 0 && <p className={styles.premium} data-order-pearl-reward><ItemIcon itemId="pearls" size={16} />+{formatPearls(offer.pearls ?? 0)} жемчужин за этот этап</p>}
    {bonus > 0 && !permanent && <p className={styles.premium}>На {number(bonus)} монет больше продажи</p>}
    {confirmation ?? <div className={styles.actions}>
      {hasFish ? <FishOrderAction economy={economy} offer={offer} disabled={submitDisabled} onSubmit={complete} />
        : <button type="button" className={styles.primary} data-guide-order-submit disabled={submitDisabled} onClick={() => complete()}>{waitSeconds > 0 ? `Доступно через ${waiting(waitSeconds)}` : "Отдать заказ"}</button>}
      {!permanent && <button type="button" className={styles.replace} disabled={locked(economy) || !currentOffer || price > state.wallet.pearls || (price > 0 && !onReplace)}
        aria-label={`${replacement.retiring ? "Убрать прежнюю просьбу" : "Заменить заказ"}: ${offer.name}${price > 0 ? `, за ${formatPearls(price)} жемчужин` : ", бесплатно"}`} onClick={() => {
          if (locked(economy) || current()?.id !== offer.id || price > state.wallet.pearls) return;
          if (onReplace) onReplace(offer); else if (price === 0) void economy.act("replace_resident_order", offer.id, 1, 0);
        }}><RefreshCw size={14} aria-hidden="true" /><span>{replacement.retiring ? "Убрать прежнюю" : "Заменить"}</span>{price > 0 && <span className={styles.price}><ItemIcon itemId="pearls" size={16} />{formatPearls(price)}</span>}</button>}
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
  const offer = board.offers.find(entry => entry.id === quote.offerId)!;
  const price = residentOrderReplacementTerms(economy, offer, board).price;
  if (price > quote.price) return "Цена изменилась. Проверьте её ещё раз.";
  if (price > state.wallet.pearls) return `Не хватает жемчужин: ${formatPearls(price - state.wallet.pearls)}.`;
  return null;
}

export function ResidentOrderReplacement({ economy, quote, offer, headingRef, onCancel, onConfirm }: {
  economy: ReadyEconomy; quote: ResidentOrderQuote; offer: ResidentOrderOffer;
  headingRef?: RefObject<HTMLHeadingElement | null>; onCancel: () => void; onConfirm: () => void;
}) {
  const board = residentOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog);
  const price = residentOrderReplacementTerms(economy, offer, board).price, reason = residentOrderQuoteReason(economy, quote);
  return <section className={styles.confirmation} aria-label={`Подтверждение замены: ${offer.name}`}>
    <h4 ref={headingRef} tabIndex={-1}>Заменить за {formatPearls(price)} жемчужин?</h4>
    <p>Текущая просьба исчезнет. Новая появится сразу.</p>
    <p className={styles.balance}>Жемчужины: {formatPearls(economy.snapshot.wallet.pearls)} → {formatPearls(Math.max(0, economy.snapshot.wallet.pearls - price))}</p>
    {reason && <p className={styles.warning} role="status">{reason}</p>}
    <div className={styles.actions}><button type="button" className={styles.replace} onClick={onCancel}>Оставить</button><button type="button" className={styles.primary} disabled={Boolean(reason)} onClick={onConfirm} aria-label={`Подтвердить замену за ${formatPearls(price)} жемчужин`}><RefreshCw size={14} aria-hidden="true" />Заменить <ItemIcon itemId="pearls" size={16} />{formatPearls(price)}</button></div>
  </section>;
}

type Attempt = { owner: string; revision: number; offerId: string; action: "complete_resident_order" | "replace_resident_order"; coins: number; completed: number; tutorialStep: number; stageHome: number; stageStep: number; completionRewards: Record<string, number>; weekly: boolean; weeklyId: string | null; weeklyStage: number; completedWeekly: number; retiring: boolean };
export function ResidentOrderBoard({ economy, residentId, introducedResidents, tutorialOnly = false, onFilterChange, ...navigation }: OrderNavigation & { economy: ReadyEconomy; residentId?: ResidentId; introducedResidents?: readonly ResidentId[]; tutorialOnly?: boolean; onFilterChange?: (residentId?: ResidentId) => void }) {
  const [selection, setSelection] = useState<{ owner: string; filter: Filter }>({ owner: economy.snapshot.ownerPublicId, filter: residentId ?? "all" });
  const available = orderResidentIds.filter(id => tradeResidentAvailable(economy.snapshot, id, economy.snapshot.catalog)
    && (!introducedResidents || introducedResidents.includes(id)));
  const requestedFilter = selection.owner === economy.snapshot.ownerPublicId ? selection.filter : residentId ?? "all";
  const filter: Filter = requestedFilter === "all" || available.includes(requestedFilter) ? requestedFilter : "all";
  const [quote, setQuote] = useState<ResidentOrderQuote | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const latest = useRef({ economy, quote, tutorialOnly });
  useLayoutEffect(() => { latest.current = { economy, quote, tutorialOnly }; }, [economy, quote, tutorialOnly]);
  const sent = useRef(false), heading = useRef<HTMLHeadingElement>(null), container = useRef<HTMLDivElement>(null), success = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => () => { sent.current = true; }, []);
  const scrollRequest = useRef<{ owner: string } | null>(null);
  const board = residentOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog);
  const weekly = tutorialOnly ? null : weeklyOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog);
  const activeWeekly = weekly?.active && available.includes(weekly.active.residentId) ? weekly.active : null;
  const weeklyVisible = Boolean(activeWeekly && (filter === "all" || filter === activeWeekly.residentId));
  const tutorial = tutorialOrderProgress(economy.snapshot).ingredientsClaimed ? tutorialResidentOrder(economy.snapshot) : null;
  const tutorialVisible = Boolean(tutorial && (tutorialOnly || filter === "all" || filter === tutorial.residentId));
  const stage = tutorialOnly ? null : stageResidentOrder(economy.snapshot);
  const stageVisible = Boolean(stage && (filter === "all" || filter === stage.residentId));
  const permanentOffers = [tutorial, stage].filter((entry): entry is ResidentOrderOffer => Boolean(entry));
  const ordinary = board.offers.filter(offer => available.includes(offer.residentId));
  const offers = [...permanentOffers, ...(tutorialOnly ? [] : ordinary), ...(activeWeekly ? [activeWeekly] : [])];
  const config = economy.snapshot.catalog.food!.orders;
  const matching = tutorialOnly ? [] : ordinary.filter(offer => filter === "all" || offer.residentId === filter);
  const quoteOffer = tutorialOnly || !quote ? null : board.offers.find(offer => offer.id === quote.offerId);
  const confirming = Boolean(quoteOffer);
  const headingId = useId();
  const panelId = `${headingId}-panel`;
  const changeFilter = (value: Filter) => {
    const allowed = value === "all" || available.includes(value) ? value : "all";
    scrollRequest.current = { owner: economy.snapshot.ownerPublicId };
    setSelection({ owner: economy.snapshot.ownerPublicId, filter: allowed }); setQuote(null); onFilterChange?.(allowed === "all" ? undefined : allowed);
  };
  useLayoutEffect(() => {
    const request = scrollRequest.current, element = container.current;
    scrollRequest.current = null;
    if (!request || !element?.isConnected || request.owner !== economy.snapshot.ownerPublicId) return;
    // Reset only after a deliberate selection has committed its new layout.
    // The world owns the scroll area; the standalone journal may use the page.
    const view = element.ownerDocument.defaultView;
    if (!view) return;
    for (let parent = element.parentElement; parent && parent !== element.ownerDocument.body; parent = parent.parentElement) {
      if (!/auto|scroll/.test(view.getComputedStyle(parent).overflowY)) continue;
      const top = parent.scrollTop + element.getBoundingClientRect().top - parent.getBoundingClientRect().top - parent.clientTop;
      parent.scrollTo({ top: Math.max(0, top), behavior: "instant" });
      return;
    }
    view.scrollTo({ top: Math.max(0, view.scrollY + element.getBoundingClientRect().top), behavior: "instant" });
  }, [selection, filter, economy.snapshot.ownerPublicId]);
  useEffect(() => { onFilterChange?.(filter === "all" ? undefined : filter); }, [filter, onFilterChange]);
  useEffect(() => {
    if (confirming) heading.current?.focus({ preventScroll: true });
  }, [confirming]);
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) sent.current = false;
  }, [economy.busy, economy.uncertain, economy.error, economy.snapshot.ownerPublicId, economy.snapshot.revision]);

  const send = (offer: BoardOrderOffer, action: Attempt["action"], price: number, selection?: FishSelection): boolean => {
    const current = latest.current.economy;
    if (sent.current || locked(current)) return false;
    if (latest.current.tutorialOnly && (!isTutorialOrderId(offer.id, current.snapshot.catalog) || action !== "complete_resident_order")) return false;
    if (offer.weekly && action !== "complete_resident_order") return false;
    const currentBoard = residentOrderBoard(current.snapshot, current.now, current.snapshot.catalog);
    const active: BoardOrderOffer | null | undefined = isTutorialOrderId(offer.id, current.snapshot.catalog) && action === "complete_resident_order" && tutorialOrderProgress(current.snapshot).ingredientsClaimed
      ? tutorialResidentOrder(current.snapshot) : isStageOrderId(offer.id, current.snapshot.catalog) && action === "complete_resident_order"
        ? stageResidentOrder(current.snapshot) : offer.weekly ? weeklyOrderBoard(current.snapshot, current.now, current.snapshot.catalog).active : currentBoard.offers.find(entry => entry.id === offer.id);
    if (!active || active.id !== offer.id || current.snapshot.ownerPublicId !== economy.snapshot.ownerPublicId) return false;
    if (action === "complete_resident_order" && (Object.entries(active.items).some(([id, count]) => (current.snapshot.inventory[id] ?? 0) < count)
      || current.snapshot.wallet.coins > ECONOMY_MAX_BALANCE - active.coins || Date.parse(active.availableAt) > current.now
      || active.expiresAt && Date.parse(active.expiresAt) <= current.now)) return false;
    if (action === "complete_resident_order" && selection && !fishSelectionMatches(current.snapshot, active.items, selection)) return false;
    const rewardUnits = Object.values(active.completionRewards ?? {}).reduce((total, count) => total + count, 0);
    const consumed = Object.values(active.items).reduce((total, count) => total + count, 0);
    if (action === "complete_resident_order" && rewardUnits > 0
      && current.snapshot.storage.used + current.snapshot.storage.reserved - consumed + rewardUnits > current.snapshot.storage.capacity) return false;
    const replacement = residentOrderReplacementTerms(current, active, currentBoard);
    if (action === "replace_resident_order" && (replacement.price > price || replacement.price > current.snapshot.wallet.pearls)) return false;
    sent.current = true;
    const relations = tradeRelationsState(current.snapshot);
    setAttempt({ owner: current.snapshot.ownerPublicId, revision: current.snapshot.revision, offerId: active.id, action, coins: active.coins, completed: currentBoard.completed,
      tutorialStep: tutorialOrderProgress(current.snapshot).step, stageHome: current.snapshot.buildings.home ?? 1, stageStep: stageOrderProgress(current.snapshot).step,
      completionRewards: { ...active.completionRewards }, weekly: active.weekly === true, weeklyId: relations.weekly?.id ?? null,
      weeklyStage: relations.weekly?.stage ?? 0, completedWeekly: relations.completedWeekly, retiring: action === "replace_resident_order" && replacement.retiring });
    const accepted = selection ? current.act(action, active.id, 1, price, selection) : current.act(action, active.id, 1, price);
    if (accepted === false) { sent.current = false; setAttempt(null); return false; }
    return true;
  };
  const replace = (offer: ResidentOrderOffer) => {
    const current = latest.current.economy;
    if (latest.current.tutorialOnly || locked(current) || sent.current) return;
    const fresh = residentOrderBoard(current.snapshot, current.now, current.snapshot.catalog);
    const active = fresh.offers.find(entry => entry.id === offer.id);
    if (!active) return;
    const price = residentOrderReplacementTerms(current, active, fresh).price;
    if (price > current.snapshot.wallet.pearls) return;
    if (price === 0) send(active, "replace_resident_order", 0);
    else {
      setAttempt(null);
      setQuote({ owner: current.snapshot.ownerPublicId, revision: current.snapshot.revision, offerId: offer.id, price });
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
      : attempt.weekly ? tradeRelationsState(economy.snapshot).completedWeekly > attempt.completedWeekly
        || tradeRelationsState(economy.snapshot).weekly?.id === attempt.weeklyId && (tradeRelationsState(economy.snapshot).weekly?.stage ?? 0) > attempt.weeklyStage
      : !board.offers.some(offer => offer.id === attempt.offerId)
        && (attempt.action !== "complete_resident_order" || board.completed > attempt.completed));
  useEffect(() => { if (confirmed) success.current?.focus({ preventScroll: true }); }, [confirmed]);
  const acceptedStage = attempt ? stageOrderProgress(economy.snapshot, attempt.stageHome) : null;
  const nextStageWait = acceptedStage?.availableAt ? remaining(acceptedStage.availableAt, economy.now) : 0;
  return <div className={`${styles.board} ${theme.root}`} data-order-customer={filter} ref={container}>
    {!tutorialOnly && <OrderResidentTabs selected={filter} available={available} panelId={panelId}
      counts={{ all: offers.length, ...Object.fromEntries(orderResidentIds.map(id => [id, offers.filter(offer => offer.residentId === id).length])) }} onSelect={changeFilter} />}
    <div className={styles.content} role={tutorialOnly ? undefined : "tabpanel"} id={panelId} aria-labelledby={tutorialOnly ? undefined : `${panelId}-tab-${filter}`}>
    {!tutorialOnly && filter !== "all" && economy.snapshot.catalog.tradeRelations && <OrderResidentRelations residentId={filter} reputation={orderReputationPresentation(economy.snapshot, filter, economy.now)} />}
    {confirmed && <p className={styles.success} role="status" ref={success} tabIndex={-1}><Check size={15} aria-hidden="true" /><span>{isTutorialOrderId(attempt.offerId, economy.snapshot.catalog) ? `Учебный заказ выполнен · +${number(attempt.coins)} монет. ${tutorialOnly ? "Продолжай обучение, к остальным просьбам можно вернуться позже." : "Теперь можно выполнять просьбы для улучшения дома."}`
      : isStageOrderId(attempt.offerId, economy.snapshot.catalog) ? `Заказ этапа выполнен · +${number(attempt.coins)} монет. ${acceptedStage?.completed ? "Все просьбы этого этапа выполнены." : nextStageWait > 0 ? `Следующая поставка через ${waiting(nextStageWait)}.` : "Следующая просьба уже на доске."}${Object.entries(attempt.completionRewards).map(([id, count]) => ` Получено: ${itemName(economy.snapshot, id)} × ${number(count)}.`).join("")}`
      : attempt.weekly ? `Этап большого поручения выполнен · +${number(attempt.coins)} монет. ${tradeRelationsState(economy.snapshot).completedWeekly > attempt.completedWeekly ? "Поручение завершено. Репутация и награды сохранены." : "Следующий этап уже открыт."}`
      : attempt.action === "complete_resident_order" ? `Заказ выполнен · +${number(attempt.coins)} монет. Новая просьба уже на доске.` : attempt.retiring ? "Прежняя просьба убрана бесплатно. Остальные заказы этого жителя остаются на доске." : "Заказ заменён. Новая просьба уже на доске."}</span><button type="button" aria-label="Скрыть результат заказа" onClick={() => setAttempt(null)}><X size={14} aria-hidden="true" /></button></p>}
    {(tutorialVisible || stageVisible) && <section className={styles.chapter} data-order-chapter="progression" aria-labelledby={`${headingId}-progression`}>
      <header className={styles.chapterHeading}><span className={styles.chapterNumber} aria-hidden="true">I</span><div><h3 id={`${headingId}-progression`}>Путь хозяйства</h3></div></header>
      <div className={styles.permanentCards}>
        {tutorialVisible && tutorial && <ResidentOrderCard economy={economy} offer={tutorial} {...navigation} onComplete={(entry, selection) => send(entry, "complete_resident_order", 0, selection)} />}
        {stageVisible && stage && <ResidentOrderCard economy={economy} offer={stage} {...navigation} onComplete={(entry, selection) => send(entry, "complete_resident_order", 0, selection)} />}
      </div>
    </section>}
    {!tutorialOnly && <section className={styles.chapter} data-order-chapter="repeatable" aria-labelledby={headingId}>
      <header className={styles.chapterHeading}><span className={styles.chapterNumber} aria-hidden="true">{tutorialVisible || stageVisible ? "II" : "I"}</span><div><h3 id={headingId}>Просьбы жителей</h3></div><span className={styles.chapterCount}>{matching.length}</span></header>
      <div className={styles.boardSummary}><p><Clock3 size={13} aria-hidden="true" />Обновление через <strong>{waiting(remaining(board.refreshAt, economy.now))}</strong></p><p>Бесплатных замен: <strong>{board.freeReplacementsRemaining} / {config.freeReplacements}</strong></p></div>
      {board.replacementPricePearls > economy.snapshot.wallet.pearls && <p className={styles.warning}>На замену не хватает {formatPearls(board.replacementPricePearls - economy.snapshot.wallet.pearls)} жемчужин.</p>}
      <div className={styles.orders}>{matching.map(offer => <ResidentOrderCard key={offer.id} economy={economy} offer={offer} {...navigation} onComplete={(entry, selection) => send(entry, "complete_resident_order", 0, selection)} onReplace={replace}
        confirmation={quoteOffer?.id === offer.id && quote ? <ResidentOrderReplacement economy={economy} quote={quote} offer={offer} headingRef={heading} onCancel={cancel} onConfirm={confirm} /> : undefined} />)}</div>
      {!matching.length && <p className={styles.repeatableEmpty}>У этого жителя пока нет новых просьб.</p>}
    </section>}
    {!tutorialOnly && economy.snapshot.catalog.tradeRelations && <section className={styles.chapter} data-order-chapter="weekly" aria-labelledby={`${headingId}-weekly`}>
      <header className={styles.chapterHeading}><span className={styles.chapterNumber} aria-hidden="true"><CalendarDays size={15} /></span><div><h3 id={`${headingId}-weekly`}>Большое поручение</h3><p>Три этапа · семь дней · больше репутации</p></div></header>
      {weeklyVisible && activeWeekly && <><p className={styles.weeklyTitle}>{weekly?.progress?.name}</p><ResidentOrderCard economy={economy} offer={activeWeekly} {...navigation} onComplete={(entry, selection) => send(entry, "complete_resident_order", 0, selection)} /></>}
      {activeWeekly && !weeklyVisible && <p className={styles.weeklyElsewhere}>Ты уже помогаешь {residents[activeWeekly.residentId].dative}.<button type="button" onClick={() => changeFilter(activeWeekly.residentId)}>Посмотреть поручение</button></p>}
      {weekly?.active && !activeWeekly && <p className={styles.repeatableEmpty}>Поручение появится здесь после знакомства с жителем.</p>}
      {!weekly?.active && <OrderWeeklyChooser economy={economy} customer={filter} available={available} />}
    </section>}
    {tutorialOnly && !tutorial && !confirmed && <p className={styles.empty} role="status" data-order-tutorial-result>{tutorialOrderProgress(economy.snapshot).completed ? "Учебный заказ выполнен. Продолжай обучение, к остальным просьбам можно вернуться позже." : "Здесь появится учебный заказ. Продолжай по подсказке."}</p>}
    {!tutorialOnly && !matching.length && !tutorialVisible && !stageVisible && <p className={styles.empty}><ClipboardList size={20} aria-hidden="true" />{offers.length ? "Сейчас просьб от этого жителя нет. Посмотрите все заказы." : "Просьбы жителей пока недоступны."}{offers.length > 0 && <button type="button" onClick={() => changeFilter("all")}>Все заказы</button>}</p>}
    </div>
  </div>;
}
