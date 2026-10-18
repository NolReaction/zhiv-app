import { adminEconomyGrantSchema, type AdminEconomyGrant } from "./admin-grants-api";
import { economyCatalog } from "@/features/economy/domain/model";
import type { GrantEntry } from "./admin-grants-model";
import { readAdminAttempt, saveAdminAttempt } from "./admin-attempt-journal";

export function pendingGrantTargets(actor: string): string[] {
  if (typeof window === "undefined") return [];
  try {
    const prefix = `zhiv:admin-grant:${actor}:`;
    return Array.from({ length: window.sessionStorage.length }, (_, index) => window.sessionStorage.key(index))
      .filter((value): value is string => !!value && value.startsWith(prefix))
      .map(value => value.slice(prefix.length)).filter(target => !!readGrantAttempt(actor, target));
  } catch { return []; }
}

/** A tab-local journal keeps an uncertain write immutable across a page reload. */
export function readGrantAttempt(actor: string, target: string): AdminEconomyGrant | null {
  const request = readAdminAttempt("grant", actor, target, adminEconomyGrantSchema);
  return request?.confirmationPublicId === target ? request : null;
}

export function saveGrantAttempt(actor: string, target: string, request: AdminEconomyGrant | null): boolean {
  return saveAdminAttempt("grant", actor, target, request);
}

export function entriesFromGrant(request: AdminEconomyGrant): GrantEntry[] {
  return [
    ...(request.coins ? [{ kind: "coins" as const, id: "coins", name: "Монеты", amount: request.coins }] : []),
    ...(request.pearls ? [{ kind: "pearls" as const, id: "pearls", name: "Жемчуг", amount: request.pearls }] : []),
    ...Object.entries(request.items).map(([id, amount]) => ({ kind: "item" as const, id, amount, name: economyCatalog.items.find(item => item.id === id)?.name ?? id })),
    ...Object.entries(request.buildings).map(([id, amount]) => ({ kind: "building" as const, id, amount, name: economyCatalog.buildings.find(item => item.id === id)?.name ?? id })),
    ...Object.entries(request.productionSlots).map(([id, amount]) => ({ kind: "slots" as const, id, amount, name: `${economyCatalog.buildings.find(item => item.id === id)?.name ?? id}: места` })),
    ...request.rods.map(id => ({ kind: "rod" as const, id, amount: 1, name: economyCatalog.fishing?.rods.find(item => item.id === id)?.name ?? id })),
    ...request.hooks.map(id => ({ kind: "hook" as const, id, amount: 1, name: economyCatalog.fishing?.hooks.find(item => item.id === id)?.name ?? id })),
  ];
}
