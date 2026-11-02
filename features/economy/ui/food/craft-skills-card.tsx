import { CookingPot, Footprints } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import { skillProgress } from "@/features/economy/domain/craft-skill";
import { worldRecipeDuration } from "@/features/economy/ui/stations/world-recipe-groups";
import styles from "./craft-skills-card.module.css";

export function CraftSkillsCard({ state, cookingOnly = false }: { state: EconomyView; cookingOnly?: boolean }) {
  return <section className={styles.skills} aria-label={cookingOnly ? "Навык кулинарии" : "Навыки Мохлика"} data-craft-skills>
    {!cookingOnly && <h3>Навыки Мохлика</h3>}
    <div className={styles.grid}>{(cookingOnly ? ["cooking"] as const : ["cooking", "travel"] as const).map(skill => {
      const progress = skillProgress(state, skill, state.catalog), cooking = skill === "cooking", Icon = cooking ? CookingPot : Footprints;
      return <div key={skill} className={styles.skill} data-craft-skill={skill}>
        <div className={styles.heading}><Icon size={19} aria-hidden="true" /><strong>{cooking ? "Кулинария" : "Путешествия"}</strong><span>Ур. {progress.level}</span></div>
        <progress value={progress.progress} max={1} aria-label={`${cooking ? "Кулинария" : "Путешествия"}: до следующего уровня`} />
        <p>{progress.bonusBps ? cooking ? `+${progress.bonusBps / 100} п.п. к успеху опытов` : `+${progress.bonusBps / 100}% к скорости вылазок` : cooking ? "Практикуйтесь с обычными блюдами и опытами" : "Практика за завершённые вылазки"}</p>
        <small>{progress.nextLevelSeconds === null ? "Мастерство достигнуто" : `До уровня ${progress.level + 1}: ${worldRecipeDuration(progress.nextLevelSeconds - progress.workSeconds)} практики`}</small>
      </div>;
    })}</div>
    {!cookingOnly && <p className={styles.hint}>Навыки растут, когда вы забираете результат. Считается исходная длительность работы, поэтому ускорения не уменьшают практику.</p>}
  </section>;
}
