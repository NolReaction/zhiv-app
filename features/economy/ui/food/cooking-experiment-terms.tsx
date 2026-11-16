import type { EconomyView } from "@/features/economy/domain/model";
import { experimentSuccessBps } from "@/features/economy/domain/craft-skill";
import { number } from "@/features/economy/ui/shared/world-economy-parts";
import type { WorldRecipe } from "@/features/economy/ui/shared/world-stations";
import styles from "./world-cookbook.module.css";

/** Keep the wager visible beside the action, including outside the cookbook. */
export function cookingExperimentSummary(state: EconomyView, recipe: WorldRecipe) {
  if (!recipe.experiment) return undefined;
  return `Успех ${number(experimentSuccessBps(state, recipe, state.catalog) / 100)}%. Ингредиенты будут потрачены в любом случае. При неудаче блюдо не получится.`;
}

export function CookingExperimentTerms({ state, recipe, id }: { state: EconomyView; recipe: WorldRecipe; id?: string }) {
  if (!recipe.experiment) return null;
  const chance = experimentSuccessBps(state, recipe, state.catalog) / 100;
  return <div id={id} className={styles.experimentTerms} data-experiment-terms>
    <strong>Успех {number(chance)}%</strong>
    <span>Ингредиенты будут потрачены в любом случае. При неудаче блюдо не получится.</span>
  </div>;
}
