"use client";

import { useId, useRef, useState } from "react";
import { Clock3, CookingPot, Hammer, RefreshCw, Utensils } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyView } from "./model";
import type { EconomyController } from "./use-economy";
import { ECONOMY_MAX_BALANCE } from "./money";
import { foodState, residentOrderBoard } from "./food";
import { economyActorConflict } from "./actor-availability";
import { itemName, locked, number, ProductIcon, type ReadyEconomy } from "./world-economy-parts";
import { worldDuration, worldMissingRequirements, worldRequirements } from "./world-stations";
import styles from "./world-food-menu.module.css";

export type WorldFoodMenuProps = {
  economy: EconomyController;
  initialTab?: "meals" | "orders";
  residentId?: "plesk" | "builder";
  onNavigateStation?: (stationId: string, recipeId?: string) => void;
};
type Consumer = "hero" | "builder";
type Order = ReturnType<typeof residentOrderBoard>["offers"][number];
type Meal = NonNullable<EconomyView["catalog"]["food"]>["meals"][number];
const residentNames = { plesk: "Плёска", builder: "Шишколап" };
const remaining = (at: string, now: number) => Math.max(0, Math.ceil((Date.parse(at) - now) / 1000));
const waiting = (seconds: number) => seconds < 60 ? `${seconds} с` : worldDuration(seconds);

function foodRecipe(state: EconomyView, itemId: string) {
  const recipes = state.catalog.recipes.filter(recipe => (recipe.rewards[itemId] ?? 0) > 0);
  return recipes.find(recipe => !worldMissingRequirements(state, worldRequirements(recipe, recipe)).length) ?? recipes[0];
}

/** This status explains the one explicit meal debit without introducing hunger. */
export function mealBlockedReason(economy: ReadyEconomy, consumer: Consumer) {
  const state = economy.snapshot, food = foodState(state);
  if (consumer === "hero") {
    if (food.heroMeal) return "Мохлик уже сыт: обед поможет в следующей вылазке.";
    return economyActorConflict(state.jobs, "departure", economy.now)?.message ?? null;
  }
  const construction = state.jobs.find(job => job.kind === "construction");
  if (construction) {
    if (Date.parse(construction.finishesAt) <= economy.now) return "Сначала завершите готовую стройку.";
    if (construction.meal) return "Шишколап уже сыт: текущая стройка ускорена.";
  }
  return food.builderMeal ? "Обед Шишколапа сохранён для следующей стройки." : null;
}

export function FoodMealCard({ economy, meal, consumer, onNavigateStation }: Pick<WorldFoodMenuProps, "onNavigateStation"> & { economy: ReadyEconomy; meal: Meal; consumer: Consumer }) {
  const state = economy.snapshot, stock = state.inventory[meal.itemId] ?? 0;
  const recipe = foodRecipe(state, meal.itemId), reason = mealBlockedReason(economy, consumer);
  const speed = (consumer === "hero" ? meal.heroSpeedBps : meal.builderSpeedBps) / 100;
  const action = consumer === "hero" ? "eat_food" : "feed_builder";
  return <article className={styles.meal} data-meal={meal.itemId}>
    <span className={styles.mealIcon}><ProductIcon state={state} itemId={meal.itemId} size={30} /></span>
    <div className={styles.mealDescription}><h3>{itemName(state, meal.itemId)}</h3><p>{consumer === "hero" ? "Скорость вылазки" : "Скорость стройки"} +{number(speed)}%</p><small>В кладовой: {number(stock)}</small></div>
    {stock > 0 ? <button type="button" className={styles.primary} disabled={locked(economy) || !!reason} aria-label={`${consumer === "hero" ? "Съесть" : "Угостить Шишколапа"}: ${itemName(state, meal.itemId)}, 1 порция`} onClick={() => {
      if (locked(economy) || reason || (economy.snapshot.inventory[meal.itemId] ?? 0) < 1) return;
      void economy.act(action, meal.itemId, 1, 0);
    }}>{consumer === "hero" ? "Съесть" : "Угостить"}</button> : recipe && onNavigateStation ? <button type="button" className={styles.secondary} aria-label={`Приготовить: ${itemName(state, meal.itemId)}`} onClick={() => onNavigateStation(recipe.buildingId, recipe.id)}>Готовить</button> : <span className={styles.muted}>Нет запаса</span>}
  </article>;
}

