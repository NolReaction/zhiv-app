import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { PEARL_DISPLAY_DIVISOR, pearlDisplayAmount } from "@/features/economy/domain/money";
import { adminRequest, verifyAdminActor } from "./admin-api";
import { adminAnalyticsEventSchema, type AdminAnalyticsFilters } from "./admin-analytics-api";
import { analyticsAction, analyticsCategory, analyticsCsv, analyticsTarget } from "./admin-analytics-utils";

export type AdminAnalyticsExportFilters = AdminAnalyticsFilters & {
  kind: string; resource: string; direction: "all" | "in" | "out"; allTime: boolean;
};
export type AdminAnalyticsExportFormat = "csv" | "json";
export type AdminAnalyticsExportProgress = { completed: number; total: number | null };
export type AdminAnalyticsExportResult = {
  blob: Blob; filename: string; count: number; snapshotAt: string; filters: AdminAnalyticsExportFilters;
};

const publicId = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/;
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const instant = z.string().datetime().refine(value => /^\d{4}-.+(?:\.\d{1,9})?Z$/.test(value));
const identifier = z.string().max(80).regex(/^(?:[a-z][a-z0-9_]{0,79})?$/);
const pageLimit = 1000;
const exportPageSchema = z.object({
  serverTime: instant, from: date, to: date, startAt: instant, endAt: instant,
  q: z.string().max(100), scope: z.enum(["players", "all"]), kind: identifier, resource: identifier,
  direction: z.enum(["all", "in", "out"]), allTime: z.boolean(), snapshotAt: instant,
  limit: z.number().int().min(1).max(pageLimit), total: z.number().int().safe().nonnegative(),
  events: z.array(adminAnalyticsEventSchema).max(pageLimit), nextCursor: z.string().min(1).max(4096).nullable(),
});
export type AdminAnalyticsExportPage = z.infer<typeof exportPageSchema>;
type ExportEvent = z.infer<typeof adminAnalyticsEventSchema>;

export const isExactAdminPlayerId = (value: string): boolean => publicId.test(value.trim().toUpperCase());
const changedHistory = () => new ApiError("История изменилась во время выгрузки. Повторите экспорт; неполный файл не сохранён.", 409);
const invalidReply = () => new ApiError("Не удалось проверить полноту выгрузки. Повторите экспорт; неполный файл не сохранён.", 502);
function active(signal: AbortSignal) {
  if (signal.aborted) throw new DOMException("Выгрузка отменена", "AbortError");
}

/** Date.parse loses PostgreSQL microseconds. Keep all nine Instant fraction digits. */
function instantNanos(value: string): bigint {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z$/.exec(value);
  const milliseconds = match ? Date.parse(`${match[1]}Z`) : NaN;
  if (!Number.isFinite(milliseconds)) throw invalidReply();
  return BigInt(milliseconds) * BigInt(1_000_000) + BigInt((match?.[2] ?? "").padEnd(9, "0"));
}

function selection(filters: AdminAnalyticsExportFilters): AdminAnalyticsExportFilters {
  const q = filters.q.trim(), query = isExactAdminPlayerId(q) ? q.toUpperCase() : q;
  if (filters.allTime && !isExactAdminPlayerId(query))
    throw new ApiError("Для всей истории выберите игрока по точному ID.", 400);
  return Object.freeze({ from: filters.from, to: filters.to, q: query, scope: filters.scope,
    kind: filters.kind, resource: filters.resource, direction: filters.direction, allTime: filters.allTime });
}

function matchesMovement(event: ExportEvent, filters: AdminAnalyticsExportFilters): boolean {
  if (filters.kind && event.kind !== filters.kind) return false;
  const values = filters.resource ? [filters.resource === "coins" ? event.coins : filters.resource === "pearls"
    ? event.pearls : Object.hasOwn(event.items, filters.resource) ? event.items[filters.resource] : 0]
    : [event.coins, event.pearls, ...Object.values(event.items)];
  return !filters.resource && filters.direction === "all" || values.some(value => filters.direction === "in"
    ? value > 0 : filters.direction === "out" ? value < 0 : value !== 0);
}

function validatePage(page: AdminAnalyticsExportPage, filters: AdminAnalyticsExportFilters): void {
  const start = instantNanos(page.startAt), end = instantNanos(page.endAt), snapshot = instantNanos(page.snapshotAt);
  if (page.limit !== pageLimit || page.q !== filters.q || page.scope !== filters.scope || page.kind !== filters.kind
    || page.resource !== filters.resource || page.direction !== filters.direction || page.allTime !== filters.allTime
    || start > end || end > snapshot || snapshot > instantNanos(page.serverTime)
    || page.events.length > page.limit || page.events.length > page.total)
    throw invalidReply();
  if (filters.allTime) {
    if (page.from !== "0001-01-01" || page.to !== page.snapshotAt.slice(0, 10)
      || start !== instantNanos("0001-01-01T00:00:00Z") || end !== snapshot) throw invalidReply();
  } else {
    const requestedStart = instantNanos(`${filters.from}T00:00:00Z`);
    const nextDay = new Date(Date.parse(`${filters.to}T00:00:00Z`) + 86_400_000).toISOString();
    const requestedEnd = instantNanos(nextDay), cappedEnd = requestedEnd < snapshot ? requestedEnd : snapshot;
    if (page.from !== filters.from || page.to !== filters.to || start !== requestedStart || end !== cappedEnd) throw invalidReply();
  }
  if (page.events.some(event => {
    const at = instantNanos(event.createdAt);
    return at < start || at >= end || isExactAdminPlayerId(filters.q) && event.publicId !== filters.q || !matchesMovement(event, filters);
  })) throw invalidReply();
}

