import { NextResponse } from "next/server";
import { getDevIdentity } from "./api-store";
import { guardDevApi } from "./api-guard";
import { devSessionToken, parseIdempotencyKey } from "./api-route";
import type { DevEarthResult } from "./earth-sharing-store";

export const DEV_EARTH_BODY_LIMIT = 8 * 1024;
export const DEV_EARTH_HEADERS = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow" } as const;
export function devEarthError(status = 400, code = "INVALID_EARTH_REQUEST", retryAfterSeconds?: number) {
  return NextResponse.json({ code, message: status === 401 ? "Войдите в профиль ещё раз" : "Не удалось выполнить запрос геопозиции",
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }) }, { status,
    headers: { ...DEV_EARTH_HEADERS, ...(retryAfterSeconds === undefined ? {} : { "Retry-After": String(retryAfterSeconds) }) } });
}
export async function devEarthContext(request: Request, write = false): Promise<{ token: string; response?: never } | { response: Response; token?: never }> {
  const rejected = guardDevApi(request, false, DEV_EARTH_BODY_LIMIT);
  if (rejected) return { response: rejected };
  const token = await devSessionToken();
  if (!token || !getDevIdentity(token)) return { response: devEarthError(401, "UNAUTHORIZED") };
  // Coordinates and identities never belong in request URLs or access logs.
  if (new URL(request.url).search) return { response: devEarthError() };
  if (write && !parseIdempotencyKey(request)) return { response: devEarthError(400, "INVALID_IDEMPOTENCY_KEY") };
  return { token };
}
export async function readDevEarthBody(request: Request): Promise<{ value: unknown; response?: never } | { response: Response; value?: never }> {
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json")
    return { response: devEarthError(415, "JSON_REQUIRED") };
  const reader = request.body?.getReader();
  if (!reader) return { response: devEarthError() };
  const bytes = new Uint8Array(DEV_EARTH_BODY_LIMIT);
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > bytes.length) {
        void reader.cancel().catch(() => {});
        return { response: devEarthError(413, "BODY_TOO_LARGE") };
      }
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    return { value: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size))) as unknown };
  } catch { return { response: devEarthError() }; }
  finally { reader.releaseLock(); }
}
export function devEarthResponse<T>(result: DevEarthResult<T>) {
  return result.kind === "ok" ? NextResponse.json(result.value, { headers: DEV_EARTH_HEADERS })
    : devEarthError(result.status, result.code, result.retryAfterSeconds);
}
