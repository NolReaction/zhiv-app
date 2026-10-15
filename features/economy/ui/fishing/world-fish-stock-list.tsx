"use client";

import { Check, ChevronRight } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyView } from "@/features/economy/domain/model";
import { fishStockEntries } from "@/features/economy/domain/fish-stock";
import { itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import { FishTapFeedbackArt, type FishTapFeedback } from "./fish-tap-feedback";
import styles from "./world-fish-stock-list.module.css";

/** Current stock is independent of the lifetime collection and adds no storage units. */
export function WorldFishStockList({ state, classId, selectedItemId, onSelect, disabled = false, feedback }: {
  state: EconomyView;
  classId: string;
  selectedItemId?: string | null;
  onSelect: (itemId: string | null) => void;
  disabled?: boolean;
  feedback?: FishTapFeedback | null;
}) {
  const entries = fishStockEntries(state, classId);
  return <div className={styles.list} data-fish-stock-class={classId} role="group" aria-label={`Виды в запасе: ${itemName(state, classId)}`}>
    {entries.length > 1 && <button type="button" className={styles.all} data-fish-stock-all aria-pressed={selectedItemId == null} disabled={disabled} onClick={() => onSelect(null)}>Все виды</button>}
    {entries.map(entry => {
      const selected = entry.itemId === selectedItemId;
      const name = entry.itemId === classId ? "Без указания вида" : itemName(state, entry.itemId);
      return <button key={entry.itemId} type="button" className={styles.fish} data-fish-stock-item={entry.itemId} aria-pressed={selected}
        aria-label={`${name}: в запасе ${number(entry.quantity)}`} disabled={disabled} onClick={() => onSelect(entry.itemId)}>
        <FishTapFeedbackArt feedback={feedback} itemId={entry.itemId}><ItemIcon itemId={entry.itemId} size={28} /></FishTapFeedbackArt><span>{name}</span><strong>×{number(entry.quantity)}</strong>
        {selected ? <Check size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
      </button>;
    })}
    {!entries.length && <p className={styles.empty}>Рыба этого класса закончилась.</p>}
  </div>;
}
