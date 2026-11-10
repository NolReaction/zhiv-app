import { economyCatalog, type EconomyState } from "@/features/economy/domain/model";
import { boatConfig, boatFuelStatus, boatModules, boatPhase, newBoatState } from "@/features/economy/domain/boat-fishing";
import { boatModuleIds, boatPrivateStateSchema } from "@/features/economy/domain/boat-model";
import { creditEconomyItems, EconomyRuleError } from "@/features/economy/domain/rules";
import type { EconomyDevCommand } from "./dev-model";

const iso = (time: number) => new Date(time).toISOString();

/** Keep the paid job and its duration valid even when a DEV click happens in its first millisecond. */
export function finishDevBoatWork(state: EconomyState, now: number): boolean {
  const work = state.boat?.work;
  if (!work || Date.parse(work.finishesAt) <= now) return false;
  const duration = Math.max(1, Date.parse(work.finishesAt) - Date.parse(work.startedAt));
  work.startedAt = iso(now - duration);
  work.finishesAt = iso(now);
  return true;
}

/** Called only after the local development gate, authenticated owner and receipt checks. */
export function applyDevBoatCommand(state: EconomyState, command: EconomyDevCommand, now: number): string {
  if (!economyCatalog.boat) throw new EconomyRuleError("ECONOMY_BOAT_UNAVAILABLE", "Обновите каталог лодки");
  const config = boatConfig(), boat = state.boat ? boatPrivateStateSchema.parse(state.boat) : newBoatState();
  if (command.action === "prepare_boat") {
    if (boat.work || boat.voyage) throw new EconomyRuleError("ECONOMY_BOAT_BUSY", "Сначала завершите работу или вернитесь и заберите улов");
    boat.level = 1; state.boat = boat;
    return "DEV: лодка восстановлена";
  }
  if (command.action === "set_boat_module_level") {
    const moduleId = boatModuleIds.find(key => key === command.targetId);
    if (!moduleId || !Number.isInteger(command.quantity) || command.quantity < 0 || command.quantity >= config.moduleEffects[moduleId].length)
      throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Неизвестный уровень модуля", 400);
    if (boat.work || boat.voyage) throw new EconomyRuleError("ECONOMY_BOAT_BUSY", "Сначала завершите работу или вернитесь и примите улов");
    const levels = boatModules(boat), tier = command.quantity;
    if (moduleId !== "hull" && tier > 0 && !levels.hull) throw new EconomyRuleError("ECONOMY_BOAT_UPGRADE", "Сначала восстановите корпус");
    if (moduleId === "hull" && tier === 0 && (levels.tank || levels.engine || levels.storage))
      throw new EconomyRuleError("ECONOMY_BOAT_UPGRADE", "Для проверки сломанной лодки сначала снимите двигатель, бак и хранилище");
    const fuel = boatFuelStatus(boat, now, config);
    boat.modules = { ...levels, [moduleId]: tier };
    if (moduleId === "hull") boat.level = tier > 0 ? 1 : 0;
    const legacy = moduleId === "engine" ? "oars" : moduleId === "storage" ? "crate" : null;
    if (legacy) {
      boat.upgrades = boat.upgrades.filter(id => id !== legacy);
      if (tier > 0) boat.upgrades.push(legacy);
    }
    if (moduleId === "tank") {
      const capacity = config.moduleEffects.tank[tier], cells = Math.min(fuel.cells, capacity);
      boat.fuel = cells === capacity ? { cells } : { cells, nextAt: iso(fuel.nextAt ?? now + config.fuel.regenSeconds * 1000) };
    }
    state.boat = boat;
    return "DEV: уровень модуля установлен";
  }
  if (command.action === "grant_boat_upgrade_cost") {
    const upgrade = config.upgrades.find(entry => entry.id === command.targetId);
    if (!upgrade) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Улучшение лодки не найдено", 400);
    state.wallet.coins = Math.max(state.wallet.coins, upgrade.cost.coins);
    creditEconomyItems(state, Object.fromEntries(Object.entries(upgrade.cost.items)
      .map(([id, quantity]) => [id, Math.max(0, quantity - (state.inventory[id] ?? 0))])));
    return `DEV: добавлена недостающая стоимость «${upgrade.name}». Условия и установка сохраняются`;
  }
  if (command.action === "set_boat_blueprint") {
    const blueprint = config.blueprints.find(entry => entry.id === command.targetId);
    if (!blueprint) throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Чертёж не найден", 400);
    if (boat.work?.upgradeId === blueprint.id) throw new EconomyRuleError("ECONOMY_BOAT_BUSY", "Сначала завершите изготовление этого предмета");
    boat.blueprints[blueprint.id] = command.quantity; state.boat = boat;
    return `DEV: ${blueprint.name} · ${command.quantity} / 3 фрагментов`;
  }
  if (command.action === "finish_boat_work") {
    if (!boat.work || boat.work.id !== command.targetId) throw new EconomyRuleError("ECONOMY_BOAT_WORK_GONE", "Работа лодки уже изменилась");
    state.boat = boat;
    if (!finishDevBoatWork(state, now)) throw new EconomyRuleError("ECONOMY_BOAT_WORK_READY", "Работа уже готова. Завершите её обычной кнопкой");
    return "DEV: ожидание работы лодки убрано. Завершите установку обычной кнопкой";
  }
  if (command.action === "finish_boat_travel") {
    const voyage = boat.voyage;
    if (!voyage || voyage.id !== command.targetId) throw new EconomyRuleError("ECONOMY_BOAT_VOYAGE_GONE", "Поездка лодки уже изменилась");
    const phase = boatPhase(boat, now);
    if (phase === "outbound") {
      const shift = Date.parse(voyage.arrivesAt) - now;
      voyage.departedAt = iso(Date.parse(voyage.departedAt) - shift);
      voyage.arrivesAt = iso(now);
      voyage.fishingUntil = iso(Date.parse(voyage.fishingUntil) - shift);
      state.boat = boat;
      return "DEV: лодка у места ловли. Забросы, снасти и будущий улов сохранены";
    }
    if (phase === "returning") {
      // A timed automatic return may still carry the expired challenge. No cast is awarded.
      delete voyage.challenge;
      voyage.returnStartedAt = iso(now - voyage.inboundSeconds * 1000);
      voyage.returnsAt = iso(now); state.boat = boat;
      return "DEV: лодка у причала. Заберите сохранённый улов обычной кнопкой";
    }
    throw new EconomyRuleError("ECONOMY_BOAT_PHASE", phase === "fishing" ? "Сначала нажмите «Вернуться с уловом»" : "Лодка уже у причала. Завершите выход");
  }
  throw new EconomyRuleError("INVALID_ECONOMY_COMMAND", "Неизвестный сценарий лодки", 400);
}
