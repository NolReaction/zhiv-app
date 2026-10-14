"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Plus, Store } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { economyMarketUnlocked, marketSlotCount, marketSlotOffer } from "@/features/economy/domain/market-rules";
import { formatPearls } from "@/features/economy/domain/money";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import styles from "./world-market-slots.module.css";

export type MarketSlotQuote = { owner: string; revision: number; slots: number; price: number };

/** Confirm the same next permanent place against the latest accepted state. */
export function marketSlotQuoteReason(economy: ReadyEconomy, quote: MarketSlotQuote): string | null {
  if (locked(economy)) return economy.uncertain ? "Проверяем последнее действие." : "Дождитесь подтверждения действия.";
  const state = economy.snapshot, offer = marketSlotOffer(state, state.catalog);
  if (state.ownerPublicId !== quote.owner || state.revision !== quote.revision || !offer || offer.slots !== quote.slots)
    return "Данные обновились. Вернитесь и выберите место ещё раз.";
  if (offer.pricePearls !== quote.price) return "Цена изменилась. Проверьте её ещё раз.";
  if (offer.pricePearls > state.wallet.pearls) return `Не хватает жемчужин: ${formatPearls(offer.pricePearls - state.wallet.pearls)}.`;
  if (!economyMarketUnlocked(state, state.catalog))
    return "Сначала откройте рынок.";
  return null;
}

/** Old listings remain visible even when there are more of them than owned places. */
export function WorldMarketSlots({ economy, used }: { economy: ReadyEconomy; used: number }) {
  const [quote, setQuote] = useState<MarketSlotQuote | null>(null);
  const sent = useRef<MarketSlotQuote | null>(null), latest = useRef({ economy, quote });
  useLayoutEffect(() => { latest.current = { economy, quote }; }, [economy, quote]);
  const trigger = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null), wasConfirming = useRef(false);
  const headingId = useId(), reasonId = useId();
  const state = economy.snapshot, capacity = marketSlotCount(state, state.catalog), offer = marketSlotOffer(state, state.catalog);
  const purchased = Boolean(quote && quote.owner === state.ownerPublicId && capacity >= quote.slots && state.revision > quote.revision);
  const confirming = Boolean(quote && !purchased);
  const nextQuote = offer ? { owner: state.ownerPublicId, revision: state.revision, slots: offer.slots, price: offer.pricePearls } : null;
  const reason = confirming && quote ? marketSlotQuoteReason(economy, quote) : nextQuote ? marketSlotQuoteReason(economy, nextQuote) : null;
  useEffect(() => {
    if (confirming) heading.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) trigger.current?.focus({ preventScroll: true });
    wasConfirming.current = confirming;
  }, [confirming]);
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) sent.current = null;
  }, [economy.busy, economy.uncertain, economy.error, state.ownerPublicId, state.revision]);

  const confirm = () => {
    const current = latest.current.economy, accepted = latest.current.quote;
    if (!quote || accepted !== quote || sent.current === quote || marketSlotQuoteReason(current, quote)) return;
    const fresh = marketSlotOffer(current.snapshot, current.snapshot.catalog);
    if (!fresh) return;
    sent.current = quote;
    void current.act("buy_market_slot", fresh.targetId, 1, fresh.pricePearls);
  };

  return <div className={styles.slots} data-market-slots={capacity}>
    <p className={styles.summary}><Store size={16} aria-hidden="true" /><strong>Ваша лавка · {used} / {capacity}</strong></p>
    <p className={styles.hint}>{state.catalog.market.baseSlots} мест бесплатно. Открытые места остаются навсегда; максимум {state.catalog.market.maxListings}.</p>
    {used >= capacity && <p className={styles.hint}>Все открытые места заняты. Продайте или снимите лот, чтобы выставить новый.</p>}
    {used > capacity && <p className={styles.hint}>Прежние лоты сохранены. Их можно продать или вернуть на склад.</p>}
    {purchased && quote && !locked(economy) && !economy.error && <p className={styles.hint} role="status">Место {quote.slots} открыто. Теперь у лавки {capacity} мест.</p>}
    {confirming && quote ? <section className={styles.confirmation} aria-labelledby={headingId}>
      <h3 ref={heading} id={headingId} tabIndex={-1}>Открыть место {quote.slots}?</h3>
      <p>Одно дополнительное место для продажи за <strong>{formatPearls(quote.price)} жемчужин</strong>.</p>
      <p>Жемчужины: {formatPearls(state.wallet.pearls)} → {formatPearls(Math.max(0, state.wallet.pearls - quote.price))}</p>
      {reason && <p className={styles.reason} id={reasonId} role="status">{reason}</p>}
      <div className={styles.actions}><button type="button" onClick={() => setQuote(null)}>Оставить как есть</button><button type="button" className={styles.buy} disabled={Boolean(reason)} aria-describedby={reason ? reasonId : undefined}
        aria-label={`Подтвердить открытие места ${quote.slots} за ${formatPearls(quote.price)} жемчужин`} onClick={confirm}>Открыть <ItemIcon itemId="pearls" size={17} />{formatPearls(quote.price)}</button></div>
    </section> : offer && <>
      <button ref={trigger} type="button" className={styles.buy} disabled={locked(economy) || Boolean(reason)} aria-describedby={reason ? reasonId : undefined}
        aria-label={`Открыть место рынка ${offer.slots} за ${formatPearls(offer.pricePearls)} жемчужин`} onClick={() => {
          const current = latest.current.economy;
          const fresh = marketSlotOffer(current.snapshot, current.snapshot.catalog);
          if (!fresh) return;
          const next = { owner: current.snapshot.ownerPublicId, revision: current.snapshot.revision, slots: fresh.slots, price: fresh.pricePearls };
          if (marketSlotQuoteReason(current, next)) return;
          setQuote(next);
        }}><Plus size={15} aria-hidden="true" />Место {offer.slots}<ItemIcon itemId="pearls" size={17} />{formatPearls(offer.pricePearls)}</button>
      {reason && <p className={styles.reason} id={reasonId}>{reason}</p>}
    </>}
  </div>;
}
