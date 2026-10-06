import type { Person } from "./check-in-contract";
import { hasUserTextControls } from "./user-text";

export const MAX_PERSON_NICKNAME_LENGTH = 50;

export function normalizePersonNickname(value: string): string | null {
  if (hasUserTextControls(value)) return null;
  const normalized = value.trim().replace(/[\s\p{Z}]+/gu, " ");
  return Array.from(normalized).length <= MAX_PERSON_NICKNAME_LENGTH ? normalized : null;
}

export function personDisplayName(person: Person): string {
  return person.nickname || person.user.displayName;
}
