import { z } from "zod";

const count = z.number().int().nonnegative().max(1_000_000_000_000);
export const playerProgressionSchema = z.object({
  version: z.literal(1).prefault(1), xp: count.prefault(0), workSeconds: count.prefault(0),
  awardedLevels: z.array(z.number().int().min(1).max(100)).max(100).prefault([]),
  badges: z.array(z.string().max(60)).max(1200).prefault([]), pendingPearls: count.prefault(0),
  season: z.object({ id: z.string().regex(/^$|^\d{4}-\d{2}$/).prefault(""), points: count.prefault(0),
    awardedMilestones: z.array(z.number().int().positive()).max(10).prefault([]),
  }).prefault({}),
  lastAward: z.object({ xp: count, source: z.enum(["construction", "production", "exploration", "order", "ship"]), at: z.string().datetime() }).optional(),
});
export type PlayerProgression = z.infer<typeof playerProgressionSchema>;
export const emptyPlayerProgression = (): PlayerProgression => playerProgressionSchema.parse({});
