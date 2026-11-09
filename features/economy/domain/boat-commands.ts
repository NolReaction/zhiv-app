import { ECONOMY_MAX_ITEMS, economyCatalog, type EconomyCommand, type EconomyCost, type EconomyState } from "./model";
import { boatConfig, newBoatState, boatDepartureReason, boatUpgradeReason, boatPhase, boatFishWeight, boatFuelStatus, boatModules, boatTripStats } from "./boat-fishing";
import { boatResistanceForClass, replayBoatReel } from "./boat-reel";
import { fishingState, selectFishingCatch } from "./fishing";
import { creditFishStock } from "./fish-stock";
import type { RareRandomInteger } from "./rare-drops";
import { boatPrivateStateSchema, type BoatPrivateState } from "./boat-model";

export const boatActions = ["start_boat_upgrade", "claim_boat_upgrade", "buy_boat_fuel", "depart_boat", "begin_boat_cast", "submit_boat_cast", "return_boat", "claim_boat"] as const;
type BoatServices = { debit: (state: EconomyState, cost: EconomyCost) => unknown; credit: (state: EconomyState, items: Record<string, number>) => void;
  assertStorage: (before: EconomyState, after: EconomyState) => void; fail: (code: string, message: string) => never };
const iso = (now: number) => new Date(now).toISOString();
const addCount = (value: number) => Math.min(1_000_000_000, value + 1);

