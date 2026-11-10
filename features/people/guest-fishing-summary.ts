import { z } from "zod";
import { economyCatalog, type EconomyState } from "@/features/economy/domain/model";
import { boatModules, boatState } from "@/features/economy/domain/boat-fishing";
import { fishingState } from "@/features/economy/domain/fishing";

const fishing = economyCatalog.fishing!;
const species = new Set(Object.keys(economyCatalog.boat?.weights ?? {}));
const tier = z.number().int().min(0).max(5);
const record = z.object({
  fishId: z.string().refine(id => species.has(id)),
  weightGrams: z.number().int().positive().max(1_000_000),
}).strict();

export const guestFishingSummarySchema = z.object({
  rodId: z.string().refine(id => fishing.rods.some(rod => rod.id === id)).nullable(),
  hookId: z.string().refine(id => fishing.hooks.some(hook => hook.id === id)).nullable(),
  baitId: z.string().refine(id => fishing.baits.some(bait => bait.itemId === id)).nullable(),
  modules: z.object({ engine: tier, hull: tier, tank: tier, storage: tier }).strict(),
  completedVoyages: z.number().int().nonnegative().max(1_000_000_000),
  records: z.array(record).max(3).refine(items => new Set(items.map(item => item.fishId)).size === items.length),
}).strict();

export function guestFishingSummary(state: Pick<EconomyState, "boat" | "fishing">) {
  const tackle = fishingState(state), boat = boatState(state);
  const records = Object.entries(boat.records).filter(([id]) => species.has(id))
    .map(([fishId, catchRecord]) => ({ fishId, weightGrams: catchRecord.weightGrams }))
    .sort((a, b) => b.weightGrams - a.weightGrams || (a.fishId < b.fishId ? -1 : 1)).slice(0, 3);
  return {
    rodId: fishing.rods.find(rod => rod.id === tackle.equippedRodId)?.id ?? null,
    hookId: fishing.hooks.find(hook => hook.id === tackle.equippedHookId)?.id ?? null,
    baitId: fishing.baits.find(bait => bait.itemId === tackle.equippedBaitId)?.itemId ?? null,
    completedVoyages: boat.completedVoyages, modules: boatModules(boat), records,
  };
}
