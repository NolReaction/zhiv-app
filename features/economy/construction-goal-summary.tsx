"use client";

import { Check, Pin, X } from "lucide-react";
import type { EconomyView } from "./model";
import type { ConstructionGoalController } from "./use-construction-goal";
import { ProductIcon, itemName, number, type StationNavigation } from "./world-economy-parts";
import { worldMaterialSource } from "./world-stations";
import styles from "./construction-goal-summary.module.css";

type ConstructionGoalSummaryProps = {
  state: EconomyView;
  constructionGoal: ConstructionGoalController;
  onOpenGoal: () => void;
  navigation?: StationNavigation;
  compact?: boolean;
};

/** A small, shared goal strip leaves room for the contents of each production/storage panel. */
export function ConstructionGoalSummary({ state, constructionGoal, onOpenGoal, navigation, compact = false }: ConstructionGoalSummaryProps) {
  const details = constructionGoal.details;
  if (!details) return null;
  const title = `${details.name} · ур. ${details.goal.targetLevel}`;
  const missing = [
    ...(details.missing.coins > 0 ? [{ id: "coins", amount: details.missing.coins }] : []),
    ...Object.entries(details.missing.items).filter(([, amount]) => amount > 0).map(([id, amount]) => ({ id, amount })),
  ];
  return <section className={styles.summary} data-compact={compact || undefined} aria-label={`Закреплённая цель: ${title}`}>
    <div className={styles.heading}>
      <button type="button" className={styles.open} data-construction-goal-open onClick={onOpenGoal} title={title} aria-label={`Открыть цель: ${title}`}><Pin size={14} aria-hidden="true" /><strong>{title}</strong></button>
      <button type="button" className={styles.remove} onClick={constructionGoal.clear} title="Снять цель" aria-label={`Снять цель: ${title}`}><X size={14} aria-hidden="true" /></button>
    </div>
    {missing.length ? <ul className={styles.items} aria-label="Не хватает для цели">{missing.map(({ id, amount }) => {
      const name = id === "coins" ? "Монеты" : itemName(state, id);
      const source = id === "coins" ? null : worldMaterialSource(state, id);
      // An unopened workshop can still explain the recipe and its requirements.
      const lockedRecipe = !source && id !== "coins" ? state.catalog.recipes.find(recipe => (recipe.rewards[id] ?? 0) > 0) : undefined;
      const rareFind = state.catalog.rareDrops?.itemIds.includes(id) && (state.buildings.home ?? 1) >= state.catalog.rareDrops.requiredHomeLevel;
      const production = source?.kind === "production" ? { stationId: source.stationId, recipeId: source.targetId } : lockedRecipe ? { stationId: lockedRecipe.buildingId, recipeId: lockedRecipe.id } : undefined;
      const openSource = production && navigation?.canOpen(production.stationId) ? () => navigation.open(production.stationId, production.recipeId) : source?.kind === "exploration" || rareFind ? navigation?.explore : undefined;
      const label = `${name}: не хватает ${number(amount)}`;
      const content = <><ProductIcon state={state} itemId={id} size={20} /><strong>{number(amount)}</strong></>;
      return <li key={id}>{openSource ? <button type="button" className={styles.item} title={label} aria-label={`Где получить: ${label}`} onClick={openSource}>{content}</button> : <span className={styles.item} title={label} aria-label={label}>{content}</span>}</li>;
    })}</ul> : <p className={styles.ready} role="status"><Check size={14} aria-hidden="true" />Материалы собраны</p>}
  </section>;
}
