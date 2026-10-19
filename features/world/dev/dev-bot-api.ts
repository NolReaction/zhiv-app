import { ApiError } from "@/lib/check-in-api";
import { withRequestDeadline } from "@/lib/request-deadline";
import { gamePresenceHeaders, reportInactivePresence } from "@/features/activity/transport-state";
import { devBotCommandSchema, devBotResultSchema, devBotsSnapshotSchema, type DevBotCommand } from "./dev-bot-model";

const endpoint = "/api/v1/dev/bots";

async function request(command: DevBotCommand | undefined, signal?: AbortSignal) {
  return withRequestDeadline(10_000, signal, async requestSignal => {
    const presence = command ? gamePresenceHeaders() : {};
    const response = await fetch(endpoint, {
      method: command ? "POST" : "GET", cache: "no-store", credentials: "same-origin", signal: requestSignal,
      headers: { Accept: "application/json", ...(command ? { "Content-Type": "application/json", ...presence } : {}) },
      ...(command ? { body: JSON.stringify(command) } : {}),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      reportInactivePresence(body?.code, presence);
      throw new ApiError(typeof body?.message === "string" ? body.message : "Не удалось загрузить тестовых друзей.", response.status);
    }
    return body;
  });
}

export async function getDevBots(ownerPublicId: string, signal?: AbortSignal) {
  const parsed = devBotsSnapshotSchema.safeParse(await request(undefined, signal));
  if (!parsed.success || parsed.data.ownerPublicId !== ownerPublicId)
    throw new ApiError("Не удалось прочитать ботов этого профиля. Обновите страницу.", 502);
  return parsed.data;
}

export async function sendDevBotCommand(command: DevBotCommand, signal?: AbortSignal) {
  const input = devBotCommandSchema.safeParse(command);
  if (!input.success) throw new ApiError("Проверьте параметры команды для бота.", 400);
  const parsed = devBotResultSchema.safeParse(await request(input.data, signal));
  if (!parsed.success || parsed.data.snapshot.ownerPublicId !== command.ownerPublicId
    || command.action !== "create" && parsed.data.botId !== command.botId)
    throw new ApiError("Сервер вернул другой профиль или бота. Проверьте результат прежнего запроса.", 502);
  return parsed.data;
}
