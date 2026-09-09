import { z } from "zod";
import catalog from "@/apps/api/src/main/resources/world/settlement-catalog.json";

export const settlementCatalog = catalog;
export const buildingKindSchema = z.enum(["workshop", "storehouse"]);
export type BuildingKind = z.infer<typeof buildingKindSchema>;
const material = z.number().int().nonnegative().safe();
export const materialsSchema = z.object({ wood: material, stone: material });
export const settlementSchema = z.object({
  version: z.literal(1), areaLevel: z.number().int().min(1).max(3), resources: materialsSchema,
  buildings: z.array(z.object({ kind: buildingKindSchema, level: z.number().int().min(1).max(2),
    x: z.number().int().min(0).max(9), y: z.number().int().min(0).max(9) })).max(2),
  gathering: z.object({ id: z.string().uuid(), finishesAt: z.string().datetime(), rewards: materialsSchema }).nullable(),
});
export type Settlement = z.infer<typeof settlementSchema>;
export type Building = Settlement["buildings"][number];
export type Materials = z.infer<typeof materialsSchema>;
export const SETTLEMENT_ACTIONS = ["settlement_build", "settlement_move", "settlement_upgrade", "settlement_expand", "settlement_gather", "settlement_claim"] as const;
export type SettlementAction = typeof SETTLEMENT_ACTIONS[number];
export const newSettlement = (): Settlement => ({ version: 1, areaLevel: 1, resources: { ...catalog.starter }, buildings: [], gathering: null });
export function areaBounds(level: number) {
  const size = catalog.areas.find(area => area.level === level)?.size ?? 6;
  const min = (catalog.gridSize - size) / 2;
  return { min, max: min + size, size };
}
export const buildingInfo = (kind: BuildingKind) => catalog.buildings.find(building => building.kind === kind)!;
export const storageCapacity = (state: Settlement) => catalog.capacities[state.buildings.find(building => building.kind === "storehouse")?.level ?? 0];
export const canPay = (resources: Materials, cost: Materials) => resources.wood >= cost.wood && resources.stone >= cost.stone;
export function canPlace(state: Settlement, x: number, y: number, moving?: BuildingKind): boolean {
  const { min, max } = areaBounds(state.areaLevel), size = catalog.footprint;
  return Number.isInteger(x) && Number.isInteger(y) && x >= min && y >= min && x + size <= max && y + size <= max &&
    !state.buildings.some(building => building.kind !== moving && x < building.x + size && x + size > building.x && y < building.y + size && y + size > building.y);
}
export function gatherRewards(state: Settlement): Materials {
  const improved = state.buildings.some(building => building.kind === "workshop" && building.level === 2);
  return { wood: catalog.gatherWood + (improved ? catalog.workshopBonusWood : 0), stone: catalog.gatherStone + (improved ? catalog.workshopBonusStone : 0) };
}
export class SettlementError extends Error {
  constructor(public code: string, message: string) { super(message); }
}
const fail = (code: string, message: string): never => { throw new SettlementError(code, message); };
/** Same catalogue and rules as SettlementRules.kt. The server owns time and spending. */
export function applySettlement(current: Settlement | null | undefined, action: string, target: string, requestId: string, now: number): { state: Settlement; message: string } {
  const state = structuredClone(current ?? newSettlement());
  const spend = (cost: Materials) => {
    if (!canPay(state.resources, cost)) fail("SETTLEMENT_RESOURCES", "Не хватает материалов. Соберите их у опушки.");
    state.resources.wood -= cost.wood; state.resources.stone -= cost.stone;
  };
  let message: string;
  switch (action) {
    case "settlement_build":
    case "settlement_move": {
      const match = /^(workshop|storehouse):([0-9]):([0-9])$/.exec(target);
      if (!match) return fail("SETTLEMENT_PLACEMENT", "Выберите участок внутри ограды.");
      const kind = match[1] as BuildingKind, x = Number(match[2]), y = Number(match[3]);
      const existing = state.buildings.find(building => building.kind === kind), moving = action === "settlement_move";
      if (moving && !existing || !moving && existing) return fail("SETTLEMENT_BUILDING", moving ? "Постройка не найдена." : "Эта постройка уже есть на поляне.");
      if (!canPlace(state, x, y, moving ? kind : undefined)) return fail("SETTLEMENT_PLACEMENT", "Здесь занято или участок ещё не открыт.");
      if (moving && existing) { existing.x = x; existing.y = y; }
      else { spend(buildingInfo(kind)); state.buildings.push({ kind, x, y, level: 1 }); }
      message = `${buildingInfo(kind).name} ${moving ? "перенесена" : "готова"}.`;
      if (kind === "storehouse") message = moving ? "Склад перенесён." : "Склад готов. Теперь можно хранить больше материалов.";
      break;
    }
    case "settlement_upgrade": {
      const building = state.buildings.find(item => item.kind === target);
      if (!building) return fail("SETTLEMENT_BUILDING", "Сначала поставьте постройку на поляне.");
      if (building.level === 2) return fail("SETTLEMENT_MAX_LEVEL", "Все улучшения этой постройки открыты.");
      const info = buildingInfo(building.kind);
      spend({ wood: info.upgradeWood, stone: info.upgradeStone }); building.level = 2;
      message = building.kind === "workshop" ? "Мастерская улучшена. Сбор приносит больше материалов." : "Склад улучшен. Вместимость увеличена до 800.";
      break;
    }
    case "settlement_expand": {
      if (target) return fail("SETTLEMENT_TARGET", "Некорректное действие.");
      const area = catalog.areas.find(item => item.level === state.areaLevel + 1);
      if (!area) return fail("SETTLEMENT_MAX_LEVEL", "Вся территория внутри ограды открыта.");
      spend(area); state.areaLevel = area.level; message = `Открыта поляна ${area.size} × ${area.size}.`; break;
    }
    case "settlement_gather": {
      if (target) return fail("SETTLEMENT_TARGET", "Некорректное действие.");
      if (state.gathering) return fail("SETTLEMENT_GATHERING", "Сбор уже идёт. Дождитесь материалов.");
      const capacity = storageCapacity(state);
      if (state.resources.wood >= capacity && state.resources.stone >= capacity) return fail("SETTLEMENT_STORAGE_FULL", "Запасы заполнены. Потратьте материалы или улучшите склад.");
      state.gathering = { id: requestId, finishesAt: new Date(now + catalog.gatherSeconds * 1000).toISOString(), rewards: gatherRewards(state) };
      message = "Материалы с опушки будут готовы через минуту."; break;
    }
    case "settlement_claim": {
      const gathering = state.gathering;
      if (!gathering || gathering.id !== target) return fail("SETTLEMENT_GATHERING_GONE", "Материалы уже получены.");
      if (now < Date.parse(gathering.finishesAt)) return fail("SETTLEMENT_NOT_READY", "Материалы ещё собираются.");
      const capacity = storageCapacity(state);
      state.resources.wood = Math.min(capacity, state.resources.wood + gathering.rewards.wood);
      state.resources.stone = Math.min(capacity, state.resources.stone + gathering.rewards.stone);
      state.gathering = null; message = "Материалы добавлены в запасы."; break;
    }
    default: return fail("INVALID_WORLD_COMMAND", "Неизвестное действие.");
  }
  return { state, message };
}
