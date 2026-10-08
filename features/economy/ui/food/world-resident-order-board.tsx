"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Check, ClipboardList, Clock3, RefreshCw, X } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { BuilderPortrait } from "@/features/world/characters/builder/builder-portrait";
import { PleskPortrait } from "@/features/world/characters/plesk/plesk-portrait";
import { residentOrderBoard, type ResidentOrderOffer } from "@/features/economy/domain/food";
import { economyLocalSellPrice } from "@/features/economy/domain/local-sale";
import { ECONOMY_MAX_BALANCE, formatPearls } from "@/features/economy/domain/money";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { itemName, number, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration, worldMaterialSource } from "@/features/economy/ui/shared/world-stations";
import styles from "./world-resident-order-board.module.css";

type ResidentId = ResidentOrderOffer["residentId"];
type Filter = "all" | ResidentId;
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
    total += catalog.fishing?.fish.some(fish => fish.itemId === id) ? item.baseSellPrice * quantity
      : economyLocalSellPrice(item.baseSellPrice, quantity, catalog.localBuyer);
  }
  return total;
}

function materialAction(economy: ReadyEconomy, itemId: string, navigation: OrderNavigation): (() => void) | null {
  const state = economy.snapshot;
  if (state.catalog.fishing?.fish.some(fish => fish.itemId === itemId)) {
    return navigation.onNavigateExpeditions ? () => navigation.onNavigateExpeditions?.("shore") : null;
  }
  const source = worldMaterialSource(state, itemId);
  if (source?.kind === "production" && navigation.onNavigateStation) return () => navigation.onNavigateStation?.(source.stationId, source.targetId);
  if (source?.kind === "exploration" && navigation.onNavigateExpeditions) {
    const sector = /shore|coastal/.test(source.targetId) ? "shore" : /cave|quarry/.test(source.targetId) ? "caves" : "forest";
    return () => navigation.onNavigateExpeditions?.(sector);
  }
  return null;
}

export function ResidentOrderCard({ economy, offer, onComplete, onReplace, confirmation, ...navigation }: OrderNavigation & {
  economy: ReadyEconomy;
  offer: ResidentOrderOffer;
  onComplete?: (offer: ResidentOrderOffer) => void;
  onReplace?: (offer: ResidentOrderOffer) => void;
  confirmation?: ReactNode;
}) {
  const state = economy.snapshot, board = residentOrderBoard(state, economy.now, state.catalog);
  const price = board.replacementPricePearls;
  const missing = Object.entries(offer.items).some(([id, quantity]) => (state.inventory[id] ?? 0) < quantity);
  const walletFull = state.wallet.coins > ECONOMY_MAX_BALANCE - offer.coins;
  const current = () => residentOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog).offers.some(order => order.id === offer.id);
  const resident = residents[offer.residentId], sale = residentOrderSaleValue(economy, offer);
  const bonus = sale === null ? 0 : offer.coins - sale;
  const currentOffer = current();
  return <article className={styles.order} data-order-id={offer.id} data-resident={offer.residentId}>
    <header className={styles.heading}>
      <resident.Portrait className={styles.portrait} />
      <div className={styles.title}><span>{resident.name}</span><h3>{offer.name}</h3></div>
      <strong className={styles.payout} aria-label={`Награда: ${number(offer.coins)} монет`}><ItemIcon itemId="coins" size={19} />{number(offer.coins)}</strong>
    </header>
    {offer.description && <p className={styles.description}>{offer.description}</p>}
    <ul className={styles.ingredients} aria-label="Для заказа">{Object.entries(offer.items).map(([id, quantity]) => {
      const owned = state.inventory[id] ?? 0, short = owned < quantity;
      const source = short ? materialAction(economy, id, navigation) : null;
      const label = <><ProductIcon state={state} itemId={id} size={23} /><span>{itemName(state, id)}</span><strong>{number(owned)} / {number(quantity)}</strong></>;
      return <li key={id} data-missing={short || undefined}>{source ? <button type="button" aria-label={`Где получить для заказа: ${itemName(state, id)}`} onClick={source}>{label}</button> : <div>{label}</div>}</li>;
    })}</ul>
    {bonus > 0 && <p className={styles.premium} title="Рыба — продажа Плёске, другие товары — местному скупщику.">На {number(bonus)} монет больше продажи</p>}
    {confirmation ?? <div className={styles.actions}>
      <button type="button" className={styles.primary} disabled={locked(economy) || missing || walletFull || !currentOffer} onClick={() => {
        if (locked(economy) || missing || walletFull || !current()) return;
        if (onComplete) onComplete(offer); else void economy.act("complete_resident_order", offer.id, 1, 0);
      }}>Отдать заказ</button>
      <button type="button" className={styles.replace} disabled={locked(economy) || !currentOffer || price > state.wallet.pearls || (price > 0 && !onReplace)}
        aria-label={`Заменить заказ: ${offer.name}${price > 0 ? `, за ${formatPearls(price)} жемчужин` : ", бесплатно"}`} onClick={() => {
          if (locked(economy) || !current() || price > state.wallet.pearls) return;
          if (onReplace) onReplace(offer); else if (price === 0) void economy.act("replace_resident_order", offer.id, 1, 0);
        }}><RefreshCw size={14} aria-hidden="true" /><span>Заменить</span>{price > 0 && <span className={styles.price}><ItemIcon itemId="pearls" size={16} />{formatPearls(price)}</span>}</button>
    </div>}
    {walletFull && <p className={styles.warning}>В кошельке нет места для награды.</p>}
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

