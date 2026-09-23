import { z } from "zod";
import { ApiError } from "@/lib/check-in-api";

export const FEEDBACK_MIN_LENGTH = 10;
export const FEEDBACK_MAX_LENGTH = 3000;
export const feedbackCategories = { bug: "Ошибка", suggestion: "Предложение", other: "Другое" } as const;
export const feedbackStatuses = { new: "Новое", reviewed: "Просмотрено", resolved: "Решено" } as const;
export const feedbackCategorySchema = z.enum(["bug", "suggestion", "other"]);
export const feedbackStatusSchema = z.enum(["new", "reviewed", "resolved"]);
export const feedbackMessageLength = (message: string) => Array.from(message.trim()).length;
export const feedbackRequestSchema = z.object({
  clientRequestId: z.string().uuid().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
  expectedOwnerPublicId: z.string().regex(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/),
  category: feedbackCategorySchema,
  message: z.string().transform(value => value.replace(/\r\n?/g, "\n").trim())
    .refine(value => feedbackMessageLength(value) >= FEEDBACK_MIN_LENGTH && feedbackMessageLength(value) <= FEEDBACK_MAX_LENGTH)
    .refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value), "Удалите управляющие символы"),
}).strict();
const instant = z.string().datetime();
export const feedbackAvailabilitySchema = z.object({ serverTime: instant, canSubmit: z.boolean(), nextAllowedAt: instant.nullable() });
const receiptSchema = z.object({ id: z.string().uuid(), clientRequestId: z.string().uuid(), createdAt: instant, nextAllowedAt: instant, replayed: z.boolean() });
const itemSchema = z.object({ id: z.string().uuid(), category: feedbackCategorySchema, message: z.string().refine(value => feedbackMessageLength(value) <= FEEDBACK_MAX_LENGTH),
  status: feedbackStatusSchema, createdAt: instant, updatedAt: instant, authorPublicId: z.string(), authorDisplayName: z.string() });
const pageSchema = z.object({ serverTime: instant, total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(100), items: z.array(itemSchema).max(100) });

export type FeedbackRequest = z.infer<typeof feedbackRequestSchema>;
export type FeedbackCategory = FeedbackRequest["category"];
export type FeedbackStatus = z.infer<typeof feedbackStatusSchema>;
export type FeedbackAvailability = z.infer<typeof feedbackAvailabilitySchema>;
export type FeedbackReceipt = z.infer<typeof receiptSchema>;
export type AdminFeedbackItem = z.infer<typeof itemSchema>;
export type AdminFeedbackPage = z.infer<typeof pageSchema>;

export class FeedbackError extends ApiError {
  constructor(message: string, status: number, readonly nextAllowedAt: string | null = null, readonly serverTime: string | null = null) {
    super(message, status);
  }
}

async function request<T>(path: string, schema: z.ZodType<T, z.ZodTypeDef, unknown>, signal?: AbortSignal, body?: unknown): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = globalThis.setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`/api/v1/${path}`, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", signal: controller.signal,
      headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const parsed = z.object({ message: z.string().optional(), error: z.object({ message: z.string() }).optional(), nextAllowedAt: instant.optional(), serverTime: instant.optional() }).safeParse(value);
      throw new FeedbackError(parsed.success ? parsed.data.error?.message ?? parsed.data.message ?? "Не удалось отправить запрос" : "Не удалось отправить запрос",
        response.status, parsed.success ? parsed.data.nextAllowedAt ?? null : null, parsed.success ? parsed.data.serverTime ?? null : null);
    }
    const parsed = schema.safeParse(value);
    if (!parsed.success) throw new FeedbackError("Не удалось проверить ответ сервера. Повторите запрос.", 502);
    return parsed.data;
  } finally {
    globalThis.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export const getFeedbackAvailability = (ownerPublicId: string, signal?: AbortSignal) => request(`feedback?${new URLSearchParams({ expectedOwnerPublicId: ownerPublicId })}`, feedbackAvailabilitySchema, signal);
export const submitFeedback = (body: FeedbackRequest, signal?: AbortSignal) => request("feedback", receiptSchema, signal, feedbackRequestSchema.parse(body));
export const getAdminFeedback = (options: { status: FeedbackStatus | "all"; category: FeedbackCategory | "all"; offset: number; limit: number }, signal?: AbortSignal) =>
  request(`admin/feedback?${new URLSearchParams({ ...options, offset: String(options.offset), limit: String(options.limit) })}`, pageSchema, signal);
export const updateAdminFeedbackStatus = (id: string, status: FeedbackStatus, requestId: string, signal?: AbortSignal) =>
  request(`admin/feedback/${encodeURIComponent(id)}/status`, itemSchema, signal, { requestId, status });
