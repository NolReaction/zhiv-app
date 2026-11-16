import { createHash } from "node:crypto";
import type { EconomyView, EconomyResult } from "@/features/economy/domain/model";
import { isDevPresenceActive } from "./activity-store";
import { NextResponse } from "next/server";
import { guardDevApi } from "./api-guard";
import { devSessionToken, NO_STORE_HEADERS } from "./api-route";
import { getDevIdentity } from "./api-store";
import { DevEconomyError } from "./economy-store";

export const economyErrorResponse = (code: string, message: string, status = 400) =>
  NextResponse.json({ code, message }, { status, headers: NO_STORE_HEADERS });
export async function devEconomyContext(request: Request, write = false, limit = 4096) {
  const rejected = guardDevApi(request, write, limit);
  if (rejected) return { response: rejected };
  const token = await devSessionToken();
  if (!getDevIdentity(token)) return { response: economyErrorResponse("UNAUTHORIZED", "Войдите в аккаунт", 401) };
  if (write && !isDevPresenceActive(getDevIdentity(token)!.user.publicId, request.headers.get("X-Game-Presence"), Date.now(), token)) return { response: economyErrorResponse("GAME_SESSION_INACTIVE", "Вернитесь в игру для продолжения", 409) };
  return { token };
}
export async function readDevEconomyBody(request: Request, limit = 4096) {
  const reader = request.body?.getReader();
  if (!reader) return { body: null };
  // Enforce the existing byte limit while reading, even when Content-Length is
  // absent or dishonest. A rejected upload must not remain buffered in memory.
  const bytes = new Uint8Array(limit);
  let size = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (size + chunk.value.byteLength > limit) {
        void reader.cancel().catch(() => {});
        return { response: economyErrorResponse("BODY_TOO_LARGE", "Запрос слишком большой", 413) };
      }
      bytes.set(chunk.value, size); size += chunk.value.byteLength;
    }
    return { body: JSON.parse(new TextDecoder().decode(bytes.subarray(0, size))) as unknown };
  } catch { return { body: null }; }
  finally { reader.releaseLock(); }
}
export function respondDevEconomy<T>(action: () => T, respond: (value: T) => Response = value => NextResponse.json(value, { headers: NO_STORE_HEADERS })) {
  try { return respond(action()); }
  catch (error) {
    if (error instanceof DevEconomyError) return economyErrorResponse(error.code, error.message, error.status);
    throw error;
  }
}

// The fingerprint describes the actual public catalog, including hotfixes within a catalog version.
export function economySnapshotResponse(request: Request, value: EconomyView | EconomyResult) {
  const state = "state" in value ? value.state : value;
  const tag = createHash("sha256").update(JSON.stringify(state.catalog)).digest("hex");
  const headers = { ...NO_STORE_HEADERS, Vary: "X-Economy-Catalog", "X-Economy-Catalog": tag };
  if (request.headers.get("X-Economy-Catalog") !== tag) return NextResponse.json(value, { headers });
  const compact = { ...state, catalog: tag };
  return NextResponse.json("state" in value ? { ...value, state: compact } : compact, { headers });
}
