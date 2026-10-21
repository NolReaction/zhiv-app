import { NextResponse } from "next/server";
import { NO_STORE_HEADERS } from "./api-route";
import type { DevMailResult } from "./mail-store";

const headers = { ...NO_STORE_HEADERS, "X-Robots-Tag": "noindex, nofollow" };
export function mailError(status = 400, code = "INVALID_MAIL_REQUEST", message = "Проверьте параметры почты") {
  return NextResponse.json({ code, message }, { status, headers });
}
export function devMailResponse<T>(result: DevMailResult<T>) {
  if (result.kind === "ok") return NextResponse.json(result.value, { headers });
  if (result.kind === "unauthorized") return mailError(401, "UNAUTHORIZED", "Войдите в профиль ещё раз");
  if (result.kind === "owner-mismatch") return mailError(409, "MAIL_OWNER_CHANGED", "Открыт другой профиль. Обновите почту.");
  if (result.kind === "not-found") return mailError(404, "MAIL_NOT_FOUND", "Письмо не найдено");
  return mailError();
}
/** Size is enforced on the stream even without a truthful Content-Length. */
export async function readDevMailBody(request: Request): Promise<{ value: unknown; response?: never } | { response: Response; value?: never }> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    return { response: mailError(415, "JSON_REQUIRED", "Ожидается application/json") };
  const reader = request.body?.getReader();
  if (!reader) return { response: mailError() };
  const bytes = new Uint8Array(1024);
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > bytes.length) {
        void reader.cancel().catch(() => {});
        return { response: mailError(413, "BODY_TOO_LARGE", "Запрос слишком большой") };
      }
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    return { value: JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))) as unknown };
  } catch { return { response: mailError() }; }
  finally { reader.releaseLock(); }
}
