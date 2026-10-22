"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { ArrowRight, Check, ChevronRight, Clock3, Soup, X } from "lucide-react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { mealDuration, pendingMeal } from "@/features/economy/domain/food";
import { isMinerJob } from "@/features/economy/domain/actor-availability";
import { availableMealRecipe, mealBlockedReason, visibleMeals, type MealConsumer } from "./meal-availability";
import { locked } from "@/features/economy/sync/controller-state";
import { itemName, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration } from "@/features/economy/ui/shared/world-stations";
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

export function mealReturnReason({ economy, consumer, isOnline }: WorldMealBoostProps) {
  if (!economy.snapshot || economy.snapshotConfirmed !== true) return "Дождитесь загрузки хозяйства.";
  if (isOnline === false || typeof navigator !== "undefined" && navigator.onLine === false) return "Подключитесь к интернету, чтобы забрать блюдо.";
  if (economy.uncertain) return "Сначала подтвердите последнее действие.";
  if (economy.busy) return "Подтверждаем действие…";
  if (economy.retryAt > economy.now) return "Дождитесь повторной проверки.";
  if (locked(economy)) return "Дождитесь подтверждения остальных действий.";
  return pendingMeal(economy.snapshot, consumer) ? null : "Это блюдо уже использовано.";
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
  const { economy, consumer, jobId, stationId, onNavigateStation } = props;
  const [quote, setQuote] = useState<Quote | null>(null);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<{ quote: Quote; observed: boolean; error: string | null } | null>(null);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const sent = useRef<Quote | null>(null), selection = useRef<string | null>(null), navigating = useRef(false);
  const latest = useRef({ props, quote });
  const trigger = useRef<HTMLButtonElement>(null), heading = useRef<HTMLHeadingElement>(null), savedBadge = useRef<HTMLSpanElement>(null);
  const headingId = useId();
  useLayoutEffect(() => { latest.current = { props, quote }; }, [props, quote]);
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) sent.current = null;
  }, [economy.busy, economy.uncertain, economy.error, economy.snapshot?.ownerPublicId, economy.snapshot?.revision]);
  const state = economy.snapshot;
  if (submitted && (!state || submitted.quote.owner !== state.ownerPublicId || submitted.quote.revision !== state.revision
    || !economy.busy && !economy.uncertain && (submitted.observed || submitted.error !== economy.error))) setSubmitted(null);
  else if (submitted && !submitted.observed && (economy.busy || economy.uncertain)) setSubmitted({ ...submitted, observed: true });
  if (!state || !state.catalog.food?.meals.length) return null;
  const meals = visibleMeals(state);
  const active = consumer === "builder" ? state.jobs.find(job => job.kind === "construction" && (!jobId || job.id === jobId))
    : state.jobs.find(job => job.kind === "exploration" && !isMinerJob(job) && job.meal?.consumer === "hero");
  const pending = pendingMeal(state, consumer);
  const applied = active?.meal?.consumer === consumer ? active.meal : null;
  const saved = applied ?? (pending ? { itemId: pending.itemId, speedBps: consumer === "hero" ? pending.heroSpeedBps : pending.builderSpeedBps } : null);
  if (!meals.length && !saved) return null;
  const reason = mealBoostReason(props);
  const open = Boolean(quote && quote.owner === state.ownerPublicId && quote.revision === state.revision && quote.consumer === consumer && quote.jobId === jobId && quote.stationId === stationId);
  const baseSeconds = applied && active ? Math.max(0, Math.ceil((Date.parse(active.finishesAt) - economy.now) / 1000)) : mealBoostSeconds(props, 0);
  const selected = meals.find(meal => meal.itemId === selectedItemId && (state.inventory[meal.itemId] ?? 0) > 0);
  const selectedSpeed = selected ? consumer === "hero" ? selected.heroSpeedBps : selected.builderSpeedBps : 0;
  const selectedSeconds = selected ? mealBoostSeconds(props, selectedSpeed) : null;
  const sending = submitted !== null;
  const feedback = reason ?? submissionError ?? economy.error;
  function choose(itemId: string) {
    const current = latest.current;
    if (!quote || current.quote !== quote || sent.current || mealBoostReason(current.props) || (current.props.economy.snapshot?.inventory[itemId] ?? 0) < 1) return;
    selection.current = itemId;
    setSelectedItemId(itemId);
    setSubmissionError(null);
  }
  function consume(itemId: string) {
    const current = latest.current;
    if (!quote || current.quote !== quote || selection.current !== itemId || sent.current || mealBoostReason(current.props)) return;
    const snapshot = current.props.economy.snapshot;
    if (!snapshot || snapshot.ownerPublicId !== quote.owner || snapshot.revision !== quote.revision || current.props.consumer !== quote.consumer
      || current.props.jobId !== quote.jobId || current.props.stationId !== quote.stationId || (snapshot.inventory[itemId] ?? 0) < 1
      || !snapshot.catalog.food?.meals.some(meal => meal.itemId === itemId)) return;
    sent.current = quote;
    setSubmitted({ quote, observed: false, error: current.props.economy.error });
    const accepted = current.props.economy.act(consumer === "hero" ? "eat_food" : "feed_builder", itemId, 1, 0);
    if (accepted === false) {
      sent.current = null;
      setSubmitted(null);
      setSubmissionError("Обед не отправлен. Попробуйте ещё раз.");
    } else setSubmissionError(null);
  }
  const returnReason = pending ? mealReturnReason(props) : null;
  const returnOwner = state.ownerPublicId, returnRevision = state.revision, returnItemId = pending?.itemId;
  function returnMeal() {
    const current = latest.current.props, snapshot = current.economy.snapshot;
    if (!returnItemId || sent.current || mealReturnReason(current) || !snapshot || snapshot.ownerPublicId !== returnOwner
      || snapshot.revision !== returnRevision || current.consumer !== consumer || current.jobId !== jobId || current.stationId !== stationId
      || pendingMeal(snapshot, consumer)?.itemId !== returnItemId) return;
    const attempt = { owner: snapshot.ownerPublicId, revision: snapshot.revision, consumer, jobId, stationId };
    sent.current = attempt;
    setSubmitted({ quote: attempt, observed: false, error: current.economy.error });
    if (current.economy.act("cancel_meal", consumer, 1, 0) === false) {
      sent.current = null;
      setSubmitted(null);
      setSubmissionError("Не удалось отправить возврат блюда. Попробуйте ещё раз.");
    } else setSubmissionError(null);
  }
  if (saved) return <span ref={savedBadge} tabIndex={-1} className={styles.saved} data-meal-boost={consumer} data-meal-applied={saved.itemId}
    title={`${itemName(state, saved.itemId)} · ${applied ? "текущая" : "следующая"} ${consumer === "hero" ? "вылазка" : "стройка"}`} aria-label={`${itemName(state, saved.itemId)}: скорость +${saved.speedBps / 100}%`}>
    <span className={styles.savedSummary}>
    <span className={styles.tileIcon}><ProductIcon state={state} itemId={saved.itemId} size={30} /></span>
    <span className={styles.tileDescription}><span className={styles.tileLabel}>{applied ? "Обед учтён" : `Для следующей ${consumer === "hero" ? "вылазки" : "стройки"}`}</span><strong>{itemName(state, saved.itemId)}<small>+{saved.speedBps / 100}% скорости</small></strong>
      {baseSeconds !== null && <span className={styles.tileDuration} data-meal-duration><Clock3 size={11} aria-hidden="true" />
        {applied ? duration(baseSeconds) : <>{duration(baseSeconds)}<ArrowRight size={10} aria-hidden="true" /><b>{duration(mealBoostSeconds(props, saved.speedBps) ?? baseSeconds)}</b></>}
      </span>}
    </span><Check className={styles.tileControl} size={17} aria-hidden="true" />
    </span>
    {applied && <span className={styles.savedNote} data-meal-used>Блюдо уже использовано в {consumer === "hero" ? "этой вылазке" : "этой стройке"}. Вернуть его нельзя.</span>}
    {pending && <span className={styles.returnMeal}>
      {applied && <span className={styles.pendingMeal} data-meal-pending={pending.itemId}><span>Для следующей {consumer === "hero" ? "вылазки" : "стройки"}</span><strong>{itemName(state, pending.itemId)}</strong></span>}
      <span className={styles.savedNote}>Неиспользованную порцию можно вернуть в кладовую.</span>
      <button type="button" className={styles.returnButton} data-meal-return={consumer} disabled={Boolean(returnReason) || sending}
        aria-label={`Забрать блюдо: ${itemName(state, pending.itemId)}`} onClick={returnMeal}>{sending ? "Возвращаем…" : "Забрать блюдо"}</button>
      {(returnReason ?? submissionError ?? economy.error) && <span className={styles.reason} role="status">{returnReason ?? submissionError ?? economy.error}</span>}
    </span>}
  </span>;
  return <Popover.Root open={open} onOpenChange={value => {
    if (!value) { selection.current = null; setSelectedItemId(null); setQuote(null); }
    else if (!sent.current && !mealBoostReason(latest.current.props) && latest.current.props.economy.snapshot) {
      const current = latest.current.props.economy.snapshot;
      navigating.current = false;
      selection.current = null;
      setSelectedItemId(null);
      setSubmissionError(null);
      setQuote({ owner: current.ownerPublicId, revision: current.revision, consumer, jobId, stationId });
    }
  }}>
    <Popover.Trigger asChild><button ref={trigger} type="button" className={styles.trigger} data-meal-boost={consumer} disabled={Boolean(reason) || sending}
      aria-label={reason ?? (consumer === "hero" ? "Еда: ускорить вылазку" : "Еда: ускорить стройку")} title={reason ?? "Ускорить едой"}>
      <span className={styles.tileIcon}><Soup size={24} aria-hidden="true" /></span>
      <span className={styles.tileDescription}><span className={styles.tileLabel}>Ускорение едой</span><strong>Выбрать блюдо</strong><small>{reason ?? "1 порция ускорит работу"}</small></span>
      <ChevronRight className={styles.tileControl} size={17} aria-hidden="true" />
    </button></Popover.Trigger>
    {open && <Popover.Portal><Popover.Content className={styles.picker} data-meal-picker={consumer} side="top" align="end" sideOffset={7} collisionPadding={12}
      aria-labelledby={headingId} onOpenAutoFocus={event => { event.preventDefault(); heading.current?.focus({ preventScroll: true }); }}
      onEscapeKeyDown={event => event.stopPropagation()} onCloseAutoFocus={event => {
        event.preventDefault(); if (navigating.current) return; const target = trigger.current?.isConnected ? trigger.current : savedBadge.current; target?.focus({ preventScroll: true });
      }} onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <header className={styles.heading}><div><h3 ref={heading} tabIndex={-1} id={headingId}>{consumer === "hero" ? "Обед перед вылазкой" : jobId ? "Обед для строителя" : "Обед перед стройкой"}</h3><p>{jobId ? "Ускорит оставшееся время" : "Бонус на одну работу"}</p></div><Popover.Close asChild><button type="button" data-meal-picker-close aria-label="Закрыть выбор еды"><X size={17} aria-hidden="true" /></button></Popover.Close></header>
      <div className={styles.meals} aria-label="Готовые блюда">{meals.map(meal => {
        const stock = state.inventory[meal.itemId] ?? 0;
        const speed = consumer === "hero" ? meal.heroSpeedBps : meal.builderSpeedBps;
        const recipe = availableMealRecipe(state, meal.itemId);
        const cook = recipe && onNavigateStation ? () => onNavigateStation(recipe.buildingId, recipe.id) : null;
        const chosen = selected?.itemId === meal.itemId;
        const content = <><span className={styles.mealIcon}><ProductIcon state={state} itemId={meal.itemId} size={28} /></span>
          <span className={styles.description}><strong>{itemName(state, meal.itemId)}</strong><small>{stock > 0 ? `В запасе ${stock}` : "Нет в запасе"}</small></span>
          <span className={styles.speed}>+{speed / 100}%</span></>;
        return <article key={meal.itemId} data-boost-meal={meal.itemId}>
          {stock > 0 ? <button type="button" className={styles.meal} data-selected={chosen || undefined} aria-pressed={chosen} disabled={locked(economy) || Boolean(reason) || sending}
            aria-label={`Выбрать: ${itemName(state, meal.itemId)}, в запасе ${stock}, скорость +${speed / 100}%`} onClick={() => choose(meal.itemId)}>{content}<span className={styles.selection} aria-hidden="true">{chosen && <Check size={13} />}</span></button>
            : cook ? <button type="button" className={`${styles.meal} ${styles.cook}`} disabled={sending} aria-label={`Приготовить: ${itemName(state, meal.itemId)}`} onClick={() => { if (sent.current) return; navigating.current = true; selection.current = null; setSelectedItemId(null); setQuote(null); cook(); }}>{content}<ChevronRight size={16} aria-hidden="true" /></button>
              : <span className={`${styles.meal} ${styles.unavailable}`}>{content}<span className={styles.empty}>Нет</span></span>}
        </article>;
      })}</div>
      <div className={styles.confirmation} aria-busy={sending}>
        {selected ? <div className={styles.preview} data-meal-preview={selected.itemId}>
          <span>{selectedSeconds !== null && baseSeconds !== null ? <>{jobId ? "Останется" : "Время"}<strong><s>{duration(baseSeconds)}</s><ArrowRight size={12} aria-hidden="true" /><b>{duration(selectedSeconds)}</b></strong></> : `Для следующей ${consumer === "hero" ? "вылазки" : "стройки"}`}</span>
          <span className={styles.bonus}>+{selectedSpeed / 100}% скорости</span>
        </div> : <p className={styles.hint}>Выберите блюдо · спишется 1 порция</p>}
        {feedback && <p className={styles.reason} role="status">{feedback}</p>}
        <button type="button" className={styles.consume} data-meal-confirm disabled={!selected || locked(economy) || Boolean(reason) || sending}
          aria-label={selected ? `${consumer === "hero" ? "Съесть" : "Угостить строителя"}: ${itemName(state, selected.itemId)}, 1 порция` : "Сначала выберите блюдо"}
          onClick={() => { if (selected) consume(selected.itemId); }}><Soup size={15} aria-hidden="true" />{sending ? "Подтверждаем…" : selected ? consumer === "hero" ? "Съесть 1 порцию" : "Угостить · 1 порция" : "Выберите блюдо"}</button>
      </div>
    </Popover.Content></Popover.Portal>}
  </Popover.Root>;
}
