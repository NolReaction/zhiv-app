import { z } from "zod";

const seconds = z.number().int().nonnegative().max(31_536_000).safe();
const identifier = z.string().regex(/^[a-z0-9_]{1,80}$/);
export const craftSkillsSchema = z.object({
  version: z.literal(1).prefault(1), cookingSeconds: seconds.prefault(0), travelSeconds: seconds.prefault(0),
  lastCooking: z.object({ jobId: z.string().uuid(), recipeId: identifier, successful: z.boolean(), at: z.string().datetime() }).optional(),
});
export const craftSkillsCatalogSchema = z.object({
  version: z.literal(1), levels: z.array(z.object({ requiredSeconds: seconds, cookingBonusBps: z.number().int().min(0).max(1000),
    travelSpeedBps: z.number().int().min(0).max(500) })).length(10),
}).refine(spec => spec.levels[0].requiredSeconds === 0 && spec.levels.every((level, index) => index === 0 ||
  level.requiredSeconds > spec.levels[index - 1].requiredSeconds && level.cookingBonusBps >= spec.levels[index - 1].cookingBonusBps
  && level.travelSpeedBps >= spec.levels[index - 1].travelSpeedBps), "Skills must grow gradually");
export type CraftSkills = z.infer<typeof craftSkillsSchema>;
export type CraftSkillId = "cooking" | "travel";
