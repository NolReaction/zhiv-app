import { economyCatalog, economyCommandSchema, economyViewSchema, type EconomyCommand, type EconomyResult, type EconomyState } from "@/features/economy/domain/model";
import { publicBoatState } from "@/features/economy/domain/boat-fishing";
import { applyEconomyCommand, economyStorage, EconomyRuleError, newEconomyState } from "@/features/economy/domain/rules";
import { economyShipSchema } from "@/features/economy/domain/ship-model";
import { ApiError } from "@/lib/check-in-api";
import { economyDevCommandSchema, type EconomyDevCommand } from "./dev-model";
import { applyDevBoatCommand } from "./dev-boat";

const playerActions = new Set(["buy_boat_fuel", "start_boat_upgrade", "claim_boat_upgrade", "depart_boat", "begin_boat_cast", "submit_boat_cast", "return_boat", "claim_boat",
  "equip_fishing_rod", "equip_fishing_hook", "equip_fishing_bait"]);
const reject = (code: string, message: string, status = 409) => new ApiError(message, status, { code, message });
const demoOwner = () => {
  const suffix = crypto.randomUUID().slice(0, 8).toUpperCase();
  // A unique demo prefix keeps coach/checkpoint keys separate from player profiles.
  return `DEMW-${suffix.slice(0, 4)}-${suffix.slice(4)}`;
};

/** A page-scoped private authority for visual rehearsal. No transport, profile or persistence. */
export function createBoatWorkshopDemo({ ownerPublicId = demoOwner(), now = () => Date.now() }:
  { ownerPublicId?: string; now?: () => number } = {}) {
  let state = newEconomyState({ resources: { sparks: 0, wood: 0, stone: 0 }, houseLevel: 4, workshopLevel: 3 });
  state.wallet.pearls = economyCatalog.boat!.fuel.refillPricePearls * 3; state.wallet.coins = 100000; state.inventory = { planks: 12, rope: 10, hardwood: 6, metal_parts: 3 }; state.buildings.warehouse = 5;
  let revision = 1;
  const receipts = new Map<string, { signature: string; result: EconomyResult }>();
  const read = () => economyViewSchema.parse({ ...state, ownerPublicId, revision,
    serverTime: new Date(now()).toISOString(), catalog: economyCatalog,
    boat: publicBoatState(state.boat), ship: economyShipSchema.parse(state.ship), storage: economyStorage(state) });

  function transact(command: EconomyCommand | EconomyDevCommand, mutate: (next: EconomyState) => string): EconomyResult {
    const signature = JSON.stringify(command), replay = receipts.get(command.requestId);
    if (replay) {
      if (replay.signature !== signature) throw reject("ECONOMY_REQUEST_CONFLICT", "Действие демо уже принято с другими параметрами.");
      return { ...structuredClone(replay.result), state: read(), replayed: true };
    }
    if (command.ownerPublicId !== ownerPublicId)
      throw reject("ECONOMY_OWNER_MISMATCH", "Демонстрационная сцена изменилась. Профиль не принадлежит этому примеру.", 403);
    if (command.expectedRevision !== revision)
      throw reject("ECONOMY_REVISION_CONFLICT", "Демонстрационная сцена изменилась. Повторите действие.");
    const next = structuredClone(state);
    let message: string;
    try { message = mutate(next); }
    catch (error) {
      // Match the real API contract: a rejected rule is definitive; unexpected failures stay uncertain.
      if (error instanceof EconomyRuleError) throw reject(error.code, error.message, error.status);
      throw error;
    }
    state = next; revision += 1;
    const result = { state: read(), message, acceptedRevision: revision, replayed: false };
    receipts.set(command.requestId, { signature, result });
    return structuredClone(result);
  }

  return { ownerPublicId, read,
    send(input: EconomyCommand) {
      const parsed = economyCommandSchema.safeParse(input);
      if (!parsed.success) throw reject("INVALID_ECONOMY_COMMAND", "Некорректная команда демонстрационной лодки.", 400);
      const command = parsed.data;
      if (!playerActions.has(command.action)) throw reject("INVALID_ECONOMY_COMMAND", "В этом демо доступны только лодка и снасти.", 400);
      return transact(command, next => applyEconomyCommand(next, command, now(), () => crypto.randomUUID(), {}, maximum => 37 % maximum));
    },
    dev(input: EconomyDevCommand) {
      const parsed = economyDevCommandSchema.safeParse(input);
      if (!parsed.success) throw reject("INVALID_ECONOMY_COMMAND", "Некорректная тестовая команда лодки.", 400);
      const command = parsed.data;
      return transact(command, next => {
        if (command.action === "grant_fishing_gear") {
          const catalog = economyCatalog.fishing!;
          next.fishing.ownedRods = [...new Set([...next.fishing.ownedRods, ...catalog.rods.map(rod => rod.id)])];
          next.fishing.ownedHooks = [...new Set([...next.fishing.ownedHooks, ...catalog.hooks.map(hook => hook.id)])];
          return "Демо: удочки и крючки доступны в снастях перед выходом.";
        }
        return applyDevBoatCommand(next, command, now());
      });
    },
  };
}
