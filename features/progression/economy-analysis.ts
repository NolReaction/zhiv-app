import { economyCatalog, type EconomyCatalog } from "@/features/economy/domain/model";
import { economyLocalSellPrice } from "@/features/economy/domain/local-sale";
import { planEconomyProduction } from "./economy-plan";
import { productionSources, sortItemSources, timeEconomyPolicy, type ProductionSource } from "./economy-sources";

export type EconomyGraphNode = { id: string; label: string; kind: "item" | "operation"; itemId?: string; sourceId?: string };
export type EconomyGraphEdge = { id: string; from: string; to: string; quantity: number; kind: "input" | "output" };
export type AnalysisItem = EconomyCatalog["items"][number] & {
  npcPrice: number | null; sourceId: string | null; sourceIds: string[];
  inputValue: number | null; ownSeconds: number | null; addedValue: number | null; addedCoinsPerMinute: number | null;
  fullWorkSeconds: number | null; launches: number | null; recurringUses: number; warnings: string[];
};
export type EconomyAnalysis = { catalogVersion: number; coinsPerMinute: number | null; items: AnalysisItem[];
  sources: ProductionSource[]; graph: { nodes: EconomyGraphNode[]; edges: EconomyGraphEdge[] } };

/** Catalogue analysis never reprices the live game. Direct margins use actual
 * liquidation prices; complete chain work includes collection once, as work of
 * the hero, and never pretends expected fishing is a guaranteed deadline. */
export function buildEconomyAnalysis(catalog: EconomyCatalog = economyCatalog): EconomyAnalysis {
  const sources = productionSources(catalog).filter(source => !source.retired);
  const policy = timeEconomyPolicy(catalog);
  const prices = new Map(catalog.items.map(item => [item.id, item.tradable
    ? economyLocalSellPrice(item.baseSellPrice, 1, catalog.localBuyer, item.id) : null]));
  const value = (items: Record<string, number>) => Object.entries(items).reduce((sum, [id, quantity]) => sum + (prices.get(id) ?? 0) * quantity, 0);
  const recurring = new Map<string, Set<string>>();
  const addUse = (id: string, use: string) => {
    if (!recurring.has(id)) recurring.set(id, new Set());
    recurring.get(id)!.add(use);
  };
  for (const source of sources) for (const id of Object.keys(source.cost.items)) addUse(id, source.id);
  for (const template of catalog.food?.orders.templates ?? []) for (const id of Object.keys(template.items)) addUse(id, `order:${template.id}`);
  for (const weekly of catalog.tradeRelations?.weekly.templates ?? []) for (const stage of weekly.stages)
    for (const id of Object.keys(stage.items)) addUse(id, `weekly:${weekly.id}:${stage.id}`);
  for (const meal of catalog.food?.meals ?? []) addUse(meal.itemId, "meal");
  for (const bait of catalog.fishing?.baits ?? []) addUse(bait.itemId, "fishing");
  const items: AnalysisItem[] = catalog.items.map(item => {
    const choices = sortItemSources(item.id, sources, catalog), baseline = choices[0];
    const quantity = baseline?.rewards[item.id] ?? 0;
    const singleOutput = baseline && Object.keys(baseline.rewards).length === 1;
    const inputValue = singleOutput ? (value(baseline.cost.items) + baseline.cost.coins) / quantity : null;
    const ownSeconds = singleOutput ? baseline.seconds / quantity : null;
    const addedValue = singleOutput ? (value(baseline.rewards) - value(baseline.cost.items) - baseline.cost.coins) / quantity : null;
    const warnings: string[] = [];
    if (baseline && !singleOutput) warnings.push("Источник даёт несколько товаров: время и стоимость всей партии нельзя приписывать каждой единице отдельно.");
    const plan = baseline ? planEconomyProduction({ targets: { [item.id]: 1 } }, catalog) : null;
    if (policy?.externalPrices[item.id] !== undefined) warnings.push("Внешняя базовая оценка: цена задана отдельно для случайного улова или покупного товара, а не выведена из гарантированного таймера.");
    if (!plan?.complete) warnings.push("Полная цепочка содержит внешний или негарантированный источник. Фиксированное время получения не рассчитано.");
    if (item.tradable && !recurring.has(item.id) && !catalog.fishing?.fish.some(fish => fish.itemId === item.id))
      warnings.push("Нет повторяемого применения в рецептах, поручениях, еде или снастях. Продажа NPC не считается отдельным применением.");
    if (addedValue !== null && addedValue <= 0) warnings.push("Переработка не увеличивает стоимость относительно продажи ингредиентов.");
    return { ...item, npcPrice: prices.get(item.id) ?? null, sourceId: baseline?.id ?? null, sourceIds: choices.map(source => source.id),
      inputValue, ownSeconds, addedValue, addedCoinsPerMinute: addedValue !== null && ownSeconds ? addedValue * 60 / ownSeconds : null,
      fullWorkSeconds: plan?.complete ? plan.workSeconds : null, launches: plan?.complete ? plan.launches : null,
      recurringUses: recurring.get(item.id)?.size ?? 0, warnings };
  });
  const nodes: EconomyGraphNode[] = [
    ...catalog.items.map(item => ({ id: `item:${item.id}`, label: item.name, kind: "item" as const, itemId: item.id })),
    ...sources.map(source => ({ id: source.id, label: source.name, kind: "operation" as const, sourceId: source.id })),
  ];
  const edges: EconomyGraphEdge[] = sources.flatMap(source => [
    ...Object.entries(source.cost.items).map(([id, quantity]) => ({ id: `${source.id}:in:${id}`, from: `item:${id}`, to: source.id, quantity, kind: "input" as const })),
    ...Object.entries(source.rewards).map(([id, quantity]) => ({ id: `${source.id}:out:${id}`, from: source.id, to: `item:${id}`, quantity, kind: "output" as const })),
  ]);
  return { catalogVersion: catalog.version, coinsPerMinute: policy?.coinsPerMinute ?? null, items, sources, graph: { nodes, edges } };
}
