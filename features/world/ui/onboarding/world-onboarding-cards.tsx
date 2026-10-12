import { Gift, RefreshCw } from "lucide-react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { workshopStarterCost } from "@/features/economy/domain/workshop-starter";
import { tutorialResidentOrder } from "@/features/economy/domain/tutorial-order";
import styles from "./world-onboarding.module.css";

/** A quote from the shared catalog, never a receipt or an optimistic balance. */
export function WorkshopStarterContents({ economy }: { economy: EconomyController }) {
  const snapshot = economy.snapshot;
  if (!snapshot) return null;
  const cost = workshopStarterCost(snapshot.catalog);
  return <div className={styles.starter} data-guide-workshop-starter>
    <Gift size={18} aria-hidden="true" />
    <span><strong>Набор на первую мастерскую</strong>
      <small>{cost.coins.toLocaleString("ru-RU")} монет{Object.entries(cost.items).map(([id, amount]) =>
        ` · ${snapshot.catalog.items.find(item => item.id === id)?.name ?? id}: ${amount}`).join("")}</small>
    </span>
  </div>;
}

/** The lesson shows the exact grant; only the server confirms it was received. */
export function TutorialOrderContents({ economy }: { economy: EconomyController }) {
  const snapshot = economy.snapshot;
  if (!snapshot) return null;
  const order = tutorialResidentOrder(snapshot);
  if (!order) return null;
  return <div className={styles.starter} data-guide-order-starter>
    <Gift size={18} aria-hidden="true" />
    <span><strong>Ингредиенты для учебного заказа</strong>
      <small>{Object.entries(order.items).map(([id, amount]) => `${snapshot.catalog.items.find(item => item.id === id)?.name ?? id}: ${amount}`).join(" · ")}</small>
    </span>
  </div>;
}

export function WorkshopRetry({ economy, isOnline }: { economy: EconomyController; isOnline?: boolean }) {
  if (!economy.uncertain && !economy.error) return null;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  return <button type="button" className={styles.retry} disabled={economy.busy || cooldown > 0 || isOnline === false}
    onClick={() => void economy.retry()}><RefreshCw size={14} aria-hidden="true" />
    {cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Повторить запрос"}
  </button>;
}
