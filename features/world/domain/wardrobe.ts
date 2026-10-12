import catalog from "@/apps/api/src/main/resources/world/catalog.json";

export type WardrobeItem = {
  id: string; name: string; slot: "palette" | "head" | "neck"; color: string;
  sparks: number; starter: boolean;
  purchase?: { currency: "coins" | "pearls"; amount: number };
};
/** Clothing is permanent ownership, separate from consumables and fishing gear. */
export const wardrobeItems: readonly WardrobeItem[] = catalog.items.filter(item => item.slot !== "rod") as WardrobeItem[];
export function wardrobeOwned(...inventories: readonly (readonly string[] | null | undefined)[]): string[] {
  const known = new Set(wardrobeItems.map(item => item.id));
  return [...new Set([...wardrobeItems.filter(item => item.starter).map(item => item.id),
    ...inventories.flatMap(items => items ?? [])])].filter(id => known.has(id)).sort();
}
/** Currency is part of the accepted quote and of the durable command signature. */
export function wardrobePurchaseTarget(item: WardrobeItem): string {
  return item.purchase ? `${item.purchase.currency}:${item.id}` : item.id;
}
