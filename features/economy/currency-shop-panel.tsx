"use client";

import { useId, useRef, useState } from "react";
import { ArrowRight, Coins, Gem, House, Sprout } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyView } from "./model";
import { currencyShopDevelopment, currencyShopGoldOffers, PEARL_SHOP_PACKAGES } from "./currency-shop";
import styles from "./currency-shop-panel.module.css";

const pages = [{ id: "pearls", label: "Жемчуг", icon: Gem }, { id: "gold", label: "Золото", icon: Coins }] as const;
type ShopPage = typeof pages[number]["id"];
const number = (value: number) => value.toLocaleString("ru-RU");

function CurrencyPile({ kind, tier }: { kind: "pearls" | "coins"; tier: number }) {
  return <div className={styles.pile} data-kind={kind} data-tier={tier} aria-hidden="true">
    {Array.from({ length: tier + 1 }, (_, index) => <ItemIcon key={index} itemId={kind} size={48} />)}
  </div>;
}

/** Deliberately receives a snapshot, never an economy session or a transaction callback. */
export function CurrencyShopPanel({ state }: { state: EconomyView | null }) {
  const [page, setPage] = useState<ShopPage>("pearls");
  const id = useId(), tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const development = state ? currencyShopDevelopment(state) : null;
  return <section className={styles.shop} aria-label="Магазин валют">
    <header className={styles.intro}>
      <span className={styles.seal}><Gem size={27} aria-hidden="true" /></span>
      <div><span className={styles.eyebrow}>Скоро в лесу</span><h2>Маленькие сокровища</h2><p>Жемчуг и золото для вашей полянки</p></div>
    </header>
    <div className={styles.tabs} role="tablist" aria-label="Разделы магазина">{pages.map((entry, index) => <button
      key={entry.id} type="button" ref={node => { tabs.current[index] = node; }} id={`${id}-${entry.id}`} role="tab"
      aria-selected={page === entry.id} aria-controls={`${id}-page`} tabIndex={page === entry.id ? 0 : -1}
      onClick={() => setPage(entry.id)} onKeyDown={event => {
        let next: number;
        if (event.key === "ArrowRight") next = (index + 1) % pages.length;
        else if (event.key === "ArrowLeft") next = (index + pages.length - 1) % pages.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = pages.length - 1;
        else return;
        event.preventDefault(); setPage(pages[next].id); tabs.current[next]?.focus();
      }}><entry.icon size={18} aria-hidden="true" />{entry.label}</button>)}</div>
    <p className={styles.preview} id={`${id}-preview`}>Витрина готовится к открытию. Покупки и обмен пока недоступны.</p>
    <div className={styles.page} role="tabpanel" id={`${id}-page`} aria-labelledby={`${id}-${page}`} tabIndex={0}>
      {page === "pearls" ? <>
        <div className={styles.heading}><h3>Жемчуг</h3><p>Для ускорений, новых слотов и особенных вещей</p></div>
        <div className={styles.packages}>{PEARL_SHOP_PACKAGES.map((pack, index) => <article className={styles.package} key={pack.id} data-shop-offer={`pearls-${pack.id}`}>
          <CurrencyPile kind="pearls" tier={index} /><h4>{pack.name}</h4>
          <strong className={styles.amount}><ItemIcon itemId="pearls" size={21} />{number(pack.pearls)}</strong>
          <button type="button" disabled aria-describedby={`${id}-preview`}>Скоро</button>
        </article>)}</div>
      </> : <>
        <div className={styles.heading}><h3>Золото за жемчуг</h3><p>Чем больше полянка, тем щедрее обмен</p></div>
        {state && development ? <>
          <div className={styles.development}>
            <strong>Ваш бонус <span>+{development.bonusPercent}%</span></strong>
            <div><span><House size={15} aria-hidden="true" />Дом {development.homeLevel} ур. <b>+{development.homeBonusPercent}%</b></span>
              <span><Sprout size={15} aria-hidden="true" />Постройки <b>+{development.buildingBonusPercent}%</b></span></div>
            <details><summary>Как растёт бонус</summary><p>За дом: +0 / 50 / 150 / 300 / 600% на уровнях 1–5. За завершённые уровни остальных построек: ещё до +100%. Сейчас {development.completedLevels} из {development.totalLevels}. Бонусы складываются; стройка в процессе пока не учитывается.</p></details>
          </div>
          <div className={styles.packages} data-gold="true">{currencyShopGoldOffers(state).map((pack, index) => <article className={styles.package} key={pack.id} data-shop-offer={`gold-${pack.id}`}>
            <CurrencyPile kind="coins" tier={index + 1} /><h4>{pack.name}</h4>
            <strong className={styles.amount}><ItemIcon itemId="coins" size={22} />{number(pack.coins)}</strong>
            <small className={styles.bonus}>{number(pack.baseCoins)} + {number(pack.bonusCoins)} бонус</small>
            <div className={styles.exchange}><ItemIcon itemId="pearls" size={18} /><span>{number(pack.pearls)}</span><ArrowRight size={14} aria-hidden="true" /><span>золото</span></div>
            <button type="button" disabled aria-describedby={`${id}-preview`}>Обмен скоро</button>
          </article>)}</div>
        </> : <p className={styles.loading} role="status">Загружаем полянку, чтобы рассчитать ваш бонус…</p>}
      </>}
    </div>
  </section>;
}
