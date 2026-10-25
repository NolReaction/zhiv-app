"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { ArrowLeft, Check, Package, RefreshCw, X } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { NeighborView } from "@/features/economy/domain/neighbor-model";
import { economyCatalog } from "@/features/economy/domain/model";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { createNeighborQuote, neighborQuoteReason, type NeighborQuote } from "./neighbor-quote";
import { neighborStationProducts } from "./neighbor-station-products";
import styles from "./neighbor-dialog.module.css";

const number = (value: number) => value.toLocaleString("ru-RU");
type ShopProps = { open: boolean; neighbor: NeighborView; economy: EconomyController; timeZone: string;
  refreshing: boolean; onRefresh: () => void; onClose: () => void; onReturnFocus: () => void };

/** The same nested storefront flow used while visiting a player's full-screen world. */
export function NeighborShopDialog({ open, neighbor, economy, timeZone, refreshing, onRefresh, onClose, onReturnFocus }: ShopProps) {
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className={styles.overlay} />
      <Dialog.Content className={styles.dialog} data-neighbor-dialog onEscapeKeyDown={event => event.stopPropagation()}
        onCloseAutoFocus={event => { event.preventDefault(); onReturnFocus(); }}>
        <header className={styles.header}>
          <button type="button" onClick={onClose} aria-label="К полянке соседа"><ArrowLeft size={20} aria-hidden="true" /></button>
          <div><span className={styles.eyebrow}>Персонаж мира</span><Dialog.Title className={styles.title}>Лавка: {neighbor.character.name}</Dialog.Title></div>
          <button type="button" data-neighbor-close onClick={onClose} aria-label="Закрыть лавку"><X size={20} aria-hidden="true" /></button>
        </header>
        <Dialog.Description className={styles.description}>Личная поставка лесного соседа. Покупки попадают в вашу кладовую.</Dialog.Description>
        <NeighborShop key={neighbor.shop.cycleId} neighbor={neighbor} economy={economy} timeZone={timeZone} refreshing={refreshing} onRefresh={onRefresh} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Visible building levels expose their catalog capabilities, without starting somebody else's work. */
export function NeighborStationInfo({ world, stationId }: { world: NeighborView["character"]["world"]; stationId: string }) {
  const building = economyCatalog.buildings.find(item => item.id === stationId), level = world.buildings[stationId] ?? 0;
  const products = neighborStationProducts(world, stationId), visible = products.slice(0, 4);
  const name = stationId === "workshop" ? "Верстак" : building?.name ?? "Лесная полянка";
  return <section className={styles.stationDetails} data-neighbor-station={stationId} aria-label={name}>
    <h3>{name}<span>{level > 0 ? `Уровень ${level}` : stationId === "dryer" ? "Обычный костёр" : "Ещё не построено"}</span></h3>
    {products.length ? <>
      <p className={styles.capability}>{stationId === "quarry" ? "Маршруты добычи этого уровня" : "Рецепты этого уровня"}</p>
      <ul className={styles.products}>{visible.map(product => <li key={product.id}><strong>{product.name}</strong>
        <span>{product.outputs.map(output => `${output.name} × ${output.quantity}`).join(", ")}</span></li>)}</ul>
      {products.length > visible.length && <p className={styles.capability}>Ещё вариантов: {products.length - visible.length}</p>}
      {visible.some(product => product.needsRecipeLearning) && <p className={styles.capability}>Для некоторых блюд сначала осваивают предыдущие рецепты.</p>}
    </> : <p>{building?.description ?? "Тихое место на лесной полянке."}</p>}
  </section>;
}

export function NeighborShop({ neighbor, economy, timeZone, refreshing = false, onRefresh }: { neighbor: NeighborView; economy: EconomyController; timeZone?: string; refreshing?: boolean; onRefresh: () => void }) {
  const [quote, setQuote] = useState<NeighborQuote | null>(null), [submitted, setSubmitted] = useState(false), [message, setMessage] = useState("");
  const [localError, setLocalError] = useState("");
  const accepted = Boolean(quote && submitted && !economy.busy && !economy.uncertain && !economy.syncPending && !economy.error && economy.notice
    && economy.snapshot?.ownerPublicId === quote.owner && economy.snapshot.revision > quote.revision);
  if (accepted) { setSubmitted(false); setMessage(economy.notice); setQuote(null); }
  if (submitted && !economy.busy && !economy.uncertain && !economy.syncPending && economy.error) setSubmitted(false);
  const latest = useRef({ economy, neighbor, quote, refreshing, readAt: 0 }), sent = useRef<NeighborQuote | null>(null), active = useRef(true);
  const heading = useRef<HTMLHeadingElement>(null), list = useRef<HTMLDivElement>(null), lastOffer = useRef<string | null>(null), confirming = useRef(false);
  const reasonId = useId();
  useLayoutEffect(() => { active.current = true; latest.current = { economy, neighbor, quote, refreshing, readAt: performance.now() };
    return () => { active.current = false; }; }, [economy, neighbor, quote, refreshing]);
  useEffect(() => {
    if (quote) heading.current?.focus({ preventScroll: true });
    else if (confirming.current && lastOffer.current) list.current?.querySelector<HTMLButtonElement>(`[data-neighbor-offer="${lastOffer.current}"]`)?.focus({ preventScroll: true });
    confirming.current = Boolean(quote);
  }, [quote]);
  useEffect(() => {
    const purchase = sent.current;
    if (!purchase || economy.busy || economy.uncertain || economy.syncPending) return;
    if (economy.error) { sent.current = null; return; }
    if (economy.snapshot?.ownerPublicId === purchase.owner && economy.snapshot.revision > purchase.revision && economy.notice) {
      sent.current = null;
    }
  }, [economy.busy, economy.uncertain, economy.syncPending, economy.error, economy.snapshot, economy.notice]);
  const state = economy.snapshot, reason = quote ? neighborQuoteReason(economy, neighbor, quote) : null;
  const pending = submitted && (economy.busy || economy.uncertain || economy.syncPending);
  const confirm = () => {
    const current = latest.current;
    if (!active.current || !quote || current.quote !== quote || sent.current || current.refreshing
      || neighborQuoteReason(current.economy, current.neighbor, quote, current.economy.now + Math.max(0, performance.now() - current.readAt))) return;
    sent.current = quote; setLocalError("");
    if (current.economy.actNeighbor(quote.offerId, quote.quantity, quote.totalPrice)) setSubmitted(true);
    else { sent.current = null; setLocalError("Покупка не отправлена. Дождитесь подключения и попробуйте снова."); }
  };
  const refreshTime = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", timeZoneName: "short", timeZone }).format(new Date(neighbor.shop.refreshAt));
  const expired = economy.now >= Date.parse(neighbor.shop.refreshAt);
  return <section className={styles.shop} aria-label={`Лавка: ${neighbor.character.name}`}>
    <div className={styles.wallet}><span><ItemIcon itemId="coins" size={20} /><strong>{state ? number(state.wallet.coins) : "…"}</strong> монет</span><span><Package size={18} aria-hidden="true" />{state?.storage.available ?? "…"} мест</span></div>
    <div className={styles.body}>
      <div className={styles.shopHeading}><h3>Лавка: {neighbor.character.name}</h3><span>Персонаж мира</span></div>
      <p className={styles.muted}>Небольшая поставка для вас. Каждую партию можно купить один раз; новая поставка ежедневно в {refreshTime}.</p>
      {!neighbor.shop.available && <p className={styles.reason} role="status">{neighbor.shop.reason === "market_locked"
        ? "Лавка откроется, когда вы откроете рынок в своём лесу. Пока можно осмотреть полянку соседа."
        : "Лавка временно закрыта. Полянка соседа остаётся открытой для гостей."}</p>}
      {economy.uncertain ? <div className={styles.feedback} role="status"><strong>Проверяем последнее действие</strong><p>{economy.error ?? "Ответ ещё не пришёл. Повторная проверка не спишет монеты дважды."}</p><button type="button" disabled={economy.busy || economy.now < economy.retryAt || economy.directActionsAvailable === false} onClick={() => void latest.current.economy.retry()}>Проверить результат</button></div>
        : economy.error || localError ? <p className={styles.error} role="alert">{economy.error || localError}</p>
          : message ? <p className={styles.success} role="status"><Check size={17} aria-hidden="true" />{message}</p> : null}
      {quote ? <section className={styles.confirmation} aria-labelledby={`${reasonId}-title`}>
        <h3 id={`${reasonId}-title`} tabIndex={-1} ref={heading}>Купить всю партию?</h3><ItemIcon itemId={quote.itemId} size={60} />
        <strong>{state?.catalog.items.find(item => item.id === quote.itemId)?.name ?? "Товар"} × {quote.quantity}</strong>
        <p>В вашу кладовую: {quote.quantity} шт.</p><p className={styles.total}><ItemIcon itemId="coins" size={22} />{number(quote.totalPrice)} монет</p>
        {state && <p>После покупки: {number(Math.max(0, state.wallet.coins - quote.totalPrice))} монет · {Math.max(0, state.storage.available - quote.quantity)} свободных мест</p>}
        {reason && <p className={styles.reason} id={reasonId} role="status">{reason}</p>}
        <div className={styles.actions}><button type="button" onClick={() => { if (!pending) { setQuote(null); setSubmitted(false); sent.current = null; } }} disabled={pending}>Назад</button><button type="button" className={styles.primary} disabled={Boolean(reason) || refreshing || submitted} aria-describedby={reason ? reasonId : undefined} aria-label={`Подтвердить покупку: ${quote.quantity} шт. за ${number(quote.totalPrice)} монет`} onClick={confirm}>{pending ? "Проверяем…" : `Купить за ${number(quote.totalPrice)}`}</button></div>
      </section> : <div className={styles.grid} ref={list} role="list" aria-label="Сегодняшние товары">{neighbor.shop.offers.map(offer => {
        const candidate = createNeighborQuote(economy, neighbor, offer), blocked = candidate ? neighborQuoteReason(economy, neighbor, candidate) : "Проверяем ваши запасы.";
        return <article className={styles.card} role="listitem" key={offer.id} data-purchased={offer.purchased || undefined}>
          <div className={styles.product}><ItemIcon itemId={offer.itemId} size={46} /><b>× {offer.quantity}</b></div><h4>{state?.catalog.items.find(item => item.id === offer.itemId)?.name ?? "Товар"}</h4>
          <p><ItemIcon itemId="coins" size={16} /><strong>{number(offer.totalPrice)}</strong><small>за партию</small></p>
          <button type="button" data-neighbor-offer={offer.id} disabled={Boolean(blocked) || refreshing} onClick={() => {
            const current = latest.current, fresh = current.neighbor.shop.offers.find(item => item.id === offer.id);
            if (!active.current || current.refreshing || !fresh) return;
            const next = createNeighborQuote(current.economy, current.neighbor, fresh);
            if (next && !neighborQuoteReason(current.economy, current.neighbor, next, current.economy.now + Math.max(0, performance.now() - current.readAt))) {
              lastOffer.current = fresh.id; setMessage(""); setLocalError(""); setSubmitted(false); sent.current = null; setQuote(next);
            }
          }}>{offer.purchased ? <><Check size={16} aria-hidden="true" />Куплено</> : "Выбрать"}</button>
          {blocked && !offer.purchased && <p className={styles.cardReason}>{blocked}</p>}
        </article>;
      })}</div>}
      {neighbor.shop.available && !neighbor.shop.offers.length && <p className={styles.muted}>Пока прилавок пуст. Заходите после следующей поставки.</p>}
      <p className={styles.note}>{neighbor.character.name} — житель игрового мира. Его лавка дополняет торговлю с друзьями.</p>
    </div>
    <footer className={styles.shopFooter}><span>{expired ? "Ждём новую поставку" : "Следующая поставка"}<strong>{refreshTime}</strong></span><button type="button" disabled={refreshing || economy.busy} onClick={onRefresh}><RefreshCw size={16} aria-hidden="true" />{refreshing ? "Проверяем…" : "Обновить"}</button></footer>
  </section>;
}
