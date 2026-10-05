"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowLeftRight, Check, LockKeyhole, RefreshCw } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { BARTER_HOME_LEVEL, BARTER_MAX_OFFERS, barterItems, type BarterOffer } from "./barter-model";
import styles from "./barter-market.module.css";

type ReadyEconomy = EconomyController & { snapshot: EconomyView };
const itemName = (state: EconomyView, id: string) => state.catalog.items.find(item => item.id === id)?.name ?? "Особый материал";
const locked = (economy: ReadyEconomy) => economy.busy || economy.uncertain || economy.retryAt > economy.now;
const eligible = (state: EconomyView, id: string) => barterItems(state).some(item => item.id === id);

function Pair({ state, give, receive }: { state: EconomyView; give: string; receive: string }) {
  return <div className={styles.pair}>
    <span><ItemIcon itemId={give} size={32} /><span><small>Отдаёте 1</small><strong>{itemName(state, give)}</strong></span></span>
    <ArrowLeftRight size={18} aria-hidden />
    <span><ItemIcon itemId={receive} size={32} /><span><small>Получаете 1</small><strong>{itemName(state, receive)}</strong></span></span>
  </div>;
}

export function BarterOfferCard({ economy, offer, owned = false }: { economy: ReadyEconomy; offer: BarterOffer; owned?: boolean }) {
  const [confirm, setConfirm] = useState(false), trigger = useRef<HTMLButtonElement>(null), confirmation = useRef<HTMLDivElement>(null);
  const wasConfirming = useRef(false);
  useEffect(() => {
    if (confirm) confirmation.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) trigger.current?.focus({ preventScroll: true });
    wasConfirming.current = confirm;
  }, [confirm]);
  const state = economy.snapshot, shelf = economy.barter;
  const current = (owned ? shelf?.mine : shelf?.offers)?.find(item => item.id === offer.id);
  const same = current?.status === "active" && current.offeredItemId === offer.offeredItemId && current.requestedItemId === offer.requestedItemId
    && current.sellerPublicId === offer.sellerPublicId && current.owned === offer.owned;
  const own = offer.owned && offer.sellerPublicId === state.ownerPublicId;
  const expired = !shelf || economy.now >= Date.parse(shelf.showcase.refreshAt);
  const enough = (state.inventory[offer.requestedItemId] ?? 0) >= 1;
  const validItems = offer.offeredItemId !== offer.requestedItemId && eligible(state, offer.offeredItemId) && eligible(state, offer.requestedItemId);
  const unavailable = locked(economy) || !same || shelf?.ownerPublicId !== state.ownerPublicId
    || (owned ? !own : own || offer.owned || expired || !enough || !validItems || (state.buildings.home ?? 1) < BARTER_HOME_LEVEL);
  const label = owned ? "Вернуть материал" : expired ? "Обновите витрину" : !enough ? "Нет нужного материала" : "Обменять";
  return <article className={styles.offer} role="listitem" aria-label={`${itemName(state, offer.offeredItemId)} на ${itemName(state, offer.requestedItemId)}`}>
    <p className={styles.seller}>{owned ? "Ваше предложение" : `Сосед: ${offer.sellerName}`}</p>
    <Pair state={state} give={owned ? offer.offeredItemId : offer.requestedItemId} receive={owned ? offer.requestedItemId : offer.offeredItemId} />
    {owned && <p className={styles.note}>Одна вещь хранится на прилавке до обмена или возврата.</p>}
    {confirm ? <div ref={confirmation} className={styles.confirmation} role="group" tabIndex={-1} aria-label={owned ? "Подтверждение возврата" : "Подтверждение обмена"}>
      <p>{owned ? `Снять предложение и вернуть 1 ${itemName(state, offer.offeredItemId)}?` : "Обменять эти две вещи один к одному?"}</p>
      <div className={styles.actions}><button type="button" disabled={locked(economy)} onClick={() => setConfirm(false)}>Назад</button>
        <button type="button" className={styles.primary} disabled={unavailable} onClick={() => {
          if (unavailable) return;
          economy.actBarter({ action: owned ? "cancel_offer" : "accept_offer", offerId: offer.id });
        }}>{owned ? "Подтвердить возврат" : "Подтвердить обмен"}</button></div>
    </div> : <button ref={trigger} type="button" disabled={unavailable} onClick={() => { if (!unavailable) setConfirm(true); }}>{label}</button>}
  </article>;
}

