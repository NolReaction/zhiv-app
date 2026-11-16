"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Clock3, Flame, LockKeyhole } from "lucide-react";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { locked, productionLocked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import type { WorldHelpContext } from "@/features/world/ui/help/world-help-types";
import { worldCostShortfalls, worldItemAvailable, worldRecipeCost, worldProductionReason, worldRecipeAccessReason, type WorldRecipe } from "@/features/economy/ui/shared/world-stations";
import { ProductIcon, itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import { worldRecipeDuration } from "@/features/economy/ui/stations/world-recipe-groups";
import { fishStockRequirements, fishSelectionMatches, type FishSelection } from "@/features/economy/domain/fish-stock";
import { canPrepareTutorialHarvest } from "@/features/economy/domain/tutorial-order";
import { tradeRelationBonusBps, tradeWorkDuration } from "@/features/economy/domain/trade-relations";
import { experimentDiscovered, skillForProduction, skillWorkDuration } from "@/features/economy/domain/craft-skill";
import { mealTimeExample, mealWorkDescription } from "@/features/economy/ui/food/meal-speed-description";
import { CookingExperimentTerms, cookingExperimentSummary } from "@/features/economy/ui/food/cooking-experiment-terms";
import { WorldFishSelection } from "@/features/economy/ui/fishing/world-fish-selection";
import { CookingExperimentIcon } from "@/features/items/item-icon";
import styles from "./world-production-card.module.css";

export function WorldProductionCard({ economy, recipe, focused = false, tutorialHarvestActive = false, onHelpContextChange, actionOnly = false }: {
  economy: ReadyEconomy;
  recipe: WorldRecipe;
  focused?: boolean;
  tutorialHarvestActive?: boolean;
  onHelpContextChange?: (context: WorldHelpContext) => void;
  /** The cookbook supplies its own ingredient/detail layout; command guards remain shared. */
  actionOnly?: boolean;
}) {
  const state = economy.productionSnapshot ?? economy.snapshot;
  const owner = state.ownerPublicId, revision = state.revision;
  const button = useRef<HTMLButtonElement>(null);
  const fishFocusOrigin = useRef<{ element: HTMLButtonElement | null; owner: string; recipeId: string } | null>(null);
  const pending = useRef<{ owner: string; revision: number; busySeen: boolean; previousError: string | null } | null>(null);
  const latest = useRef({ economy, recipe, tutorialHarvestActive });
  const [choosingFish, setChoosingFish] = useState(false);
  const [feedback, setFeedback] = useState<{ text: string; owner: string; revision: number; recipeId: string } | null>(null);
  const notice = feedback?.owner === state.ownerPublicId && feedback.revision === state.revision && feedback.recipeId === recipe.id ? feedback.text : "";
  const setNotice = (text: string) => setFeedback({ text, owner: state.ownerPublicId, revision: state.revision, recipeId: recipe.id });
  const noticeId = useId();
  const detailId = useId();
  const results = Object.entries(recipe.rewards);
  const undiscovered = Boolean(recipe.experiment && !experimentDiscovered(state, recipe));
  const title = undiscovered ? recipe.experiment!.title : results.length === 1 ? itemName(state, results[0][0]) : recipe.name.split(" · ")[0];
  const firstHarvest = tutorialHarvestActive && canPrepareTutorialHarvest(state, recipe.id);
  const tradeSpeedBps = recipe.buildingId === "woodlot" ? tradeRelationBonusBps(state, "lopukh", state.catalog, economy.now) : 0;
  const duration = firstHarvest ? "Сразу · первый урожай" : worldRecipeDuration(skillWorkDuration(state, skillForProduction(recipe.buildingId), recipe.buildingId === "woodlot"
    ? tradeWorkDuration(state, recipe.seconds, "lopukh", 0, state.catalog, economy.now) : recipe.seconds, state.catalog));
  const reason = worldProductionReason(state, recipe, 1);
  const accessReason = worldRecipeAccessReason(state, recipe);
  const recipeCost = worldRecipeCost(state, recipe);
  const costs = [...(recipeCost.coins > 0 ? [["coins", recipeCost.coins] as const] : []), ...Object.entries(recipeCost.items)];
  const hasFish = Object.keys(fishStockRequirements(recipe.cost.items, state.catalog.fishing)).length > 0;
  const durableProduction = !recipe.experiment && !firstHarvest && economy.productionQueueAvailable && !hasFish && !recipe.fishInput;
  const meal = state.catalog.food?.meals.find(entry => (recipe.rewards[entry.itemId] ?? 0) > 0);
  const restriction = reason && reason !== "Не хватает материалов или монет" ? reason : null;
  const description = [
    !undiscovered && (results.length > 1 || results.some(([, amount]) => amount !== 1))
      ? `Результат: ${results.map(([id, amount]) => `${itemName(state, id)} ×${number(amount)}`).join(", ")}.` : "",
    costs.length ? `Понадобится: ${costs.map(([id, amount]) => `${id === "coins" ? "Монеты" : itemName(state, id)} ×${number(amount)}`).join(", ")}.` : "",
    reason,
    firstHarvest ? "Первый учебный урожай созреет сразу. Сбор Мохликом остаётся обычным; помощь доступна один раз." : "",
    !undiscovered && meal ? `Пример: вылазка ${mealTimeExample(meal.heroSpeedBps, meal.heroWorkSeconds)}, стройка ${mealTimeExample(meal.builderSpeedBps, meal.builderWorkSeconds, "builder")}. ${mealWorkDescription(meal.heroWorkSeconds)}` : "",
  ].filter(Boolean).join(" ");
  const context = () => onHelpContextChange?.({ intent: "production", stationId: recipe.buildingId, recipeId: recipe.id, quantity: 1 });
  useLayoutEffect(() => { latest.current = { economy, recipe, tutorialHarvestActive }; }, [economy, recipe, tutorialHarvestActive]);
  useEffect(() => {
    if (focused) {
      button.current?.focus({ preventScroll: true });
      button.current?.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);
  useEffect(() => {
    if (!feedback) return;
    const timeout = setTimeout(() => setFeedback(null), 4_000);
    return () => clearTimeout(timeout);
  }, [feedback]);
  useEffect(() => {
    const intent = pending.current;
    if (!intent) return;
    if (economy.busy) intent.busySeen = true;
    if (state.ownerPublicId !== intent.owner || state.revision !== intent.revision
      || !economy.uncertain && !economy.busy && (intent.busySeen || economy.error && economy.error !== intent.previousError)) {
      pending.current = null;
      setFeedback(null);
    }
  }, [state.ownerPublicId, state.revision, economy.busy, economy.uncertain, economy.error]);
  function deny(message: string) {
    setNotice(message);
    playUiCue(getAudioRuntime(), "ui.error");
    return false;
  }
  function start(selection?: FishSelection): boolean {
    context();
    const current = latest.current, snapshot = current.economy.productionSnapshot ?? current.economy.snapshot;
    if (snapshot.ownerPublicId !== owner || snapshot.revision !== revision || current.recipe.id !== recipe.id
      || current.tutorialHarvestActive !== tutorialHarvestActive) return false;
    const currentReason = worldProductionReason(snapshot, current.recipe, 1);
    const wait = !durableProduction && current.economy.directActionsAvailable === false ? "Восстанавливаем соединение. Дождитесь подтверждения."
      : current.economy.uncertain ? "Проверяем последнее действие. Дождитесь подтверждения."
      : !durableProduction && current.economy.retryAt > current.economy.now ? `Повторите через ${Math.ceil((current.economy.retryAt - current.economy.now) / 1000)} с.`
        : current.economy.busy || !durableProduction && (pending.current || (current.economy.pendingProductionCount ?? 0) > 0) ? "Дождитесь завершения действия." : null;
    const missing = currentReason === "Не хватает материалов или монет" ? worldCostShortfalls(snapshot, worldRecipeCost(snapshot, current.recipe))
      .map(entry => `${entry.id === "coins" ? "Монеты" : itemName(snapshot, entry.id)} ×${number(entry.required - entry.available)}`).join(", ") : "";
    const blocked = wait ?? (missing ? `Не хватает: ${missing}.` : currentReason);
    if (blocked) return deny(blocked);
    if (hasFish && !selection) {
      fishFocusOrigin.current = { element: button.current, owner: snapshot.ownerPublicId, recipeId: current.recipe.id };
      setChoosingFish(true); return false;
    }
    if (selection && !fishSelectionMatches(snapshot, worldRecipeCost(snapshot, current.recipe).items, selection)) return deny("Запас рыбы изменился. Выберите рыбу снова.");
    const action = current.tutorialHarvestActive && canPrepareTutorialHarvest(snapshot, current.recipe.id)
      ? "start_tutorial_harvest" : "start_production";
    const accepted = selection ? current.economy.act(action, current.recipe.id, 1, 0, selection)
      : current.economy.act(action, current.recipe.id, 1);
    if (!accepted) return deny("Не удалось начать. Проверьте соединение и попробуйте ещё раз.");
    pending.current = { owner: snapshot.ownerPublicId, revision: snapshot.revision, busySeen: false, previousError: current.economy.error };
    setChoosingFish(false);
    setNotice(durableProduction ? "Сохранено" : "Запускаем…");
    return true;
  }
  return <div className={`${styles.entry} ${actionOnly ? styles.actionEntry : ""}`} data-production-product={undiscovered ? "experiment" : Object.keys(recipe.rewards).sort().join(":")}>
    <CookingExperimentTerms state={state} recipe={recipe} id={`${detailId}-experiment`} />
    <button ref={button} type="button" className={actionOnly ? styles.cookAction : styles.card} data-recipe={recipe.id} data-recipe-product={undiscovered ? undefined : results[0]?.[0]}
      data-recipe-order data-recipe-focused={focused || undefined} data-blocked={Boolean(reason) || (durableProduction ? productionLocked(economy) : locked(economy)) || undefined}
      aria-label={`${recipe.experiment ? "Попробовать" : actionOnly ? "Приготовить" : "Произвести"}: ${title}, ${duration}`}
      aria-describedby={[recipe.experiment ? `${detailId}-experiment` : "", description ? detailId : "", notice ? noticeId : ""].filter(Boolean).join(" ") || undefined}
      title={restriction ?? undefined} onFocus={context} onClick={() => start()}>
      {actionOnly ? <><Flame size={17} aria-hidden="true" />{recipe.experiment ? "Попробовать" : "Приготовить"}<small>{duration}</small></> : <><span className={styles.header} data-production-header data-production-mixed={results.length > 1 || undefined}>
        <span className={styles.outputs}>{undiscovered ? <CookingExperimentIcon recipeId={recipe.id} size={30} /> : results.map(([id, amount]) => <span key={id}><ProductIcon state={state} itemId={id} size={30} />{(amount !== 1 || results.length > 1) && <b>×{number(amount)}</b>}</span>)}</span>
        <strong title={title}>{title}</strong>
      </span>
      <span className={styles.time}><Clock3 size={12} aria-hidden="true" />{duration}{restriction && <LockKeyhole className={styles.lock} size={12} aria-hidden="true" />}</span>
      <span className={styles.details}>
        {accessReason && <span className={styles.accessReason} data-recipe-access>{accessReason}</span>}
        {tradeSpeedBps > 0 && <span className={styles.benefits} data-production-trade-bonus>Лопоух: +{number(tradeSpeedBps / 100)}% к скорости</span>}
        {costs.length > 0 && <span className={styles.costs} data-production-inputs aria-label="Понадобится">{costs.map(([id, amount]) => {
          const available = id === "coins" ? state.wallet.coins : worldItemAvailable(state, id);
          const missing = available < amount;
          return <span key={id} data-missing={missing || undefined} title={`${id === "coins" ? "Монеты" : itemName(state, id)}: есть ${number(available)}, нужно ${number(amount)}`}>
            <ProductIcon state={state} itemId={id} size={15} />
            <span>{id === "coins" ? "Монеты" : itemName(state, id)}</span><b>{missing ? `${number(available)} / ${number(amount)}` : `×${number(amount)}`}</b>
          </span>;
        })}</span>}
        {recipe.fishInput?.exactSpecies && <span className={styles.benefits}>Нужен указанный вид рыбы</span>}
        {!undiscovered && meal && <span className={styles.benefits}><span>Пример вылазки: {mealTimeExample(meal.heroSpeedBps, meal.heroWorkSeconds)}</span><span>Одна стройка: {mealTimeExample(meal.builderSpeedBps, meal.builderWorkSeconds, "builder")}</span><span>{mealWorkDescription(meal.heroWorkSeconds)}</span><span>{mealWorkDescription(meal.builderWorkSeconds, "builder")}</span></span>}
      </span></>}
    </button>
    {description && <span id={detailId} className={styles.accessible}>{description}</span>}
    {notice && <p id={noticeId} className={styles.notice} role="status" aria-live="polite">{notice}</p>}
    {choosingFish && hasFish && <WorldFishSelection economy={economy} requiredItems={recipeCost.items} contextId={`recipe:${recipe.id}`} confirmLabel="Готовить" summary={cookingExperimentSummary(state, recipe)}
      onClose={() => setChoosingFish(false)} onConfirm={start} onCloseAutoFocus={event => {
        event.preventDefault();
        const origin = fishFocusOrigin.current, current = latest.current;
        fishFocusOrigin.current = null;
        if (origin?.element && origin.element === button.current && origin.element.isConnected && !origin.element.disabled
          && origin.owner === current.economy.snapshot.ownerPublicId && origin.recipeId === current.recipe.id) origin.element.focus({ preventScroll: true });
      }} />}
  </div>;
}
