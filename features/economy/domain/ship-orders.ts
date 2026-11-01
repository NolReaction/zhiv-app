import catalogJson from "@/apps/api/src/main/resources/world/ship-orders-catalog.json";
import { economyCatalog, type EconomyCatalog, type EconomyState } from "./model";
import { economyShipSchema, shipOrdersConfigSchema, type EconomyShip, type ShipVoyage } from "./ship-model";
import { obtainableResidentOrderItems } from "./order-effort";
import { economyLocalSellPrice } from "./local-sale";
import { ECONOMY_MAX_BALANCE, PEARL_DISPLAY_DIVISOR } from "./money";

export const shipOrdersConfig = shipOrdersConfigSchema.parse(catalogJson);
export const SHIP_ORDER_GROUPS = ["supplies", "provisions", "craft"] as const;
export const SHIP_ORDER_DIFFICULTIES = ["easy", "medium", "hard"] as const;
export const SHIP_COMPLETION_PEARLS = 10 * PEARL_DISPLAY_DIVISOR;
function shipCargoValue(items: Record<string, number>, catalog = economyCatalog): number {
  return Object.entries(items).reduce((sum, [itemId, quantity]) => {
    const item = catalog.items.find(item => item.id === itemId);
    if (!item || !item.tradable || item.category === "special" || catalog.fishing?.fish.some(fish => fish.itemId === itemId)
      || catalog.fishing?.classes.some(fish => fish.itemId === itemId) || itemId === "fish") throw new Error(`Invalid ship cargo: ${itemId}`);
    const value = sum + economyLocalSellPrice(item.baseSellPrice, quantity, catalog.localBuyer, itemId);
    if (!Number.isSafeInteger(value) || value <= 0 || value > ECONOMY_MAX_BALANCE) throw new Error("Ship cargo value exceeds its safe range");
    return value;
  }, 0);
}
export function shipOrderReward(items: Record<string, number>, catalog = economyCatalog, config = shipOrdersConfig): number {
  const total = shipCargoValue(items, catalog);
  const reward = Math.floor(total / 10000) * config.payoutBps + Math.ceil(total % 10000 * config.payoutBps / 10000);
  if (!Number.isSafeInteger(reward) || reward <= 0 || reward > ECONOMY_MAX_BALANCE) throw new Error("Ship reward exceeds its safe range");
  return reward;
}
for (const template of shipOrdersConfig.templates) {
  shipOrderReward(template.items);
  if (Object.keys(template.rewardItems).length) shipCargoValue(template.rewardItems);
  if (Object.entries(template.requiredBuildings).some(([id, level]) => !economyCatalog.buildings
    .find(building => building.id === id)?.levels.some(entry => entry.level === level))) throw new Error("Unknown ship building requirement");
}
export function shipOrdersUnlocked(state: Pick<EconomyState, "buildings">): boolean {
  return (state.buildings.lighthouse ?? 0) >= 1;
}
export function shipOrdersState(state: Pick<EconomyState, "ship">): EconomyShip {
  return economyShipSchema.parse(state.ship);
}
/** Same unsigned FNV-1a as Kotlin. Entropy is a server-generated UUID, never a request ID. */
export function shipOrderHash(value: string): number {
  let result = 2166136261;
  for (let index = 0; index < value.length; index++) result = Math.imul(result ^ value.charCodeAt(index), 16777619) >>> 0;
  result = Math.imul(result ^ result >>> 16, 0x85ebca6b);
  result = Math.imul(result ^ result >>> 13, 0xc2b2ae35);
  return (result ^ result >>> 16) >>> 0;
}
export function eligibleShipTemplates(state: EconomyState, catalog: EconomyCatalog = economyCatalog,
  config = shipOrdersConfig) {
  const reachable = obtainableResidentOrderItems(state, catalog);
  return config.templates.filter(template => (state.buildings.home ?? 1) >= template.requiredHomeLevel
    && Object.entries(template.requiredBuildings).every(([id, level]) => (state.buildings[id] ?? 0) >= level)
    && [...Object.keys(template.items), ...Object.keys(template.rewardItems)].every(id => reachable.has(id)));
}
/** Called only by an accepted server command. All promised terms are copied into account state. */
export function createShipVoyage(state: EconomyState, now: number, id: string,
  catalog: EconomyCatalog = economyCatalog, config = shipOrdersConfig): ShipVoyage | null {
  const eligible = eligibleShipTemplates(state, catalog, config);
  const choices = SHIP_ORDER_DIFFICULTIES.map(difficulty => {
    const candidates = eligible.filter(template => template.difficulty === difficulty);
    return candidates[shipOrderHash(`${id}:${difficulty}`) % candidates.length];
  });
  if (choices.some(template => !template)) return null;
  return {
    id, number: shipOrdersState(state).completedVoyages + 1, openedAt: new Date(now).toISOString(),
    rewardPearls: SHIP_COMPLETION_PEARLS,
    orders: choices.map((template, index) => {
      return { id: `${id}:${index}`, templateId: template.id, title: template.title,
        items: { ...template.items }, loadedItems: {}, difficulty: template.difficulty, rewardItems: { ...template.rewardItems }, rewardCoins: shipOrderReward(template.items, catalog, config), deliveredAt: null };
    }),
  };
}
