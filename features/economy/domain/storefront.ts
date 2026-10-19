import { z } from "zod";
import catalogJson from "@/apps/api/src/main/resources/world/storefront-catalog.json";
import { premiumCostumes } from "@/features/world/domain/premium-costumes";
import { economyCatalog, recipeBuildingLevel, type EconomyCatalog, type EconomyView } from "./model";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_PEARLS, PEARL_DISPLAY_DIVISOR } from "./money";

const offerId = z.string().regex(/^[a-z][a-z0-9_]*_v1$/).max(80);
const label = z.string().min(1).max(100);
const priceRub = z.number().int().positive().safe().max(100_000);
const pearls = z.number().int().positive().safe().max(ECONOMY_MAX_PEARLS)
  .refine(value => value % PEARL_DISPLAY_DIVISOR === 0, "Storefront pearls must be whole displayed units");
const offer = z.object({ id: offerId, name: label, priceRub }).strict();
const starter = offer.extend({
  description: z.string().min(1).max(200), homeLevel: z.number().int().min(1).max(5), purchaseLimit: z.literal(1),
  rewards: z.object({ pearls, coins: z.number().int().nonnegative().safe().max(ECONOMY_MAX_BALANCE),
    items: z.record(z.string().min(1).max(80), z.number().int().positive().safe().max(20)),
  }).strict().refine(rewards => Object.values(rewards.items).reduce((sum, quantity) => sum + quantity, 0) <= 20,
    "Starter items must fit a modest part of the initial fifty-place pantry"),
}).strict();

/** Display terms only. No purchase command or client-side entitlement is provided. */
export const storefrontCatalogSchema = z.object({
  version: z.literal(1), currency: z.literal("RUB"), paymentsEnabled: z.literal(false),
  pearlPacks: z.array(offer.extend({ pearls }).strict()).length(3),
  costumeOffers: z.array(offer.extend({ description: z.string().min(1).max(200),
    outfitId: z.string().min(1).max(80), purchaseLimit: z.literal(1),
  }).strict()).length(3),
  starterPacks: z.array(starter).length(5),
}).strict().superRefine((catalog, context) => {
  const allOffers = [...catalog.pearlPacks, ...catalog.costumeOffers, ...catalog.starterPacks];
  if (new Set(allOffers.map(entry => entry.id)).size !== allOffers.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Storefront offer IDs must be unique" });
  if (new Set(catalog.starterPacks.map(entry => entry.homeLevel)).size !== 5)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Every house level requires one starter" });
  if (new Set(catalog.costumeOffers.map(entry => entry.outfitId)).size !== catalog.costumeOffers.length)
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Costume outfits must be unique" });
});
export type StorefrontCatalog = z.infer<typeof storefrontCatalogSchema>;
export type StorefrontStarterOffer = StorefrontCatalog["starterPacks"][number];
export type StorefrontCostumeOffer = StorefrontCatalog["costumeOffers"][number];

/** Cross-catalog checks keep preview bundles within their stage; they never unlock content. */
export function validateStorefrontCatalog(catalog: StorefrontCatalog, economy: EconomyCatalog = economyCatalog): void {
  const outfits = new Set(premiumCostumes.map(outfit => outfit.id));
  for (const costume of catalog.costumeOffers) if (!outfits.has(costume.outfitId))
    throw new Error(`Unknown premium outfit: ${costume.outfitId}`);
  const home = economy.buildings.find(building => building.id === "home");
  for (const pack of catalog.starterPacks) {
    if (!home?.levels.some(level => level.level === pack.homeLevel)) throw new Error(`Unknown starter house level: ${pack.homeLevel}`);
    // Closing each prerequisite includes the previous levels' requirements. The
    // pack may appear immediately after the house claim, before any new station.
    const completed: Record<string, number> = { home: pack.homeLevel };
    let expanded = true;
    while (expanded) {
      expanded = false;
      for (const building of economy.buildings) for (const level of building.levels) {
        if (level.level > (completed[building.id] ?? 0)) continue;
        for (const [id, requiredLevel] of Object.entries(level.requiredBuildings)) if (requiredLevel > (completed[id] ?? 0)) {
          completed[id] = requiredLevel;
          expanded = true;
        }
      }
    }
    for (const itemId of Object.keys(pack.rewards.items)) {
      const item = economy.items.find(item => item.id === itemId);
      if (!item || item.category === "special") throw new Error(`Starter item must be an ordinary economy item: ${itemId}`);
      const sources = [...economy.recipes, ...economy.explorations].filter(source => (source.rewards[itemId] ?? 0) > 0);
      if (!sources.some(source => source.requiredHomeLevel <= pack.homeLevel
        && Object.entries(source.requiredBuildings).every(([id, level]) => (completed[id] ?? 0) >= level)
        && (!("buildingId" in source) || (completed[source.buildingId] ?? 0) >= recipeBuildingLevel(source))))
        throw new Error(`Starter item is unavailable at house ${pack.homeLevel}: ${itemId}`);
    }
  }
}

export const storefrontCatalog = storefrontCatalogSchema.parse(catalogJson);
validateStorefrontCatalog(storefrontCatalog);

/** Read only the owner's completed buildings. Ready or in-progress jobs do not change the offer. */
export function storefrontStarterOffer(state: Pick<EconomyView, "buildings" | "catalog"> | null | undefined): StorefrontStarterOffer | null {
  if (!state) return null;
  const level = state.buildings.home;
  if (!Number.isSafeInteger(level) || !state.catalog.buildings.find(building => building.id === "home")?.levels.some(entry => entry.level === level)) return null;
  return storefrontCatalog.starterPacks.find(pack => pack.homeLevel === level) ?? null;
}

export function storefrontCostumes(): readonly StorefrontCostumeOffer[] {
  return storefrontCatalog.costumeOffers;
}
