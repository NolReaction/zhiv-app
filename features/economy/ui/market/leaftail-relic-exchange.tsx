"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowRightLeft, Check, LockKeyhole } from "lucide-react";
import { leaftailRelicExchangeItems, leaftailRelicExchangeOffer } from "@/features/economy/domain/leaftail-relic-exchange";
import type { EconomyView } from "@/features/economy/domain/model";
import { locked } from "@/features/economy/sync/controller-state";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { ItemIcon } from "@/features/items/item-icon";
import styles from "./leaftail-relic-exchange.module.css";

type ExchangeQuote = { owner: string; revision: number; targetId: string; fromItemId: string; toItemId: string; quantity: number; priceCoins: number };
const number = (value: number) => value.toLocaleString("ru-RU");
const itemName = (state: EconomyView, id: string) => state.catalog.items.find(item => item.id === id)?.name ?? id;
const successMessage = "Реликвии обменены. Находка отправлена в кладовую";

export function leaftailRelicExchangeQuote(state: EconomyView, fromItemId: string, toItemId: string): ExchangeQuote | null {
  const offer = leaftailRelicExchangeOffer(state, fromItemId, toItemId, state.catalog);
  return offer ? { owner: state.ownerPublicId, revision: state.revision, targetId: offer.targetId,
    fromItemId, toItemId, quantity: offer.quantity, priceCoins: offer.priceCoins } : null;
}

export function leaftailRelicExchangeReason(economy: EconomyController, quote: ExchangeQuote, isOnline: boolean): string | null {
  if (!isOnline) return "Для обмена нужно соединение.";
  if (locked(economy) || !economy.snapshotConfirmed) return economy.uncertain ? "Проверяем последний обмен." : "Дождитесь подтверждения действия.";
  const state = economy.snapshot;
  if (!state || state.ownerPublicId !== quote.owner || state.revision !== quote.revision)
    return "Запасы обновились. Проверьте обмен ещё раз.";
  const offer = leaftailRelicExchangeOffer(state, quote.fromItemId, quote.toItemId, state.catalog);
  if (!offer || offer.targetId !== quote.targetId || offer.quantity !== quote.quantity || offer.priceCoins !== quote.priceCoins)
    return "Условия обмена изменились. Выберите реликвии ещё раз.";
  if (!offer.unlocked) return `Обмен откроется после улучшения дома до уровня ${offer.requiredHomeLevel}.`;
  if (offer.availableQuantity < offer.quantity) return `Нужно в кладовой: ${itemName(state, quote.fromItemId)} ×${number(offer.quantity)}. Сейчас ${number(offer.availableQuantity)}.`;
  if (!offer.canAfford) return `Не хватает ${number(offer.priceCoins - state.wallet.coins)} монет.`;
  return null;
}

/** Selecting relics is a preview. Only the separately confirmed server command
 * consumes the two items and coins; pending market goods are not inventory. */
