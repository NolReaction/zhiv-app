"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Clock3 } from "lucide-react";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import type { WorldHelpContext } from "@/features/world/ui/help/world-help-types";
import { worldCostShortfalls, worldProductionReason, type WorldRecipe } from "@/features/economy/ui/shared/world-stations";
import { ProductIcon, itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import { worldRecipeDuration } from "@/features/economy/ui/stations/world-recipe-groups";
import styles from "./world-production-card.module.css";

export function WorldProductionCard({ economy, recipe, focused = false, onHelpContextChange }: {
  economy: ReadyEconomy;
  recipe: WorldRecipe;
  focused?: boolean;
  onHelpContextChange?: (context: WorldHelpContext) => void;
}) {
  const state = economy.snapshot;
  const button = useRef<HTMLButtonElement>(null);
  const pending = useRef<{ owner: string; revision: number; busySeen: boolean; previousError: string | null } | null>(null);
  const [feedback, setFeedback] = useState<{ text: string; owner: string; revision: number; recipeId: string } | null>(null);
  const notice = feedback?.owner === state.ownerPublicId && feedback.revision === state.revision && feedback.recipeId === recipe.id ? feedback.text : "";
  const setNotice = (text: string) => setFeedback({ text, owner: state.ownerPublicId, revision: state.revision, recipeId: recipe.id });
  const noticeId = useId();
  const results = Object.entries(recipe.rewards);
  const title = results.length === 1 ? itemName(state, results[0][0]) : recipe.name.split(" · ")[0];
  const reason = worldProductionReason(state, recipe, 1);
  const costs = [...(recipe.cost.coins > 0 ? [["coins", recipe.cost.coins] as const] : []), ...Object.entries(recipe.cost.items)];
  const meal = state.catalog.food?.meals.find(entry => (recipe.rewards[entry.itemId] ?? 0) > 0);
  const context = () => onHelpContextChange?.({ intent: "production", stationId: recipe.buildingId, recipeId: recipe.id, quantity: 1 });
  useEffect(() => {
    if (focused) {
      button.current?.focus({ preventScroll: true });
      button.current?.scrollIntoView({ block: "nearest" });
    }
  }, [focused]);
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
  function start() {
    context();
    const wait = economy.uncertain ? "Проверяем последнее действие. Дождитесь подтверждения."
      : economy.retryAt > economy.now ? `Повторите через ${Math.ceil((economy.retryAt - economy.now) / 1000)} с.`
        : economy.busy || pending.current ? "Дождитесь завершения действия." : null;
    const missing = reason === "Не хватает материалов или монет" ? worldCostShortfalls(state, recipe.cost)
      .map(entry => `${entry.id === "coins" ? "Монеты" : itemName(state, entry.id)} ×${number(entry.required - entry.available)}`).join(", ") : "";
    const blocked = wait ?? (missing ? `Не хватает: ${missing}.` : reason);
    if (blocked) { setNotice(blocked); return; }
    if (!economy.act("start_production", recipe.id, 1)) {
      setNotice("Не удалось начать. Проверьте соединение и попробуйте ещё раз.");
      return;
    }
    pending.current = { owner: state.ownerPublicId, revision: state.revision, busySeen: false, previousError: economy.error };
    setNotice("Запускаем…");
  }
  return <div className={styles.entry} data-production-product={Object.keys(recipe.rewards).sort().join(":")}>
    <button ref={button} type="button" className={styles.card} data-recipe={recipe.id} data-recipe-product={results[0]?.[0]}
      data-recipe-order data-recipe-focused={focused || undefined} data-blocked={Boolean(reason) || economy.busy || economy.uncertain || economy.retryAt > economy.now || undefined}
      aria-label={`Произвести: ${title}, ${worldRecipeDuration(recipe.seconds)}`}
      aria-describedby={notice ? noticeId : undefined} onFocus={context} onClick={start}>
      <span className={styles.outputs}>{results.map(([id, amount]) => <span key={id}><ProductIcon state={state} itemId={id} size={34} /><b>×{number(amount)}</b></span>)}</span>
      <strong>{title}</strong>
      <span className={styles.time}><Clock3 size={12} aria-hidden="true" />{worldRecipeDuration(recipe.seconds)}</span>
      {costs.length > 0 && <span className={styles.costs} aria-label="Понадобится">{costs.map(([id, amount]) => {
        const available = id === "coins" ? state.wallet.coins : state.inventory[id] ?? 0;
        const missing = available < amount;
        return <span key={id} data-missing={missing || undefined} title={`${id === "coins" ? "Монеты" : itemName(state, id)}: есть ${number(available)}, нужно ${number(amount)}`}>
          <ProductIcon state={state} itemId={id} size={18} />
          <span>{id === "coins" ? "Монеты" : itemName(state, id)}</span><b>{missing ? `${number(available)} / ${number(amount)}` : `×${number(amount)}`}</b>
        </span>;
      })}</span>}
      {reason && reason !== "Не хватает материалов или монет" && <span className={styles.reason}>{reason}</span>}
      {meal && <span className={styles.benefits}>Вылазка +{number(meal.heroSpeedBps / 100)}% · стройка +{number(meal.builderSpeedBps / 100)}% к скорости</span>}
    </button>
    {notice && <p id={noticeId} className={styles.notice} role="status" aria-live="polite">{notice}</p>}
  </div>;
}
