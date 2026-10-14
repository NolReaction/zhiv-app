import { Fish } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { fishClassForItem } from "@/features/economy/domain/fishing";
import type { EconomyJob, EconomyView } from "@/features/economy/domain/model";
import { FishRarityBadge } from "./fish-rarity";
import styles from "./fishing-catch-report.module.css";

/** The client timer cannot reveal a catch from an older, still-masked snapshot. */
export function fishingCatchRevealed(state: EconomyView, job: EconomyJob) {
  const finish = Date.parse(job.finishesAt), server = Date.parse(state.serverTime);
  if (!Number.isFinite(finish) || !Number.isFinite(server) || server < finish || job.fishing?.catchRevealed === false) return false;
  if (job.fishing?.catchRevealed === true) return true;
  // Saved class or distinct species rewards in older jobs are already explicit.
  return Object.keys(job.rewards).some(id => id !== "fish" && fishClassForItem(id, state.catalog.fishing));
}

export function FishingCatchReport({ state, rewards, revealed }: {
  state: EconomyView; rewards: Readonly<Record<string, number>>; revealed: boolean;
}) {
  const catalog = state.catalog.fishing;
  if (!catalog) return null;
  const fish = Object.entries(rewards).flatMap(([itemId, quantity]) => {
    const group = fishClassForItem(itemId, catalog);
    if (!group || !Number.isSafeInteger(quantity) || quantity <= 0) return [];
    const name = state.catalog.items.find(item => item.id === itemId)?.name ?? itemId;
    return [{ itemId, quantity, name, rarity: group.rarity }];
  });
  if (!fish.length) return null;
  if (!revealed) {
    const count = fish.reduce((sum, item) => sum + item.quantity, 0);
    return <div className={styles.pending} data-pending-catch={count}><Fish size={22} aria-hidden="true" /><span>Улов · <strong>{count.toLocaleString("ru-RU")}</strong> рыб</span></div>;
  }
  return <div className={styles.report} role="list" aria-label="Пойманные рыбы" data-fishing-catch-report>
    {fish.map(item => <div key={item.itemId} className={styles.catch} role="listitem" data-fish-catch={item.itemId} data-quantity={item.quantity}
      aria-label={`${item.name}, ${item.quantity}`}>
      <span className={styles.icon}><ItemIcon itemId={item.itemId} size={37} /></span>
      <span className={styles.description}><strong>{item.name}</strong><FishRarityBadge rarity={item.rarity} /></span>
      <span className={styles.quantity}>×{item.quantity.toLocaleString("ru-RU")}</span>
    </div>)}
  </div>;
}
