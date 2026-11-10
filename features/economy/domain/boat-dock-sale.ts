import type { BoatVoyage } from "./boat-model";
import type { EconomyCatalog } from "./model";
import { fishClassForItem } from "./fishing";

/** A dock offer covers the actual fish still on board. The warehouse holds interchangeable class goods. */
export function boatDockSaleQuote(catches: BoatVoyage["catches"], catalog: EconomyCatalog) {
  const percent = catalog.boat?.dockSaleBonusPercent;
  if (percent == null || !catalog.fishing || !catches.length) return null;
  let base = 0, bonus = 0;
  for (const fish of catches) {
    const range = catalog.boat?.weights[fish.fishId];
    const group = fishClassForItem(fish.fishId, catalog.fishing);
    const price = catalog.items.find(item => item.id === group?.itemId)?.baseSellPrice;
    if (!range || !price) return null;
    const span = range.maxGrams - range.minGrams;
    const excess = Math.max(0, Math.min(span, fish.weightGrams - range.minGrams));
    base += price;
    bonus += Number(BigInt(price) * BigInt(percent) * BigInt(excess) / BigInt(100 * span));
  }
  return { base, bonus, total: base + bonus };
}
