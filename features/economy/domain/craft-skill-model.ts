import { z } from "zod";

const seconds = z.number().int().nonnegative().max(31_536_000).safe();
const identifier = z.string().regex(/^[a-z0-9_]{1,80}$/);
export const craftSkillIds = ["cooking", "travel", "fishing", "crafting", "smelting", "gathering", "forestry", "mining", "building"] as const;
export type CraftSkillId = typeof craftSkillIds[number];
export const craftSkillsSchema = z.object({
  version: z.literal(1).prefault(1), buildingHistoryVersion: z.literal(1).optional(), cookingSeconds: seconds.prefault(0), travelSeconds: seconds.prefault(0),
  fishingSeconds: seconds.prefault(0), craftingSeconds: seconds.prefault(0), smeltingSeconds: seconds.prefault(0),
  gatheringSeconds: seconds.prefault(0), forestrySeconds: seconds.prefault(0), miningSeconds: seconds.prefault(0), buildingSeconds: seconds.prefault(0),
  lastCooking: z.object({ jobId: z.string().uuid(), recipeId: identifier, successful: z.boolean(), at: z.string().datetime() }).optional(),
});
export const craftSkillsCatalogSchema = z.object({
  version: z.literal(1), buildingPracticeDivisor: z.number().int().min(1).max(8).prefault(1),
  levels: z.array(z.object({ requiredSeconds: seconds, cookingBonusBps: z.number().int().min(0).max(1000),
    travelSpeedBps: z.number().int().min(0).max(500), workSpeedBps: z.number().int().min(0).max(300).prefault(0) })).length(10),
}).refine(spec => spec.levels[0].requiredSeconds === 0 && spec.levels.every((level, index) => index === 0 ||
  level.requiredSeconds > spec.levels[index - 1].requiredSeconds && level.cookingBonusBps >= spec.levels[index - 1].cookingBonusBps
  && level.travelSpeedBps >= spec.levels[index - 1].travelSpeedBps && level.workSpeedBps >= spec.levels[index - 1].workSpeedBps), "Skills must grow gradually");
export type CraftSkills = z.infer<typeof craftSkillsSchema>;
