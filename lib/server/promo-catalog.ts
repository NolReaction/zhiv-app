// Server-only catalog. Never import this module into features/ or public assets.
import raw from "@/apps/api/src/main/resources/world/promo-codes.json";
import { z } from "zod";
import { economyCatalog } from "@/features/economy/domain/model";
import { normalizePromoCode } from "@/features/promo/model";
const itemIds = new Set(economyCatalog.items.map(item => item.id));
const date = z.string().datetime({ offset: true });
const gift = z.object({ coins: z.number().int().min(0).max(1_000_000).prefault(0),
  pearls: z.number().int().min(0).max(10_000).prefault(0),
  items: z.record(z.string(), z.number().int().min(1).max(10_000)).prefault({}), }).strict();
const entry = z.object({ id: z.string().regex(/^[a-z0-9][a-z0-9_-]{2,63}$/),
  code: z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/), enabled: z.boolean(),
  title: z.string().trim().min(1).max(80), startsAt: date.nullable().prefault(null), endsAt: date.nullable().prefault(null),
  reward: gift, }).strict();
const schema = z.object({ version: z.literal(1), codes: z.array(entry).max(1000) }).strict().superRefine((catalog, context) => {
  const ids = new Set<string>(), codes = new Set<string>();
  catalog.codes.forEach((value, i) => {
    const error = (message: string) => context.addIssue({ code: z.ZodIssueCode.custom, path: ["codes", i], message });
    if (ids.has(value.id) || codes.has(normalizePromoCode(value.code))) error("Duplicate promo id or code");
    ids.add(value.id); codes.add(normalizePromoCode(value.code));
    if (value.startsAt && value.endsAt && Date.parse(value.startsAt) >= Date.parse(value.endsAt)) error("Invalid promo date range");
    if (!value.reward.coins && !value.reward.pearls && !Object.keys(value.reward.items).length) error("Empty promo reward");
    if (Object.keys(value.reward.items).some(id => !itemIds.has(id))) error("Unknown promo item");
    if (Object.values(value.reward.items).reduce((sum, count) => sum + count, 0) > 10_000) error("Too many promo items");
  });
});
export const parsePromoCatalog = (value: unknown) => schema.parse(value);
export const promoCatalog = parsePromoCatalog(raw);
export type PromoCatalog = ReturnType<typeof parsePromoCatalog>;
