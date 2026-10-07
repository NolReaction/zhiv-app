import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { adminRequest, getAdminAccess } from "./admin-api";

const count = z.number().int().safe().nonnegative();
const signed = z.number().int().safe();
const instant = z.string().datetime();
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const identifier = z.string().min(1).max(100);
const shared = { serverTime: instant, from: date, to: date, startAt: instant, endAt: instant,
  q: z.string().max(100), scope: z.enum(["players", "all"]) };
const category = z.enum(["gameplay", "trade", "escrow"]);
const analyticsSchema = z.object({ ...shared,
  summary: z.object({ activePlayers: count, events: count, spendingPlayers: count,
    constructionStarts: count, constructionClaims: count, constructionPlayers: count }),
  daily: z.array(z.object({ date, players: count, events: count, constructionStarts: count })).max(366),
  resources: z.array(z.object({ resourceId: identifier, received: count, spent: count, reserved: count,
    returned: count, net: signed, players: count }).refine(value => value.net === value.received + value.returned - value.spent - value.reserved,
  "Resource net must include receipts, expenses and escrow")).max(1000),
  flows: z.array(z.object({ kind: identifier, targetId: identifier.nullable(), resourceId: identifier,
    category, received: count, spent: count, players: count, events: count })).max(1000),
  actions: z.array(z.object({ kind: identifier, targetId: identifier.nullable(), events: count, players: count })).max(1000),
  construction: z.array(z.object({ buildingId: identifier, starts: count, claims: count, players: count })).max(1000),
  firstConstructions: z.array(z.object({ buildingId: identifier.nullable(), players: count })).max(1000),
  buildingLevels: z.array(z.object({ buildingId: identifier, level: count, players: count })).max(1000),
  gameplay: z.object({ mealsConsumed: count, foodPlayers: count, ordersCompleted: count, orderPlayers: count,
    orderCoinsEarned: count, orderReplacements: count, paidOrderReplacements: count, orderPearlsSpent: count })
    .refine(value => value.paidOrderReplacements <= value.orderReplacements),
  meals: z.array(z.object({ itemId: identifier, heroPortions: count, builderPortions: count, players: count })).max(1000),
  orders: z.array(z.object({ templateId: identifier.nullable(), completed: count, replacements: count,
    paidReplacements: count, coinsEarned: count, pearlsSpent: count, players: count })
    .refine(value => value.paidReplacements <= value.replacements)).max(1000),
  presence: z.object({ coverageFrom: instant.nullable(), players: count, onlineSeconds: count, flaggedPlayers: count,
    daily: z.array(z.object({ date, players: count, onlineSeconds: count, flaggedPlayers: count })).max(366),
    reviewDays: z.array(z.object({ publicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/),
      displayName: z.string(), date, onlineSeconds: count.max(86400), flaggedAt: instant, watchlisted: z.boolean() })).max(100),
    reviewDaysTruncated: z.boolean() }),
  coverage: z.object({ firstRecordedAt: instant.nullable(), unattributedEvents: count,
    matchingPlayers: count, initializedPlayers: count, flowsTruncated: z.boolean(), actionsTruncated: z.boolean(), ordersTruncated: z.boolean() }),
});
const eventsSchema = z.object({ ...shared, kind: z.string().max(100), resource: z.string().max(100),
  direction: z.enum(["all", "in", "out"]), at: instant.nullable(), offset: count,
  limit: z.number().int().min(1).max(100), total: count,
  events: z.array(z.object({ id: z.string().min(1).max(512),
    publicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/), displayName: z.string(),
    createdAt: instant, kind: identifier, targetId: identifier.nullable(), quantity: signed.nullable(),
    contextKnown: z.boolean(), category, coins: signed, pearls: signed,
    items: z.record(z.string().min(1).max(100), signed) })).max(100),
});

export type AdminAnalytics = z.infer<typeof analyticsSchema>;
export type AdminAnalyticsEvents = z.infer<typeof eventsSchema>;
export type AdminAnalyticsFilters = { from: string; to: string; q: string; scope: "players" | "all" };
export type AdminAnalyticsEventFilters = AdminAnalyticsFilters & {
  kind: string; resource: string; direction: "all" | "in" | "out"; offset: number; limit: number; at: string | null;
};
function matchesFilters(value: z.infer<z.ZodObject<typeof shared>>, filters: AdminAnalyticsFilters) {
  return value.from === filters.from && value.to === filters.to && value.q === filters.q && value.scope === filters.scope
    && Date.parse(value.startAt) <= Date.parse(value.endAt) && Date.parse(value.endAt) <= Date.parse(value.serverTime);
}
export function getAdminAnalytics(filters: AdminAnalyticsFilters, signal?: AbortSignal) {
  return adminRequest(`analytics?${new URLSearchParams(filters)}`,
    analyticsSchema.refine(value => matchesFilters(value, filters), "Analytics response must match filters"), signal);
}
export function getAdminAnalyticsEvents(filters: AdminAnalyticsEventFilters, signal?: AbortSignal) {
  const { at, offset, limit, ...rest } = filters;
  const query = new URLSearchParams({ ...rest, offset: String(offset), limit: String(limit), ...(at ? { at } : {}) });
  return adminRequest(`analytics/events?${query}`, eventsSchema.refine(value => matchesFilters(value, filters)
    && value.kind === filters.kind && value.resource === filters.resource && value.direction === filters.direction
    && value.offset === offset && value.limit === limit && value.at === at && value.events.length <= limit
    && value.events.length <= Math.max(0, value.total - value.offset)
    && value.events.every(event => Date.parse(event.createdAt) >= Date.parse(value.startAt) && Date.parse(event.createdAt) < Date.parse(value.endAt))
    && new Set(value.events.map(event => event.id)).size === value.events.length,
  "Event response must match filters and page"), signal);
}
export async function loadAdminAnalytics(actorPublicId: string, filters: AdminAnalyticsFilters, signal: AbortSignal) {
  await verifyActor(actorPublicId, signal);
  return getAdminAnalytics(filters, signal);
}
export async function loadAdminAnalyticsEvents(actorPublicId: string, filters: AdminAnalyticsEventFilters, signal: AbortSignal) {
  await verifyActor(actorPublicId, signal);
  return getAdminAnalyticsEvents(filters, signal);
}
async function verifyActor(actorPublicId: string, signal: AbortSignal) {
  const actor = await getAdminAccess(signal);
  if (signal.aborted) throw new DOMException("Запрос отменён", "AbortError");
  if (actor.publicId !== actorPublicId) throw new ApiError("Аккаунт администратора сменился. Откройте панель заново.", 403);
}
