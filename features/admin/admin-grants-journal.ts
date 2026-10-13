import { adminEconomyGrantSchema, type AdminEconomyGrant } from "./admin-grants-api";
import { economyCatalog } from "@/features/economy/domain/model";
import type { GrantEntry } from "./admin-grants-model";

const key = (actor: string, target: string) => `zhiv:admin-grant:${actor}:${target}`;

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
  if (typeof window === "undefined") return null;
  try {
    const saved = window.sessionStorage.getItem(key(actor, target));
    if (!saved) return null;
    const parsed = adminEconomyGrantSchema.safeParse(JSON.parse(saved));
    return parsed.success && parsed.data.confirmationPublicId === target ? parsed.data : null;
  } catch { return null; }
}

export function saveGrantAttempt(actor: string, target: string, request: AdminEconomyGrant | null): boolean {
  try {
    if (request) window.sessionStorage.setItem(key(actor, target), JSON.stringify(request));
    else window.sessionStorage.removeItem(key(actor, target));
    return true;
  } catch { return false; }
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
