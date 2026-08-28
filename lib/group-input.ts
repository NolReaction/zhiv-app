export function normalizeGroupTitle(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function isValidGroupTitle(value: string): boolean {
  const normalized = normalizeGroupTitle(value);
  const length = Array.from(normalized).length;
  return length >= 1 && length <= 64 && !/[\u0000-\u001f\u007f]/.test(normalized);
}

export function normalizeGroupEmoji(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized.length === 0 ? null : normalized;
}

export function isValidGroupEmoji(value: string | null): boolean {
  return value === null || (
    Array.from(value).length <= 16 && !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export function matchesGroupPeopleSearch(displayName: string, query: string): boolean {
  const normalizeSearchText = (value: string) => normalizeGroupTitle(value.normalize("NFKC"))
    .toLocaleLowerCase("ru-RU")
    .replaceAll("ё", "е");
  const normalizedName = normalizeSearchText(displayName);
  const queryTokens = normalizeSearchText(query)
    .split(" ")
    .filter(Boolean);

  return queryTokens.every((token) => normalizedName.includes(token));
}
