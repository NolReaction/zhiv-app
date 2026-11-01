"use client";

import { useEffect, useRef } from "react";
import { PackageCheck, Sparkles, X } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import type { InventoryGain } from "@/features/economy/domain/inventory-gain";
import { ProductIcon, itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import styles from "./expedition-loot.module.css";

type Route = EconomyView["catalog"]["explorations"][number];
const percent = (value: number) => `${value.toLocaleString("ru-RU", { maximumFractionDigits: 1 })}%`;

/** Base loot only; the mutually exclusive bonus draw is explained separately. */
export function expeditionRewardRanges(route: Route) {
  const extras = new Map((route.loot ?? []).map(entry => [entry.itemId, entry]));
  return [...new Set([...Object.keys(route.rewards), ...extras.keys()])].map(itemId => {
    const base = route.rewards[itemId] ?? 0, extra = extras.get(itemId);
    const min = base + (extra?.min ?? 0), max = base + (extra?.max ?? 0);
    return { itemId, min, max, chance: min > 0 ? 100 : max > 0 ? 100 * max / (max + 1) : 0 };
  }).filter(entry => entry.max > 0);
}

export function ExpeditionLootPreview({ state, route, compact = false }: { state: EconomyView; route: Route; compact?: boolean }) {
  return <span className={styles.loot} data-compact={compact || undefined} role="list" aria-label="Возможная добыча">
    {expeditionRewardRanges(route).map(entry => {
      const name = itemName(state, entry.itemId), range = entry.min === entry.max ? number(entry.min) : `${number(entry.min)}–${number(entry.max)}`;
      return <span key={entry.itemId} role="listitem" className={styles.resource}
        aria-label={`${name}: ${range}, шанс ${percent(entry.chance)}`} title={`${name}: ${range}, шанс ${percent(entry.chance)}`}>
        <ProductIcon state={state} itemId={entry.itemId} size={compact ? 18 : 24} />
        <span className={styles.name}>{name}{!compact && <small>{entry.chance === 100 ? "В каждом походе" : `Шанс ${percent(entry.chance)}`}</small>}</span>
        <strong>{range}</strong>
      </span>;
    })}
  </span>;
}

export function ExpeditionReturnReport({ gain, state, onDismiss }: { gain: InventoryGain; state: EconomyView; onDismiss: () => void }) {
  const report = useRef<HTMLElement>(null);
  useEffect(() => {
    // The claimed job's button disappeared. Do not steal focus from another control.
    if (!document.hidden && document.activeElement === document.body) report.current?.focus({ preventScroll: true });
  }, [gain.id]);
  if (!gain.expedition || gain.ownerPublicId !== state.ownerPublicId) return null;
  return <section ref={report} tabIndex={-1} className={styles.report} aria-label={`Итоги вылазки: ${gain.expedition.title}`}
    data-expedition-report={gain.id} onKeyDown={event => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDismiss(); }
    }}>
    <header><PackageCheck size={20} aria-hidden="true" /><div><small>Всё уже в кладовой</small><h3>Мохлик принёс</h3></div>
      <button type="button" aria-label="Закрыть итоги вылазки" onClick={onDismiss}><X size={18} aria-hidden="true" /></button></header>
    <p className={styles.route}>{gain.expedition.title}</p>
    <div role="status" className={styles.results}>
      {gain.items.map(item => <div key={item.itemId} className={styles.result} data-rare={gain.expedition?.rareItemIds.includes(item.itemId) || undefined}>
        <ProductIcon state={state} itemId={item.itemId} size={30} /><span>{itemName(state, item.itemId)}
          {gain.expedition?.rareItemIds.includes(item.itemId) && <small><Sparkles size={11} aria-hidden="true" />Редкая находка</small>}</span><strong>+{number(item.quantity)}</strong>
      </div>)}
      {gain.expedition.xp > 0 && <p className={styles.xp}><Sparkles size={14} aria-hidden="true" />Опыт за вылазку <strong>+{number(gain.expedition.xp)} XP</strong></p>}
    </div>
  </section>;
}
