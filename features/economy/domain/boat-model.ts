import { z } from "zod";

const count = z.number().int().nonnegative().safe();
const id = z.string().min(1).max(80);
const uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const instant = z.string().datetime();
const cost = z.object({ coins: count.max(1_000_000_000), items: z.record(id, count.max(1_000_000)) });
export const boatUpgradeIds = ["repair", "crate", "oars", "landing_net", "telescope"] as const;
export const boatArtifactIds = ["landing_net", "telescope"] as const;
const artifact = z.enum(boatArtifactIds);
export const boatReelInputSchema = z.object({ tick: count.max(599), held: z.boolean() }).strict();
export const boatReelCommandSchema = z.object({ challengeId: uuid, inputs: z.array(boatReelInputSchema).max(600), endTick: count.min(1).max(600) }).strict()
  .refine(value => value.inputs.every((input, index) => input.tick < value.endTick && (!index || input.tick > value.inputs[index - 1].tick)), "Inputs must be ordered within the attempt");
export const boatChallengeSchema = z.object({ id: uuid, rulesVersion: z.literal(1), seed: count.max(0xffff_ffff), tickMs: z.literal(50),
  maxTicks: z.literal(600), zoneWidth: z.union([z.literal(3200), z.literal(4000)]), difficulty: count.min(1).max(5), startedAt: instant, expiresAt: instant,
  biteAt: instant.optional(), fishRarity: z.enum(["common", "uncommon", "rare", "epic", "legendary"]).optional() })
  .refine(value => Date.parse(value.expiresAt) > Date.parse(value.startedAt)
    && (!value.biteAt || Date.parse(value.biteAt) >= Date.parse(value.startedAt) && Date.parse(value.biteAt) < Date.parse(value.expiresAt)), "Attempt bite must be within its lifetime");
const boatCatchSchema = z.object({ castIndex: count.max(9), fishId: id, weightGrams: count.min(1).max(1_000_000), caughtAt: instant });
const boatWorkSchema = z.object({ id: uuid, upgradeId: z.enum(boatUpgradeIds), startedAt: instant, finishesAt: instant, cost })
  .refine(value => Date.parse(value.finishesAt) > Date.parse(value.startedAt), "Boat work must take time");
const voyageFields = { id: uuid, routeId: id, departedAt: instant, arrivesAt: instant, fishingUntil: instant,
  returnStartedAt: instant.optional(), returnsAt: instant.optional(), maxCasts: count.min(1).max(10), maxCatches: count.min(1).max(10),
  castsUsed: count.max(10), catches: z.array(boatCatchSchema).max(10),
  loadout: z.object({ rodId: id, hookId: id, baitId: id.nullable() }), outboundSeconds: count.min(1).max(3600), inboundSeconds: count.min(1).max(3600),
  challenge: boatChallengeSchema.optional() };
export const boatVoyageSchema = z.object(voyageFields).refine(value => value.castsUsed <= value.maxCasts
  && value.catches.length <= Math.min(value.maxCatches, value.castsUsed)
  && new Set(value.catches.map(caught => caught.castIndex)).size === value.catches.length && value.catches.every(caught => caught.castIndex < value.castsUsed)
  && Date.parse(value.arrivesAt) >= Date.parse(value.departedAt) && Date.parse(value.fishingUntil) > Date.parse(value.arrivesAt)
  && (value.returnStartedAt == null) === (value.returnsAt == null)
  && (!value.returnStartedAt || Date.parse(value.returnsAt!) > Date.parse(value.returnStartedAt))
  && (!value.challenge || value.castsUsed > 0 && !value.returnStartedAt), "Invalid saved boat voyage");
export const boatPrivateVoyageSchema = boatVoyageSchema.safeExtend({ slots: z.array(z.object({ fishId: id, weightGrams: count.min(1).max(1_000_000),
  challengeSeed: count.max(0xffff_ffff), difficulty: count.min(1).max(5), zoneWidth: z.union([z.literal(3200), z.literal(4000)]) })).min(1).max(10) })
  .refine(value => value.slots.length === value.maxCasts, "Each attempt needs its saved outcome");
const stateFields = { version: z.literal(1).prefault(1), level: count.max(1).prefault(0),
  upgrades: z.array(z.enum(["crate", "oars"])).max(2).prefault([]),
  blueprints: z.object({ landing_net: count.max(3).prefault(0), telescope: count.max(3).prefault(0) }).prefault({}),
  artifacts: z.array(artifact).max(2).prefault([]), completedVoyages: count.max(1_000_000_000).prefault(0), qualifiedVoyages: count.max(1_000_000_000).prefault(0),
  records: z.record(id, z.object({ weightGrams: count.min(1).max(1_000_000), caughtAt: instant })).prefault({}), work: boatWorkSchema.optional() };
const validState = (value: { upgrades: string[]; artifacts: string[]; qualifiedVoyages: number; completedVoyages: number; work?: unknown; voyage?: unknown }) =>
  new Set(value.upgrades).size === value.upgrades.length && new Set(value.artifacts).size === value.artifacts.length
  && value.qualifiedVoyages <= value.completedVoyages && !(value.work && value.voyage);
export const boatStateSchema = z.object({ ...stateFields, voyage: boatVoyageSchema.optional() }).refine(validState, "Invalid boat progress").prefault({});
export const boatPrivateStateSchema = z.object({ ...stateFields, voyage: boatPrivateVoyageSchema.optional() }).refine(validState, "Invalid private boat progress").prefault({});
export const boatCatalogSchema = z.object({ version: z.literal(1), routeId: id, name: z.string(), outboundSeconds: count.min(1).max(3600),
  inboundSeconds: count.min(1).max(3600), maxCasts: count.min(1).max(8), activeSeconds: count.min(120).max(3600), castExpirySeconds: z.literal(120),
  zoneWidth: z.literal(3200), netZoneWidth: z.literal(4000), oarsTravelSeconds: count.min(1).max(3600),
  upgrades: z.array(z.object({ id: z.enum(boatUpgradeIds), name: z.string(), description: z.string(), cost, seconds: count.min(1).max(86400),
    requiredHomeLevel: count.min(1).max(5), requiredBuildings: z.record(id, count.min(1).max(100)), blueprint: artifact.optional() })).length(5),
  blueprints: z.array(z.object({ id: artifact, name: z.string(), milestones: z.array(count.min(1).max(100)).length(3)
    .refine(values => values.every((value, index) => !index || value > values[index - 1])) })).length(2),
  weights: z.record(id, z.object({ minGrams: count.min(1).max(1_000_000), maxGrams: count.min(1).max(1_000_000) })
    .refine(value => value.minGrams < value.maxGrams)),
}).refine(value => new Set(value.upgrades.map(upgrade => upgrade.id)).size === 5 && new Set(value.blueprints.map(blueprint => blueprint.id)).size === 2,
  "Boat upgrades and blueprints must be distinct");
export type BoatState = z.infer<typeof boatStateSchema>;
export type BoatPrivateState = z.infer<typeof boatPrivateStateSchema>;
export type BoatVoyage = z.infer<typeof boatVoyageSchema>;
export type BoatPrivateVoyage = z.infer<typeof boatPrivateVoyageSchema>;
export type BoatChallenge = z.infer<typeof boatChallengeSchema>;
export type BoatReelInput = z.infer<typeof boatReelInputSchema>;
export type BoatReelCommand = z.infer<typeof boatReelCommandSchema>;
export type BoatCatalog = z.infer<typeof boatCatalogSchema>;
export type BoatUpgradeId = typeof boatUpgradeIds[number];
