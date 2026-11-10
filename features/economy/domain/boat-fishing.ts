import { economyCatalog, type EconomyCatalog, type EconomyState } from "./model";
import { boatPrivateStateSchema, type BoatState, type BoatPrivateState, type BoatVoyage, type BoatUpgradeId, type BoatCatalog, type BoatModuleId } from "./boat-model";
import { economyActorConflict } from "./actor-availability";
import { fishingState, fishingBaitCompatible } from "./fishing";

export type { BoatState, BoatChallenge, BoatReelInput, BoatVoyage } from "./boat-model";
export const boatConfig = (catalog: EconomyCatalog = economyCatalog): BoatCatalog => {
  if (!catalog.boat) throw new Error("Boat catalog is unavailable");
  return catalog.boat;
};
export const newBoatState = (): BoatPrivateState => boatPrivateStateSchema.parse({});
export const boatState = (state: { boat?: BoatState }): BoatState => state.boat ?? newBoatState();
/** Purchases made before module tiers retain their first-tier rights, including pending paid work on claim. */
export function boatModules(boat: BoatState) {
  return {
    engine: Math.max(boat.modules?.engine ?? 0, Number(boat.upgrades.includes("oars"))),
    tank: boat.modules?.tank ?? 0,
    hull: Math.max(boat.level, boat.modules?.hull ?? 0),
    storage: Math.max(boat.modules?.storage ?? 0, Number(boat.upgrades.includes("crate"))),
  };
}
export function boatModuleUpgrade(boat: BoatState, module: BoatModuleId, config = boatConfig()) {
  const nextTier = boatModules(boat)[module] + 1;
  return config.upgrades.find(entry => entry.module === module && entry.tier === nextTier);
}
export function boatTripStats(boat: BoatState, config = boatConfig()) {
  const maxCatches = config.moduleEffects.storage[boatModules(boat).storage];
  return { outboundSeconds: config.outboundSeconds, inboundSeconds: config.inboundSeconds, maxCatches, maxCasts: maxCatches + config.spareCasts };
}
/** A snapshot keeps one absolute recharge deadline. Time spent full cannot accrue hidden cells. */
export function boatFuelStatus(boat: BoatState, now: number, config = boatConfig()) {
  const capacity = config.moduleEffects.tank[boatModules(boat).tank];
  const interval = config.fuel.regenSeconds * 1000;
  const initial = Math.min(capacity, boat.fuel?.cells ?? capacity);
  if (initial === capacity) return { cells: capacity, capacity, nextAt: null };
  const deadline = boat.fuel?.nextAt ? Date.parse(boat.fuel.nextAt) : now + interval;
  const earned = Math.max(0, 1 + Math.floor((now - deadline) / interval));
  const cells = Math.min(capacity, initial + earned);
  return { cells, capacity, nextAt: cells === capacity ? null : deadline + earned * interval };
}
export function boatReturnStartedAt(voyage: BoatVoyage): number {
  return voyage.returnStartedAt ? Date.parse(voyage.returnStartedAt) : Date.parse(voyage.fishingUntil);
}
export function boatReturnsAt(voyage: BoatVoyage): number {
  return voyage.returnsAt ? Date.parse(voyage.returnsAt) : boatReturnStartedAt(voyage) + voyage.inboundSeconds * 1000;
}
export function boatPhase(boat: BoatState, now: number): "broken" | "repairing" | "docked" | "outbound" | "fishing" | "returning" | "ready" {
  const voyage = boat.voyage;
  if (!voyage) return boat.level ? "docked" : boat.work ? "repairing" : "broken";
  if (now >= boatReturnsAt(voyage)) return "ready";
  if (now >= boatReturnStartedAt(voyage)) return "returning";
  return now < Date.parse(voyage.arrivesAt) ? "outbound" : "fishing";
}
/** An explicit allowlist: private future draws never reach player or admin views. */
export function publicBoatState(value?: BoatState | null): BoatState {
  const boat = value ?? newBoatState(), voyage = boat.voyage;
  return { version: 1, level: boat.level, upgrades: [...boat.upgrades], blueprints: { ...boat.blueprints }, artifacts: [...boat.artifacts],
    ...(boat.modules ? { modules: { ...boatModules(boat) } } : {}),
    ...(boat.fuel ? { fuel: { cells: boat.fuel.cells, ...(boat.fuel.nextAt ? { nextAt: boat.fuel.nextAt } : {}) } } : {}),
    completedVoyages: boat.completedVoyages, qualifiedVoyages: boat.qualifiedVoyages,
    records: Object.fromEntries(Object.entries(boat.records).map(([id, record]) => [id, { weightGrams: record.weightGrams, caughtAt: record.caughtAt }])),
    ...(boat.work ? { work: { id: boat.work.id, upgradeId: boat.work.upgradeId, startedAt: boat.work.startedAt, finishesAt: boat.work.finishesAt,
      cost: { coins: boat.work.cost.coins, items: { ...boat.work.cost.items } } } } : {}),
    ...(voyage ? { voyage: { id: voyage.id, routeId: voyage.routeId, departedAt: voyage.departedAt, arrivesAt: voyage.arrivesAt, fishingUntil: voyage.fishingUntil,
      ...(voyage.returnStartedAt ? { returnStartedAt: voyage.returnStartedAt } : {}), ...(voyage.returnsAt ? { returnsAt: voyage.returnsAt } : {}),
      maxCasts: voyage.maxCasts, maxCatches: voyage.maxCatches, castsUsed: voyage.castsUsed, outboundSeconds: voyage.outboundSeconds, inboundSeconds: voyage.inboundSeconds,
      loadout: { rodId: voyage.loadout.rodId, hookId: voyage.loadout.hookId, baitId: voyage.loadout.baitId },
      catches: voyage.catches.map(caught => ({ castIndex: caught.castIndex, fishId: caught.fishId, weightGrams: caught.weightGrams, caughtAt: caught.caughtAt, ...(caught.reelSeconds != null ? { reelSeconds: caught.reelSeconds } : {}) })),
      ...(voyage.challenge ? { challenge: { id: voyage.challenge.id, rulesVersion: voyage.challenge.rulesVersion, seed: voyage.challenge.seed,
        tickMs: voyage.challenge.tickMs, maxTicks: voyage.challenge.maxTicks, zoneWidth: voyage.challenge.zoneWidth, difficulty: voyage.challenge.difficulty,
        startedAt: voyage.challenge.startedAt, expiresAt: voyage.challenge.expiresAt,
        ...(voyage.challenge.rulesVersion >= 5 ? { motorResponse: voyage.challenge.motorResponse, hullDamping: voyage.challenge.hullDamping } : {}),
        ...(voyage.challenge.resistance ? { resistance: voyage.challenge.resistance } : {}),
        ...(voyage.challenge.biteAt ? { biteAt: voyage.challenge.biteAt } : {}),
        ...(voyage.challenge.fishRarity ? { fishRarity: voyage.challenge.fishRarity } : {}) } } : {}) } } : {}) };
}
type BoatSource = Pick<EconomyState, "buildings" | "jobs" | "inventory" | "wallet" | "fishing"> & { boat?: BoatState; catalog?: EconomyCatalog };
export function boatUpgradeReason(state: BoatSource, upgradeId: BoatUpgradeId | string, now = Date.now()): string | null {
  if (!Number.isFinite(now)) return "Обновите время хозяйства";
  const boat = boatState(state), upgrade = (state.catalog?.boat ?? boatConfig()).upgrades.find(entry => entry.id === upgradeId);
  if (!upgrade) return "Улучшение не найдено";
  if (boat.work || (upgrade.seconds > 0 && state.jobs.some(job => job.kind === "construction"))) return "Строитель занят. Сначала завершите текущую работу";
  if (boat.voyage) return "Сначала вернитесь и заберите улов";
  if (upgradeId === "repair" ? boat.level > 0 : boat.level === 0) return upgradeId === "repair" ? "Лодка уже восстановлена" : "Сначала восстановите лодку";
  if (upgrade.module && upgrade.tier !== boatModules(boat)[upgrade.module] + 1)
    return (upgrade.tier ?? 0) <= boatModules(boat)[upgrade.module] ? "Улучшение уже готово" : "Сначала установите предыдущий уровень";
  if (boat.artifacts.some(id => id === upgradeId)) return "Улучшение уже готово";
  if (upgrade.requiredHomeLevel > 1 && (state.buildings.home ?? 1) < upgrade.requiredHomeLevel) return `Нужен дом уровня ${upgrade.requiredHomeLevel}`;
  if (Object.entries(upgrade.requiredBuildings).some(([id, level]) => (state.buildings[id] ?? 0) < level)) return "Сначала улучшите мастерскую";
  if (upgrade.blueprint && boat.blueprints[upgrade.blueprint] < 3) return "Соберите три страницы чертежа";
  if (state.wallet.coins < upgrade.cost.coins) return "Не хватает монет";
  if (Object.entries(upgrade.cost.items).some(([id, amount]) => (state.inventory[id] ?? 0) < amount)) return "Не хватает материалов";
  return null;
}
export function boatDepartureReason(state: BoatSource, now: number): string | null {
  const boat = boatState(state), tackle = fishingState(state), fishing = economyCatalog.fishing;
  if (!boat.level) return "Сначала восстановите лодку";
  if (boat.work) return "Дождитесь улучшения лодки и заберите работу";
  if (boat.voyage) return "Сначала вернитесь и заберите улов";
  if (boatFuelStatus(boat, now, state.catalog?.boat).cells === 0) return "Бак пуст. Дождитесь топлива или заправьтесь за жемчуг";
  const conflict = economyActorConflict(state.jobs, "departure", now);
  if (conflict) return conflict.message;
  if (!fishing || !tackle.ownedRods.includes(tackle.equippedRodId) || !fishing.rods.some(rod => rod.id === tackle.equippedRodId)
    || !tackle.ownedHooks.includes(tackle.equippedHookId) || !fishing.hooks.some(hook => hook.id === tackle.equippedHookId)) return "Выберите свои удочку и крючок";
  if (tackle.equippedBaitId && (!fishingBaitCompatible(tackle.equippedRodId, tackle.equippedBaitId, fishing) || !(state.inventory[tackle.equippedBaitId] > 0))) return "Проверьте запас и совместимость наживки";
  return null;
}
/** Independent uniforms create a bounded right tail; control performance never changes mass. */
export function boatFishWeight(minGrams: number, maxGrams: number, first: number, second: number): number {
  return minGrams + Math.floor((maxGrams - minGrams) * first * second / 100_000_000);
}
export function boatClaimPracticeSeconds(before: BoatState | undefined, after: BoatState | undefined, action: string): number {
  const voyage = before?.voyage;
  if ((action !== "claim_boat" && action !== "sell_boat_catch") || !voyage || after?.voyage) return 0;
  const travel = voyage.outboundSeconds + voyage.inboundSeconds;
  return travel ? Math.floor(travel * voyage.catches.length / voyage.maxCatches)
    : voyage.catches.reduce((total, caught) => total + (caught.reelSeconds ?? 0), 0);
}
