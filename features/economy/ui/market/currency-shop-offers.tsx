"use client";

import { useState } from "react";
import { Check, Gift, House, Palette, Sparkles } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import { storefrontCostumes, storefrontStarterOffer } from "@/features/economy/domain/storefront";
import { formatPearls } from "@/features/economy/domain/money";
import { worldRecipeDuration } from "@/features/economy/ui/stations/world-recipe-groups";
import { ItemIcon } from "@/features/items/item-icon";
import { premiumCostumes } from "@/features/world/domain/premium-costumes";
import { WardrobePreview } from "@/features/world/ui/wardrobe/world-wardrobe";
import styles from "./currency-shop-panel.module.css";

const number = (value: number) => value.toLocaleString("ru-RU");

/** The contents are display-only. No client grant or purchase command is available. */
export function StarterOffer({ state, previewId }: { state: EconomyView | null; previewId: string }) {
  const offer = storefrontStarterOffer(state);
  if (!state || !offer) return <p className={styles.loading} role="status">Загружаем полянку, чтобы подобрать набор для вашего дома…</p>;
  return <article className={styles.starter} data-shop-offer={offer.id} data-home-level={offer.homeLevel}>
    <div className={styles.starterTop}><span className={styles.homeTag}><House size={14} aria-hidden="true" />Дом {offer.homeLevel} ур.</span><span className={styles.limit}>Один раз на уровень дома</span></div>
    <div className={styles.starterHero}>
      <div className={styles.parcel} aria-hidden="true"><Gift size={62} strokeWidth={1.3} /><Sparkles size={22} /></div>
      <div><span className={styles.eyebrow}>Набор для нового этапа</span><h3>{offer.name}</h3><p>{offer.description}</p></div>
    </div>
    <div className={styles.starterCurrencies} aria-label="Валюты в наборе">
      <div><ItemIcon itemId="pearls" size={32} /><span><strong>{formatPearls(offer.rewards.pearls)}</strong><small>жемчужин</small></span></div>
      <div><ItemIcon itemId="coins" size={32} /><span><strong>{number(offer.rewards.coins)}</strong><small>монет</small></span></div>
    </div>
    <ul className={styles.starterItems} aria-label="Предметы в наборе">{Object.entries(offer.rewards.items).map(([itemId, quantity]) => {
      const name = state.catalog.items.find(item => item.id === itemId)?.name ?? itemId;
      const meal = state.catalog.food?.meals.find(entry => entry.itemId === itemId);
      return <li key={itemId}><span className={styles.rewardIcon}><ItemIcon itemId={itemId} size={34} /></span><span><strong>{name}</strong>{meal && <><small>Скорость: вылазка +{meal.heroSpeedBps / 100}% · стройка +{meal.builderSpeedBps / 100}%</small>{meal.heroWorkSeconds && <small>Запас на {worldRecipeDuration(meal.heroWorkSeconds)} работы Мохлика</small>}</>}</span><b>×{quantity}</b></li>;
    })}</ul>
    <p className={styles.foodNote}>Блюдо ускоряет работу Мохлика или одну стройку. Запас сил и скорость указаны в меню еды; бонусы не складываются.</p>
    <button className={styles.offerPrice} type="button" disabled aria-describedby={previewId}><span>{number(offer.priceRub)} ₽</span><small>Скоро</small></button>
    <p className={styles.stageNote}>{state.catalog.buildings.find(building => building.id === "home")?.levels.some(level => level.level > offer.homeLevel)
      ? "После улучшения дома здесь появится новый набор." : "Набор для последнего уровня дома."}</p>
  </article>;
}

/** A fitting only: selecting an outfit neither owns it nor changes the player. */
export function CostumeOffers({ previewId }: { previewId: string }) {
  const offers = storefrontCostumes();
  const [selectedId, setSelectedId] = useState(offers[0]?.id);
  const selected = offers.find(offer => offer.id === selectedId) ?? offers[0];
  const outfit = premiumCostumes.find(entry => entry.id === selected?.outfitId);
  if (!selected || !outfit) return null;
  return <section className={styles.costumes} aria-label="Особые костюмы">
    <div className={styles.heading}><h3>Свой характер</h3><p>Целый образ для Мохлика. Только внешний вид.</p></div>
    <article className={styles.costumeFeature} data-costume={selected.outfitId} data-shop-offer={selected.id}>
      <div className={styles.costumeMirror}><Sparkles size={17} aria-hidden="true" /><WardrobePreview appearance={outfit.appearance} /><span>Примерка</span></div>
      <div className={styles.costumeDescription}><span className={styles.eyebrow}>Особый образ</span><h4>{selected.name}</h4><p>{selected.description}</p><span className={styles.cosmetic}><Palette size={13} aria-hidden="true" />Без игровых бонусов</span></div>
      <button className={styles.offerPrice} type="button" disabled aria-describedby={previewId}><span>{number(selected.priceRub)} ₽</span><small>Скоро</small></button>
    </article>
    <div className={styles.costumeChoices} role="group" aria-label="Примерить костюм">{offers.map(offer => {
      const preview = premiumCostumes.find(entry => entry.id === offer.outfitId);
      if (!preview) return null;
      return <button type="button" key={offer.id} className={styles.costumeChoice} aria-pressed={selected.id === offer.id} aria-label={`Примерить: ${offer.name}`} onClick={() => setSelectedId(offer.id)}>
        <span className={styles.costumeThumb}><WardrobePreview appearance={preview.appearance} />{selected.id === offer.id && <Check size={14} aria-hidden="true" />}</span><strong>{offer.name}</strong><small>{number(offer.priceRub)} ₽</small>
      </button>;
    })}</div>
  </section>;
}
