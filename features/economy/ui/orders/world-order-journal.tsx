"use client";

import { useState } from "react";
import { Check, Leaf, Mail, RefreshCw } from "lucide-react";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { tradeResidentAvailable } from "@/features/economy/domain/trade-relations";
import { number } from "@/features/economy/ui/shared/world-economy-parts";
import { ResidentOrderBoard, type OrderNavigation } from "./world-resident-order-board";
import { orderJournalSummary } from "./order-journal-summary";
import { orderResidents, type OrderResidentId } from "./order-residents";
import styles from "./world-order-journal.module.css";
import theme from "./order-resident-theme.module.css";

export type WorldOrderJournalProps = OrderNavigation & {
  economy: EconomyController;
  residentId?: OrderResidentId;
  introducedResidents?: readonly OrderResidentId[];
  /** The active main course shows its single pinned request, without later work. */
  tutorialOnly?: boolean;
};

/** The world supplies the dialog frame and its single scroll area. */
export function WorldOrderJournal({ economy, residentId, introducedResidents, tutorialOnly = false, ...navigation }: WorldOrderJournalProps) {
  const [customer, setCustomer] = useState(residentId);
  const state = economy.snapshot;
  const visibleCustomer = customer && state && tradeResidentAvailable(state, customer, state.catalog)
    && (!introducedResidents || introducedResidents.includes(customer)) ? customer : undefined;
  const summary = state ? orderJournalSummary(state, economy.now, tutorialOnly ? undefined : visibleCustomer, tutorialOnly, introducedResidents) : { total: 0, ready: 0 };
  const retrySeconds = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  const recovery = !economy.syncError && (economy.error || economy.uncertain) && <div className={styles.recovery} role="alert">
    <p>{economy.uncertain ? "Проверяем последнее действие. Дождись подтверждения." : economy.error}</p>
    <button type="button" disabled={economy.busy || retrySeconds > 0} onClick={() => {
      if (!economy.busy && retrySeconds <= 0) void economy.retry();
    }}><RefreshCw size={15} aria-hidden="true" />{retrySeconds ? `Повторить через ${retrySeconds} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button>
  </div>;
  return <div className={`${styles.journal} ${theme.root}`} data-order-journal data-order-customer={tutorialOnly ? "all" : visibleCustomer ?? "all"} data-section-guide-content="orders" aria-busy={economy.busy || undefined}>
    <header className={styles.cover}>
      <span className={styles.emblem} aria-hidden="true"><Mail size={27} strokeWidth={1.5} /><Leaf className={styles.leaf} size={16} strokeWidth={1.5} /></span>
      <div className={styles.coverTitle}><p>{tutorialOnly ? "Лесная почта" : "Жители леса"}</p><h2>{tutorialOnly ? "Учебный заказ" : visibleCustomer ? orderResidents[visibleCustomer].title : "Все просьбы"}</h2></div>
      {state?.catalog.food && <div className={styles.status} data-order-journal-summary aria-label={`Можно сдать: ${summary.ready}. Всего заказов: ${summary.total}.`}>
        <strong><Check size={13} aria-hidden="true" />{number(summary.ready)} <span>готово</span></strong><small>из {number(summary.total)} заказов</small>
      </div>}
    </header>
    {recovery}
    {!state ? !recovery && <p className={styles.placeholder} role="status">Открываем журнал…</p>
      : !state.catalog.food ? <p className={styles.placeholder}>Журнал пока недоступен.</p>
      : <ResidentOrderBoard economy={{ ...economy, snapshot: state }} residentId={residentId} introducedResidents={introducedResidents} tutorialOnly={tutorialOnly} onFilterChange={setCustomer} {...navigation} />}
  </div>;
}
