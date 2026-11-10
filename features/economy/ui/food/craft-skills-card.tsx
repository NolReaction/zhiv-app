import type { EconomyView } from "@/features/economy/domain/model";
import { ForestSkillCard } from "@/features/economy/ui/skills/forest-skills-panel";

/** A contextual cooking summary; the complete forest skills live in the profile. */
export function CraftSkillsCard({ state }: { state: EconomyView; cookingOnly?: boolean }) {
  return <section aria-label="Навык кулинарии"><ForestSkillCard state={state} skill="cooking" compact /></section>;
}
