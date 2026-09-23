import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev/api-guard";
import { devSessionToken, NO_STORE_HEADERS } from "@/lib/dev/api-route";
import { getDevFeedbackAvailability, submitDevFeedback } from "@/lib/dev/feedback-store";
import { getDevIdentity } from "@/lib/dev/api-store";

export const dynamic = "force-dynamic";
const MAX_BODY_BYTES = 16_384;

export async function GET(request: Request) {
  const rejected = guardDevApi(request);
  if (rejected) return rejected;
  const token = await devSessionToken();
  const identity = getDevIdentity(token);
  const expected = new URL(request.url).searchParams.get("expectedOwnerPublicId");
  if (identity && expected !== identity.user.publicId) return NextResponse.json({ code: "FEEDBACK_ACCOUNT_CHANGED", message: "Аккаунт изменился. Обновите приложение перед отправкой." }, { status: 409, headers: NO_STORE_HEADERS });
  const value = getDevFeedbackAvailability(token);
  return value ? NextResponse.json(value, { headers: NO_STORE_HEADERS })
    : NextResponse.json({ code: "UNAUTHORIZED", message: "Сессия не найдена" }, { status: 401, headers: NO_STORE_HEADERS });
}

export async function POST(request: Request) {
  const rejected = guardDevApi(request, true, MAX_BODY_BYTES);
  if (rejected) return rejected;
  // Read a bounded stream: Content-Length may be absent or incorrect.
  const reader = request.body?.getReader();
  let size = 0;
  const chunks: Uint8Array[] = [];
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return NextResponse.json({ code: "BODY_TOO_LARGE", message: "Запрос слишком большой" }, { status: 413, headers: NO_STORE_HEADERS });
      }
      chunks.push(value);
    }
  }
  const body = new Uint8Array(size);
  let cursor = 0;
  for (const chunk of chunks) { body.set(chunk, cursor); cursor += chunk.length; }
  let value: unknown = null;
  try { value = JSON.parse(new TextDecoder().decode(body)); } catch { /* Validation returns a controlled 400. */ }
  const result = submitDevFeedback(await devSessionToken(), value);
  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE_HEADERS });
}
