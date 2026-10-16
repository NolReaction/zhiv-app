"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Check, Clock3, Leaf, LockKeyhole, RefreshCw } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { leaftailShopView } from "@/features/economy/domain/leaftail-shop";
import { locked } from "@/features/economy/sync/controller-state";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import styles from "./world-leaftail-market.module.css";

type Quote = { owner: string; revision: number; targetId: string; itemId: string; price: number };
const number = (value: number) => value.toLocaleString("ru-RU");
const descriptions: Record<string, string> = {
  ancient_core: "Для больших построек и расширения кладовой.",
  moon_crystal: "Для развития поселения и расширения кладовой.",
  living_resin: "Для улучшения дома и расширения кладовой.",
};
const resetDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Moscow" });

/** A visible quote belongs to this account, revision and daily delivery. */
export function leaftailPurchaseReason(economy: EconomyController, quote: Quote, isOnline: boolean): string | null {
  if (!isOnline) return "Для покупки нужно соединение.";
  if (locked(economy) || !economy.snapshotConfirmed) return economy.uncertain ? "Проверяем последнее действие." : "Дождитесь подтверждения действия.";
  const state = economy.snapshot;
  if (!state || state.ownerPublicId !== quote.owner || state.revision !== quote.revision)
    return "Запасы обновились. Выберите предмет ещё раз.";
  const shop = leaftailShopView(state, economy.now, state.catalog);
  if (!shop) return "Листохвост пока не открыл лавку.";
  if (!shop.unlocked) return `Лавка откроется с домом уровня ${shop.requiredHomeLevel}.`;
  const offer = shop.offers.find(item => item.targetId === quote.targetId && item.itemId === quote.itemId);
  if (!offer || offer.priceCoins !== quote.price) return "Поставка изменилась. Выберите предмет ещё раз.";
  if (offer.remaining < 1) return "Сегодня уже куплено. Дождитесь новой поставки.";
  if (state.storage.available < 1) return "Освободите одно место в кладовой.";
  if (state.wallet.coins < offer.priceCoins) return `Не хватает ${number(offer.priceCoins - state.wallet.coins)} монет.`;
  return null;
}

