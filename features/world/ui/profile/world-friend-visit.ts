import type { Person } from "@/lib/check-in-contract";
import { personDisplayName } from "@/lib/person-nickname";
import type { GuestWorldTarget } from "@/features/people/guest-world-model";

export type ProfileFriendVisit = { ownerPublicId: string; target: GuestWorldTarget };

/** Resolve the relationship again so an old card cannot open a different account or a revoked friend. */
export function profileFriendVisit(ownerPublicId: string | null | undefined, people: readonly Person[] | undefined,
  person: Pick<Person, "circleId" | "user">, isOnline: boolean): ProfileFriendVisit | null {
  if (!ownerPublicId || !isOnline || person.user.publicId === ownerPublicId) return null;
  const connected = people?.find(friend => friend.circleId === person.circleId && friend.user.publicId === person.user.publicId);
  if (!connected || connected.theirSharingMode === "OFF") return null;
  return { ownerPublicId, target: { circleId: connected.circleId, targetPublicId: connected.user.publicId,
    displayName: personDisplayName(connected) } };
}

export function currentProfileFriendVisit(ownerPublicId: string | null | undefined, selection: ProfileFriendVisit | null,
  people: readonly Person[] | undefined, isOnline: boolean, open: boolean): GuestWorldTarget | undefined {
  if (!open || !selection || selection.ownerPublicId !== ownerPublicId) return undefined;
  return profileFriendVisit(ownerPublicId, people, { circleId: selection.target.circleId,
    user: { publicId: selection.target.targetPublicId, displayName: selection.target.displayName } }, isOnline)?.target;
}
