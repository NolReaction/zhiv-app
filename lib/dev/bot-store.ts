// Local memory adapter only. Bots are ordinary local users with private server credentials.
import { devBotCommandSchema, devBotsSnapshotSchema, type DevBotCommand, type DevBotResult, type DevBotsSnapshot } from "@/features/world/dev/dev-bot-model";
import type { EconomyCommand } from "@/features/economy/domain/model";
import type { EconomyDevCommand } from "@/features/economy/dev/dev-model";
import { createDevOwnedBot, deleteDevOwnedBot, getDevIdentity, getDevOwnedBots, listDevPeople, renameDevOwnedBot, updateDevSharing } from "./api-store";
import { commandDevEconomy, commandDevEconomyCheat, commandDevEconomyMarket, DevEconomyError, getDevEconomy, getDevGuestWorldEconomy, removeDevEconomyOwner } from "./economy-store";
import { commandDevWorld, getDevGuestWorldAppearance, getDevWorld, removeDevWorldOwner, syncDevWorldWardrobe } from "./world-store";

type Receipt = { signature: string; botId: string; message: string };
const globalStore = globalThis as typeof globalThis & { __zhivDevBotReceipts?: Map<string, Map<string, Receipt>> };
const receipts = () => globalStore.__zhivDevBotReceipts ??= new Map();
function fail(code: string, message: string, status = 409): never { throw new DevEconomyError(code, message, status); }
function ownerFor(token: string | undefined, expectedOwner?: string) {
  if (process.env.NODE_ENV !== "development") return fail("DEV_API_DISABLED", "Тестовые друзья доступны только в локальной разработке", 503);
  const owner = getDevIdentity(token)?.user.publicId;
  if (!owner) return fail("UNAUTHORIZED", "Войдите в аккаунт", 401);
  if (expectedOwner !== undefined && owner !== expectedOwner) return fail("DEV_BOT_OWNER_CHANGED", "Аккаунт изменился. Обновите тестовых друзей");
  return owner;
}

export function getDevBots(token: string | undefined, now = Date.now(), expectedOwner?: string): DevBotsSnapshot {
  const owner = ownerFor(token, expectedOwner);
  const bots = getDevOwnedBots(token).map(bot => {
    const identity = getDevIdentity(bot.token)!;
    const state = getDevEconomy(bot.token, now);
    const appearance = getDevGuestWorldAppearance(bot.publicId);
    const projection = getDevGuestWorldEconomy(owner, bot.publicId, identity.user.displayName, appearance);
    return { id: bot.id, publicId: bot.publicId, displayName: identity.user.displayName, circleId: bot.circleId,
      sharingMode: getBotSharing(bot.token, bot.circleId), createdAt: bot.createdAt,
      economy: { revision: state.revision, buildings: state.buildings, wallet: state.wallet, inventory: state.inventory, jobs: state.jobs, storage: state.storage },
      equipment: appearance.equipment, listings: projection.market.listings.map(listing => ({ ...listing, owned: true })) };
  });
  return devBotsSnapshotSchema.parse({ ownerPublicId: owner, serverTime: new Date(now).toISOString(), maxBots: 5, bots });
}

// Read the accepted relationship from its normal projection, including effective sharing.
function getBotSharing(token: string, circleId: string): "LATEST_ONLY" | "OFF" {
  const people = listDevPeople(token);
  const person = people.kind === "ok" ? people.value.people.find(person => person.circleId === circleId) : null;
  return person?.mySharingMode === "OFF" || !person ? "OFF" : "LATEST_ONLY";
}

