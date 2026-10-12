import { z } from "zod";
import { economyResultSchema } from "@/features/economy/domain/model";

export const normalizePromoCode = (value: string) => value.trim().toUpperCase();
export const promoRequestSchema = z.object({
  requestId: z.string().uuid(), ownerPublicId: z.string().min(1).max(80),
  expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  code: z.string().max(80).transform(normalizePromoCode).pipe(z.string().regex(/^[A-Z0-9][A-Z0-9_-]{2,39}$/)),
}).strict();
export const promoRewardSchema = z.object({ coins: z.number().int().nonnegative(), pearls: z.number().int().nonnegative(),
  items: z.record(z.number().int().positive()), });
export const promoResultSchema = economyResultSchema.extend({ title: z.string(), reward: promoRewardSchema });
export type PromoRequest = z.infer<typeof promoRequestSchema>;
export type PromoResult = z.infer<typeof promoResultSchema>;
