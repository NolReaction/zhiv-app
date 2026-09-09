import { naturalItems } from "@/features/game/game-rewards";
import { applySettlement, SettlementError, SETTLEMENT_ACTIONS } from "@/features/settlement/model";
// Development adapter only. Production requests are handled by Ktor/PostgreSQL.
import { getDevIdentity, getDevItemStreak } from "@/lib/dev/api-store";
import { canAfford, newWorldState, workshopLevel, worldCatalog as catalog, type WorldCommand, type WorldResources, type WorldSnapshot, type WorldState } from "@/features/world/model";

type Profile = { state: WorldState; revision: number; day: string; earned: number; remainder: number;
  receipts: Map<string, { signature: string; message: string }>; tapKeys: Set<string> };
const globalStore = globalThis as typeof globalThis & { __zhivDevWorldStore?: Map<string, Profile> };
const store = () => globalStore.__zhivDevWorldStore ??= new Map();
export const resetDevWorldStoreForTests = () => { delete globalStore.__zhivDevWorldStore; };
export class DevWorldError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
const fail = (code: string, message: string): never => { throw new DevWorldError(code, message); };
function profile(token: string | undefined, now: number) {
  const identity = getDevIdentity(token);
  if (!identity) throw new DevWorldError("UNAUTHORIZED", "Войдите в аккаунт", 401);
  const owner = identity.user.publicId;
  if (!store().has(owner)) store().set(owner, { state: newWorldState(), revision: 0, day: new Date(now).toISOString().slice(0, 10),
    earned: 0, remainder: 0, receipts: new Map(), tapKeys: new Set() });
  return { owner, value: store().get(owner)! };
}
export function getDevWorld(token: string | undefined, now = Date.now()): WorldSnapshot {
  const { owner, value } = profile(token, now);
  return { ownerPublicId: owner, revision: value.revision, serverTime: new Date(now).toISOString(),
    devTools: process.env.NODE_ENV === "development",
    state: structuredClone(value.state), gifts: naturalItems(getDevItemStreak(owner, now)), catalogVersion: catalog.version as 1,
    dailySparksEarned: value.day === new Date(now).toISOString().slice(0, 10) ? value.earned : 0 };
}
function apply(state: WorldState, command: WorldCommand, now: number): string {
  if ((SETTLEMENT_ACTIONS as readonly string[]).includes(command.action)) {
    try {
      const result = applySettlement(state.settlement, command.action, command.target, command.requestId, now);
      state.settlement = result.state;
      return result.message;
    } catch (error) {
      if (error instanceof SettlementError) throw new DevWorldError(error.code, error.message);
      throw error;
    }
  }
  const spend = (cost: WorldResources) => {
    if (!canAfford(state.resources, cost)) fail("WORLD_RESOURCES", "Пока не хватает материалов. Их можно принести из путешествия.");
    for (const key of ["sparks", "wood", "stone"] as const) state.resources[key] -= cost[key];
  };
  switch (command.action) {
    case "dev_grant_resources":
      for (const key of ["sparks", "wood", "stone"] as const) state.resources[key] += 50;
      return "+50 искр, дерева и камня";
    case "upgrade_house": {
      const cost = catalog.houseUpgrades.find(c => c.level === state.houseLevel + 1);
      if (!cost) return fail("WORLD_MAX_LEVEL", "Домик уже полностью улучшен");
      spend(cost); state.houseLevel++; return "Домик стал уютнее. Открыты новые возможности!";
    }
    case "build_workshop":
      if (state.workshop) return fail("WORLD_ALREADY_BUILT", "Мастерская уже построена");
      spend(catalog.workshop); state.workshop = true; state.workshopLevel = 1; return "Мастерская готова. Теперь можно делать одежду!";
    case "upgrade_workshop": {
      if (!state.workshop) return fail("WORLD_WORKSHOP_REQUIRED", "Сначала постройте мастерскую");
      const cost = catalog.workshopUpgrades.find(c => c.level === workshopLevel(state) + 1);
      if (!cost) return fail("WORLD_MAX_LEVEL", "Мастерская уже полностью улучшена");
      spend(cost); state.workshopLevel = cost.level; return "Мастерская стала уютнее и просторнее";
    }
    case "craft": {
      const item = catalog.items.find(i => i.id === command.target && !i.starter && i.sparks > 0);
      if (!item) return fail("WORLD_ITEM", "Этот предмет нельзя изготовить");
      if (!state.workshop) return fail("WORLD_WORKSHOP_REQUIRED", "Сначала постройте мастерскую");
      if (state.inventory.includes(item.id)) return fail("WORLD_ITEM_OWNED", "Предмет уже в рюкзаке");
      spend({ sparks: item.sparks, wood: 0, stone: 0 }); state.inventory.push(item.id); state.inventory.sort();
      return `${item.name} теперь в рюкзаке`;
    }
    case "equip": {
      if (command.target === "remove_head") { state.equipment.head = null; return "Головной убор снят"; }
      if (command.target === "remove_neck") { state.equipment.neck = null; return "Шарф снят"; }
      const item = catalog.items.find(i => i.id === command.target);
      if (!item || !state.inventory.includes(item.id)) return fail("WORLD_ITEM_NOT_OWNED", "Сначала получите этот предмет");
      state.equipment[item.slot as keyof WorldState["equipment"]] = item.id;
      return `Мохлик примерил: ${item.name.toLowerCase()}`;
    }
    case "start_journey": {
      const route = catalog.routes.find(r => r.id === command.target);
      if (!route) return fail("WORLD_ROUTE", "Маршрут не найден");
      if (state.journeys.length) return fail("WORLD_JOURNEY_ACTIVE", "Мохлик уже в пути");
      if (route.houseLevel > state.houseLevel) return fail("WORLD_HOUSE_REQUIRED", "Сначала улучшите домик");
      if (route.once && state.firstJourneyCompleted) return fail("WORLD_ROUTE_COMPLETED", "Первая прогулка уже состоялась");
      state.journeys = [{ id: crypto.randomUUID(), routeId: route.id, startedAt: new Date(now).toISOString(),
        finishesAt: new Date(now + route.seconds * 1000).toISOString(), rewards: { sparks: route.sparks, wood: route.wood, stone: route.stone },
        finds: [...route.finds], introductory: route.once, catalogVersion: catalog.version }];
      return "Мохлик отправился в путь";
    }
    case "recall_journey":
    case "claim_journey": {
      const journey = state.journeys.find(j => j.id === command.target);
      if (!journey) return fail("WORLD_JOURNEY_GONE", "Мохлик уже дома или награда уже получена");
      if (command.action === "claim_journey") {
        if (now < Date.parse(journey.finishesAt)) return fail("WORLD_JOURNEY_NOT_READY", "Мохлик ещё в пути");
        for (const key of ["sparks", "wood", "stone"] as const) state.resources[key] += journey.rewards[key];
        const found = journey.finds.find(id => !state.collection.includes(id));
        if (found) state.collection.push(found);
        state.collection.sort(); state.completedJourneys++; state.firstJourneyCompleted ||= journey.introductory;
        if (catalog.finds.every(f => state.collection.includes(f.id)) && !state.inventory.includes("explorer_cap")) state.inventory.push("explorer_cap");
      }
      state.journeys = state.journeys.filter(j => j.id !== journey.id);
      return command.action === "recall_journey" ? "Мохлик вернулся домой без находок" : "Мохлик принёс находку и материалы!";
    }
    default: return fail("INVALID_WORLD_COMMAND", "Неизвестное действие.");
  }
}
export function commandDevWorld(token: string | undefined, command: WorldCommand, now = Date.now()) {
  if (command.action === "dev_grant_resources" && (process.env.NODE_ENV !== "development" || command.target !== "")) {
    throw new DevWorldError("DEV_TOOLS_DISABLED", "Тестовая выдача недоступна", 404);
  }
  const { owner, value } = profile(token, now);
  if (owner !== command.ownerPublicId) return fail("WORLD_OWNER_CHANGED", "Аккаунт изменился. Обновите мир.");
  const signature = JSON.stringify([command.ownerPublicId, command.expectedRevision, command.action, command.target]);
  const receipt = value.receipts.get(command.requestId);
  if (receipt) {
    if (receipt.signature !== signature) return fail("WORLD_COMMAND_CONFLICT", "Этот запрос уже использован");
    return { snapshot: getDevWorld(token, now), message: receipt.message, replayed: true };
  }
  if (command.expectedRevision !== value.revision) return fail("WORLD_REVISION_CONFLICT", "Мир изменился на другом устройстве. Обновите его и повторите действие.");
  const next = structuredClone(value.state);
  const message = apply(next, command, now);
  value.state = next; value.revision++;
  value.receipts.set(command.requestId, { signature, message });
  return { snapshot: getDevWorld(token, now), message, replayed: false };
}
export function creditDevWorldTaps(owner: string, sourceKey: string, taps: number, now: number) {
  const value = store().get(owner);
  if (!value || taps <= 0 || value.tapKeys.has(sourceKey)) return;
  value.tapKeys.add(sourceKey);
  const day = new Date(now).toISOString().slice(0, 10);
  if (value.day !== day) { value.day = day; value.earned = 0; value.remainder = 0; }
  const total = value.remainder + taps;
  const reward = Math.min(catalog.dailySparkLimit - value.earned, Math.floor(total / catalog.tapsPerSpark));
  value.remainder = total % catalog.tapsPerSpark; value.earned += reward;
  if (reward > 0) { value.state.resources.sparks += reward; value.revision++; }
}
