import { z } from "zod";
import { ApiError, getMe } from "./check-in-api";
import { deviceTimeZone } from "./time-zone";

export const authOptionsSchema = z.object({ telegram: z.boolean().default(false), email: z.boolean(), vk: z.boolean().default(false), legacy: z.boolean().default(false) });
const accountAccessSchema = z.object({
  methods: z.array(z.object({ provider: z.enum(["telegram", "email", "vk"]), label: z.string() })),
  sessions: z.array(z.object({ id: z.string().uuid(), label: z.string(), createdAt: z.string().datetime(), lastSeenAt: z.string().datetime(), current: z.boolean() })),
});
export type AuthOptions = z.infer<typeof authOptionsSchema>;
export type AccountAccess = z.infer<typeof accountAccessSchema>;
export type AuthIntent = "login" | "link";

export async function authRequest<T extends z.ZodTypeAny>(path: string, schema: T, body?: unknown, method?: string): Promise<z.output<T>> {
  const response = await fetch(`/api/v1/auth/${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ code: z.string(), message: z.string(), requestId: z.string().uuid().nullish() }).safeParse(value);
    throw new ApiError(error.success ? error.data.message : response.status === 429 ? "Слишком много попыток. Подождите и попробуйте позже." : "Не удалось связаться с сервером", response.status, error.success ? error.data : undefined, response.headers.get("X-Request-ID"));
  }
  return schema.parse(value);
}
export const getAuthOptions = () => authRequest("options", authOptionsSchema);
export const getAccountAccess = () => authRequest("account", accountAccessSchema);
export const startAuth = (provider: "vk" | "email", intent: AuthIntent, email?: string) => authRequest(`${provider}/start`, z.object({ flow: z.string(), url: z.string().nullable() }), { intent, ...(email ? { email } : {}) });
// A mobile connection can lose the body after the server commits and sets cookies.
// Reconcile the browser's server-side state instead of replaying a one-use proof.
function mayHaveCompleted(error: unknown): boolean {
  return !(error instanceof ApiError) || error.status >= 500 || error.body?.code === "AUTH_EXPIRED" || error.body?.code === "AUTH_USE_LINK";
}
export async function verifyEmailLogin(flow: string, code: string, link = false): Promise<{ status: "ok" | "profile-required" }> {
  try { return await authRequest("email/verify", z.object({ status: z.enum(["ok", "profile-required"]) }), { flow, code }); }
  catch (error) {
    // An existing session is expected during linking and cannot prove it succeeded.
    if (!link && mayHaveCompleted(error)) {
      try {
        if (await getMe()) return { status: "ok" };
        if ((await getRegistrationState()).pending) return { status: "profile-required" };
      } catch { /* Preserve the original failure if reconciliation is also offline. */ }
    }
    throw error;
  }
}
export const getRegistrationState = () => authRequest("registration", z.object({ pending: z.boolean() }));
export async function completeRegistration(displayName: string): Promise<{ status: "ok" }> {
  try { return await authRequest("registration", z.object({ status: z.literal("ok") }), { displayName, timeZone: deviceTimeZone() }); }
  catch (error) {
    if (mayHaveCompleted(error)) {
      try { if (await getMe()) return { status: "ok" }; } catch { /* Keep the original error. */ }
    }
    throw error;
  }
}
export const cancelRegistration = () => authRequest("registration", z.object({ status: z.literal("ok") }), undefined, "DELETE");
export const revokeSession = (id: string) => authRequest(`sessions/${encodeURIComponent(id)}`, z.object({ status: z.literal("ok") }), undefined, "DELETE");
export const revokeOtherSessions = () => authRequest("sessions/revoke-others", z.object({ status: z.literal("ok") }), {});
export const logout = () => authRequest("logout", z.object({ status: z.literal("ok") }), {});

export function authReturnMessage(code: string): string {
  const messages: Record<string, string> = {
    linked: "Способ входа привязан к вашему профилю.",
    "signed-in": "Вы вошли в свой профиль.",
    "profile-required": "",
    "account-proof": "Доступ подтверждён. Продолжите действие в профиле.",
    auth_not_linked: "Этот способ входа ещё не привязан. Откройте прежний профиль и привяжите его в разделе «Способы входа».",
    auth_already_linked: "Этот способ входа уже связан с другим профилем. Аккаунты не были объединены.",
    unauthorized: "Сеанс закончился. Войдите снова и повторите привязку.",
    auth_session_limit: "Закройте ненужные сеансы в разделе «Устройства» и повторите вход.",
    auth_expired: "Время подтверждения истекло или вход открыт в другом браузере. Начните вход ещё раз в этом окне.",
    auth_cancelled: "Вход отменён. Вы можете попробовать ещё раз.",
    vk_login_failed: "Не удалось подтвердить вход через ВК. Попробуйте ещё раз чуть позже.",
    telegram_login_failed: "Не удалось связаться с Telegram. Выберите доступный способ входа.",
    auth_unavailable: "Этот способ входа временно недоступен.",
  };
  return messages[code] ?? "Вход не завершён. Попробуйте ещё раз.";
}