/** Mutate only a private clone. Failed capacity, replay or entropy validation commits nothing. */
export function applyBoatCommand(state: EconomyState, command: EconomyCommand, now: number, id: () => string, random: RareRandomInteger, services: BoatServices): string {
  const next = structuredClone(state), message = transition(next, command, now, id, random, services);
  Object.assign(state, next);
  return message;
}
function transition(state: EconomyState, command: EconomyCommand, now: number, id: () => string, random: RareRandomInteger, services: BoatServices): string {
  const config = boatConfig(), boat: BoatPrivateState = state.boat ? boatPrivateStateSchema.parse(state.boat) : newBoatState(), { fail } = services;
  const draw = (maximum: number) => {
    const value = random(maximum);
    if (!Number.isSafeInteger(value) || value < 0 || value >= maximum) throw new Error("Invalid trusted boat draw");
    return value;
  };
  const saveFuel = (cells: number, capacity: number, nextAt: number | null) => {
    boat.fuel = { cells, ...(cells < capacity ? { nextAt: iso(nextAt ?? now + config.fuel.regenSeconds * 1000) } : {}) };
  };
  if (command.action === "buy_boat_fuel") {
    if (command.targetId !== "fuel_cell" || command.totalPrice !== config.fuel.refillPricePearls)
      return fail("ECONOMY_BOAT_FUEL_PRICE", "Цена топлива изменилась. Обновите мастерскую");
    const { cells, capacity, nextAt } = boatFuelStatus(boat, now, config);
    if (!boat.level || boat.voyage || boat.work || cells !== 0)
      return fail("ECONOMY_BOAT_FUEL", "Заправка доступна у причала, когда бак пуст и лодка готова");
    if (state.wallet.pearls < config.fuel.refillPricePearls) return fail("ECONOMY_PEARLS", "Не хватает жемчуга для заправки");
    state.wallet.pearls -= config.fuel.refillPricePearls;
    saveFuel(1, capacity, nextAt); state.boat = boat;
    return "В бак добавлена одна ячейка топлива";
  }
  if (command.action === "start_boat_upgrade") {
    const reason = boatUpgradeReason(state, command.targetId, now);
    if (reason) return fail("ECONOMY_BOAT_UPGRADE", reason);
    const upgrade = config.upgrades.find(entry => entry.id === command.targetId)!;
    services.debit(state, upgrade.cost);
    boat.work = { id: id(), upgradeId: upgrade.id, startedAt: iso(now), finishesAt: iso(now + upgrade.seconds * 1000), cost: structuredClone(upgrade.cost) };
    state.boat = boat;
    return upgrade.id === "repair" ? "Начат ремонт лодки" : "Улучшение лодки началось";
  }
  if (command.action === "claim_boat_upgrade") {
    const work = boat.work;
    if (!work || work.id !== command.targetId) return fail("ECONOMY_BOAT_WORK_GONE", "Работа уже получена или изменилась");
    if (now < Date.parse(work.finishesAt)) return fail("ECONOMY_BOAT_WORK_WAIT", "Работа ещё не закончена");
    const upgrade = config.upgrades.find(entry => entry.id === work.upgradeId)!;
    if (upgrade.module && upgrade.tier) {
      const fuel = boatFuelStatus(boat, now, config);
      boat.modules = { ...boatModules(boat), [upgrade.module]: upgrade.tier };
      if (upgrade.module === "tank") saveFuel(fuel.cells, config.moduleEffects.tank[upgrade.tier], fuel.nextAt);
      if (work.upgradeId === "repair") boat.level = 1;
      if (work.upgradeId === "crate" || work.upgradeId === "oars") boat.upgrades = [...new Set([...boat.upgrades, work.upgradeId])];
    } else if (upgrade.blueprint) boat.artifacts = [...new Set([...boat.artifacts, upgrade.blueprint])];
    delete boat.work; state.boat = boat;
    return "Лодка готова. Улучшение получено";
  }
  if (command.action === "depart_boat") {
    if (command.targetId !== config.routeId) return fail("ECONOMY_BOAT_ROUTE", "Место рыбалки не найдено");
    const reason = boatDepartureReason(state, now);
    if (reason) return fail("ECONOMY_BOAT_DEPARTURE", reason);
    const tackle = fishingState(state), { outboundSeconds, inboundSeconds, maxCasts, maxCatches } = boatTripStats(boat, config);
    const fuel = boatFuelStatus(boat, now, config);
    const loadout = { rodId: tackle.equippedRodId, hookId: tackle.equippedHookId, baitId: tackle.equippedBaitId };
    const cost = { coins: 0, items: loadout.baitId ? { [loadout.baitId]: 1 } : {} };
    // All slots use server entropy independent of requestId and public reel seeds.
    const seed = `boat:${draw(0x1_0000_0000)}:${draw(0x1_0000_0000)}`;
    const slots = Array.from({ length: maxCasts }, (_, index) => {
      const fishId = selectFishingCatch(seed, loadout.rodId, loadout.baitId, economyCatalog.fishing!, loadout.hookId, index), spec = config.weights[fishId];
      if (!spec) throw new Error("Boat species has no authored weight range");
      const weightGrams = boatFishWeight(spec.minGrams, spec.maxGrams, draw(10001), draw(10001));
      const rarity = economyCatalog.fishing!.fish.find(fish => fish.itemId === fishId)!.rarity;
      const difficulty = Math.min(5, ["common", "uncommon", "rare", "epic", "legendary"].indexOf(rarity) + 1
        + Number((weightGrams - spec.minGrams) * 100 > (spec.maxGrams - spec.minGrams) * 65));
      return { fishId, weightGrams, difficulty, challengeSeed: draw(0x1_0000_0000), zoneWidth: boat.artifacts.includes("landing_net") ? config.netZoneWidth : config.zoneWidth };
    });
    services.debit(state, cost);
    saveFuel(fuel.cells - 1, fuel.capacity, fuel.nextAt);
    boat.voyage = { id: id(), routeId: config.routeId, departedAt: iso(now), arrivesAt: iso(now + outboundSeconds * 1000),
      fishingUntil: iso(now + (outboundSeconds + config.activeSeconds) * 1000), outboundSeconds, inboundSeconds,
      maxCasts, maxCatches, castsUsed: 0, catches: [], loadout, slots };
    state.boat = boat;
    return "Мохлик отправился на речной плёс";
  }
  const voyage = boat.voyage;
  if (!voyage || voyage.id !== command.targetId) return fail("ECONOMY_BOAT_VOYAGE_GONE", "Поездка уже завершена или изменилась");
  const phase = boatPhase(boat, now);
  if (command.action === "begin_boat_cast") {
    if (phase !== "fishing") return fail("ECONOMY_BOAT_PHASE", "Заброс доступен только на речном плёсе");
    if (voyage.challenge && now < Date.parse(voyage.challenge.expiresAt)) return fail("ECONOMY_BOAT_CAST_ACTIVE", "Завершите текущую поклёвку");
    if (voyage.castsUsed >= voyage.maxCasts || voyage.catches.length >= voyage.maxCatches) return fail("ECONOMY_BOAT_CAST_LIMIT", "Забросы закончились. Пора возвращаться");
    const slot = voyage.slots[voyage.castsUsed];
    if (!slot) throw new Error("Missing saved boat slot");
    const biteAt = now + (4 + slot.challengeSeed % 4) * 1000;
    const expiresAt = Math.min(now + config.castExpirySeconds * 1000, Date.parse(voyage.fishingUntil));
    if (biteAt + 50 >= expiresAt) return fail("ECONOMY_BOAT_CAST_WAIT", "Для нового заброса не хватает времени. Пора возвращаться");
    const fishRarity = economyCatalog.fishing!.fish.find(fish => fish.itemId === slot.fishId)!.rarity;
    voyage.castsUsed++;
    const levels = boatModules(boat), motorResponse = config.moduleEffects.engine[levels.engine], hullDamping = config.moduleEffects.hull[levels.hull];
    // Previously departed trips keep their original replay, including a pending attempt acquired on another device.
    const assisted = voyage.outboundSeconds === 0 && voyage.inboundSeconds === 0 && (motorResponse > 0 || hullDamping > 0);
    voyage.challenge = { id: id(), rulesVersion: assisted ? 5 : 4, ...(assisted ? { motorResponse, hullDamping } : {}), resistance: boatResistanceForClass(fishRarity, slot.challengeSeed), seed: slot.challengeSeed, tickMs: 50, maxTicks: 600,
      zoneWidth: slot.zoneWidth, difficulty: slot.difficulty, startedAt: iso(now), expiresAt: iso(expiresAt), biteAt: iso(biteAt), fishRarity };
    state.boat = boat;
    return "Удочка заброшена. Ждём поклёвку";
  }
  if (command.action === "submit_boat_cast") {
    const challenge = voyage.challenge, reel = command.reel;
    if (!challenge || !reel || challenge.id !== reel.challengeId) return fail("ECONOMY_BOAT_CAST_GONE", "Эта поклёвка уже закончилась");
    const expiresAt = Date.parse(challenge.expiresAt);
    const earliestFinish = Date.parse(challenge.biteAt ?? challenge.startedAt) + reel.endTick * challenge.tickMs;
    // Only the outstanding server-issued slot may settle after reconnecting. Its original
    // time budget, replay and private draw are still authoritative.
    const deliverLater = reel.deferred && !voyage.returnStartedAt && earliestFinish <= expiresAt && now <= expiresAt + 86_400_000;
    if ((phase !== "fishing" || now >= expiresAt) && !deliverLater) return fail("ECONOMY_BOAT_CAST_EXPIRED", "Рыба ушла. Можно сделать следующий заброс");
    if (now < earliestFinish) return fail("ECONOMY_BOAT_TRACE", "Дождитесь поклёвки и завершите вываживание");
    let result;
    try { result = replayBoatReel(challenge, reel.inputs, reel.endTick); }
    catch { return fail("ECONOMY_BOAT_TRACE", "Не удалось проверить управление удочкой"); }
    if (result.status === "active") return fail("ECONOMY_BOAT_TRACE", "Попытка ещё не закончилась");
    if (result.status === "caught") {
      const slot = voyage.slots[voyage.castsUsed - 1];
      if (!slot || voyage.catches.length >= voyage.maxCatches) return fail("ECONOMY_BOAT_CAST_LIMIT", "Ящик уже заполнен");
      voyage.catches.push({ castIndex: voyage.castsUsed - 1, fishId: slot.fishId, weightGrams: slot.weightGrams, caughtAt: iso(Math.min(now, expiresAt)),
        ...(voyage.outboundSeconds === 0 && voyage.inboundSeconds === 0 ? { reelSeconds: Math.floor(reel.endTick * challenge.tickMs / 1000) } : {}) });
    }
    delete voyage.challenge; state.boat = boat;
    return result.status === "caught" ? "Рыба в лодке! Заберите улов после возвращения" : "Рыба сорвалась";
  }
  if (command.action === "return_boat") {
    if (phase !== "fishing") return fail("ECONOMY_BOAT_PHASE", "Лодка ещё в пути или уже возвращается");
    delete voyage.challenge;
    voyage.returnStartedAt = iso(now); voyage.returnsAt = iso(now + voyage.inboundSeconds * 1000); state.boat = boat;
    return "Мохлик возвращается к берегу";
  }
  if (command.action !== "claim_boat" || phase !== "ready") return fail("ECONOMY_BOAT_PHASE", "Дождитесь возвращения лодки");
  const rewards: Record<string, number> = {};
  for (const caught of voyage.catches) rewards[caught.fishId] = (rewards[caught.fishId] ?? 0) + 1;
  const previous = structuredClone(state);
  services.credit(state, rewards); services.assertStorage(previous, state);
  creditFishStock(state, rewards);
  const tackle = fishingState(state), catches = { ...tackle.catches };
  for (const [fishId, count] of Object.entries(rewards)) catches[fishId] = Math.min(ECONOMY_MAX_ITEMS, (catches[fishId] ?? 0) + count);
  state.fishing = { ...tackle, catches };
  for (const caught of voyage.catches) if ((boat.records[caught.fishId]?.weightGrams ?? 0) < caught.weightGrams)
    boat.records[caught.fishId] = { weightGrams: caught.weightGrams, caughtAt: caught.caughtAt };
  boat.completedVoyages = addCount(boat.completedVoyages);
  if (voyage.catches.length === voyage.maxCatches || voyage.castsUsed === voyage.maxCasts && voyage.catches.length > 0) {
    boat.qualifiedVoyages = addCount(boat.qualifiedVoyages);
  }
  if (voyage.catches.length) {
    state.completedExplorations = Math.min(ECONOMY_MAX_ITEMS, state.completedExplorations + 1);
    state.progression.routes[voyage.routeId] = Math.min(ECONOMY_MAX_ITEMS, (state.progression.routes[voyage.routeId] ?? 0) + 1);
    state.unlockedItems = [...new Set([...(state.unlockedItems ?? []), ...Object.keys(rewards)])];
  }
  delete boat.voyage; state.boat = boat;
  return voyage.catches.length ? `Улов получен: ${voyage.catches.length}` : "Мохлик вернулся с рыбалки";
}