export function commandDevBots(token: string | undefined, input: DevBotCommand, now = Date.now()): DevBotResult {
  const owner = ownerFor(token);
  const parsed = devBotCommandSchema.safeParse(input);
  if (!parsed.success) return fail("INVALID_DEV_BOT_COMMAND", "Некорректная команда тестового друга", 400);
  const command = parsed.data;
  command.requestId = command.requestId.toLowerCase();
  if ("botId" in command) command.botId = command.botId.toLowerCase();
  if ("listingId" in command) command.listingId = command.listingId.toLowerCase();
  if ("jobId" in command) command.jobId = command.jobId.toLowerCase();
  ownerFor(token, command.ownerPublicId);
  const requestId = command.requestId.toLowerCase();
  const signature = JSON.stringify(command);
  let ownerReceipts = receipts().get(owner);
  if (!ownerReceipts) receipts().set(owner, ownerReceipts = new Map());
  const old = ownerReceipts.get(requestId);
  if (old) {
    if (old.signature !== signature) return fail("DEV_BOT_REQUEST_CONFLICT", "Этот запрос уже использован для другого действия");
    return { snapshot: getDevBots(token, now, owner), botId: old.botId, message: old.message, replayed: true };
  }
  if (ownerReceipts.size >= 2048) return fail("DEV_BOT_REQUEST_LIMIT", "Лимит локального стенда исчерпан. Перезапустите сервер разработки");
  let botId: string;
  let message: string;
  if (command.action === "create") {
    if (getDevOwnedBots(token).length >= 5) return fail("DEV_BOT_LIMIT", "Можно создать до пяти тестовых друзей");
    const bot = createDevOwnedBot(token, command.displayName, now);
    if (!bot) return fail("DEV_BOT_UNAVAILABLE", "Не удалось создать тестового друга");
    botId = bot.id;
    const state = getDevEconomy(bot.token, now);
    commandDevEconomyCheat(bot.token, { requestId: crypto.randomUUID(), ownerPublicId: bot.publicId, expectedRevision: state.revision,
      action: "apply_settlement", targetId: "home", quantity: command.homeLevel, totalPrice: 0 }, now);
    getDevWorld(bot.token, now);
    message = "Тестовый друг создан и добавлен в друзья";
  } else {
    const bot = getDevOwnedBots(token).find(bot => bot.id === command.botId);
    if (!bot) return fail("DEV_BOT_NOT_FOUND", "Тестовый друг недоступен", 404);
    botId = bot.id;
    const base = () => ({ requestId: crypto.randomUUID(), ownerPublicId: bot.publicId, expectedRevision: getDevEconomy(bot.token, now).revision, quantity: 1, totalPrice: 0 as const });
    const cheat = (action: EconomyDevCommand["action"], targetId: string, quantity = 1) =>
      commandDevEconomyCheat(bot.token, { ...base(), action, targetId, quantity }, now).message;
    const regular = (action: EconomyCommand["action"], targetId: string) => commandDevEconomy(bot.token, { ...base(), action, targetId }, now).message;
    switch (command.action) {
      case "rename":
        renameDevOwnedBot(token, bot.id, command.displayName); message = "Имя тестового друга изменено"; break;
      case "set_home": message = cheat("apply_settlement", "home", command.homeLevel); getDevWorld(bot.token, now); break;
      case "set_building": message = cheat("set_building_level", command.buildingId, command.level); getDevWorld(bot.token, now); break;
      case "grant_currency": message = cheat("grant_currency", command.currency, command.quantity); break;
      case "grant_item": message = cheat("grant_item", command.itemId, command.quantity); break;
      case "equip": {
        if (command.itemId !== null) {
          if (command.slot !== "rod") cheat("grant_wardrobe", command.itemId);
          syncDevWorldWardrobe(bot.token, [command.itemId], now);
        }
        const state = getDevWorld(bot.token, now);
        message = commandDevWorld(bot.token, { requestId: crypto.randomUUID(), ownerPublicId: bot.publicId, expectedRevision: state.revision,
          action: "equip", target: command.itemId ?? `remove_${command.slot}` }, now).message;
        break;
      }
      case "create_listing":
        message = commandDevEconomyMarket(bot.token, { ...base(), action: "create_listing", targetId: command.itemId,
          quantity: command.quantity, totalPrice: command.totalPrice }, now).message; break;
      case "cancel_listing":
        message = commandDevEconomyMarket(bot.token, { ...base(), action: "cancel_listing", targetId: command.listingId }, now).message; break;
      case "finish_jobs": message = cheat("finish_jobs", "all"); break;
      case "start_job": message = regular(command.kind === "construction" ? "start_construction" : command.kind === "production" ? "start_production" : "start_exploration", command.targetId); break;
      case "claim_job": {
        const job = getDevEconomy(bot.token, now).jobs.find(job => job.id === command.jobId);
        // Harvest remains a real timed character action. The first click sends the bot to collect it.
        message = regular(job?.collection && !job.collection.startedAt ? "start_collection" : "claim_job", command.jobId); break;
      }
      case "set_sharing": {
        const result = updateDevSharing(bot.token, bot.circleId, command.sharingMode);
        if (result.kind !== "ok") return fail("DEV_BOT_FRIENDSHIP_CHANGED", "Связь с тестовым другом удалена. Создайте нового друга");
        message = command.sharingMode === "OFF" ? "Тестовый друг закрыл доступ к своему миру" : "Мир тестового друга снова доступен"; break;
      }
      case "delete": {
        const removed = deleteDevOwnedBot(token, bot.id);
        if (!removed) return fail("DEV_BOT_NOT_FOUND", "Тестовый друг недоступен", 404);
        removeDevEconomyOwner(removed, { deleteHistory: true }); removeDevWorldOwner(removed);
        message = "Тестовый друг и его лавка удалены"; break;
      }
    }
  }
  ownerReceipts.set(requestId, { signature, botId, message });
  return { snapshot: getDevBots(token, now, owner), botId, message, replayed: false };
}
