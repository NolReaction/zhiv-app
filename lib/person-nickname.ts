import type { Person } from "./check-in-contract";

export const MAX_PERSON_NICKNAME_LENGTH = 50;

export function normalizePersonNickname(value: string): string | null {
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return null;
  const normalized = value.trim().replace(/[\s\p{Z}]+/gu, " ");
  return Array.from(normalized).length <= MAX_PERSON_NICKNAME_LENGTH ? normalized : null;
}

export function personDisplayName(person: Person): string {
  return person.nickname || person.user.displayName;
}
