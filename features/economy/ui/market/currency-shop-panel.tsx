"use client";

import { PromoCodeForm } from "@/features/promo/promo-code-form";
import { useId, useRef, useState } from "react";
import { Coins, Gem, Gift, Shirt } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import type { EconomyView } from "@/features/economy/domain/model";
import { PEARL_SHOP_PACKAGES } from "@/features/economy/domain/currency-shop";
import { formatPearls } from "@/features/economy/domain/money";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { CurrencyGoldExchange } from "./currency-gold-exchange";
import { CostumeOffers, StarterOffer } from "./currency-shop-offers";
import styles from "./currency-shop-panel.module.css";

const pages = [{ id: "starters", label: "Наборы", icon: Gift }, { id: "costumes", label: "Костюмы", icon: Shirt },
  { id: "pearls", label: "Жемчуг", icon: Gem }, { id: "gold", label: "Золото", icon: Coins }] as const;
export type CurrencyShopPage = typeof pages[number]["id"];
const number = (value: number) => value.toLocaleString("ru-RU");

function CurrencyPile({ kind, tier }: { kind: "pearls" | "coins"; tier: number }) {
  return <div className={styles.pile} data-kind={kind} data-tier={tier} aria-hidden="true">
    {Array.from({ length: tier + 1 }, (_, index) => <ItemIcon key={index} itemId={kind} size={48} />)}
  </div>;
}

/** Cash offers remain previews; gold exchange and promo gifts use server commands. */
export function CurrencyShopPanel({ state, economy, onRedeemed, initialPage = "starters" }: { state: EconomyView | null; economy?: EconomyController; onRedeemed?: () => void | Promise<unknown>; initialPage?: CurrencyShopPage }) {
  const [page, setPage] = useState<CurrencyShopPage>(initialPage);
  const id = useId(), tabs = useRef<Array<HTMLButtonElement | null>>([]);
  function changePage(next: CurrencyShopPage) {
    if (next === page) return;
    playUiCue(getAudioRuntime(), "ui.tab");
    setPage(next);
  }
  return <section className={styles.shop} aria-label="Лесная лавка">
    <header className={styles.intro}>
      <span className={styles.seal}><Gift size={27} aria-hidden="true" /></span>
      <div><span className={styles.eyebrow}>Для вашей полянки</span><h2>Лесная лавка</h2><p>Особые образы и маленькие сокровища</p></div>
    </header>
    <div className={styles.tabs} role="tablist" aria-label="Разделы магазина">{pages.map((entry, index) => <button
      key={entry.id} type="button" ref={node => { tabs.current[index] = node; }} id={`${id}-${entry.id}`} role="tab"
      aria-selected={page === entry.id} aria-controls={`${id}-page`} tabIndex={page === entry.id ? 0 : -1}
      onClick={() => changePage(entry.id)} onKeyDown={event => {
        let next: number;
        if (event.key === "ArrowRight") next = (index + 1) % pages.length;
        else if (event.key === "ArrowLeft") next = (index + pages.length - 1) % pages.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = pages.length - 1;
        else return;
        event.preventDefault(); changePage(pages[next].id); tabs.current[next]?.focus();
      }}><entry.icon size={18} aria-hidden="true" />{entry.label}</button>)}</div>
    {page !== "gold" && <p className={styles.preview} id={`${id}-preview`}>Покупки за реальные деньги пока недоступны.</p>}
    <div className={styles.page} role="tabpanel" id={`${id}-page`} aria-labelledby={`${id}-${page}`} tabIndex={0}>
      {page === "starters" && <StarterOffer state={state} previewId={`${id}-preview`} />}
      {page === "costumes" && <CostumeOffers previewId={`${id}-preview`} />}
      {page === "pearls" ? <>
        <div className={styles.heading}><h3>Жемчуг</h3><p>Для ускорений, новых слотов и особенных вещей</p></div>
        <div className={styles.packages}>{PEARL_SHOP_PACKAGES.map((pack, index) => <article className={styles.package} key={pack.id} data-shop-offer={`pearls-${pack.id}`}>
          <CurrencyPile kind="pearls" tier={index} /><h4>{pack.name}</h4>
          <strong className={styles.amount}><ItemIcon itemId="pearls" size={21} />{formatPearls(pack.pearls)}</strong>
          <button type="button" disabled aria-describedby={`${id}-preview`}><span>{number(pack.priceRub)} ₽</span><small>Скоро</small></button>
        </article>)}</div>
      </> : page === "gold" ? <>
        <div className={styles.heading}><h3>Золото за жемчуг</h3></div>
        {state ? <CurrencyGoldExchange key={state.ownerPublicId} state={state} economy={economy} /> : <p className={styles.loading} role="status">Загружаем полянку…</p>}
      </> : null}
    </div>
    <div className={styles.promo}><PromoCodeForm key={state?.ownerPublicId ?? "loading"} state={state} onRedeemed={onRedeemed} /></div>
  </section>;
}
