"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { ArrowRight, Check, Clock3, Soup, X } from "lucide-react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { mealDuration, pendingMeal } from "@/features/economy/domain/food";
import { mealBlockedReason, type MealConsumer } from "./meal-availability";
import { locked } from "@/features/economy/sync/controller-state";
import { itemName, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration, worldMissingRequirements, worldRequirements } from "@/features/economy/ui/shared/world-stations";
import styles from "./world-meal-boost.module.css";

export type WorldMealBoostProps = {
  economy: EconomyController;
  consumer: MealConsumer;
  /** Base duration before eating. Active construction uses its saved job timer. */
  seconds?: number;
  jobId?: string;
  stationId?: string;
  isOnline?: boolean;
  onNavigateStation?: (stationId: string, recipeId?: string) => void;
  onOpenMeals?: () => void;
};
type Quote = { owner: string; revision: number; consumer: MealConsumer; jobId?: string; stationId?: string };

export function mealBoostReason({ economy, consumer, jobId, isOnline }: WorldMealBoostProps) {
  const state = economy.snapshot;
  if (!state) return "Загружаем запасы…";
  if (isOnline === false) return "Подключитесь к интернету, чтобы использовать еду.";
  if (economy.uncertain) return "Сначала подтвердите последнее действие.";
  if (economy.busy) return "Подтверждаем действие…";
  if (economy.retryAt > economy.now) return "Дождитесь повторной проверки.";
  if (consumer === "builder") {
    const active = state.jobs.find(job => job.kind === "construction");
    if (jobId && active?.id !== jobId) return "Стройка изменилась. Откройте её заново.";
    if (!jobId && active) return "Строитель занят. Угостить его можно у текущей стройки.";
  }
  return mealBlockedReason({ ...economy, snapshot: state }, consumer);
}

/** Whole seconds for display; an active construction divides its remaining milliseconds. */
export function mealBoostSeconds({ economy, seconds, jobId }: Pick<WorldMealBoostProps, "economy" | "seconds" | "jobId">, speedBps: number) {
  if (jobId) {
    const job = economy.snapshot?.jobs.find(job => job.kind === "construction" && job.id === jobId);
    if (!job) return null;
    const milliseconds = Math.max(0, Math.ceil(Date.parse(job.finishesAt) - economy.now));
    return Number.isSafeInteger(milliseconds) ? Math.ceil(mealDuration(milliseconds, speedBps) / 1000) : null;
  }
  return seconds !== undefined && Number.isSafeInteger(seconds) && seconds >= 0 ? mealDuration(seconds, speedBps) : null;
}

const duration = (seconds: number) => seconds < 60 ? `${seconds} с` : worldDuration(seconds);

