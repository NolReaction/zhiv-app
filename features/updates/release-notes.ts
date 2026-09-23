import bundledFeed from "@/public/updates.json";

export type ReleaseNote = {
  id: string;
  version: string;
  date: string;
  title: string;
  changes: string[];
};

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function plainText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength && !/[<>]/.test(value);
}

/** Reject the whole malformed feed, so a bad deployment never erases good notes. */
export function parseReleaseFeed(value: unknown): ReleaseNote[] | null {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.releases)
    || value.releases.length === 0 || value.releases.length > 200) return null;
  const ids = new Set<string>();
  const releases: ReleaseNote[] = [];
  for (const item of value.releases) {
    if (!isRecord(item) || typeof item.id !== "string" || !ID_PATTERN.test(item.id) || ids.has(item.id)
      || !plainText(item.version, 40) || !plainText(item.title, 160)
      || typeof item.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(item.date)
      || !Number.isFinite(Date.parse(item.date)) || new Date(item.date).toISOString().slice(0, 10) !== item.date
      || !Array.isArray(item.changes) || item.changes.length === 0 || item.changes.length > 12
      || !item.changes.every(change => plainText(change, 400))) return null;
    ids.add(item.id);
    releases.push({ id: item.id, version: item.version.trim(), date: item.date, title: item.title.trim(), changes: item.changes.map(change => change.trim()) });
  }
  return releases.sort((a, b) => b.date.localeCompare(a.date));
}

export const BUNDLED_RELEASE_NOTES: ReleaseNote[] = parseReleaseFeed(bundledFeed) ?? [];

export function releaseReadStorageKey(ownerPublicId: string): string {
  return `zhiv:updates:read:v1:${encodeURIComponent(ownerPublicId)}`;
}

export function parseReadReleaseIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !Array.isArray(parsed.ids)) return new Set();
    return new Set(parsed.ids.filter((id): id is string => typeof id === "string" && ID_PATTERN.test(id)));
  } catch { return new Set(); }
}

export function unreadReleaseIds(releases: readonly ReleaseNote[], readIds: ReadonlySet<string>): string[] {
  return releases.filter(release => !readIds.has(release.id)).map(release => release.id);
}
