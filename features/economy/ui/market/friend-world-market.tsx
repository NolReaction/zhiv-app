"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { ArrowLeft, Check, LockKeyhole, Package, RefreshCw, ShoppingBasket, Store, X } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { GuestWorld } from "@/features/people/guest-world-model";
import type { EconomyMarketListing } from "@/features/economy/domain/model";
import { economyMarketUnlocked, marketListingEligible, marketMinimumPrice } from "@/features/economy/domain/market-rules";
import { locked } from "@/features/economy/sync/controller-state";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import styles from "./friend-world-market.module.css";

const number = (amount: number) => amount.toLocaleString("ru-RU");
const itemName = (economy: EconomyController, id: string) => economy.snapshot?.catalog.items.find(item => item.id === id)?.name ?? "Товар";
const gateReason = (visit: GuestWorld) => visit.market.reason === "buyer_locked" ? "Сначала откройте рынок в своём мире."
  : visit.market.reason === "seller_locked" ? "Хозяин ещё не открыл свой рынок."
    : visit.market.reason === "home_band" ? "Торговля доступна между домами 2-3 или 4-5 уровней." : null;

export type FriendMarketQuote = {
  buyer: string; revision: number; circleId: string; seller: string;
  listingId: string; itemId: string; quantity: number; totalPrice: number; expiresAt: number;
};

/** Check the accepted state again at the final press; a displayed quote never authorizes a different lot. */
export function friendMarketQuoteReason(economy: EconomyController, visit: GuestWorld, quote: FriendMarketQuote, now = economy.now): string | null {
  const state = economy.snapshot;
  if (!state || economy.snapshotConfirmed === false) return "Проверяем ваши запасы.";
  if (economy.uncertain) return "Проверяем предыдущую покупку. Не оформляйте её заново.";
  if (locked(economy)) return economy.directActionsAvailable === false ? "Покупки доступны после подключения к игре." : "Дождитесь подтверждения действия.";
  if (state.ownerPublicId !== quote.buyer || state.revision !== quote.revision || visit.ownerPublicId !== quote.buyer
    || visit.circleId !== quote.circleId || visit.user.publicId !== quote.seller)
    return "Данные обновились. Выберите товар ещё раз.";
  if (!visit.market.available || !economyMarketUnlocked(state, state.catalog)) return gateReason(visit) ?? "Сначала откройте рынок в своём мире.";
  if (now >= quote.expiresAt) return "Подтверждение устарело. Вернитесь и проверьте товар ещё раз.";
  const listing = visit.market.listings.find(item => item.id === quote.listingId);
  if (!listing || listing.status !== "active" || listing.owned || listing.sellerPublicId !== quote.seller
    || listing.sellerPublicId === quote.buyer || listing.itemId !== quote.itemId
    || listing.quantity !== quote.quantity || listing.totalPrice !== quote.totalPrice)
    return "Лот изменился или уже продан. Обновите лавку.";
  if (!marketListingEligible(listing, state, state.catalog)) return "Этот товар пока недоступен вам.";
  if (state.storage.available < listing.quantity) return `Нужно ${number(listing.quantity)} мест в кладовой, свободно ${number(state.storage.available)}.`;
  if (state.wallet.coins < listing.totalPrice) return `Не хватает ${number(listing.totalPrice - state.wallet.coins)} монет.`;
  const budget = economy.market?.ownerPublicId === quote.buyer ? economy.market.tradeBudget : null;
  if (budget && now < Date.parse(budget.resetsAt) && budget.buysUsed + marketMinimumPrice(listing.itemId, listing.quantity, state.catalog) > budget.limit)
    return "Дневной объём покупок исчерпан. Приходите завтра.";
  return null;
}

type Props = { open: boolean; visit: GuestWorld; economy: EconomyController; onClose: () => void; onRefresh: () => void; refreshing?: boolean; onReturnFocus?: () => void };

