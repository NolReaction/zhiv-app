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
  return { token };
}
export async function readDevEconomyBody(request: Request, limit = 4096) {
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > limit) return { response: economyErrorResponse("BODY_TOO_LARGE", "Запрос слишком большой", 413) };
  try { return { body: JSON.parse(text) as unknown }; } catch { return { body: null }; }
}
export function respondDevEconomy<T>(action: () => T) {
  try { return NextResponse.json(action(), { headers: NO_STORE_HEADERS }); }
  catch (error) {
    if (error instanceof DevEconomyError) return economyErrorResponse(error.code, error.message, error.status);
    throw error;
  }
}
