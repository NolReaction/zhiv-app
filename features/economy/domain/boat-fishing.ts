import { economyCatalog, type EconomyCatalog, type EconomyState } from "./model";
import { boatPrivateStateSchema, type BoatState, type BoatPrivateState, type BoatVoyage, type BoatUpgradeId, type BoatCatalog } from "./boat-model";
import { economyActorConflict } from "./actor-availability";
import { fishingState, fishingBaitCompatible } from "./fishing";

export type { BoatState, BoatChallenge, BoatReelInput, BoatVoyage } from "./boat-model";
export const boatConfig = (catalog: EconomyCatalog = economyCatalog): BoatCatalog => {
  if (!catalog.boat) throw new Error("Boat catalog is unavailable");
  return catalog.boat;
};
export const newBoatState = (): BoatPrivateState => boatPrivateStateSchema.parse({});
export const boatState = (state: { boat?: BoatState }): BoatState => state.boat ?? newBoatState();
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
    completedVoyages: boat.completedVoyages, qualifiedVoyages: boat.qualifiedVoyages,
    records: Object.fromEntries(Object.entries(boat.records).map(([id, record]) => [id, { weightGrams: record.weightGrams, caughtAt: record.caughtAt }])),
    ...(boat.work ? { work: { id: boat.work.id, upgradeId: boat.work.upgradeId, startedAt: boat.work.startedAt, finishesAt: boat.work.finishesAt,
      cost: { coins: boat.work.cost.coins, items: { ...boat.work.cost.items } } } } : {}),
    ...(voyage ? { voyage: { id: voyage.id, routeId: voyage.routeId, departedAt: voyage.departedAt, arrivesAt: voyage.arrivesAt, fishingUntil: voyage.fishingUntil,
      ...(voyage.returnStartedAt ? { returnStartedAt: voyage.returnStartedAt } : {}), ...(voyage.returnsAt ? { returnsAt: voyage.returnsAt } : {}),
      maxCasts: voyage.maxCasts, maxCatches: voyage.maxCatches, castsUsed: voyage.castsUsed, outboundSeconds: voyage.outboundSeconds, inboundSeconds: voyage.inboundSeconds,
      loadout: { rodId: voyage.loadout.rodId, hookId: voyage.loadout.hookId, baitId: voyage.loadout.baitId },
      catches: voyage.catches.map(caught => ({ castIndex: caught.castIndex, fishId: caught.fishId, weightGrams: caught.weightGrams, caughtAt: caught.caughtAt })),
      ...(voyage.challenge ? { challenge: { id: voyage.challenge.id, rulesVersion: voyage.challenge.rulesVersion, seed: voyage.challenge.seed,
        tickMs: voyage.challenge.tickMs, maxTicks: voyage.challenge.maxTicks, zoneWidth: voyage.challenge.zoneWidth, difficulty: voyage.challenge.difficulty,
        startedAt: voyage.challenge.startedAt, expiresAt: voyage.challenge.expiresAt } } : {}) } } : {}) };
}
type BoatSource = Pick<EconomyState, "buildings" | "jobs" | "inventory" | "wallet" | "fishing"> & { boat?: BoatState };
export function boatUpgradeReason(state: BoatSource, upgradeId: BoatUpgradeId | string, now = Date.now()): string | null {
  if (!Number.isFinite(now)) return "Обновите время хозяйства";
  const boat = boatState(state), upgrade = boatConfig().upgrades.find(entry => entry.id === upgradeId);
  if (!upgrade) return "Улучшение не найдено";
  if (boat.work || state.jobs.some(job => job.kind === "construction")) return "Строитель занят. Сначала завершите текущую работу";
  if (boat.voyage) return "Сначала вернитесь и заберите улов";
  if (upgradeId === "repair" ? boat.level > 0 : boat.level === 0) return upgradeId === "repair" ? "Лодка уже восстановлена" : "Сначала восстановите лодку";
  if (boat.upgrades.some(id => id === upgradeId) || boat.artifacts.some(id => id === upgradeId)) return "Улучшение уже готово";
  if ((state.buildings.home ?? 1) < upgrade.requiredHomeLevel) return `Нужен дом уровня ${upgrade.requiredHomeLevel}`;
  if (Object.entries(upgrade.requiredBuildings).some(([id, level]) => (state.buildings[id] ?? 0) < level)) return "Сначала улучшите мастерскую";
  if (upgrade.blueprint && boat.blueprints[upgrade.blueprint] < 3) return "Соберите три страницы чертежа";
  if (state.wallet.coins < upgrade.cost.coins || Object.entries(upgrade.cost.items).some(([id, amount]) => (state.inventory[id] ?? 0) < amount)) return "Не хватает монет или материалов";
  return null;
}
export function boatDepartureReason(state: BoatSource, now: number): string | null {
  const boat = boatState(state), tackle = fishingState(state), fishing = economyCatalog.fishing;
  if (!boat.level) return "Сначала восстановите лодку";
  if (boat.work) return "Дождитесь улучшения лодки и заберите работу";
  if (boat.voyage) return "Сначала вернитесь и заберите улов";
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
  return action === "claim_boat" && voyage && !after?.voyage
    ? Math.floor((voyage.outboundSeconds + voyage.inboundSeconds) * voyage.catches.length / voyage.maxCatches) : 0;
}