type Attempt = { owner: string; revision: number; offerId: string; action: "complete_resident_order" | "replace_resident_order"; coins: number; completed: number };
export function ResidentOrderBoard({ economy, residentId, ...navigation }: OrderNavigation & { economy: ReadyEconomy; residentId?: ResidentId }) {
  const [filter, setFilter] = useState<Filter>(residentId ?? "all");
  const [quote, setQuote] = useState<ResidentOrderQuote | null>(null);
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const latest = useRef({ economy, quote });
  useLayoutEffect(() => { latest.current = { economy, quote }; }, [economy, quote]);
  const sent = useRef(false), heading = useRef<HTMLHeadingElement>(null), container = useRef<HTMLDivElement>(null), success = useRef<HTMLParagraphElement>(null);
  const board = residentOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog);
  const config = economy.snapshot.catalog.food!.orders;
  const matching = board.offers.filter(offer => filter === "all" || offer.residentId === filter);
  const quoteOffer = quote && board.offers.find(offer => offer.id === quote.offerId);
  const confirming = Boolean(quoteOffer);
  const headingId = useId();
  useEffect(() => {
    if (confirming) heading.current?.focus({ preventScroll: true });
  }, [confirming]);
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) sent.current = false;
  }, [economy.busy, economy.uncertain, economy.error, economy.snapshot.ownerPublicId, economy.snapshot.revision]);

  const send = (offer: ResidentOrderOffer, action: Attempt["action"], price: number) => {
    const current = latest.current.economy;
    if (sent.current || locked(current)) return;
    const currentBoard = residentOrderBoard(current.snapshot, current.now, current.snapshot.catalog);
    const active = currentBoard.offers.find(entry => entry.id === offer.id);
    if (!active || current.snapshot.ownerPublicId !== economy.snapshot.ownerPublicId) return;
    if (action === "complete_resident_order" && (Object.entries(active.items).some(([id, count]) => (current.snapshot.inventory[id] ?? 0) < count)
      || current.snapshot.wallet.coins > ECONOMY_MAX_BALANCE - active.coins)) return;
    if (action === "replace_resident_order" && (currentBoard.replacementPricePearls > price || currentBoard.replacementPricePearls > current.snapshot.wallet.pearls)) return;
    sent.current = true;
    setAttempt({ owner: current.snapshot.ownerPublicId, revision: current.snapshot.revision, offerId: active.id, action, coins: active.coins, completed: currentBoard.completed });
    void current.act(action, active.id, 1, price);
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
    && !board.offers.some(offer => offer.id === attempt.offerId)
    && (attempt.action !== "complete_resident_order" || board.completed > attempt.completed);
  useEffect(() => { if (confirmed) success.current?.focus({ preventScroll: true }); }, [confirmed]);
  return <div className={styles.board} ref={container}>
    <div className={styles.boardSummary}><p><Clock3 size={13} aria-hidden="true" />Обновление через <strong>{waiting(remaining(board.refreshAt, economy.now))}</strong></p><p>Бесплатных замен: <strong>{board.freeReplacementsRemaining} / {config.freeReplacements}</strong></p></div>
    {board.replacementPricePearls > economy.snapshot.wallet.pearls && <p className={styles.warning}>На замену не хватает {formatPearls(board.replacementPricePearls - economy.snapshot.wallet.pearls)} жемчужин.</p>}
    <div className={styles.filters} role="group" aria-label="Заказчик">{(["all", "plesk", "builder"] as const).map(value => <button key={value} type="button" aria-pressed={filter === value} onClick={() => { setFilter(value); setQuote(null); }}>{value === "all" ? "Все" : residents[value].name}<span>{value === "all" ? board.offers.length : board.offers.filter(offer => offer.residentId === value).length}</span></button>)}</div>
    <p className={styles.lore}>{filter === "all" ? "Просьбы жителей за монеты. Угощения — во вкладке «Еда»." : residents[filter].role}</p>
    {confirmed && <p className={styles.success} role="status" ref={success} tabIndex={-1}><Check size={15} aria-hidden="true" /><span>{attempt.action === "complete_resident_order" ? `Заказ выполнен · +${number(attempt.coins)} монет. Новая просьба уже на доске.` : "Заказ заменён. Новая просьба уже на доске."}</span><button type="button" aria-label="Скрыть результат заказа" onClick={() => setAttempt(null)}><X size={14} aria-hidden="true" /></button></p>}
    <section className={styles.orders} aria-labelledby={headingId}><h3 id={headingId} className={styles.srOnly}>Текущие заказы</h3>{matching.map(offer => <ResidentOrderCard key={offer.id} economy={economy} offer={offer} {...navigation} onComplete={entry => send(entry, "complete_resident_order", 0)} onReplace={replace}
      confirmation={quoteOffer?.id === offer.id && quote ? <ResidentOrderReplacement economy={economy} quote={quote} offer={offer} headingRef={heading} onCancel={cancel} onConfirm={confirm} /> : undefined} />)}</section>
    {!matching.length && <p className={styles.empty}><ClipboardList size={20} aria-hidden="true" />{board.offers.length ? "Сейчас просьб от этого жителя нет. Посмотрите все заказы." : "Просьбы жителей пока недоступны."}{board.offers.length > 0 && <button type="button" onClick={() => setFilter("all")}>Все заказы</button>}</p>}
    <p className={styles.footnote}>После сдачи новый заказ появится сразу. Ещё {board.freeReplacementsRemaining} замен бесплатно, затем {formatPearls(config.replacementPricePearls)} жемчужин за замену. Бесплатные замены восстановятся через {waiting(remaining(board.replacementsResetAt, economy.now))}.</p>
  </div>;
}
