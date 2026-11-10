import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const id = z.string().min(1).max(80);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const instant = z.string().datetime();
const cost = z.object({ coins: count.max(1_000_000_000), items: z.record(id, count.max(1_000_000)) });
export const boatModuleIds = ["engine", "tank", "hull", "storage"] as const;
export type BoatModuleId = typeof boatModuleIds[number];
export const boatUpgradeIds = ["repair", "crate", "oars", "landing_net", "telescope",
  "engine_2", "engine_3", "engine_4", "engine_5", "tank_1", "tank_2", "tank_3", "tank_4", "tank_5",
  "hull_2", "hull_3", "hull_4", "hull_5", "storage_2", "storage_3", "storage_4", "storage_5"] as const;
const moduleTier = count.max(5);
export const boatArtifactIds = ["landing_net", "telescope"] as const;
const artifact = z.enum(boatArtifactIds);
export const boatReelInputSchema = z.object({ tick: count.max(599), held: z.boolean() }).strict();
export const BOAT_HOOK_WINDOW_MS = 3200;
export const boatReelCommandSchema = z.object({ challengeId: uuid, deferred: z.boolean().optional(), missedBite: z.literal(true).optional(), inputs: z.array(boatReelInputSchema).max(600), endTick: count.max(600) }).strict()
  .refine(value => value.missedBite ? value.endTick === 0 && value.inputs.length === 0 : value.endTick > 0, "A missed bite has no reel input")
  .refine(value => value.inputs.every((input, index) => input.tick < value.endTick && (!index || input.tick > value.inputs[index - 1].tick)), "Inputs must be ordered within the attempt");
export const boatResistanceIds = ["steady", "sprightly", "surging", "stubborn"] as const;
export type BoatResistance = typeof boatResistanceIds[number];
export const boatChallengeSchema = z.object({ id: uuid, rulesVersion: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5), z.literal(6)]), seed: count.max(0xffff_ffff), tickMs: z.literal(50),
  maxTicks: z.literal(600), zoneWidth: count.min(590).max(4000).multipleOf(2), difficulty: count.min(1).max(5), startedAt: instant, expiresAt: instant,
  motorResponse: count.max(5).optional(), hullDamping: count.max(20).optional(),
  resistance: z.enum(boatResistanceIds).optional(), biteAt: instant.optional(), fishRarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).optional() })
  .refine(value => Date.parse(value.expiresAt) > Date.parse(value.startedAt)
    && (!value.biteAt || Date.parse(value.biteAt) >= Date.parse(value.startedAt) && Date.parse(value.biteAt) < Date.parse(value.expiresAt)), "Attempt bite must be within its lifetime")
  .refine(value => value.rulesVersion >= 6 || [3200, 4000].includes(value.zoneWidth), "Legacy attempts require their original zone width")
  .refine(value => value.rulesVersion === 1 || value.resistance !== undefined, "Versioned attempts require their saved resistance profile")
  .refine(value => value.rulesVersion < 3 || value.fishRarity !== undefined, "V3+ attempts require their public fish class")
  .refine(value => value.rulesVersion < 5 || value.motorResponse !== undefined && value.hullDamping !== undefined, "V5+ attempts require saved control parameters");
const boatCatchSchema = z.object({ castIndex: count.max(10), reelSeconds: count.max(30).optional(), fishId: id, weightGrams: count.min(1).max(1_000_000), caughtAt: instant });
const boatWorkSchema = z.object({ id: uuid, upgradeId: z.enum(boatUpgradeIds), startedAt: instant, finishesAt: instant, cost })
  .refine(value => Date.parse(value.finishesAt) > Date.parse(value.startedAt), "Boat work must take time");
const voyageFields = { id: uuid, routeId: id, departedAt: instant, arrivesAt: instant, fishingUntil: instant,
  returnStartedAt: instant.optional(), returnsAt: instant.optional(), maxCasts: count.min(1).max(11), maxCatches: count.min(1).max(10),
  castsUsed: count.max(11), catches: z.array(boatCatchSchema).max(10),
  loadout: z.object({ rodId: id, hookId: id, baitId: id.nullable() }), outboundSeconds: count.max(3600), inboundSeconds: count.max(3600),
  challenge: boatChallengeSchema.optional() };
export const boatVoyageSchema = z.object(voyageFields).refine(value => value.castsUsed <= value.maxCasts
  && value.catches.length <= Math.min(value.maxCatches, value.castsUsed)
  && new Set(value.catches.map(caught => caught.castIndex)).size === value.catches.length && value.catches.every(caught => caught.castIndex < value.castsUsed)
  && Date.parse(value.arrivesAt) >= Date.parse(value.departedAt) && Date.parse(value.fishingUntil) > Date.parse(value.arrivesAt)
  && (value.returnStartedAt == null) === (value.returnsAt == null)
  && (!value.returnStartedAt || Date.parse(value.returnsAt!) >= Date.parse(value.returnStartedAt))
  && (!value.challenge || value.castsUsed > 0 && !value.returnStartedAt), "Invalid saved boat voyage");
export const boatPrivateVoyageSchema = boatVoyageSchema.safeExtend({ slots: z.array(z.object({ fishId: id, weightGrams: count.min(1).max(1_000_000),
  challengeSeed: count.max(0xffff_ffff), difficulty: count.min(1).max(5), zoneWidth: z.union([z.literal(3200), z.literal(4000)]) })).min(1).max(11) })
  .refine(value => value.slots.length === value.maxCasts, "Each attempt needs its saved outcome");