export function BarterCreateForm({ economy }: { economy: ReadyEconomy }) {
  const state = economy.snapshot, items = barterItems(state), id = useId();
  const [offeredId, setOffered] = useState(""), [requestedId, setRequested] = useState("");
  const [confirm, setConfirm] = useState<{ offeredId: string; requestedId: string } | null>(null);
  const offered = confirm ? items.find(item => item.id === confirm.offeredId)
    : items.find(item => item.id === offeredId) ?? items.find(item => (state.inventory[item.id] ?? 0) > 0) ?? items[0];
  const requested = confirm ? items.find(item => item.id === confirm.requestedId)
    : items.find(item => item.id === requestedId && item.id !== offered?.id) ?? items.find(item => item.id !== offered?.id);
  const shelf = economy.barter;
  const unavailable = locked(economy) || (state.buildings.home ?? 1) < BARTER_HOME_LEVEL
    || !shelf || shelf.ownerPublicId !== state.ownerPublicId || shelf.mine.length >= BARTER_MAX_OFFERS
    || !offered || !requested || offered.id === requested.id || (state.inventory[offered.id] ?? 0) < 1;
  if (!offered || !requested) return <p className={styles.note}>Особые материалы появятся в каталоге после обновления хозяйства.</p>;
  return <form className={styles.create} onSubmit={event => { event.preventDefault(); if (!unavailable) setConfirm({ offeredId: offered.id, requestedId: requested.id }); }}>
    <h3>Своё предложение</h3>
    <p className={styles.note}>Отложите одну находку и выберите, какую хотите получить взамен.</p>
    <div className={styles.fields}>
      <label htmlFor={`${id}-give`}>Отдаёте<select id={`${id}-give`} value={offered.id} disabled={locked(economy) || Boolean(confirm)} onChange={event => setOffered(event.target.value)}>
        {items.map(item => <option key={item.id} value={item.id} disabled={(state.inventory[item.id] ?? 0) < 1}>{item.name} · есть {state.inventory[item.id] ?? 0}</option>)}
      </select></label>
      <label htmlFor={`${id}-receive`}>Хотите получить<select id={`${id}-receive`} value={requested.id} disabled={locked(economy) || Boolean(confirm)} onChange={event => setRequested(event.target.value)}>
        {items.filter(item => item.id !== offered.id).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
    </div>
    {confirm ? <div className={styles.confirmation} role="group" aria-label="Подтверждение предложения">
      <Pair state={state} give={offered.id} receive={requested.id} />
      <p>Одна вещь уйдёт на прилавок. При отмене она вернётся в ваши запасы.</p>
      <div className={styles.actions}><button type="button" disabled={locked(economy)} onClick={() => setConfirm(null)}>Назад</button>
        <button type="button" className={styles.primary} disabled={unavailable} onClick={() => {
          if (unavailable) return;
          economy.actBarter({ action: "create_offer", offeredItemId: offered.id, requestedItemId: requested.id });
        }}>Подтвердить предложение</button></div>
    </div> : <button type="submit" className={styles.primary} disabled={unavailable}>{shelf && shelf.mine.length >= BARTER_MAX_OFFERS ? "Все три места заняты" : "Предложить обмен"}</button>}
  </form>;
}

/** The account-owned economy session holds receipts even when this panel closes. */
export function BarterMarket({ economy, onMarket, onHome }: { economy: ReadyEconomy; onMarket?: () => void; onHome?: () => void }) {
  const [section, setSection] = useState<"browse" | "create" | "mine">("browse");
  const { snapshot: state, barter, barterError, refreshBarter } = economy;
  const unlocked = (state.buildings.home ?? 1) >= BARTER_HOME_LEVEL;
  useEffect(() => { if (unlocked) void refreshBarter(); }, [refreshBarter, unlocked]);
  const refreshIn = barter ? Math.max(0, Math.ceil((Date.parse(barter.showcase.refreshAt) - economy.now) / 1000)) : 0;
  const validShelf = barter?.ownerPublicId === state.ownerPublicId ? barter : null;
  return <section className={styles.market} aria-label="Обмен особыми материалами">
    <header className={styles.heading}><div><span className={styles.eyebrow}>Соседский прилавок</span><h2><ArrowLeftRight size={20} aria-hidden />Обмен находками</h2><p>Одна особая находка за другую. Без монет и жемчуга.</p></div></header>
    {onMarket && <button type="button" className={styles.back} onClick={onMarket}><ArrowLeft size={15} aria-hidden />Обычный рынок</button>}
    {!unlocked ? <div className={styles.empty}><LockKeyhole size={28} aria-hidden /><h3>Сначала обустройте дом</h3><p>Обмен особыми материалами откроется с домом {BARTER_HOME_LEVEL} уровня.</p>{onHome && <button type="button" onClick={onHome}>Обустройство дома</button>}</div> : <>
      <nav className={styles.tabs} aria-label="Разделы обмена"><button type="button" aria-pressed={section === "browse"} onClick={() => setSection("browse")}>Витрина</button><button type="button" aria-pressed={section === "create"} onClick={() => setSection("create")}>Предложить</button><button type="button" aria-pressed={section === "mine"} onClick={() => setSection("mine")}>Мои{validShelf?.mine.length ? ` · ${validShelf.mine.length}` : ""}</button></nav>
      {barterError && <div className={styles.error} role="alert"><p>{barterError}</p><button type="button" disabled={locked(economy)} onClick={() => void refreshBarter()}>Обновить обмен</button></div>}
      {economy.notice && !economy.error && !economy.uncertain && <p role="status" className={styles.success}><Check size={16} aria-hidden />{economy.notice}</p>}
      {!validShelf && !barterError && <p role="status" className={styles.note}>Открываем соседские прилавки…</p>}
      {validShelf && section === "browse" && <>
        <div className={styles.shelf}><div><strong>Ваша витрина · {validShelf.offers.length} / 6</strong><p>{refreshIn ? `Смена через ${Math.ceil(refreshIn / 60)} мин` : "Доступна новая витрина"}</p></div><button type="button" disabled={locked(economy)} onClick={() => void refreshBarter()}><RefreshCw size={15} aria-hidden />{refreshIn ? "Проверить наличие" : "Обновить витрину"}</button></div>
        <p className={styles.note}>Не больше одного предложения от соседа. Подборка меняется раз в 30 минут; ушедшие вещи до смены не заменяются.</p>
        {validShelf.offers.length ? <div className={styles.offers} role="list" aria-label="Предложения обмена">{validShelf.offers.map(offer => <BarterOfferCard key={offer.id} economy={economy} offer={offer} />)}</div> : <div className={styles.empty}><ArrowLeftRight size={26} aria-hidden /><h3>Прилавки пока свободны</h3><p>Соседи ещё не предложили находки или предыдущие обмены уже закончились.</p><button type="button" onClick={() => setSection("create")}>Предложить свою находку</button></div>}
      </>}
      {validShelf && section === "create" && <BarterCreateForm economy={economy} />}
      {validShelf && section === "mine" && <><p className={styles.note}>Ваш прилавок · {validShelf.mine.length} / {BARTER_MAX_OFFERS}. Новые предложения попадут к соседям при смене витрины.</p>{validShelf.mine.length ? <div className={styles.offers} role="list" aria-label="Ваши предложения обмена">{validShelf.mine.map(offer => <BarterOfferCard key={offer.id} economy={economy} offer={offer} owned />)}</div> : <p className={styles.note}>Ваши находки пока не выставлены.</p>}</>}
    </>}
  </section>;
}
