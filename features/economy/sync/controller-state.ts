import type { EconomyView } from "@/features/economy/domain/model";
import type { EconomyController } from "./use-economy";

/** A controller with a confirmed snapshot, ready for screen selectors and actions. */
export type ReadyEconomy = EconomyController & { snapshot: EconomyView };

/** Pending confirmation and retry cooldown block every economy command equally. */
export const locked = (economy: EconomyController) => economy.busy || economy.uncertain || economy.retryAt > economy.now;
