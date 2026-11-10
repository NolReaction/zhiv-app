import { z } from "zod";

export const fishingVisibilitySchema = z.object({
  ownerPublicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/),
  leaderboardOptIn: z.boolean(),
  visibilityVersion: z.number().int().nonnegative().safe(),
});
export const fishingStandingsSchema = fishingVisibilitySchema.extend({
  scope: z.enum(["friends", "global"]),
  entries: z.array(z.object({
    fishId: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
    weightGrams: z.number().int().positive().max(1_000_000),
    displayName: z.string().min(1).max(100),
    isMe: z.boolean(),
    tiedCount: z.number().int().positive().safe(),
  })).max(256).refine(rows => new Set(rows.map(row => row.fishId)).size === rows.length),
});
export type FishingStandings = z.infer<typeof fishingStandingsSchema>;
export type FishingVisibility = z.infer<typeof fishingVisibilitySchema>;
