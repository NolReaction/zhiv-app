import type { EconomyCatalog, EconomyView } from "@/features/economy/domain/model";
import type { AdminEconomyGrant } from "./admin-grants-api";

export type GrantKind = "coins" | "pearls" | "item" | "building" | "slots" | "rod" | "hook";
export type GrantEntry = { kind: GrantKind; id: string; name: string; amount: number };
export const grantEntryKey = (entry: Pick<GrantEntry, "kind" | "id">) => `${entry.kind}:${entry.id}`;
export const formatGrantNumber = (value: number) => value.toLocaleString("ru-RU");
export function grantBuildingBusy(state: EconomyView | null, catalog: EconomyCatalog, id: string): boolean {
  return !!state?.jobs.some(job => (job.targetId === id && (job.kind === "construction" || job.kind === "production"))
    || id === "quarry" && job.kind === "exploration" && catalog.explorations.some(route => route.id === job.targetId && route.requiredBuildings.quarry > 0));
}
export function grantAmountLabel(entry: GrantEntry) {
  return entry.kind === "building" ? `до ур. ${entry.amount}` : entry.kind === "slots" ? `до ${entry.amount} мест`
    : entry.kind === "rod" || entry.kind === "hook" ? "во владение" : `+${formatGrantNumber(entry.amount)}`;
}
export function makeEconomyGrant(entries: GrantEntry[], requestId: string, publicId: string, reason: string): AdminEconomyGrant {
  const request: AdminEconomyGrant = { requestId, confirmationPublicId: publicId, reason: reason.trim(), coins: 0, pearls: 0,
    items: {}, buildings: {}, productionSlots: {}, rods: [], hooks: [] };
  for (const entry of entries) {
    if (entry.kind === "coins" || entry.kind === "pearls") request[entry.kind] += entry.amount;
    else if (entry.kind === "rod" || entry.kind === "hook") request[entry.kind === "rod" ? "rods" : "hooks"].push(entry.id);
    else request[entry.kind === "item" ? "items" : entry.kind === "building" ? "buildings" : "productionSlots"][entry.id] = entry.amount;
  }
  return request;
}
export function grantBasketIssue(entries: GrantEntry[], state: EconomyView | null, catalog: EconomyCatalog): string | null {
  if (entries.some(entry => !Number.isSafeInteger(entry.amount) || entry.amount < 1 || entry.amount > (entry.kind === "coins" || entry.kind === "pearls" ? 1_000_000_000 : 10_000)))
    return "Укажите целое положительное количество в пределах лимита.";
  const units = entries.filter(entry => entry.kind === "item").reduce((sum, entry) => sum + entry.amount, 0);
  if (units > 10_000) return "В одной выдаче может быть не больше 10 000 предметов.";
  const buildings = { ...state?.buildings, ...Object.fromEntries(entries.filter(entry => entry.kind === "building").map(entry => [entry.id, entry.amount])) };
  const home = buildings.home ?? 1;
  for (const entry of entries) {
    if (entry.kind === "building") {
      const spec = catalog.buildings.find(building => building.id === entry.id)?.levels.find(level => level.level === entry.amount);
      if (!spec) return `У здания «${entry.name}» нет такого уровня.`;
      if (grantBuildingBusy(state, catalog, entry.id)) return `«${entry.name}» сейчас строится или работает. Сначала игрок должен получить результат текущего задания.`;
      const levels = catalog.buildings.find(building => building.id === entry.id)!.levels.filter(level => level.level > (state?.buildings[entry.id] ?? 0) && level.level <= entry.amount);
      for (const level of levels) {
        if (home < level.requiredHomeLevel) return `Для «${entry.name}» нужен дом уровня ${level.requiredHomeLevel}. Добавьте его в эту выдачу.`;
        const missing = Object.entries(level.requiredBuildings).find(([id, amount]) => (buildings[id] ?? 0) < amount);
        if (missing) return `Для «${entry.name}» нужно: ${catalog.buildings.find(building => building.id === missing[0])?.name ?? missing[0]}, ур. ${missing[1]}.`;
      }
    }
    if (entry.kind === "slots") {
      if (state?.jobs.some(job => job.kind === "construction" && job.targetId === entry.id)) return `«${entry.name}»: сначала игрок должен получить результат стройки.`;
      const spec = catalog.productionSlots.upgrades.find(upgrade => upgrade.slots === entry.amount);
      if (!spec || home < spec.requiredHomeLevel || !(buildings[entry.id] > 0)) return `Для «${entry.name}» нужна построенная станция и дом уровня ${spec?.requiredHomeLevel ?? "из каталога"}.`;
    }
    if (entry.kind === "rod" || entry.kind === "hook") {
      const gear = (entry.kind === "rod" ? catalog.fishing?.rods : catalog.fishing?.hooks)?.find(item => item.id === entry.id);
      if (gear && home < gear.requiredHomeLevel) return `Для «${entry.name}» нужен дом уровня ${gear.requiredHomeLevel}.`;
    }
  }
  if (state && units) {
    const warehouseLevel = buildings.warehouse ?? 1;
    const capacity = catalog.buildings.find(building => building.id === "warehouse")?.levels.find(level => level.level === warehouseLevel)?.warehouseCapacity ?? state.storage.capacity;
    if (state.storage.used + state.storage.reserved + units > capacity) return `Не хватает места: после выдачи нужно ${formatGrantNumber(state.storage.used + state.storage.reserved + units)}, вместимость — ${formatGrantNumber(capacity)}. Уменьшите количество или добавьте улучшение кладовой.`;
  }
  return null;
}
