import { initializeDevEconomy, creditDevLegacyJourney, getDevEconomyBuildingLevels, getDevEconomyWardrobe } from "@/lib/dev/economy-store";
import { naturalItems } from "@/features/game/game-rewards";
// Development adapter only. Production requests are handled by Ktor/PostgreSQL.
import { getDevIdentity, getDevItemStreak } from "@/lib/dev/api-store";
import { collectionRewards, collectionCount, newWorldState, workshopLevel, worldCatalog as catalog, type WorldCommand, type WorldSnapshot, type WorldState } from "@/features/world/domain/model";

type Profile = { state: WorldState; revision: number; day: string; earned: number; remainder: number;
  receipts: Map<string, { signature: string; message: string }>; tapKeys: Set<string> };
const globalStore = globalThis as typeof globalThis & { __zhivDevWorldStore?: Map<string, Profile> };
const store = () => globalStore.__zhivDevWorldStore ??= new Map();
export const resetDevWorldStoreForTests = () => { delete globalStore.__zhivDevWorldStore; };
export class DevWorldError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
const fail = (code: string, message: string): never => { throw new DevWorldError(code, message); };
function profile(token: string | undefined, now: number): { owner: string; value: Profile } {
  const identity = getDevIdentity(token);
  if (!identity) throw new DevWorldError("UNAUTHORIZED", "Войдите в аккаунт", 401);
  const owner = identity.user.publicId;
  if (!store().has(owner)) store().set(owner, { state: newWorldState(), revision: 0, day: new Date(now).toISOString().slice(0, 10),
    earned: 0, remainder: 0, receipts: new Map(), tapKeys: new Set() });
  return { owner, value: store().get(owner)! };
}
export function hasDevLegacyJourney(token: string | undefined, now = Date.now()): boolean {
  return profile(token, now).value.state.journeys.length > 0;
}
export function consumeDevLegacyEconomy(token: string | undefined, now = Date.now()): { resources: WorldState["resources"]; houseLevel: number; workshopLevel: number } {
  const { value } = profile(token, now);
  const legacy = { resources: { ...value.state.resources }, houseLevel: value.state.houseLevel, workshopLevel: workshopLevel(value.state) };
  if (Object.values(value.state.resources).some(amount => amount !== 0)) value.revision++;
  value.state.resources = { sparks: 0, wood: 0, stone: 0 };
  value.earned = 0; value.remainder = 0;
  return legacy;
}
export function getDevWorld(token: string | undefined, now = Date.now()): WorldSnapshot {
  initializeDevEconomy(token, now);
  const { owner, value } = profile(token, now);
  const buildings = getDevEconomyBuildingLevels(token, now);
  syncDevWorldWardrobe(token, getDevEconomyWardrobe(token, now), now);
  if (value.state.houseLevel !== buildings.home || workshopLevel(value.state) !== buildings.workshop) {
    value.state.houseLevel = buildings.home;
    value.state.workshop = buildings.workshop > 0;
    value.state.workshopLevel = buildings.workshop;
    value.revision++;
  }
  return { ownerPublicId: owner, revision: value.revision, serverTime: new Date(now).toISOString(),
    devTools: process.env.NODE_ENV === "development",
    state: structuredClone(value.state), gifts: naturalItems(getDevItemStreak(owner, now)), catalogVersion: catalog.version as WorldSnapshot["catalogVersion"],
    dailySparksEarned: value.day === new Date(now).toISOString().slice(0, 10) ? value.earned : 0 };
}
function apply(state: WorldState, command: WorldCommand, now: number, gifts: readonly string[]): string {
  switch (command.action) {
    case "set_decoration": {
      const match = /^(show|hide)_(flower|leaf_bed|keepsakes|leaf_garland)$/.exec(command.target);
      if (!match) return fail("WORLD_ITEM", "Украшение не найдено");
      const item = match[2] as NonNullable<WorldState["hiddenGifts"]>[number];
      if (!gifts.includes(item)) return fail("WORLD_ITEM_NOT_OWNED", "Сначала получите этот подарок за отметки");
      state.hiddenGifts = match[1] === "show" ? (state.hiddenGifts ?? []).filter(id => id !== item)
        : [...new Set([...(state.hiddenGifts ?? []), item])].sort();
      return match[1] === "show" ? "Украшение включено" : "Украшение убрано";
    }
    case "equip": {
      if (command.target === "remove_head") { state.equipment.head = null; return "Головной убор снят"; }
      if (command.target === "remove_rod") { state.equipment.rod = null; return "Удочка убрана"; }
      if (command.target === "remove_neck") { state.equipment.neck = null; return "Шарф снят"; }
      const item = catalog.items.find(i => i.id === command.target);
      if (!item || !state.inventory.includes(item.id)) return fail("WORLD_ITEM_NOT_OWNED", "Сначала получите этот предмет");
      state.equipment[item.slot as keyof WorldState["equipment"]] = item.id;
      return `Мохлик примерил: ${item.name.toLowerCase()}`;
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
        state.inventory = [...new Set([...state.inventory, ...collectionRewards(state.collection)])].sort();
      }
      state.journeys = state.journeys.filter(j => j.id !== journey.id);
      return command.action === "recall_journey" ? "Мохлик вернулся домой без находок" : "Мохлик принёс находку и материалы!";
    }
    default: return fail("WORLD_ECONOMY_MOVED", "Это действие перенесено в хозяйство.");
  }
}
export function commandDevWorld(token: string | undefined, command: WorldCommand, now = Date.now()) {
  if (command.action === "dev_grant_resources" && (process.env.NODE_ENV !== "development" || command.target !== "")) {
    throw new DevWorldError("DEV_TOOLS_DISABLED", "Тестовая выдача недоступна", 404);
  }
  getDevWorld(token, now);
  const { owner, value } = profile(token, now);
  if (owner !== command.ownerPublicId) return fail("WORLD_OWNER_CHANGED", "Аккаунт изменился. Обновите мир.");
  const signature = JSON.stringify([command.ownerPublicId, command.expectedRevision, command.action, command.target]);
  const receipt = value.receipts.get(command.requestId);
  if (receipt) {
    if (receipt.signature !== signature) return fail("WORLD_COMMAND_CONFLICT", "Этот запрос уже использован");
    return { snapshot: getDevWorld(token, now), message: receipt.message, replayed: true };
  }
  if (!["equip", "set_decoration", "claim_journey", "recall_journey"].includes(command.action))
    return fail("WORLD_ECONOMY_MOVED", "Это действие перенесено в хозяйство. Обновите приложение и откройте раздел хозяйства.");
  if (command.expectedRevision !== value.revision) return fail("WORLD_REVISION_CONFLICT", "Мир изменился на другом устройстве. Обновите его и повторите действие.");
  const next: WorldState = structuredClone(value.state);
  const journey = command.action === "claim_journey" ? next.journeys.find(item => item.id === command.target) : undefined;
  const originalMessage = apply(next, command, now, naturalItems(getDevItemStreak(owner, now)));
  next.resources = { sparks: 0, wood: 0, stone: 0 };
  if (journey) creditDevLegacyJourney(token, journey, now);
  const message = journey ? "Путешествие завершено: находки сохранены, награда пересчитана в новую экономику." : originalMessage;
  value.state = next; value.revision++;
  value.receipts.set(command.requestId, { signature, message });
  return { snapshot: getDevWorld(token, now), message, replayed: false };
}
// Taps continue to count in the game store; retired world currencies are never credited.
export function creditDevWorldTaps(owner: string, sourceKey: string, taps: number, now: number) {
  void owner; void sourceKey; void taps; void now;
}

export function getDevCollectionCount(owner: string): number { return collectionCount(store().get(owner)?.state.collection ?? []); }

/** Read-only legacy ownership for the unified book; does not create a world profile. */
export function getDevCollectionFinds(owner: string): readonly string[] { return store().get(owner)?.state.collection ?? []; }

/** Legacy ownership projection has no initialization or currency side effect. */
export function getDevLegacyWardrobe(owner: string): readonly string[] { return store().get(owner)?.state.inventory ?? []; }
export function syncDevWorldWardrobe(token: string | undefined, owned: readonly string[], now = Date.now()): void {
  const { value } = profile(token, now);
  const inventory = [...new Set([...value.state.inventory, ...owned])];
  if (inventory.length !== value.state.inventory.length || inventory.some((id, index) => id !== value.state.inventory[index])) {
    value.state.inventory = inventory; value.revision++;
  }
}
