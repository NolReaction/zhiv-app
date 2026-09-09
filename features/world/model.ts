import { z } from "zod";
import catalog from "@/apps/api/src/main/resources/world/catalog.json";

export const worldCatalog = catalog;
const count = z.number().int().nonnegative().safe();
export const resourcesSchema = z.object({ sparks: count, wood: count, stone: count });
export const journeySchema = z.object({
  id: z.string().uuid(), routeId: z.string(), startedAt: z.string().datetime(), finishesAt: z.string().datetime(),
  rewards: resourcesSchema, finds: z.array(z.string()).max(20), introductory: z.boolean(), catalogVersion: count,
});
export const worldStateSchema = z.object({
  schemaVersion: z.literal(1), resources: resourcesSchema, houseLevel: z.number().int().min(1).max(5),
  workshop: z.boolean(), workshopLevel: z.number().int().min(0).max(3).optional(), inventory: z.array(z.string()).max(100),
  equipment: z.object({ palette: z.string(), head: z.string().nullable(), neck: z.string().nullable() }),
  collection: z.array(z.string()).max(100), journeys: z.array(journeySchema).max(32),
  firstJourneyCompleted: z.boolean(), completedJourneys: count,
});
export const worldSnapshotSchema = z.object({
  ownerPublicId: z.string().min(1), revision: count, serverTime: z.string().datetime(), state: worldStateSchema,
  gifts: z.array(z.string()).max(100), dailySparksEarned: count, catalogVersion: z.literal(1), devTools: z.boolean().optional(),
});
export const worldCommandSchema = z.object({
  requestId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/), ownerPublicId: z.string().min(1).max(40), expectedRevision: count,
  action: z.enum(["upgrade_house", "build_workshop", "upgrade_workshop", "craft", "equip", "start_journey", "recall_journey", "claim_journey", "dev_grant_resources"]),
  target: z.string().max(80).default(""),
}).strict();
export const worldResultSchema = z.object({ snapshot: worldSnapshotSchema, message: z.string(), replayed: z.boolean() });
export type WorldState = z.infer<typeof worldStateSchema>;
export type WorldSnapshot = z.infer<typeof worldSnapshotSchema>;
export type WorldCommand = z.infer<typeof worldCommandSchema>;
export type WorldResources = z.infer<typeof resourcesSchema>;
export const newWorldState = (): WorldState => ({
  schemaVersion: 1, resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 1, workshop: false, workshopLevel: 0,
  inventory: ["moss", "amber_scarf"], equipment: { palette: "moss", head: null, neck: null },
  collection: [], journeys: [], firstJourneyCompleted: false, completedJourneys: 0,
});
export function canAfford(resources: WorldResources, cost: WorldResources) {
  return resources.sparks >= cost.sparks && resources.wood >= cost.wood && resources.stone >= cost.stone;
}

export function workshopLevel(state: Pick<WorldState, "workshop" | "workshopLevel">) {
  return state.workshop ? Math.max(1, Math.min(3, state.workshopLevel ?? 1)) : 0;
}