/** A meal is chosen deliberately. Opening and previewing never spend or start a job. */
export function WorldMealBoost(props: WorldMealBoostProps) {
  const { economy, consumer, jobId, stationId, onNavigateStation, onOpenMeals } = props;
  const [quote, setQuote] = useState<Quote | null>(null);
  const sent = useRef<Quote | null>(null), navigating = useRef(false);
  const latest = useRef({ props, quote });
  const trigger = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null), savedBadge = useRef<HTMLSpanElement>(null);
  const headingId = useId();
  useLayoutEffect(() => { latest.current = { props, quote }; }, [props, quote]);
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) sent.current = null;
  }, [economy.busy, economy.uncertain, economy.error, economy.snapshot?.ownerPublicId, economy.snapshot?.revision]);
  const state = economy.snapshot, meals = state?.catalog.food?.meals;
  if (!state || !meals?.length) return null;
  const active = jobId ? state.jobs.find(job => job.kind === "construction" && job.id === jobId) : null;
  const pending = pendingMeal(state, consumer);
  const applied = active?.meal?.consumer === consumer ? active.meal : null;
  const saved = applied ?? (pending ? { itemId: pending.itemId, speedBps: consumer === "hero" ? pending.heroSpeedBps : pending.builderSpeedBps } : null);
  const reason = mealBoostReason(props);
  const open = Boolean(quote && quote.owner === state.ownerPublicId && quote.revision === state.revision && quote.consumer === consumer && quote.jobId === jobId && quote.stationId === stationId);
  const baseSeconds = mealBoostSeconds(props, 0);
  function consume(itemId: string) {
    const current = latest.current;
    if (!quote || current.quote !== quote || sent.current === quote || mealBoostReason(current.props)) return;
    const snapshot = current.props.economy.snapshot;
    if (!snapshot || snapshot.ownerPublicId !== quote.owner || snapshot.revision !== quote.revision || current.props.consumer !== quote.consumer
      || current.props.jobId !== quote.jobId || current.props.stationId !== quote.stationId || (snapshot.inventory[itemId] ?? 0) < 1
      || !snapshot.catalog.food?.meals.some(meal => meal.itemId === itemId)) return;
    sent.current = quote;
    void current.props.economy.act(consumer === "hero" ? "eat_food" : "feed_builder", itemId, 1, 0);
  }
  if (saved) return <span ref={savedBadge} tabIndex={-1} className={styles.saved} data-meal-boost={consumer} data-meal-applied={saved.itemId}
    title={`${itemName(state, saved.itemId)} · ${applied ? "текущая" : "следующая"} ${consumer === "hero" ? "вылазка" : "стройка"}`} aria-label={`${itemName(state, saved.itemId)}: скорость +${saved.speedBps / 100}%`}>
    <Soup size={17} aria-hidden="true" /><span>+{saved.speedBps / 100}%</span><Check size={12} aria-hidden="true" />
  </span>;
  return <Popover.Root open={open} onOpenChange={value => {
    if (!value) setQuote(null);
    else if (!mealBoostReason(latest.current.props) && latest.current.props.economy.snapshot) {
      const current = latest.current.props.economy.snapshot;
      navigating.current = false;
      setQuote({ owner: current.ownerPublicId, revision: current.revision, consumer, jobId, stationId });
    }
  }}>
    <Popover.Trigger asChild><button ref={trigger} type="button" className={styles.trigger} data-meal-boost={consumer} disabled={Boolean(reason)}
      aria-label={reason ?? (consumer === "hero" ? "Еда: ускорить вылазку" : "Еда: ускорить стройку")} title={reason ?? "Ускорить едой"}>
      <Soup size={18} aria-hidden="true" /><span>Еда</span>
    </button></Popover.Trigger>
    {open && <Popover.Portal><Popover.Content className={styles.picker} data-meal-picker={consumer} side="top" align="end" sideOffset={7} collisionPadding={12}
      aria-labelledby={headingId} onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus({ preventScroll: true }); }}
      onEscapeKeyDown={event => event.stopPropagation()} onCloseAutoFocus={event => {
        event.preventDefault(); if (navigating.current) return; const target = trigger.current?.isConnected ? trigger.current : savedBadge.current; target?.focus({ preventScroll: true });
      }} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <header className={styles.heading}><div><h3 ref={heading} tabIndex={-1} id={headingId}>{consumer === "hero" ? "Обед перед вылазкой" : jobId ? "Обед для строителя" : "Обед перед стройкой"}</h3><p>Расходуется 1 готовое блюдо</p></div><Popover.Close asChild><button type="button" data-meal-picker-close aria-label="Закрыть выбор еды"><X size={17} aria-hidden="true" /></button></Popover.Close></header>
      {reason && <p className={styles.reason} role="status">{reason}</p>}
      <div className={styles.meals} aria-label="Готовые блюда">{meals.map(meal => {
        const stock = state.inventory[meal.itemId] ?? 0;
        const speed = consumer === "hero" ? meal.heroSpeedBps : meal.builderSpeedBps;
        const result = mealBoostSeconds(props, speed);
        const recipes = state.catalog.recipes.filter(recipe => (recipe.rewards[meal.itemId] ?? 0) > 0);
        const recipe = recipes.find(recipe => !worldMissingRequirements(state, worldRequirements(recipe, recipe)).length) ?? recipes[0];
        const cook = recipe && onNavigateStation ? () => onNavigateStation(recipe.buildingId, recipe.id) : onOpenMeals;
        return <article key={meal.itemId} className={styles.meal} data-boost-meal={meal.itemId}>
          <ProductIcon state={state} itemId={meal.itemId} size={28} />
          <div className={styles.description}><strong>{itemName(state, meal.itemId)}</strong><span>Скорость +{speed / 100}% · есть {stock}</span>{result !== null && baseSeconds !== null && <small><Clock3 size={11} aria-hidden="true" />{duration(baseSeconds)}<ArrowRight size={10} aria-hidden="true" /><b>{duration(result)}</b></small>}</div>
          {stock > 0 ? <button type="button" className={styles.consume} disabled={locked(economy) || Boolean(reason)} aria-label={`${consumer === "hero" ? "Съесть" : "Угостить строителя"}: ${itemName(state, meal.itemId)}, 1 порция`} onClick={() => consume(meal.itemId)}>{consumer === "hero" ? "Съесть 1" : "Угостить 1"}</button>
            : cook ? <button type="button" className={styles.cook} aria-label={`Приготовить: ${itemName(state, meal.itemId)}`} onClick={() => { navigating.current = true; setQuote(null); cook(); }}>Готовить</button> : <span className={styles.empty}>Нет</span>}
        </article>;
      })}</div>
      <p className={styles.note}>{jobId ? "Ускорит оставшееся время этой стройки." : `Бонус останется до следующей ${consumer === "hero" ? "вылазки" : "стройки"}.`} Повторный обед не усилит бонус.</p>
    </Popover.Content></Popover.Portal>}
  </Popover.Root>;
}
