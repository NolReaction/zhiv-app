"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowRight, Check, RefreshCw } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import { currencyShopGoldOffers } from "@/features/economy/domain/currency-shop";
import { currencyExchangeOffer } from "@/features/economy/domain/currency-exchange";
import { ECONOMY_MAX_BALANCE, formatPearls } from "@/features/economy/domain/money";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { locked } from "@/features/economy/sync/controller-state";
import { ItemIcon } from "@/features/items/item-icon";
import styles from "./currency-shop-panel.module.css";

type Quote = { owner: string; revision: number; id: string; pearls: number; coins: number };
const number = (value: number) => value.toLocaleString("ru-RU");
export function goldExchangeReason(economy: EconomyController | undefined, quote: Quote): string | null {
  if (!economy || !economy.snapshotConfirmed || locked(economy)) return "Дождитесь подключения и подтверждения действий.";
  const state = economy.snapshot, offer = currencyExchangeOffer(quote.id);
  if (!state || state.ownerPublicId !== quote.owner || state.revision !== quote.revision) return "Кошелёк обновился. Выберите пакет ещё раз.";
  if (!offer || offer.pearls !== quote.pearls || offer.coins !== quote.coins) return "Предложение изменилось. Обновите магазин.";
  if (state.wallet.pearls < offer.pearls) return "Не хватает жемчуга.";
  if (state.wallet.coins > ECONOMY_MAX_BALANCE - offer.coins) return "В кошельке не хватает места для золота.";
  return null;
}

export function CurrencyGoldExchange({ state, economy }: { state: EconomyView; economy?: EconomyController }) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const heading = useRef<HTMLElement>(null), origin = useRef<HTMLButtonElement | null>(null), sent = useRef(false);
  const latest = useRef<{ economy?: EconomyController; quote: Quote | null } | null>({ economy, quote });
  useLayoutEffect(() => { latest.current = { economy, quote }; return () => { latest.current = null; }; }, [economy, quote]);
  useEffect(() => {
    if (quote) heading.current?.focus();
    else if (origin.current) { origin.current.focus(); origin.current = null; }
  }, [quote]);
  useEffect(() => { if (!economy?.busy && !economy?.uncertain) sent.current = false; },
    [economy?.busy, economy?.uncertain, economy?.error, state.ownerPublicId, state.revision]);
  const reason = quote ? goldExchangeReason(economy, quote) : null;
  const retrySeconds = economy ? Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000)) : 0;
  function confirm() {
    const current = latest.current;
    if (!current?.economy || !quote || current.quote !== quote || sent.current || goldExchangeReason(current.economy, quote)) return;
    sent.current = true;
    if (current.economy.act("exchange_pearls_for_gold", quote.id, 1, quote.pearls) === false) sent.current = false;
    else setQuote(null);
  }
  return <div data-gold-exchange onKeyDown={event => {
    if (event.key === "Escape" && quote) { event.preventDefault(); event.stopPropagation(); setQuote(null); }
  }}>
    {economy && (economy.error || economy.syncError || economy.uncertain) && <div className={styles.exchangeMessage} role="alert">
      <p>{economy.uncertain ? "Проверяем обмен. Не отправляйте его повторно." : economy.syncError || economy.error}</p>
      <button type="button" disabled={economy.busy || retrySeconds > 0} onClick={() => { if (!economy.busy && retrySeconds <= 0) void economy.retry(); }}>
        <RefreshCw size={14} aria-hidden="true" />{retrySeconds ? `Проверить через ${retrySeconds} с` : "Проверить результат"}
      </button>
    </div>}
    {economy?.notice?.startsWith("Обмен выполнен.") && !economy.error && !economy.uncertain && <p className={styles.exchangeSuccess} role="status"><Check size={16} aria-hidden="true" />{economy.notice}</p>}
    {quote && <section ref={heading} tabIndex={-1} className={styles.goldConfirmation} aria-label="Подтверждение обмена">
      <h4>Обменять жемчуг на золото?</h4>
      <div><span><ItemIcon itemId="pearls" size={21} />{formatPearls(quote.pearls)} жемчужин</span><ArrowRight size={17} aria-hidden="true" /><span><ItemIcon itemId="coins" size={21} />{number(quote.coins)} золота</span></div>
      <p>Обмен нельзя отменить.</p>
      {reason && <p role="status">{reason}</p>}
      <footer><button type="button" onClick={() => setQuote(null)}>Назад</button><button type="button" disabled={Boolean(reason)} onClick={confirm}>Подтвердить обмен</button></footer>
    </section>}
    <div className={styles.packages} data-gold="true">{currencyShopGoldOffers(state).map((pack, index) => {
      const candidate: Quote = { owner: state.ownerPublicId, revision: state.revision, id: pack.id, pearls: pack.pearls, coins: pack.coins };
      const blocked = goldExchangeReason(economy, candidate);
      return <article className={styles.package} key={pack.id} data-shop-offer={`gold-${pack.id}`}>
        <div className={styles.pile} data-kind="coins" data-tier={index + 1} aria-hidden="true">{Array.from({ length: index + 2 }, (_, i) => <ItemIcon key={i} itemId="coins" size={48} />)}</div>
        <h4>{pack.name}</h4><strong className={styles.amount}><ItemIcon itemId="coins" size={22} />{number(pack.coins)}</strong>
        <span className={styles.bonus}>{pack.bonusCoins > 0 ? `Включая +${number(pack.bonusCoins)} бонусом (${pack.bonusPercent}%)` : "Без бонуса"}</span>
        <div className={styles.exchange}><ItemIcon itemId="pearls" size={18} /><span>{formatPearls(pack.pearls)}</span><ArrowRight size={14} aria-hidden="true" /><span>золото</span></div>
        <button type="button" disabled={Boolean(blocked) || Boolean(quote)} title={blocked ?? undefined} aria-label={`Обменять ${formatPearls(pack.pearls)} жемчужин на ${number(pack.coins)} золота`}
          onClick={economy ? event => { if (!blocked && !quote && !sent.current) { origin.current = event.currentTarget; setQuote(candidate); } } : undefined}>Обменять</button>
        {economy && blocked && !locked(economy) && economy.snapshotConfirmed && <small className={styles.exchangeReason}>{blocked}</small>}
      </article>;
    })}</div>
  </div>;
}