function metadata(page: AdminAnalyticsExportPage) {
  return { from: page.from, to: page.to, startAt: page.startAt, endAt: page.endAt, q: page.q, scope: page.scope,
    kind: page.kind, resource: page.resource, direction: page.direction, allTime: page.allTime,
    snapshotAt: page.snapshotAt, total: page.total };
}

const csvHeaders = ["ID операции", "Время UTC", "ID игрока", "Игрок", "Тип операции (ID)", "Операция",
  "Объект (ID)", "Объект", "Количество", "Контекст записан (1/0)", "Категория (ID)", "Категория",
  "Монеты: изменение", "Жемчуг: изменение", "Жемчуг: сырые единицы", "Предметы JSON", "С UTC", "По UTC",
  "Начало диапазона UTC", "Конец диапазона UTC", "Поиск игрока", "Аудитория", "Фильтр операции",
  "Фильтр ресурса", "Фильтр направления", "Вся история (1/0)", "Снимок UTC", "Всего операций"];
function csvRows(page: AdminAnalyticsExportPage) {
  return page.events.map(event => [event.id, event.createdAt, event.publicId, event.displayName, event.kind,
    analyticsAction(event.kind), event.targetId, event.targetId ? analyticsTarget(event.targetId) : null,
    event.quantity, Number(event.contextKnown), event.category, analyticsCategory[event.category], event.coins,
    pearlDisplayAmount(event.pearls), event.pearls, JSON.stringify(event.items), page.from, page.to,
    page.startAt, page.endAt, page.q, page.scope, page.kind, page.resource, page.direction, Number(page.allTime),
    page.snapshotAt, page.total]);
}

/** Read every keyset page; a Blob is returned only after complete validation and a final actor check. */
export async function loadAdminAnalyticsExport(actorPublicId: string, input: AdminAnalyticsExportFilters,
  format: AdminAnalyticsExportFormat, signal: AbortSignal,
  onProgress?: (progress: AdminAnalyticsExportProgress) => void): Promise<AdminAnalyticsExportResult> {
  active(signal);
  if (format !== "csv" && format !== "json") throw new ApiError("Выберите формат выгрузки.", 400);
  const filters = selection(input), chunks: BlobPart[] = [], identifiers = new Set<string>(), cursors = new Set<string>();
  let cursor: string | null = null, first: AdminAnalyticsExportPage | null = null, signature = "", completed = 0;
  let previousAt: bigint | null = null;
  onProgress?.({ completed: 0, total: null });
  do {
    active(signal);
    await verifyAdminActor(actorPublicId, signal);
    active(signal);
    const query: URLSearchParams = new URLSearchParams({ ...filters, allTime: String(filters.allTime), limit: String(pageLimit), ...(cursor ? { cursor } : {}) });
    const page: AdminAnalyticsExportPage = await adminRequest(`analytics/events/export?${query}`, exportPageSchema, signal);
    active(signal);
    validatePage(page, filters);
    const nextSignature = JSON.stringify(metadata(page));
    if (!first) {
      first = page; signature = nextSignature;
      if (format === "csv") chunks.push(`${analyticsCsv([csvHeaders])}\r\n`);
      else chunks.push(`${JSON.stringify({ schemaVersion: 1, generatedAt: page.serverTime, ...metadata(page),
        currencyUnits: { rawCoinUnitsPerDisplayedCoin: 1, rawPearlUnitsPerDisplayedPearl: PEARL_DISPLAY_DIVISOR }, complete: true }).slice(0, -1)},"events":[\n`);
    } else if (nextSignature !== signature) throw changedHistory();
    if (page.nextCursor !== null && (page.events.length === 0 || cursors.has(page.nextCursor))) throw invalidReply();
    for (const event of page.events) {
      const at = instantNanos(event.createdAt);
      if (identifiers.has(event.id) || previousAt !== null && at > previousAt) throw changedHistory();
      identifiers.add(event.id); previousAt = at;
    }
    if (completed + page.events.length > page.total) throw changedHistory();
    if (format === "csv" && page.events.length) chunks.push(`${analyticsCsv(csvRows(page)).slice(1)}\r\n`);
    if (format === "json" && page.events.length) chunks.push(`${completed ? ",\n" : ""}${page.events.map((event: ExportEvent) => JSON.stringify(event)).join(",\n")}`);
    completed += page.events.length;
    active(signal);
    onProgress?.({ completed, total: page.total });
    cursor = page.nextCursor;
    if (cursor !== null) {
      if (completed >= page.total) throw invalidReply();
      cursors.add(cursor);
    }
  } while (cursor !== null);
  if (!first || completed !== first.total) throw changedHistory();
  await verifyAdminActor(actorPublicId, signal);
  active(signal);
  if (format === "json") chunks.push("\n]}\n");
  const name = isExactAdminPlayerId(filters.q) ? filters.q : "filtered";
  const period = filters.allTime ? "all-history" : `${filters.from}_${filters.to}`;
  const at = first.snapshotAt.slice(0, 19).replaceAll(":", "-");
  const blob = new Blob(chunks, { type: format === "csv" ? "text/csv;charset=utf-8" : "application/json;charset=utf-8" });
  return { blob, filename: `economy-${name}-${period}-${at}.${format}`, count: completed, snapshotAt: first.snapshotAt, filters };
}

/** Called synchronously by the active UI after its owner/filter freshness guard. */
export function downloadAdminAnalyticsExport(result: AdminAnalyticsExportResult): void {
  const url = URL.createObjectURL(result.blob);
  const link = document.createElement("a"); link.href = url; link.download = result.filename;
  try { document.body.append(link); link.click(); }
  finally { link.remove(); URL.revokeObjectURL(url); }
}
