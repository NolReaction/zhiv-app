import { NextResponse } from "next/server";
import { guardDevApi } from "@/lib/dev-api-guard";
import { devSessionToken, NO_STORE_HEADERS } from "@/lib/dev-api-route";
import { getDevIdentity } from "@/lib/dev-api-store";
import type { DevGameResult } from "@/lib/dev-game-store";

export async function devGameContext(request: Request, write = false) {
  const rejected = guardDevApi(request, write);
  if (rejected) return { response: rejected };
  const token = await devSessionToken();
  if (!getDevIdentity(token)) return { response: gameRequestError("UNAUTHORIZED", 401) };
  return { token };
}

export function gameRequestError(code: string, status = 400) {
  return NextResponse.json({ code, message: "Не удалось выполнить игровой запрос" }, { status, headers: NO_STORE_HEADERS });
}

export async function readDevGameBody(request: Request) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > 2_048) {
    return { response: gameRequestError("BODY_TOO_LARGE", 413) };
  }
  try {
    return { body: JSON.parse(text) as unknown };
  } catch {
    return { body: null };
  }
}

export function devGameResponse<T>(result: DevGameResult<T>) {
  if (result.kind === "ok") return NextResponse.json(result.value, { headers: NO_STORE_HEADERS });
  const status = result.code === "UNAUTHORIZED" ? 401 : result.code === "GAME_SESSION_LIMIT" ? 429 : 409;
  return gameRequestError(result.code, status);
}
