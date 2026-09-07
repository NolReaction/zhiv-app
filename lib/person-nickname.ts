import type { Person } from "./check-in-contract";
import { normalizeUserStatus } from "./user-status";

export const MAX_PERSON_NICKNAME_LENGTH = 50;

export function normalizePersonNickname(value: string): string | null {
  const normalized = normalizeUserStatus(value);
  return normalized !== null && Array.from(normalized).length <= MAX_PERSON_NICKNAME_LENGTH
    ? normalized
    : null;
}

export function personDisplayName(person: Person): string {
  return person.nickname || person.user.displayName;
}
