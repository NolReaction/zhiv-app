import { NextResponse } from "next/server";
import { isTrustedDevRequest } from "@/lib/dev-api-origin";

export function guardDevApi(request: Request, requireJson = false): NextResponse | null {
  if (process.env.NODE_ENV === "production" && process.env.ENABLE_DEV_API !== "true") {
    return NextResponse.json(
      { code: "DEV_API_DISABLED", message: "Подключите production API" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (!isTrustedDevRequest(request)) {
    return NextResponse.json(
      { code: "UNTRUSTED_ORIGIN", message: "Источник запроса не разрешён" },
      { status: 403, headers: { "Cache-Control": "no-store" } },
    );
  }

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > 2_048) {
    return NextResponse.json(
      { code: "BODY_TOO_LARGE", message: "Запрос слишком большой" },
      { status: 413, headers: { "Cache-Control": "no-store" } },
    );
  }

  if (requireJson && !request.headers.get("content-type")?.startsWith("application/json")) {
    return NextResponse.json(
      { code: "JSON_REQUIRED", message: "Ожидается application/json" },
      { status: 415, headers: { "Cache-Control": "no-store" } },
    );
  }

  return null;
}
