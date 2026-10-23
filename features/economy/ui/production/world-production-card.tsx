"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Clock3, LockKeyhole } from "lucide-react";
import { locked, productionLocked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import type { WorldHelpContext } from "@/features/world/ui/help/world-help-types";
import { worldCostShortfalls, worldProductionReason, worldRecipeAccessReason, type WorldRecipe } from "@/features/economy/ui/shared/world-stations";
import { ProductIcon, itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import { worldRecipeDuration } from "@/features/economy/ui/stations/world-recipe-groups";
import { fishStockRequirements, fishSelectionMatches, type FishSelection } from "@/features/economy/domain/fish-stock";
import { canPrepareTutorialHarvest } from "@/features/economy/domain/tutorial-order";
import { tradeRelationBonusBps, tradeWorkDuration } from "@/features/economy/domain/trade-relations";
import { WorldFishSelection } from "@/features/economy/ui/fishing/world-fish-selection";
import styles from "./world-production-card.module.css";

export function WorldProductionCard({ economy, recipe, focused = false, tutorialHarvestActive = false, onHelpContextChange }: {
  economy: ReadyEconomy;
  recipe: WorldRecipe;
  focused?: boolean;
  tutorialHarvestActive?: boolean;
  onHelpContextChange?: (context: WorldHelpContext) => void;
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
  const title = results.length === 1 ? itemName(state, results[0][0]) : recipe.name.split(" · ")[0];
  const firstHarvest = tutorialHarvestActive && canPrepareTutorialHarvest(state, recipe.id);
  const tradeSpeedBps = recipe.buildingId === "woodlot" ? tradeRelationBonusBps(state, "lopukh", state.catalog) : 0;
  const duration = firstHarvest ? "Сразу · первый урожай" : worldRecipeDuration(recipe.buildingId === "woodlot"
    ? tradeWorkDuration(state, recipe.seconds, "lopukh", 0, state.catalog) : recipe.seconds);
  const reason = worldProductionReason(state, recipe, 1);
  const accessReason = worldRecipeAccessReason(state, recipe);
  const costs = [...(recipe.cost.coins > 0 ? [["coins", recipe.cost.coins] as const] : []), ...Object.entries(recipe.cost.items)];
  const hasFish = Object.keys(fishStockRequirements(recipe.cost.items, state.catalog.fishing)).length > 0;
  const durableProduction = !firstHarvest && economy.productionQueueAvailable && !hasFish && !recipe.fishInput;
  const meal = state.catalog.food?.meals.find(entry => (recipe.rewards[entry.itemId] ?? 0) > 0);
  const restriction = reason && reason !== "Не хватает материалов или монет" ? reason : null;
  const description = [
    results.length > 1 || results.some(([, amount]) => amount !== 1)
      ? `Результат: ${results.map(([id, amount]) => `${itemName(state, id)} ×${number(amount)}`).join(", ")}.` : "",
    costs.length ? `Понадобится: ${costs.map(([id, amount]) => `${id === "coins" ? "Монеты" : itemName(state, id)} ×${number(amount)}`).join(", ")}.` : "",
    reason,
    firstHarvest ? "Первый учебный урожай созреет сразу. Сбор Мохликом остаётся обычным; помощь доступна один раз." : "",
    meal ? `Скорость вылазки +${number(meal.heroSpeedBps / 100)}%, стройки +${number(meal.builderSpeedBps / 100)}%.` : "",
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
    const missing = currentReason === "Не хватает материалов или монет" ? worldCostShortfalls(snapshot, current.recipe.cost)
      .map(entry => `${entry.id === "coins" ? "Монеты" : itemName(snapshot, entry.id)} ×${number(entry.required - entry.available)}`).join(", ") : "";
    const blocked = wait ?? (missing ? `Не хватает: ${missing}.` : currentReason);
    if (blocked) { setNotice(blocked); return false; }
    if (hasFish && !selection) {
      fishFocusOrigin.current = { element: button.current, owner: snapshot.ownerPublicId, recipeId: current.recipe.id };
      setChoosingFish(true); return false;
    }
    if (selection && !fishSelectionMatches(snapshot, current.recipe.cost.items, selection)) return false;
    const action = current.tutorialHarvestActive && canPrepareTutorialHarvest(snapshot, current.recipe.id)
      ? "start_tutorial_harvest" : "start_production";
    const accepted = selection ? current.economy.act(action, current.recipe.id, 1, 0, selection)
      : current.economy.act(action, current.recipe.id, 1);
    if (!accepted) {
      setNotice("Не удалось начать. Проверьте соединение и попробуйте ещё раз.");
      return false;
    }
    pending.current = { owner: snapshot.ownerPublicId, revision: snapshot.revision, busySeen: false, previousError: current.economy.error };
    setChoosingFish(false);
    setNotice(durableProduction ? "Сохранено" : "Запускаем…");
    return true;
  }
  return <div className={styles.entry} data-production-product={Object.keys(recipe.rewards).sort().join(":")}>
    <button ref={button} type="button" className={styles.card} data-recipe={recipe.id} data-recipe-product={results[0]?.[0]}
      data-recipe-order data-recipe-focused={focused || undefined} data-blocked={Boolean(reason) || (durableProduction ? productionLocked(economy) : locked(economy)) || undefined}
      aria-label={`Произвести: ${title}, ${duration}`}
      aria-describedby={[description ? detailId : "", notice ? noticeId : ""].filter(Boolean).join(" ") || undefined}
      title={restriction ?? undefined} onFocus={context} onClick={() => start()}>
      <span className={styles.header} data-production-header data-production-mixed={results.length > 1 || undefined}>
        <span className={styles.outputs}>{results.map(([id, amount]) => <span key={id}><ProductIcon state={state} itemId={id} size={30} />{(amount !== 1 || results.length > 1) && <b>×{number(amount)}</b>}</span>)}</span>
        <strong title={title}>{title}</strong>
      </span>
      <span className={styles.time}><Clock3 size={12} aria-hidden="true" />{duration}{restriction && <LockKeyhole className={styles.lock} size={12} aria-hidden="true" />}</span>
      <span className={styles.details}>
        {accessReason && <span className={styles.accessReason} data-recipe-access>{accessReason}</span>}
        {tradeSpeedBps > 0 && <span className={styles.benefits} data-production-trade-bonus>Лопоух: +{number(tradeSpeedBps / 100)}% к скорости</span>}
        {costs.length > 0 && <span className={styles.costs} data-production-inputs aria-label="Понадобится">{costs.map(([id, amount]) => {
          const available = id === "coins" ? state.wallet.coins : state.inventory[id] ?? 0;
          const missing = available < amount;
          return <span key={id} data-missing={missing || undefined} title={`${id === "coins" ? "Монеты" : itemName(state, id)}: есть ${number(available)}, нужно ${number(amount)}`}>
            <ProductIcon state={state} itemId={id} size={15} />
            <span>{id === "coins" ? "Монеты" : itemName(state, id)}</span><b>{missing ? `${number(available)} / ${number(amount)}` : `×${number(amount)}`}</b>
          </span>;
        })}</span>}
        {meal && <span className={styles.benefits}><span>Вылазка +{number(meal.heroSpeedBps / 100)}% скорости</span><span>Стройка +{number(meal.builderSpeedBps / 100)}% скорости</span></span>}
      </span>
    </button>
    {description && <span id={detailId} className={styles.accessible}>{description}</span>}
    {notice && <p id={noticeId} className={styles.notice} role="status" aria-live="polite">{notice}</p>}
    {choosingFish && hasFish && <WorldFishSelection economy={economy} requiredItems={recipe.cost.items} contextId={`recipe:${recipe.id}`} confirmLabel="Готовить"
      onClose={() => setChoosingFish(false)} onConfirm={start} onCloseAutoFocus={event => {
        event.preventDefault();
        const origin = fishFocusOrigin.current, current = latest.current;
        fishFocusOrigin.current = null;
        if (origin?.element && origin.element === button.current && origin.element.isConnected && !origin.element.disabled
          && origin.owner === current.economy.snapshot.ownerPublicId && origin.recipeId === current.recipe.id) origin.element.focus({ preventScroll: true });
      }} />}
  </div>;
}