export function LeaftailRelicExchange({ economy, isOnline }: { economy: EconomyController; isOnline: boolean }) {
  const state = economy.snapshot, ids = state ? leaftailRelicExchangeItems(state.catalog) : [];
  const initialFrom = ids.find(id => (state?.inventory[id] ?? 0) >= (state?.catalog.leaftailShop?.relicExchange?.quantity ?? 2)) ?? ids[0] ?? "";
  const [from, setFrom] = useState(initialFrom), [to, setTo] = useState(ids.find(id => id !== initialFrom) ?? "");
  const [quote, setQuote] = useState<ExchangeQuote | null>(null);
  const formId = useId(), heading = useRef<HTMLHeadingElement>(null), reviewButton = useRef<HTMLButtonElement>(null);
  const sent = useRef<ExchangeQuote | null>(null), wasConfirming = useRef(false);
  const latest = useRef<{ economy: EconomyController; isOnline: boolean; quote: ExchangeQuote | null } | null>({ economy, isOnline, quote });
  useLayoutEffect(() => { latest.current = { economy, isOnline, quote }; return () => { latest.current = null; }; }, [economy, isOnline, quote]);
  useEffect(() => {
    if (quote) heading.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) reviewButton.current?.focus({ preventScroll: true });
    wasConfirming.current = Boolean(quote);
  }, [quote]);
  useEffect(() => { if (!economy.busy && !economy.uncertain) sent.current = null; },
    [economy.busy, economy.uncertain, economy.error, state?.ownerPublicId, state?.revision]);
  if (!state || !state.catalog.leaftailShop?.relicExchange) return null;
  const candidate = leaftailRelicExchangeQuote(state, from, to);
  const reason = (quote ?? candidate) ? leaftailRelicExchangeReason(economy, (quote ?? candidate)!, isOnline) : "Выберите две разные реликвии.";
  const pending = locked(economy), requiredHome = state.catalog.leaftailShop.relicExchange.requiredHomeLevel;
  function confirm() {
    const current = latest.current;
    if (!current || !quote || current.quote !== quote || sent.current || leaftailRelicExchangeReason(current.economy, quote, current.isOnline)) return;
    sent.current = quote;
    if (current.economy.act("exchange_leaftail_relic", quote.targetId, 1, quote.priceCoins) === false) sent.current = null;
    else setQuote(null);
  }
  return <section className={styles.exchange} aria-labelledby={`${formId}-title`} data-relic-exchange onKeyDown={event => {
    if (event.key === "Escape" && quote && !pending) { event.preventDefault(); event.stopPropagation(); setQuote(null); }
  }}>
    <header><ArrowRightLeft size={18} aria-hidden="true" /><div><h3 id={`${formId}-title`}>Обмен реликвий</h3><p>Листохвост обменяет лишние находки на нужную реликвию за монеты.</p></div></header>
    {economy.notice === successMessage && !economy.error && !economy.busy && !economy.uncertain && <p className={styles.success} role="status"><Check size={16} aria-hidden="true" />{successMessage}.</p>}
    {(state.buildings.home ?? 1) < requiredHome && <p className={styles.hint}><LockKeyhole size={14} aria-hidden="true" />Доступно с дома {requiredHome}.</p>}
    {!quote ? <>
      <div className={styles.selectors}>
        <div><label htmlFor={`${formId}-from`}>Отдать из кладовой</label><select id={`${formId}-from`} value={from} disabled={pending} data-relic-from onChange={event => {
          const value = event.target.value; setFrom(value); if (to === value) setTo(ids.find(id => id !== value) ?? "");
        }}>{ids.map(id => <option key={id} value={id}>{itemName(state, id)} · есть {number(state.inventory[id] ?? 0)}</option>)}</select></div>
        <div><label htmlFor={`${formId}-to`}>Получить</label><select id={`${formId}-to`} value={to} disabled={pending} data-relic-to onChange={event => setTo(event.target.value)}>
          {ids.filter(id => id !== from).map(id => <option key={id} value={id}>{itemName(state, id)} · есть {number(state.inventory[id] ?? 0)}</option>)}
        </select></div>
      </div>
      {candidate && <p className={styles.summary} data-relic-exchange-summary><span><ItemIcon itemId={from} size={18} />{itemName(state, from)} ×{number(candidate.quantity)}</span><span>+ {number(candidate.priceCoins)} монет</span><strong>→ {itemName(state, to)} ×1</strong></p>}
      <p className={styles.hint}>Реликвии на обмен берём только из кладовой. Полученная находка тоже попадёт в кладовую.</p>
      {reason && <p className={styles.reason} id={`${formId}-reason`} role="status">{reason}</p>}
      <button ref={reviewButton} type="button" className={styles.primary} disabled={Boolean(reason)} aria-describedby={reason ? `${formId}-reason` : undefined} data-relic-review onClick={() => {
        const current = latest.current;
        if (!current || !candidate || sent.current || leaftailRelicExchangeReason(current.economy, candidate, current.isOnline)) return;
        setQuote(candidate);
      }}>Проверить обмен</button>
    </> : <div className={styles.confirmation} data-relic-confirmation aria-labelledby={`${formId}-confirm-title`}>
      <h4 ref={heading} tabIndex={-1} id={`${formId}-confirm-title`}>Подтвердить обмен?</h4>
      <p>Отдать <strong>{itemName(state, quote.fromItemId)} ×{number(quote.quantity)}</strong> и <strong>{number(quote.priceCoins)} монет</strong>.</p>
      <p>Получить <strong>{itemName(state, quote.toItemId)} ×1</strong>.</p>
      <p>Монеты: {number(state.wallet.coins)} → {number(Math.max(0, state.wallet.coins - quote.priceCoins))}.</p>
      {reason && <p className={styles.reason} role="status">{reason}</p>}
      <div className={styles.actions}><button type="button" disabled={pending} onClick={() => setQuote(null)}>Назад</button>
        <button type="button" className={styles.primary} disabled={Boolean(reason)} data-relic-confirm onClick={confirm}>Обменять за {number(quote.priceCoins)} монет</button></div>
    </div>}
  </section>;
}