const stateFields = { version: z.literal(1).prefault(1), level: count.max(1).prefault(0),
  modules: z.object({ engine: moduleTier, tank: moduleTier, hull: moduleTier, storage: moduleTier }).optional(),
  fuel: z.object({ cells: count.max(7), nextAt: instant.optional() }).optional(),
  upgrades: z.array(z.enum(["crate", "oars"])).max(2).prefault([]),
  blueprints: z.object({ landing_net: count.max(3).prefault(0), telescope: count.max(3).prefault(0) }).prefault({}),
  artifacts: z.array(artifact).max(2).prefault([]), completedVoyages: count.max(1_000_000_000).prefault(0), qualifiedVoyages: count.max(1_000_000_000).prefault(0),
  records: z.record(id, z.object({ weightGrams: count.min(1).max(1_000_000), caughtAt: instant })).prefault({}), work: boatWorkSchema.optional() };
const validState = (value: { upgrades: string[]; artifacts: string[]; qualifiedVoyages: number; completedVoyages: number; work?: unknown; voyage?: unknown }) =>
  new Set(value.upgrades).size === value.upgrades.length && new Set(value.artifacts).size === value.artifacts.length
  && value.qualifiedVoyages <= value.completedVoyages && !(value.work && value.voyage);
export const boatStateSchema = z.object({ ...stateFields, voyage: boatVoyageSchema.optional() }).refine(validState, "Invalid boat progress").prefault({});
export const boatPrivateStateSchema = z.object({ ...stateFields, voyage: boatPrivateVoyageSchema.optional() }).refine(validState, "Invalid private boat progress").prefault({});
export const boatCatalogSchema = z.object({ version: z.literal(1), routeId: id, name: z.string(), outboundSeconds: count.max(3600),
  inboundSeconds: count.max(3600), maxCasts: count.min(1).max(8), activeSeconds: count.min(120).max(3600), castExpirySeconds: z.literal(120),
  zoneWidth: z.literal(3200), netZoneWidth: z.literal(4000), oarsTravelSeconds: count.max(3600),
  fuel: z.object({ baseCapacity: count.min(1).max(7), regenSeconds: count.positive(), refillPricePearls: count.positive() }),
  moduleEffects: z.object({ engine: z.array(count.max(5)).length(6), tank: z.array(count.min(1).max(7)).length(6),
    storage: z.array(count.min(1).max(9)).length(6), hull: z.array(count.max(20)).length(6) }), spareCasts: count.max(2), dockSaleBonusPercent: count.max(100).optional(),
  upgrades: z.array(z.object({ id: z.enum(boatUpgradeIds), name: z.string(), description: z.string(), cost, seconds: count.max(86400),
    requiredHomeLevel: count.min(1).max(5), requiredBuildings: z.record(id, count.min(1).max(100)), module: z.enum(boatModuleIds).optional(), tier: moduleTier.min(1).optional(), blueprint: artifact.optional() }).refine(upgrade => upgrade.seconds > 0 || upgrade.id === "repair", "Only the first hull can be installed immediately")).length(boatUpgradeIds.length),
  blueprints: z.array(z.object({ id: artifact, name: z.string(), milestones: z.array(count.min(1).max(100)).length(3)
    .refine(values => values.every((value, index) => !index || value > values[index - 1])) })).length(2),
  weights: z.record(id, z.object({ minGrams: count.min(1).max(1_000_000), maxGrams: count.min(1).max(1_000_000) })
    .refine(value => value.minGrams < value.maxGrams)),
}).refine(value => new Set(value.upgrades.map(upgrade => upgrade.id)).size === boatUpgradeIds.length && new Set(value.blueprints.map(blueprint => blueprint.id)).size === 2,
  "Boat upgrades and blueprints must be distinct");
// A rolling deployment may still serve the five-upgrade workshop. Its paid repair
// cannot be quoted by the new UI. Keep the rest of the economy and saved claims readable.
const legacyBoatCatalogSchema = z.object({
  version: z.literal(1), routeId: id, outboundSeconds: count.positive(), inboundSeconds: count.positive(),
  fuel: z.never().optional(), moduleEffects: z.never().optional(),
  upgrades: z.array(z.object({ id: z.enum(["repair", "crate", "oars", "landing_net", "telescope"]) })).length(5),
}).refine(value => new Set(value.upgrades.map(entry => entry.id)).size === 5).transform(() => undefined);
export const compatibleBoatCatalogSchema = z.union([boatCatalogSchema, legacyBoatCatalogSchema]).optional();
export type BoatState = z.infer<typeof boatStateSchema>;
export type BoatPrivateState = z.infer<typeof boatPrivateStateSchema>;
export type BoatVoyage = z.infer<typeof boatVoyageSchema>;
export type BoatPrivateVoyage = z.infer<typeof boatPrivateVoyageSchema>;
export type BoatChallenge = z.infer<typeof boatChallengeSchema>;
export type BoatReelInput = z.infer<typeof boatReelInputSchema>;
export type BoatReelCommand = z.infer<typeof boatReelCommandSchema>;
export type BoatCatalog = z.infer<typeof boatCatalogSchema>;
export type BoatUpgradeId = typeof boatUpgradeIds[number];
