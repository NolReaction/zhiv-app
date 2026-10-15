import type { EconomyView } from "@/features/economy/domain/model";
import type { EconomyController } from "./use-economy";

/** A controller with a confirmed snapshot, ready for screen selectors and actions. */
export type ReadyEconomy = EconomyController & { snapshot: EconomyView };

/** Spending, claiming and trading wait for all reserved production intents. */
export const locked = (economy: EconomyController) => economy.directActionsAvailable === false || economy.busy || economy.uncertain || (economy.pendingProductionCount ?? 0) > 0 || economy.retryAt > economy.now;

/** Safe production can reserve another slot while its durable queue is delivering. */
export const productionLocked = (economy: EconomyController) => economy.busy || economy.uncertain
  || !economy.productionQueueAvailable && (economy.directActionsAvailable === false || economy.retryAt > economy.now);
