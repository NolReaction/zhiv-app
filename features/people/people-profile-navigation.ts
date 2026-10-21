import type { Person } from "@/lib/check-in-contract";

export type PersonProfileTarget = { ownerPublicId: string; circleId: string; targetPublicId: string };

/** A profile entry belongs to the current account and an exact, still connected person. */
export function personProfileTarget(ownerPublicId: string | null | undefined, people: readonly Person[] | undefined,
  person: Pick<Person, "circleId" | "user">): PersonProfileTarget | null {
  if (!ownerPublicId || ownerPublicId === person.user.publicId) return null;
  const connected = people?.find(row => row.circleId === person.circleId && row.user.publicId === person.user.publicId);
  return connected ? { ownerPublicId, circleId: connected.circleId, targetPublicId: connected.user.publicId } : null;
}

export function currentPersonProfile(ownerPublicId: string | null | undefined, target: PersonProfileTarget | null | undefined,
  people: readonly Person[] | undefined): Person | null {
  if (!target || !ownerPublicId || target.ownerPublicId !== ownerPublicId || target.targetPublicId === ownerPublicId) return null;
  return people?.find(person => person.circleId === target.circleId && person.user.publicId === target.targetPublicId) ?? null;
}
