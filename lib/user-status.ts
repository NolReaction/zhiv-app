export const MAX_STATUS_LENGTH = 120;

export function normalizeUserStatus(value: string): string | null {
  if (/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value)) return null;
  const normalized = value.trim().replace(/[\s\p{Z}]+/gu, " ");
  return Array.from(normalized).length <= MAX_STATUS_LENGTH ? normalized : null;
}
