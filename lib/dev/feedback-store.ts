import { getDevIdentity } from "./api-store";
import { feedbackRequestSchema, type FeedbackRequest, type FeedbackReceipt } from "@/features/feedback/feedback-api";

const COOLDOWN_MS = 24 * 60 * 60 * 1000;
type StoredFeedback = { body: FeedbackRequest; receipt: FeedbackReceipt };
const globalStore = globalThis as typeof globalThis & { __zhivDevFeedback?: Map<string, Map<string, StoredFeedback>> };
const store = (): Map<string, Map<string, StoredFeedback>> => globalStore.__zhivDevFeedback ??= new Map<string, Map<string, StoredFeedback>>();

export function getDevFeedbackAvailability(token: string | undefined, now = Date.now()) {
  const identity = getDevIdentity(token);
  if (!identity) return null;
  const records = store().get(identity.user.publicId);
  const lastTime = records?.size ? Math.max(...Array.from(records.values(), record => Date.parse(record.receipt.createdAt))) : null;
  const nextAllowedAt = lastTime === null ? null : new Date(lastTime + COOLDOWN_MS).toISOString();
  return { serverTime: new Date(now).toISOString(), canSubmit: lastTime === null || now >= lastTime + COOLDOWN_MS, nextAllowedAt };
}

export function submitDevFeedback(token: string | undefined, input: unknown, now = Date.now()) {
  const identity = getDevIdentity(token);
  if (!identity) return { status: 401, body: { code: "UNAUTHORIZED", message: "Сессия не найдена" } };
  const parsed = feedbackRequestSchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { code: "INVALID_FEEDBACK", message: "Выберите тему и напишите от 10 до 3000 символов" } };
  const body = parsed.data;
  if (body.expectedOwnerPublicId !== identity.user.publicId) return { status: 409, body: { code: "FEEDBACK_ACCOUNT_CHANGED", message: "Аккаунт изменился. Обновите приложение перед отправкой." } };
  const records = store().get(identity.user.publicId) ?? new Map<string, StoredFeedback>();
  const existing = records.get(body.clientRequestId);
  if (existing) {
    if (existing.body.category !== body.category || existing.body.message !== body.message) return { status: 409, body: { code: "IDEMPOTENCY_CONFLICT", message: "Этот запрос уже содержит другое сообщение" } };
    return { status: 200, body: { ...existing.receipt, replayed: true } };
  }
  const availability = getDevFeedbackAvailability(token, now)!;
  if (!availability.canSubmit) return { status: 429, body: { code: "FEEDBACK_COOLDOWN", message: "Можно отправить одно обращение за 24 часа", nextAllowedAt: availability.nextAllowedAt, serverTime: availability.serverTime } };
  const receipt: FeedbackReceipt = { id: crypto.randomUUID(), clientRequestId: body.clientRequestId, createdAt: new Date(now).toISOString(), nextAllowedAt: new Date(now + COOLDOWN_MS).toISOString(), replayed: false };
  records.set(body.clientRequestId, { body, receipt });
  store().set(identity.user.publicId, records);
  return { status: 201, body: receipt };
}

export function resetDevFeedbackForTests() { store().clear(); }