/** Ordinary receipt-based economy action; the browser never grants an item. */
export function WorldLeaftailMarket({ economy, isOnline }: { economy: EconomyController; isOnline: boolean }) {
  const [quote, setQuote] = useState<Quote | null>(null);
  const latest = useRef({ economy, quote, isOnline }), sent = useRef<Quote | null>(null);
  const shopElement = useRef<HTMLDivElement>(null), triggerItem = useRef<string | null>(null), heading = useRef<HTMLHeadingElement>(null);
  const wasConfirming = useRef(false), headingId = useId();
  useLayoutEffect(() => { latest.current = { economy, quote, isOnline }; }, [economy, quote, isOnline]);
  const state = economy.snapshot, shop = state ? leaftailShopView(state, economy.now, state.catalog) : null;
  const confirming = Boolean(quote);
  useEffect(() => {
    if (confirming) heading.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) {
      const buttons = Array.from(shopElement.current?.querySelectorAll<HTMLButtonElement>("[data-leaftail-purchase]") ?? []);
      const original = buttons.find(button => button.dataset.leaftailPurchase === triggerItem.current && !button.disabled);
      (original ?? buttons.find(button => !button.disabled) ?? shopElement.current)?.focus({ preventScroll: true });
    }
    wasConfirming.current = confirming;
  }, [confirming]);
  useEffect(() => { if (!economy.busy && !economy.uncertain) sent.current = null; },
    [economy.busy, economy.uncertain, economy.error, state?.ownerPublicId, state?.revision]);
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const recovery = !economy.syncError && (economy.error || economy.uncertain) && <div className={styles.recovery} role="alert">
    <p>{economy.uncertain ? "Проверяем покупку. Дождитесь подтверждения, прежде чем покупать снова." : economy.error}</p>
    <button type="button" disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={13} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить покупку" : "Повторить"}</button>
  </div>;
  function confirm() {
    const current = latest.current;
    if (!quote || current.quote !== quote || sent.current === quote || leaftailPurchaseReason(current.economy, quote, current.isOnline)) return;
    sent.current = quote;
    if (current.economy.act("buy_leaftail_item", quote.targetId, 1, quote.price) === false) sent.current = null;
    else setQuote(null);
  }
  const reason = quote && confirming ? leaftailPurchaseReason(economy, quote, isOnline) : null;
  // Cached snapshots are untrusted. Keep their stock fence, but never pass an
  // unrepresentable delivery date to Intl before the server refresh arrives.
  const deliveryDate = shop ? new Date(shop.refreshAt) : null;
  const deliveryLabel = deliveryDate && Number.isFinite(deliveryDate.getTime())
    ? `Новая поставка ${resetDate.format(deliveryDate)} МСК.` : "Проверяем время новой поставки.";
  return <div ref={shopElement} tabIndex={-1} className={styles.shop} aria-label="Находки Листохвоста" aria-busy={economy.busy || undefined} data-leaftail-shop>
    <p className={styles.intro}><Leaf size={18} aria-hidden="true" /><span>«Собрал кое-что для твоего поселения. Выбирай, пока не разобрали!»</span></p>
    {recovery}
    {!state ? <p role="status">Проверяем ваши запасы…</p> : !shop ? <p>Листохвост готовит свой прилавок. Обновите игру немного позже.</p> : <>
      <div className={styles.wallet}><span>Ваши монеты</span><strong><ItemIcon itemId="coins" size={18} />{number(state.wallet.coins)}</strong></div>
      {!shop.unlocked && <p className={styles.locked}><LockKeyhole size={17} aria-hidden="true" />Лавка откроется с домом уровня {shop.requiredHomeLevel}.</p>}
      <p className={styles.hint}>По одному предмету каждого вида на игрока за поставку.</p>
      {confirming && quote ? <section className={styles.confirmation} aria-labelledby={headingId}>
        <h3 id={headingId} ref={heading} tabIndex={-1}>Купить {state.catalog.items.find(item => item.id === quote.itemId)?.name ?? quote.itemId}?</h3>
        <p>1 шт. в кладовую за <strong>{number(quote.price)} монет</strong>.</p>
        <p>Монеты: {number(state.wallet.coins)} → {number(Math.max(0, state.wallet.coins - quote.price))}</p>
        {reason && <p className={styles.reason} role="status">{reason}</p>}
        <div className={styles.actions}><button type="button" onClick={() => setQuote(null)}>Назад</button><button className={styles.buy} type="button" disabled={Boolean(reason)} onClick={confirm}>Подтвердить<ItemIcon itemId="coins" size={16} />{number(quote.price)}</button></div>
      </section> : <div className={styles.offers}>{shop.offers.map(offer => {
        const nextQuote = { owner: state.ownerPublicId, revision: state.revision, targetId: offer.targetId, itemId: offer.itemId, price: offer.priceCoins };
        const disabledReason = leaftailPurchaseReason(economy, nextQuote, isOnline);
        const name = state.catalog.items.find(item => item.id === offer.itemId)?.name ?? offer.itemId;
        return <article className={styles.offer} key={offer.id} data-leaftail-item={offer.itemId}>
          <div className={styles.item}><ItemIcon itemId={offer.itemId} size={36} /><div><strong>{name}</strong><small>{descriptions[offer.itemId] ?? "Для развития поселения."}</small></div><span className={styles.stock}>{offer.remaining}/{offer.stock}</span></div>
          <div className={styles.offerBottom}><small>В кладовой: {number(state.inventory[offer.itemId] ?? 0)}</small><button type="button" className={styles.buy} data-leaftail-purchase={offer.itemId} disabled={Boolean(disabledReason)} aria-label={`Купить ${name} за ${number(offer.priceCoins)} монет`} onClick={() => {
            const current = latest.current;
            if (leaftailPurchaseReason(current.economy, nextQuote, current.isOnline)) return;
            triggerItem.current = offer.itemId; setQuote(nextQuote);
          }}>{offer.remaining ? <><span>Купить</span><ItemIcon itemId="coins" size={16} />{number(offer.priceCoins)}</> : <><Check size={15} aria-hidden="true" />Сегодня куплено</>}</button></div>
          {disabledReason && shop.unlocked && offer.remaining > 0 && <p className={styles.reason}>{disabledReason}</p>}
        </article>;
      })}</div>}
      {economy.notice === "Покупка у Листохвоста отправлена в кладовую" && !economy.error && <p className={styles.success} role="status"><Check size={15} aria-hidden="true" />Покупка в кладовой.</p>}
      <p className={styles.delivery}><Clock3 size={14} aria-hidden="true" /><span>{deliveryLabel}<small>Ежедневно в 00:00 UTC (03:00 МСК).</small></span></p>
    </>}
  </div>;
}
