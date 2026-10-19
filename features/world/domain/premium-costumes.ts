import type { WorldState } from "./model";

export type PremiumCostume = {
  id: string; name: string; description: string;
  appearance: WorldState["equipment"]; itemIds: readonly string[];
};

/** Preview data only. Looking at an outfit never grants or equips its pieces. */
export const premiumCostumes: readonly PremiumCostume[] = [
  { id: "premium_stargazer", name: "Звездочёт", description: "Ночная мантия, звёздный колпак и золотой шарф.",
    appearance: { palette: "premium_stargazer_moss", head: "premium_stargazer_hat", neck: "premium_stargazer_scarf" },
    itemIds: ["premium_stargazer_moss", "premium_stargazer_hat", "premium_stargazer_scarf"] },
  { id: "premium_ember", name: "Хранитель огня", description: "Огненный плащ, тёплая шапка и угольный шарф.",
    appearance: { palette: "premium_ember_moss", head: "premium_ember_hat", neck: "premium_ember_scarf" },
    itemIds: ["premium_ember_moss", "premium_ember_hat", "premium_ember_scarf"] },
  { id: "premium_explorer", name: "Первопроходец", description: "Дорожная куртка, широкополая шляпа и лазурный шарф.",
    appearance: { palette: "premium_explorer_moss", head: "premium_explorer_hat", neck: "premium_explorer_scarf" },
    itemIds: ["premium_explorer_moss", "premium_explorer_hat", "premium_explorer_scarf"] },
];

export function premiumCostumeAppearance(id: string): WorldState["equipment"] | undefined {
  const appearance = premiumCostumes.find(costume => costume.id === id)?.appearance;
  return appearance ? { ...appearance } : undefined;
}