export function ResidentOrderCard({ economy, offer, onNavigateStation }: Pick<WorldFoodMenuProps, "onNavigateStation"> & { economy: ReadyEconomy; offer: Order }) {
  const state = economy.snapshot;
  const cooldown = remaining(offer.availableAt, economy.now);
  const missing = Object.entries(offer.items).some(([id, quantity]) => (state.inventory[id] ?? 0) < quantity);
  const walletFull = state.wallet.coins > ECONOMY_MAX_BALANCE - offer.coins;
  const current = () => residentOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog).offers.some(order => order.id === offer.id);
  return <article className={styles.order} data-order-id={offer.id}>
    <header className={styles.orderHeading}><div><span>{residentNames[offer.residentId]}</span><h3>{offer.name}</h3></div><strong className={styles.payout} aria-label={`Награда: ${number(offer.coins)} монет`}><ItemIcon itemId="coins" size={20} />{number(offer.coins)}</strong></header>
    <ul className={styles.ingredients} aria-label="Для заказа">{Object.entries(offer.items).map(([id, quantity]) => {
      const owned = state.inventory[id] ?? 0, short = owned < quantity, recipe = short ? foodRecipe(state, id) : null;
      const label = <><ProductIcon state={state} itemId={id} size={22} /><span>{itemName(state, id)}</span><strong>{number(owned)} / {number(quantity)}</strong></>;
      return <li key={id} data-missing={short || undefined}>{recipe && onNavigateStation ? <button type="button" aria-label={`Приготовить для заказа: ${itemName(state, id)}`} onClick={() => onNavigateStation(recipe.buildingId, recipe.id)}>{label}</button> : <div>{label}</div>}</li>;
    })}</ul>
    <div className={styles.orderActions}><button type="button" className={styles.primary} disabled={locked(economy) || cooldown > 0 || missing || walletFull} onClick={() => {
      if (locked(economy) || cooldown > 0 || missing || walletFull || !current()) return;
      void economy.act("complete_resident_order", offer.id, 1, 0);
    }}>Отдать заказ</button><button type="button" className={styles.secondary} disabled={locked(economy) || cooldown > 0} aria-label={`Заменить заказ: ${offer.name}`} onClick={() => {
      if (locked(economy) || cooldown > 0 || !current()) return;
      void economy.act("replace_resident_order", offer.id, 1, 0);
    }}><RefreshCw size={14} aria-hidden="true" />Заменить</button></div>
    {cooldown > 0 ? <p className={styles.muted}><Clock3 size={12} aria-hidden="true" />Доступен через {waiting(cooldown)}</p> : walletFull ? <p className={styles.warning}>В кошельке нет места для награды.</p> : missing && <p className={styles.muted}>Красным отмечено, чего не хватает.</p>}
  </article>;
}

