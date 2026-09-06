import { z } from "zod";
import { ApiError } from "./check-in-api";

export const authOptionsSchema = z.object({ telegram: z.boolean(), email: z.boolean() });
const accountAccessSchema = z.object({
  methods: z.array(z.object({ provider: z.enum(["telegram", "email"]), label: z.string() })),
  sessions: z.array(z.object({ id: z.string().uuid(), label: z.string(), createdAt: z.string().datetime(), lastSeenAt: z.string().datetime(), current: z.boolean() })),
});
export type AuthOptions = z.infer<typeof authOptionsSchema>;
export type AccountAccess = z.infer<typeof accountAccessSchema>;
export type AuthIntent = "login" | "register" | "link";

async function authRequest<T>(path: string, schema: z.ZodType<T>, body?: unknown, method?: string): Promise<T> {
  const response = await fetch(`/api/v1/auth/${path}`, {
    method: method ?? (body === undefined ? "GET" : "POST"),
    credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000),
    headers: { Accept: "application/json", ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const error = z.object({ code: z.string(), message: z.string() }).safeParse(value);
    throw new ApiError(error.success ? error.data.message : response.status === 429 ? "Слишком много попыток. Подождите и попробуйте позже." : "Не удалось связаться с сервером", response.status, error.success ? error.data : undefined);
  }
  return schema.parse(value);
}
export const getAuthOptions = () => authRequest("options", authOptionsSchema);
export const getAccountAccess = () => authRequest("account", accountAccessSchema);
export const startAuth = (provider: "telegram" | "email", intent: AuthIntent, displayName?: string, email?: string) => authRequest(`${provider}/start`, z.object({ flow: z.string(), url: z.string().nullable() }), { intent, ...(displayName ? { displayName } : {}), ...(email ? { email } : {}) });
export const verifyEmailLogin = (flow: string, code: string) => authRequest("email/verify", z.object({ status: z.literal("ok") }), { flow, code });
export const revokeSession = (id: string) => authRequest(`sessions/${encodeURIComponent(id)}`, z.object({ status: z.literal("ok") }), undefined, "DELETE");
export const revokeOtherSessions = () => authRequest("sessions/revoke-others", z.object({ status: z.literal("ok") }), {});
export const logout = () => authRequest("logout", z.object({ status: z.literal("ok") }), {});

export function authReturnMessage(code: string): string {
  const messages: Record<string, string> = {
    linked: "Способ входа привязан к вашему профилю.",
    "signed-in": "Вы вошли в свой профиль.",
    auth_not_linked: "Этот способ входа ещё не привязан. Откройте прежний профиль и привяжите его в разделе «Способы входа». Если профиля ещё нет — выберите «Создать профиль».",
    auth_already_linked: "Этот способ входа уже связан с другим профилем. Аккаунты не были объединены.",
    unauthorized: "Сеанс закончился. Войдите снова и повторите привязку.",
    auth_session_limit: "Закройте ненужные сеансы в разделе «Устройства» и повторите вход.",
  };
  return messages[code] ?? "Вход не завершён. Попробуйте снова или выберите вход по почте.";
}
