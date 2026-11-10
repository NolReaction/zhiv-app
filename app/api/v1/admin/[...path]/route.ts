import { NextResponse } from "next/server";
import { z } from "zod";
import { neighborAdminBuyCommandSchema, neighborAdminSettingsCommandSchema } from "@/features/economy/domain/neighbor-model";
import { devSessionToken } from "@/lib/dev/api-route";
import { getDevAdminDirectory, getDevIdentity } from "@/lib/dev/api-store";
import { guardDevApi } from "@/lib/dev/api-guard";
import { devAdminAllowed, lockDevAdmin, trustedDevAdminRequest, unlockDevAdmin } from "@/lib/dev/admin-access";
import { commandDevAdminNeighbor, getDevAdminAudit } from "@/lib/dev/admin-store";
import { getDevAdminNeighbor } from "@/lib/dev/economy-store";
import { readDevEconomyBody, respondDevEconomy } from "@/lib/dev/economy-route";

const headers = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow" };
const error = (code: string, message: string, status: number) => NextResponse.json({ code, message }, { status, headers });
function guard(request: Request, write: boolean) {
  // Caddy forwards production administration to Ktor. This adapter can never open that namespace in a web build.
  if (process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test")
    return error("ADMIN_UNAVAILABLE", "Панель не подключена к серверу приложения", 503);
  if (!trustedDevAdminRequest(request)) return error("UNTRUSTED_ORIGIN", "Локальная панель доступна только с доверенного адреса и той же страницы", 403);
  return guardDevApi(request, write, 32768);
}
const route = (request: Request) => new URL(request.url).pathname.replace(/^\/api\/v1\/admin\//, "").replace(/\/$/, "");
const publicId = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/;

export async function GET(request: Request) {
  const rejected = guard(request, false); if (rejected) return rejected;
  const token = await devSessionToken(), identity = getDevIdentity(token);
  if (!token || !identity) return error("UNAUTHORIZED", "Войдите в локальный аккаунт", 401);
  if (!devAdminAllowed(token)) return error("FORBIDDEN", "Введите локальный код администратора из терминала", 403);
  const path = route(request), query = new URL(request.url).searchParams;
  if (path === "access" && !query.size) return NextResponse.json({ publicId: identity.user.publicId,
    displayName: identity.user.displayName, serverTime: new Date().toISOString(), mode: "local" }, { headers });
  if (path === "local/players" && !query.size) return NextResponse.json({ players: getDevAdminDirectory() }, { headers });
  if (path === "neighbor") {
    const target = query.get("publicId") ?? undefined;
    if ([...query.keys()].some(key => key !== "publicId") || query.getAll("publicId").length > 1 || (target !== undefined && !publicId.test(target)))
      return error("INVALID_NEIGHBOR_PLAYER", "Укажите точный публичный ID игрока", 400);
    return respondDevEconomy(() => getDevAdminNeighbor(token, target));
  }
  if (path === "audit") {
    if ([...query.keys()].some(key => !["offset", "limit"].includes(key))) return error("INVALID_ADMIN_QUERY", "Некорректный запрос журнала", 400);
    const offset = Number(query.get("offset") ?? 0), limit = Number(query.get("limit") ?? 25);
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      return error("INVALID_ADMIN_QUERY", "Некорректная страница журнала", 400);
    return NextResponse.json(getDevAdminAudit(offset, limit), { headers });
  }
  return error("LOCAL_ADMIN_UNSUPPORTED", "В локальной панели доступны сосед и журнал. Этот раздел требует сервер приложения", 503);
}

export async function POST(request: Request) {
  const rejected = guard(request, true); if (rejected) return rejected;
  const token = await devSessionToken();
  if (!token || !getDevIdentity(token)) return error("UNAUTHORIZED", "Войдите в локальный аккаунт", 401);
  if (new URL(request.url).search) return error("INVALID_ADMIN_QUERY", "Параметры в адресе операции не разрешены", 400);
  const path = route(request);
  if (path === "local/unlock") {
    const parsed = await readDevEconomyBody(request, 1024); if (parsed.response) return parsed.response;
    const body = z.object({ password: z.string().min(1).max(256) }).strict().safeParse(parsed.body);
    if (!body.success) return error("INVALID_LOCAL_ADMIN_CODE", "Введите код из терминала разработки", 400);
    const result = unlockDevAdmin(token, body.data.password);
    if (result === "limited") return error("LOCAL_ADMIN_RATE_LIMIT", "Слишком много попыток. Подождите минуту", 429);
    if (result === "unconfigured") return error("LOCAL_ADMIN_UNCONFIGURED", "Перезапустите через npm run dev:lan: код появится в терминале", 503);
    if (result !== "ok") return error("INVALID_LOCAL_ADMIN_CODE", "Код не подошёл", 403);
    return NextResponse.json({ unlocked: true }, { headers });
  }
  if (!devAdminAllowed(token)) return error("FORBIDDEN", "Нет локального доступа администратора", 403);
  if (path === "local/lock") { lockDevAdmin(token); return NextResponse.json({ locked: true }, { headers }); }
  if (!["neighbor/settings", "neighbor/buy"].includes(path)) return error("LOCAL_ADMIN_UNSUPPORTED", "Эта операция требует сервер приложения", 503);
  const parsed = await readDevEconomyBody(request, 32768); if (parsed.response) return parsed.response;
  if (path === "neighbor/settings") {
    const command = neighborAdminSettingsCommandSchema.safeParse(parsed.body);
    if (!command.success) return error("INVALID_NEIGHBOR_SETTINGS", "Проверьте настройки и причину", 400);
    return respondDevEconomy(() => commandDevAdminNeighbor(token, "settings", command.data));
  }
  const command = neighborAdminBuyCommandSchema.safeParse(parsed.body);
  if (!command.success) return error("INVALID_NEIGHBOR_BUY", "Проверьте лот, цену и причину", 400);
  return respondDevEconomy(() => commandDevAdminNeighbor(token, "buy", command.data));
}