export function FriendWorldMarket({ open, visit, economy, onClose, onRefresh, refreshing = false, onReturnFocus }: Props) {
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className={styles.overlay} />
      <Dialog.Content className={styles.dialog} onEscapeKeyDown={event => event.stopPropagation()}
        onCloseAutoFocus={event => { if (onReturnFocus) { event.preventDefault(); onReturnFocus(); } }}
        onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
        <FriendMarketContents key={`${visit.ownerPublicId}:${visit.circleId}`} visit={visit} economy={economy} onRefresh={onRefresh} refreshing={refreshing} />
        <Dialog.Close className={styles.close} aria-label="Закрыть лавку"><X size={20} aria-hidden="true" /></Dialog.Close>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

function FriendMarketContents({ visit, economy, onRefresh, refreshing }: Omit<Props, "open" | "onClose" | "onReturnFocus">) {
  const [selectedQuote, setQuote] = useState<FriendMarketQuote | null>(null);
  const [message, setMessage] = useState("");
  const [localError, setLocalError] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const accepted = Boolean(selectedQuote && submitted && !economy.busy && !economy.uncertain && !economy.syncPending && !economy.error && economy.notice
    && economy.snapshot?.ownerPublicId === selectedQuote.buyer && economy.snapshot.revision > selectedQuote.revision);
  const quote = accepted ? null : selectedQuote;
  const settled = submitted && !economy.busy && !economy.uncertain && !economy.syncPending && (Boolean(economy.error) || accepted);
  // Consume this confirmed view once, so a later background sync cannot restore its old confirmation.
  if (accepted) { setQuote(null); setSubmitted(false); setMessage(economy.notice); }
  const sent = useRef<FriendMarketQuote | null>(null), handled = useRef<FriendMarketQuote | null>(null);
  const latest = useRef({ economy, visit, quote, refreshing, readAt: 0 });
  useLayoutEffect(() => { latest.current = { economy, visit, quote, refreshing, readAt: performance.now() }; }, [economy, visit, quote, refreshing]);
  const heading = useRef<HTMLHeadingElement>(null), triggerId = useRef<string | null>(null), list = useRef<HTMLDivElement>(null);
  const wasConfirming = useRef(false), reasonId = useId();
  useEffect(() => {
    if (quote) heading.current?.focus({ preventScroll: true });
    else if (wasConfirming.current && triggerId.current) list.current?.querySelector<HTMLButtonElement>(`[data-lot="${triggerId.current}"]`)?.focus({ preventScroll: true });
    wasConfirming.current = Boolean(quote);
  }, [quote]);
  useEffect(() => {
    const purchase = sent.current;
    if (!purchase || handled.current === purchase || economy.busy || economy.uncertain || economy.syncPending) return;
    if (economy.error) { handled.current = purchase; sent.current = null; onRefresh(); return; }
    if (economy.snapshot?.ownerPublicId === purchase.buyer && economy.snapshot.revision > purchase.revision && economy.notice) {
      handled.current = purchase;
      sent.current = null;
      onRefresh();
    }
  }, [economy.busy, economy.uncertain, economy.syncPending, economy.error, economy.notice, economy.snapshot, onRefresh]);

  const state = economy.snapshot;
  const createQuote = (listing: EconomyMarketListing): FriendMarketQuote | null => state ? {
    buyer: state.ownerPublicId, revision: state.revision, circleId: visit.circleId, seller: visit.user.publicId,
    listingId: listing.id, itemId: listing.itemId, quantity: listing.quantity, totalPrice: listing.totalPrice, expiresAt: economy.now + 60_000,
  } : null;
  const reason = quote ? friendMarketQuoteReason(economy, visit, quote) : null;
  const pending = submitted && (economy.busy || economy.uncertain || economy.syncPending);
  const retryReady = !economy.busy && economy.directActionsAvailable !== false && economy.now >= economy.retryAt;
  const confirm = () => {
    const current = latest.current;
    if (!quote || current.quote !== quote || sent.current || current.refreshing
      || friendMarketQuoteReason(current.economy, current.visit, quote, current.economy.now + Math.max(0, performance.now() - current.readAt))) return;
    sent.current = quote;
    setLocalError("");
    if (!current.economy.actFriendMarket(quote.circleId, quote.listingId, quote.quantity, quote.totalPrice)) {
      sent.current = null;
      setLocalError("Покупка не отправлена. Дождитесь подключения и попробуйте ещё раз.");
    } else setSubmitted(true);
  };

  return <>
    <header className={styles.header}>
      <span className={styles.shopIcon}><Store size={24} aria-hidden="true" /></span>
      <div><span className={styles.eyebrow}>В гостях</span><Dialog.Title className={styles.title}>Лавка {visit.user.displayName}</Dialog.Title></div>
    </header>
    <Dialog.Description className={styles.description}>Товары хозяина. Покупка целиком отправится в вашу кладовую.</Dialog.Description>
    <div className={styles.wallet} aria-label="Ваши запасы"><span><ItemIcon itemId="coins" size={20} /><strong>{state ? number(state.wallet.coins) : "…"}</strong><small>ваши монеты</small></span><span><Package size={17} aria-hidden="true" /><strong>{state ? number(state.storage.available) : "…"}</strong><small>свободно</small></span></div>
    <div className={styles.body}>
      {economy.uncertain ? <div className={styles.feedback} role="status"><strong>Проверяем последнее действие</strong><p>{economy.error ?? "Ответ ещё не пришёл. Повторная проверка не спишет монеты дважды."}</p><button type="button" disabled={!retryReady} onClick={() => void latest.current.economy.retry()}>Проверить результат</button></div>
        : economy.error || localError ? <p className={styles.error} role="alert">{economy.error || localError}</p>
          : message || accepted ? <p className={styles.success} role="status"><Check size={17} aria-hidden="true" />{message || economy.notice}</p> : null}
      {quote ? <section className={styles.confirmation} aria-labelledby={`${reasonId}-heading`}>
        <h3 id={`${reasonId}-heading`} ref={heading} tabIndex={-1}>Купить весь лот?</h3>
        <span className={styles.productIcon}><ItemIcon itemId={quote.itemId} size={54} /></span>
        <strong className={styles.productName}>{itemName(economy, quote.itemId)}</strong>
        <p>{number(quote.quantity)} шт. в вашу кладовую</p>
        <p className={styles.total}><ItemIcon itemId="coins" size={21} /><strong>{number(quote.totalPrice)}</strong><span>за всё</span></p>
        {state && <p className={styles.balance}>Ваши монеты: {number(state.wallet.coins)} → {number(Math.max(0, state.wallet.coins - quote.totalPrice))}</p>}
        {reason && <p className={styles.reason} id={reasonId} role="status">{reason}</p>}
        <div className={styles.actions}><button type="button" onClick={() => setQuote(null)}><ArrowLeft size={16} aria-hidden="true" />Назад</button><button type="button" className={styles.primary} disabled={Boolean(reason) || refreshing || submitted && !settled} aria-describedby={reason ? reasonId : undefined} aria-label={`Подтвердить покупку: ${itemName(economy, quote.itemId)}, ${quote.quantity} шт. за ${number(quote.totalPrice)} монет`} onClick={confirm}>{pending ? "Проверяем…" : "Купить"}</button></div>
      </section> : <>
        {!visit.market.available && <p className={styles.reason}><LockKeyhole size={17} aria-hidden="true" />{gateReason(visit)}</p>}
        {visit.market.listings.length ? <div className={styles.grid} ref={list} role="list" aria-label="Товары хозяина">{visit.market.listings.map(listing => {
          const candidate = createQuote(listing), blocked = candidate ? friendMarketQuoteReason(economy, visit, candidate) : "Проверяем ваши запасы.";
          return <article className={styles.card} key={listing.id} role="listitem">
            <span className={styles.productIcon}><ItemIcon itemId={listing.itemId} size={40} /><b>×{number(listing.quantity)}</b></span>
            <h3>{itemName(economy, listing.itemId)}</h3><p className={styles.price}><ItemIcon itemId="coins" size={17} /><strong>{number(listing.totalPrice)}</strong><small>за всё</small></p>
            <button type="button" data-lot={listing.id} disabled={Boolean(blocked) || refreshing} aria-describedby={blocked ? `${reasonId}-${listing.id}` : undefined}
              aria-label={`Выбрать: ${itemName(economy, listing.itemId)}, ${listing.quantity} шт. за ${number(listing.totalPrice)} монет`}
              onClick={() => {
                const current = latest.current, fresh = current.visit.market.listings.find(item => item.id === listing.id), snapshot = current.economy.snapshot;
                if (!fresh || !snapshot || current.refreshing || sent.current) return;
                const selected = { buyer: snapshot.ownerPublicId, revision: snapshot.revision, circleId: current.visit.circleId, seller: current.visit.user.publicId,
                  listingId: fresh.id, itemId: fresh.itemId, quantity: fresh.quantity, totalPrice: fresh.totalPrice, expiresAt: current.economy.now + 60_000 };
                if (!friendMarketQuoteReason(current.economy, current.visit, selected)) { triggerId.current = fresh.id; setLocalError(""); setMessage(""); setSubmitted(false); setQuote(selected); }
              }}>Выбрать</button>
            {blocked && <p className={styles.cardReason} id={`${reasonId}-${listing.id}`}>{blocked}</p>}
          </article>;
        })}</div> : <div className={styles.empty}><ShoppingBasket size={36} aria-hidden="true" /><h3>Прилавок пока пуст</h3><p>Здесь появятся товары, которые хозяин выставит на продажу.</p></div>}
      </>}
    </div>
    <footer className={styles.footer}><span>{visit.market.listings.length} / 10 лотов</span><button type="button" disabled={refreshing || economy.busy} onClick={() => latest.current.refreshing || onRefresh()}><RefreshCw size={15} aria-hidden="true" />{refreshing ? "Обновляем…" : "Обновить лавку"}</button></footer>
  </>;
}
