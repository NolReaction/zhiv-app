import { ArrowUpRight, Gift, RefreshCw } from "lucide-react";
import { PleskPortrait } from "@/features/world/characters/plesk/plesk-portrait";
import { BuilderPortrait } from "@/features/world/characters/builder/builder-portrait";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { workshopStarterCost } from "@/features/economy/domain/workshop-starter";
import styles from "./world-onboarding.module.css";

export function WorldNeighborCards({ onOpenResident }: { onOpenResident: (id: "plesk" | "builder") => void }) {
  return <div className={styles.neighbors}>
    <button type="button" className={styles.neighbor} data-guide-resident="plesk" onClick={() => onOpenResident("plesk")}>
      <PleskPortrait animated className={styles.portrait} />
      <span><strong>Плёска</strong><small>Рыба, наживка и снасти</small></span><ArrowUpRight size={16} aria-hidden="true" />
    </button>
    <button type="button" className={styles.neighbor} data-guide-resident="builder" onClick={() => onOpenResident("builder")}>
      <BuilderPortrait animated className={styles.portrait} />
      <span><strong>Шишколап</strong><small>Ёжик: строит и улучшает</small></span><ArrowUpRight size={16} aria-hidden="true" />
    </button>
  </div>;
}

/** A quote from the shared catalog, never a receipt or an optimistic balance. */
export function WorkshopStarterContents({ economy, onOpenPantry }: { economy: EconomyController; onOpenPantry?: () => void }) {
  const snapshot = economy.snapshot;
  if (!snapshot) return null;
  const cost = workshopStarterCost(snapshot.catalog);
  return <><div className={styles.starter} data-guide-workshop-starter>
    <Gift size={18} aria-hidden="true" />
    <span><strong>Набор на первую мастерскую</strong>
      <small>{cost.coins.toLocaleString("ru-RU")} монет{Object.entries(cost.items).map(([id, amount]) =>
        ` · ${snapshot.catalog.items.find(item => item.id === id)?.name ?? id}: ${amount}`).join("")}</small>
    </span>
  </div>{onOpenPantry && <button type="button" className={styles.retry} onClick={onOpenPantry}>Открыть кладовую</button>}</>;
}

export function WorkshopRetry({ economy, isOnline }: { economy: EconomyController; isOnline?: boolean }) {
  if (!economy.uncertain && !economy.error) return null;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  return <button type="button" className={styles.retry} disabled={economy.busy || cooldown > 0 || isOnline === false}
    onClick={() => void economy.retry()}><RefreshCw size={14} aria-hidden="true" />
    {cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Повторить запрос"}
  </button>;
}