/** Content only; WorldView supplies the compact dialog frame and scroll area. */
export function WorldFoodMenu({ economy, initialTab = "meals", residentId, onNavigateStation }: WorldFoodMenuProps) {
  const [tab, setTab] = useState(initialTab);
  const [consumer, setConsumer] = useState<Consumer>(residentId === "builder" ? "builder" : "hero");
  const tabId = useId(), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const state = economy.snapshot, retrySeconds = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const recovery = (economy.error || economy.uncertain) && <div className={styles.error} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Новые действия станут доступны после подтверждения." : economy.error}</p><button type="button" disabled={economy.busy || retrySeconds > 0} onClick={() => { if (!economy.busy && retrySeconds <= 0) void economy.retry(); }}><RefreshCw size={14} aria-hidden="true" />{retrySeconds ? `Повторить через ${retrySeconds} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button></div>;
  if (!state) return <div className={styles.food}>{recovery || <p role="status">Открываем кухню…</p>}</div>;
  const readyEconomy = { ...economy, snapshot: state }, config = state.catalog.food;
  if (!config) return <div className={styles.food}>{recovery}<p>Кухня пока недоступна.</p></div>;
  const food = foodState(state), board = residentOrderBoard(state, economy.now, state.catalog);
  const reason = mealBlockedReason(readyEconomy, consumer);
  const pending = consumer === "hero" ? food.heroMeal : food.builderMeal;
  const active = state.jobs.find(job => job.meal?.consumer === consumer);
  const offers = [...board.offers].sort((a, b) => Number(b.residentId === residentId) - Number(a.residentId === residentId) || a.slot - b.slot);
  const sections = [{ id: "meals", name: "Еда", icon: Utensils }, { id: "orders", name: "Заказы", icon: CookingPot }] as const;
  return <div className={styles.food} aria-busy={economy.busy || undefined}>
    {recovery}
    <nav className={styles.tabs} role="tablist" aria-label="Еда и заказы">{sections.map((section, index) => <button key={section.id} ref={element => { tabs.current[index] = element; }} type="button" role="tab" id={`${tabId}-${section.id}`} aria-controls={`${tabId}-content`} aria-selected={tab === section.id} tabIndex={tab === section.id ? 0 : -1} onClick={() => setTab(section.id)} onKeyDown={event => {
      const next = event.key === "ArrowRight" ? (index + 1) % sections.length : event.key === "ArrowLeft" ? (index + sections.length - 1) % sections.length : event.key === "Home" ? 0 : event.key === "End" ? sections.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); setTab(sections[next].id); tabs.current[next]?.focus({ preventScroll: true });
    }}><section.icon size={16} aria-hidden="true" />{section.name}</button>)}</nav>
    <section className={styles.content} id={`${tabId}-content`} role="tabpanel" aria-labelledby={`${tabId}-${tab}`}>
      {tab === "meals" ? <>
        <div className={styles.consumers} role="group" aria-label="Кого угостить"><button type="button" aria-pressed={consumer === "hero"} onClick={() => setConsumer("hero")}><Utensils size={14} aria-hidden="true" />Мохлик</button><button type="button" aria-pressed={consumer === "builder"} onClick={() => setConsumer("builder")}><Hammer size={14} aria-hidden="true" />Шишколап</button></div>
        <p className={styles.summary}>{pending ? `${itemName(state, pending)}: бонус сохранён для следующей ${consumer === "hero" ? "вылазки" : "стройки"}.` : active ? `${itemName(state, active.meal!.itemId)}: скорость ${consumer === "hero" ? "вылазки" : "стройки"} +${number(active.meal!.speedBps / 100)}%.` : consumer === "hero" ? "Один обед ускорит следующую вылазку или рыбалку." : "Обед даст +10% к скорости текущей или следующей стройки."}</p>
        {reason && !pending && (!active || Date.parse(active.finishesAt) <= economy.now) && <p className={styles.warning}>{reason}</p>}
        <div className={styles.meals}>{config.meals.map(meal => <FoodMealCard key={meal.itemId} economy={readyEconomy} meal={meal} consumer={consumer} onNavigateStation={onNavigateStation} />)}</div>
        <p className={styles.muted}>Угощение расходует 1 порцию. Сытость не складывается и не убывает, пока вы не играете.</p>
      </> : <>
        <div className={styles.boardSummary}><p>Все заказы обновятся через <strong>{waiting(remaining(board.refreshAt, economy.now))}</strong></p><small>В {new Date(board.refreshAt).toISOString().slice(11, 16)} UTC</small></div>
        <div className={styles.orders}>{offers.map(offer => <ResidentOrderCard key={offer.id} economy={readyEconomy} offer={offer} onNavigateStation={onNavigateStation} />)}</div>
        {!offers.length && <p className={styles.summary}>Новые просьбы появятся после обустройства костра.</p>}
        <p className={styles.muted}>Замена бесплатна: новый заказ ждёт {worldDuration(config.orders.replacementSeconds)}. После сдачи — {worldDuration(config.orders.completionSeconds)}. Награда — только монеты.</p>
      </>}
    </section>
  </div>;
}
