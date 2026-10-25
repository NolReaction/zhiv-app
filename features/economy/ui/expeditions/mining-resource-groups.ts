import type { EconomyView } from "@/features/economy/domain/model";

type MiningRoute = EconomyView["catalog"]["explorations"][number];
export const miningDurationFilters = [
  { id: "all", label: "Все" },
  { id: "short", label: "До 15 мин" },
  { id: "medium", label: "15 мин - 1 ч" },
  { id: "long", label: "Дольше 1 ч" },
] as const;
export type MiningDurationFilter = typeof miningDurationFilters[number]["id"];

/** Filter the quoted work time, including the miner's earned speed bonus. */
export function miningDurationMatches(seconds: number, filter: MiningDurationFilter) {
  return filter === "all" || (filter === "short" && seconds <= 900)
    || (filter === "medium" && seconds > 900 && seconds <= 3600)
    || (filter === "long" && seconds > 3600);
}

export function miningDurationLabel(seconds: number) {
  const total = Math.max(0, Math.ceil(seconds));
  if (!total) return "Сразу";
  const hours = Math.floor(total / 3600), minutes = Math.floor(total % 3600 / 60), remainder = total % 60;
  return [hours && `${hours} ч`, minutes && `${minutes} мин`, remainder && `${remainder} с`].filter(Boolean).join(" ");
}

/** Mixed yields belong to one section, so a mission never appears twice. */
export function miningResourceGroups(routes: readonly MiningRoute[], filter: MiningDurationFilter, seconds: (route: MiningRoute) => number) {
  const groups = new Map<string, { id: string; itemId: string | null; routes: MiningRoute[] }>();
  for (const route of routes) {
    if (route.retired) continue;
    if (!miningDurationMatches(seconds(route), filter)) continue;
    const items = Object.keys(route.rewards).filter(id => route.rewards[id] > 0);
    const itemId = items.length === 1 ? items[0] : null, id = itemId ?? "mixed";
    const group = groups.get(id) ?? { id, itemId, routes: [] };
    group.routes.push(route);
    groups.set(id, group);
  }
  const priority = ["stone", "ore", "clay", "sand"];
  const order = (id: string) => id === "mixed" ? Number.MAX_SAFE_INTEGER : priority.includes(id) ? priority.indexOf(id) : priority.length;
  return [...groups.values()].sort((a, b) => order(a.id) - order(b.id) || a.id.localeCompare(b.id))
    .map(group => ({ ...group, routes: group.routes.sort((a, b) => seconds(a) - seconds(b) || a.id.localeCompare(b.id)) }));
}
