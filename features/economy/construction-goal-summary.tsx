"use client";

import { ArrowRight, Check, Pin, X } from "lucide-react";
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

/** The same goal stays visible while moving between the map, production and storage. */
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
      <button type="button" className={styles.open} data-construction-goal-open onClick={onOpenGoal} aria-label={`Открыть цель: ${title}`}><Pin size={15} aria-hidden="true" /><span><small>Собираю на улучшение</small><strong>{title}</strong></span><ArrowRight size={14} aria-hidden="true" /></button>
      <button type="button" className={styles.remove} onClick={constructionGoal.clear} aria-label={`Снять цель: ${title}`}><X size={16} aria-hidden="true" /></button>
    </div>
    {missing.length ? <div className={styles.shortfall}><span className={styles.caption}>Ещё нужно</span><ul className={styles.items} aria-label="Не хватает для цели">{missing.map(({ id, amount }) => {
      const name = id === "coins" ? "Монеты" : itemName(state, id);
      const source = id === "coins" ? null : worldMaterialSource(state, id);
      const rareFind = state.catalog.rareDrops?.itemIds.includes(id) && (state.buildings.home ?? 1) >= state.catalog.rareDrops.requiredHomeLevel;
      const openSource = source?.kind === "production" && navigation?.canOpen(source.stationId) ? () => navigation.open(source.stationId) : source?.kind === "exploration" || rareFind ? navigation?.explore : undefined;
      const label = `${name}: не хватает ${number(amount)}`;
      const content = <><ProductIcon state={state} itemId={id} size={18} /><span className={styles.itemName}>{name}</span><strong>{number(amount)}</strong>{openSource && <ArrowRight size={11} aria-hidden="true" />}</>;
      return <li key={id}>{openSource ? <button type="button" className={styles.item} title={label} aria-label={`Где получить: ${label}`} onClick={openSource}>{content}</button> : <span className={styles.item} title={label} aria-label={label}>{content}</span>}</li>;
    })}</ul></div> : <p className={styles.ready} role="status"><Check size={15} aria-hidden="true" />Материалы собраны</p>}
  </section>;
}
