import { z } from "zod";
import policy from "@/apps/api/src/main/resources/world/guest-profile-policy.json";
import { economyCatalog } from "@/features/economy/domain/model";
import { collectionCatalog } from "@/features/world/domain/collection-book";
import { GAME_ACHIEVEMENT_TARGETS } from "@/features/game/achievement-progress";

export const GUEST_ACHIEVEMENT_IDS = policy.achievementIds;
export const GUEST_COLLECTION_IDS = {
  travel: collectionCatalog.travel.finds,
  fishing: economyCatalog.fishing?.fish.map(fish => fish.itemId) ?? [],
  quarry: collectionCatalog.quarry.finds.map(find => find.id),
};
const publicId = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/);
const ids = (known: readonly string[]) => z.array(z.string().refine(id => known.includes(id))).max(known.length)
  .refine(values => new Set(values).size === values.length);
export const guestProfileSchema = z.object({
  ownerPublicId: publicId, circleId: z.string().uuid(),
  user: z.object({ publicId, displayName: z.string().min(1).max(100) }).strict(),
  homeLevel: z.number().int().min(1).max(5), completedExplorations: z.number().int().nonnegative().safe(),
  achievements: z.array(z.object({ id: z.string().refine(id => GUEST_ACHIEVEMENT_IDS.includes(id)),
    level: z.number().int().positive().max(4) }).strict().refine(award => {
      const levels = GAME_ACHIEVEMENT_TARGETS[award.id as keyof typeof GAME_ACHIEVEMENT_TARGETS];
      return !!levels && award.level <= levels.length;
    })).max(GUEST_ACHIEVEMENT_IDS.length).refine(awards => new Set(awards.map(award => award.id)).size === awards.length),
  collections: z.object({ travel: ids(GUEST_COLLECTION_IDS.travel), fishing: ids(GUEST_COLLECTION_IDS.fishing), quarry: ids(GUEST_COLLECTION_IDS.quarry) }).strict(),
  serverTime: z.string().datetime(),
}).strict();
export type GuestProfile = z.infer<typeof guestProfileSchema>;

/** Stable catalogue order; discoveries only, never quantities or the private job clocks. */
export function guestCollections(finds: readonly string[], catches: Readonly<Record<string, number>>) {
  return { travel: GUEST_COLLECTION_IDS.travel.filter(id => finds.includes(id)),
    fishing: GUEST_COLLECTION_IDS.fishing.filter(id => (catches[id] ?? 0) > 0),
    quarry: GUEST_COLLECTION_IDS.quarry.filter(id => finds.includes(id)) };
}
