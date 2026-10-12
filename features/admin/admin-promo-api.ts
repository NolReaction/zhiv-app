import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";
import { economyCatalog } from "@/features/economy/domain/model";
import { getAdminAccess } from "./admin-api";
import { validAdminReason } from "./admin-input";

const count = z.number().int().nonnegative().safe();
const instant = z.string().datetime({ offset: true });
const promoId = z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/);
const knownItems = new Set(economyCatalog.items.map(item => item.id));
export const adminPromoDefinitionSchema = z.object({
  id: promoId, code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/),
  title: z.string().trim().min(1).max(80), enabled: z.boolean(),
  startsAt: instant.nullable(), endsAt: instant.nullable(),
  reward: z.object({ coins: count.max(1_000_000), pearls: count.max(10_000),
    items: z.record(z.string().refine(id => knownItems.has(id)), count.positive().max(10_000)),
  }).refine(value => Object.values(value.items).reduce((sum, amount) => sum + amount, 0) <= 10_000,
    "Не более 10 000 предметов в подарке").refine(value => value.coins > 0 || value.pearls > 0 || Object.keys(value.items).length > 0,
    "Добавьте хотя бы одну награду"),
}).refine(value => !value.startsAt || !value.endsAt || Date.parse(value.endsAt) > Date.parse(value.startsAt),
  "Окончание должно быть позже начала");
export const adminPromoCommandSchema = z.object({
  requestId: z.string().uuid(), action: z.enum(["create", "update", "delete"]), promoId,
  expectedVersion: count, reason: z.string().refine(validAdminReason), definition: adminPromoDefinitionSchema.optional(),
}).refine(value => value.action === "delete" ? value.definition === undefined : value.definition?.id === value.promoId)
  .refine(value => value.action !== "create" || value.expectedVersion === 0);
const entrySchema = z.object({ definition: adminPromoDefinitionSchema, version: count, redemptions: count,
  createdAt: instant.nullable(), updatedAt: instant.nullable() });
const listSchema = z.object({ serverTime: instant, codes: z.array(entrySchema).max(1000) })
  .refine(value => new Set(value.codes.map(entry => entry.definition.id)).size === value.codes.length
    && new Set(value.codes.map(entry => entry.definition.code)).size === value.codes.length);
const receiptSchema = z.object({ requestId: z.string().uuid(), action: z.enum(["create", "update", "delete"]),
  promoId, version: count, createdAt: instant, replayed: z.boolean() });
export type AdminPromoDefinition = z.infer<typeof adminPromoDefinitionSchema>;
export type AdminPromoCommand = z.infer<typeof adminPromoCommandSchema>;
export type AdminPromoEntry = z.infer<typeof entrySchema>;
export type AdminPromos = z.infer<typeof listSchema>;

async function promoRequest<T>(actorPublicId: string, path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>,
  signal: AbortSignal, body?: AdminPromoCommand): Promise<T> {
  const actor = await getAdminAccess(signal);
  signal.throwIfAborted();
  if (actor.publicId !== actorPublicId) throw new ApiError("Аккаунт администратора сменился. Откройте панель заново.", 403);
  const controller = new AbortController();
  const abort = () => controller.abort(signal.reason);
  signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/v1/admin/${path}`, { method: body ? "POST" : "GET", credentials: "same-origin",
      cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const error = z.object({ code: z.string(), message: z.string() }).safeParse(value);
      throw new ApiError(error.success ? error.data.message : "Не удалось обновить промокоды", response.status,
        error.success ? error.data : undefined, response.headers.get("X-Request-ID"));
    }
    const result = schema.safeParse(value);
    if (!result.success) throw new ApiError("Ответ по промокодам не удалось проверить. Повторите тот же запрос.", 502);
    return result.data;
  } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); }
}
export const loadAdminPromos = (actorPublicId: string, signal: AbortSignal) =>
  promoRequest(actorPublicId, "promos", listSchema, signal);
export function manageAdminPromo(actorPublicId: string, command: AdminPromoCommand, signal: AbortSignal) {
  const body = adminPromoCommandSchema.parse(command);
  return promoRequest(actorPublicId, "promos/manage", receiptSchema.refine(value => value.requestId === body.requestId
    && value.action === body.action && value.promoId === body.promoId && value.version > body.expectedVersion), signal, body);
}

const pendingKey = (actor: string) => `zhiv.admin.promo.pending.${actor}`;
/** A lost response retains its exact UUID and payload, including across tab changes. */
export function readPendingAdminPromo(storage: Pick<Storage, "getItem">, actor: string): AdminPromoCommand | null {
  try { const value = adminPromoCommandSchema.safeParse(JSON.parse(storage.getItem(pendingKey(actor)) ?? "null")); return value.success ? value.data : null; }
  catch { return null; }
}
export function writePendingAdminPromo(storage: Pick<Storage, "setItem" | "removeItem">, actor: string, value: AdminPromoCommand | null): void {
  if (value) storage.setItem(pendingKey(actor), JSON.stringify(value));
  else storage.removeItem(pendingKey(actor));
}
