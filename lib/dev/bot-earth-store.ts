// Synthetic GPS is a private, disposable input. Public points still use normal Earth consent and publication rules.
import type { DevBot, DevBotCommand } from "@/features/world/dev/dev-bot-model";
import { EARTH_POSITION_PUBLISH_MS, type EarthSharedPerson } from "@/lib/earth-sharing-contract";
import { getDevOwnedBots } from "./api-store";
import { devBotEarthSimulation } from "./bot-earth-state";
import { DevEconomyError } from "./economy-store";
import { projectDevEarthSharing, putDevEarthPosition, putDevEarthSharing, type DevEarthResult } from "./earth-sharing-store";

type Bot = ReturnType<typeof getDevOwnedBots>[number];
type Position = NonNullable<DevBot["earth"]["position"]>;
type Simulation = ReturnType<typeof devBotEarthSimulation>;
type EarthCommand = Extract<DevBotCommand, { action: "set_earth_sharing" | "set_earth_position" }>;
const fail = (code: string, message: string, status = 409): never => { throw new DevEconomyError(code, message, status); };
function ownedBot(token: string | undefined, id: string) {
  if (process.env.NODE_ENV !== "development") return fail("DEV_API_DISABLED", "Тестовые друзья доступны только в локальной разработке", 503);
  return getDevOwnedBots(token).find(bot => bot.id === id) ?? fail("DEV_BOT_NOT_FOUND", "Тестовый друг недоступен", 404);
}
function value<T>(result: DevEarthResult<T>): T {
  if (result.kind === "ok") return result.value;
  const message = result.code === "EARTH_RATE_LIMITED" ? `Следующая геопозиция доступна через ${result.retryAfterSeconds ?? 30} с`
    : result.code === "INVALID_EARTH_SHARING" ? "Связь с тестовым другом удалена. Создайте нового друга"
    : "Передача геопозиции остановлена. Включите доступ заново";
  return fail(result.code, message, result.status);
}
function publish(bot: Bot, state: Simulation, position: Position) {
  if (!state.publicationEpoch) return fail("DEV_BOT_EARTH_PAUSED", "Включите передачу геопозиции тестового друга");
  if (state.nextPublishAt !== null && Date.now() < state.nextPublishAt)
    return fail("EARTH_RATE_LIMITED", `Следующая геопозиция доступна через ${Math.ceil((state.nextPublishAt - Date.now()) / 1_000)} с`, 429);
  const receipt = value(putDevEarthPosition(bot.token, { expectedOwnerPublicId: bot.publicId, publicationEpoch: state.publicationEpoch,
    sequence: state.sequence + 1, ...position, capturedAt: new Date().toISOString() }));
  state.sequence++; state.nextPublishAt = Date.parse(receipt.acceptedAt) + EARTH_POSITION_PUBLISH_MS;
}

/** Owner-only simulation metadata. The timestamp projection is the caller's ordinary authorized feed. */
export function getDevBotEarth(token: string | undefined, botId: string, sharedPoint?: EarthSharedPerson): DevBot["earth"] {
  const bot = ownedBot(token, botId), state = devBotEarthSimulation(bot), settings = value(projectDevEarthSharing(bot.token));
  if (settings.mode !== "SHARING" || !settings.recipientCircleIds.includes(bot.circleId)) {
    state.publicationEpoch = null; state.sequence = 0; state.nextPublishAt = null;
  }
  return { mode: settings.mode, precision: settings.precision, sharingUntil: settings.sharingUntil,
    position: state.position ? { ...state.position } : null,
    sharedUpdatedAt: sharedPoint?.updatedAt ?? null, sharedExpiresAt: sharedPoint?.expiresAt ?? null,
    nextPublishAt: state.nextPublishAt === null ? null : new Date(state.nextPublishAt).toISOString() };
}

export function commandDevBotEarth(token: string | undefined, command: EarthCommand): string {
  const bot = ownedBot(token, command.botId), state = devBotEarthSimulation(bot);
  // Privacy reductions must remain available even after the public read budget is exhausted.
  if (command.action === "set_earth_sharing" && command.mode !== "SHARING") {
    value(putDevEarthSharing(bot.token, { expectedOwnerPublicId: bot.publicId, expectedRevision: 0,
      mode: command.mode, precision: command.precision, durationMinutes: command.durationMinutes,
      recipientCircleIds: [], frozenCircleIds: [] }));
    state.publicationEpoch = null; state.sequence = 0; state.nextPublishAt = null;
    return command.mode === "GHOST" ? "Тестовый друг оставил последнюю разрешённую точку" : "Тестовый друг полностью отозвал геодоступ";
  }
  const settings = value(projectDevEarthSharing(bot.token));
  if (command.action === "set_earth_position") {
    const position = { latitude: command.latitude, longitude: command.longitude, accuracyMeters: command.accuracyMeters };
    if (command.showOnMap) {
      // One explicit DEV placement includes consent for this synthetic bot only.
      // It cannot accidentally publish the real viewer's GPS, broaden recipients
      // or bypass the normal cadence by starting another publication epoch.
      if (settings.mode === "SHARING" && state.nextPublishAt !== null && Date.now() < state.nextPublishAt)
        return fail("EARTH_RATE_LIMITED", `Следующая геопозиция доступна через ${Math.ceil((state.nextPublishAt - Date.now()) / 1_000)} с`, 429);
      if (settings.mode !== "SHARING" || settings.precision !== "PRECISE" || !state.publicationEpoch
        || settings.recipientCircleIds.length !== 1 || settings.recipientCircleIds[0] !== bot.circleId || settings.frozenCircleIds.length !== 0) {
        const updated = value(putDevEarthSharing(bot.token, { expectedOwnerPublicId: bot.publicId, expectedRevision: settings.revision,
          mode: "SHARING", precision: "PRECISE", durationMinutes: 60, recipientCircleIds: [bot.circleId], frozenCircleIds: [] }));
        state.publicationEpoch = updated.publicationEpoch; state.sequence = 0; state.nextPublishAt = null;
      }
      publish(bot, state, position);
    } else if (settings.mode === "SHARING") publish(bot, state, position);
    state.position = position;
    return command.showOnMap ? "Тестовый друг поставлен на карту и виден только вам"
      : settings.mode === "SHARING" ? "Свежая геопозиция тестового друга опубликована" : "Синтетическая позиция изменена. Передача выключена";
  }
  const updated = value(putDevEarthSharing(bot.token, { expectedOwnerPublicId: bot.publicId, expectedRevision: settings.revision,
    mode: command.mode, precision: command.precision, durationMinutes: command.durationMinutes,
    recipientCircleIds: command.mode === "SHARING" ? [bot.circleId] : settings.recipientCircleIds,
    frozenCircleIds: command.mode === "SHARING" ? [] : settings.frozenCircleIds }));
  state.publicationEpoch = updated.publicationEpoch; state.sequence = 0; state.nextPublishAt = null;
  if (updated.mode === "SHARING" && state.position) publish(bot, state, state.position);
  return updated.mode === "SHARING" ? "Тестовый друг делится геопозицией только с вами"
    : updated.mode === "GHOST" ? "Тестовый друг оставил последнюю разрешённую точку" : "Тестовый друг полностью отозвал геодоступ";
}
