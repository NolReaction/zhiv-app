"use client";

import { useId, useRef, useState } from "react";
import { ClipboardList, Hammer, RefreshCw, Utensils } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { foodState } from "@/features/economy/domain/food";
import { mealBlockedReason } from "./meal-availability";
import { ResidentOrderBoard, type OrderNavigation } from "./world-resident-order-board";
export { mealBlockedReason } from "./meal-availability";
export { ResidentOrderCard } from "./world-resident-order-board";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { itemName, number, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import { worldMissingRequirements, worldRequirements } from "@/features/economy/ui/shared/world-stations";
import styles from "./world-food-menu.module.css";

export type WorldFoodMenuProps = OrderNavigation & {
  economy: EconomyController;
  initialTab?: "meals" | "orders";
  residentId?: "plesk" | "builder";
};
type Consumer = "hero" | "builder";
type Meal = NonNullable<EconomyView["catalog"]["food"]>["meals"][number];

function foodRecipe(state: EconomyView, itemId: string) {
  const recipes = state.catalog.recipes.filter(recipe => (recipe.rewards[itemId] ?? 0) > 0);
  return recipes.find(recipe => !worldMissingRequirements(state, worldRequirements(recipe, recipe)).length) ?? recipes[0];
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

/** Content only; WorldView supplies the compact dialog frame and scroll area. */
export function WorldFoodMenu({ economy, initialTab = "meals", residentId, onNavigateStation, onNavigateExpeditions }: WorldFoodMenuProps) {
  const [tab, setTab] = useState(initialTab);
  const [consumer, setConsumer] = useState<Consumer>(residentId === "builder" ? "builder" : "hero");
  const tabId = useId(), tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const state = economy.snapshot, retrySeconds = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const recovery = (economy.error || economy.uncertain) && <div className={styles.error} role="alert"><p>{economy.uncertain ? "Проверяем последнее действие. Новые действия станут доступны после подтверждения." : economy.error}</p><button type="button" disabled={economy.busy || retrySeconds > 0} onClick={() => { if (!economy.busy && retrySeconds <= 0) void economy.retry(); }}><RefreshCw size={14} aria-hidden="true" />{retrySeconds ? `Повторить через ${retrySeconds} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button></div>;
  if (!state) return <div className={styles.food}>{recovery || <p role="status">Открываем кухню…</p>}</div>;
  const readyEconomy = { ...economy, snapshot: state }, config = state.catalog.food;
  if (!config) return <div className={styles.food}>{recovery}<p>Кухня пока недоступна.</p></div>;
  const food = foodState(state);
  const reason = mealBlockedReason(readyEconomy, consumer);
  const pending = consumer === "hero" ? food.heroMeal : food.builderMeal;
  const active = state.jobs.find(job => job.meal?.consumer === consumer);
  const sections = [{ id: "meals", name: "Еда", icon: Utensils }, { id: "orders", name: "Заказы", icon: ClipboardList }] as const;
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
        <p className={styles.summary}>{pending ? `${itemName(state, pending)}: бонус сохранён для следующей ${consumer === "hero" ? "вылазки" : "стройки"}.` : active ? `${itemName(state, active.meal!.itemId)}: скорость ${consumer === "hero" ? "вылазки" : "стройки"} +${number(active.meal!.speedBps / 100)}%.` : consumer === "hero" ? "Один обед ускорит следующую вылазку или рыбалку." : "Обед ускорит текущую или следующую стройку. Бонус зависит от блюда."}</p>
        {reason && !pending && (!active || Date.parse(active.finishesAt) <= economy.now) && <p className={styles.warning}>{reason}</p>}
        <div className={styles.meals}>{config.meals.map(meal => <FoodMealCard key={meal.itemId} economy={readyEconomy} meal={meal} consumer={consumer} onNavigateStation={onNavigateStation} />)}</div>
        <p className={styles.muted}>Угощение расходует 1 порцию. Сытость не складывается и не убывает, пока вы не играете.</p>
      </> : <ResidentOrderBoard economy={readyEconomy} residentId={residentId} onNavigateStation={onNavigateStation} onNavigateExpeditions={onNavigateExpeditions} />}
    </section>
  </div>;
}
