import { CookingPot, Fish, Flame, Footprints, Hammer, House, Pickaxe, Sprout, Trees, type LucideIcon } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import type { CraftSkillId } from "@/features/economy/domain/craft-skill-model";
import { craftSkillIds, craftSkillNames, experimentSuccessBps, skillProgress } from "@/features/economy/domain/craft-skill";
import { mealTimeExample } from "@/features/economy/ui/food/meal-speed-description";
import styles from "./forest-skills-panel.module.css";

const details: Record<CraftSkillId, { icon: LucideIcon; activity: string; benefit: string }> = {
  cooking: { icon: CookingPot, activity: "Готовьте блюда и забирайте их у костра.", benefit: "Кулинарные опыты удаются чаще." },
  travel: { icon: Footprints, activity: "Отправляйтесь в вылазки и получайте находки.", benefit: "Мохлик быстрее проходит маршруты." },
  fishing: { icon: Fish, activity: "Рыбачьте и забирайте улов.", benefit: "Рыбалка занимает меньше времени." },
  crafting: { icon: Hammer, activity: "Изготавливайте вещи в мастерской и забирайте готовое.", benefit: "Мастерская быстрее выполняет работу." },
  smelting: { icon: Flame, activity: "Обжигайте материалы и забирайте их из печи.", benefit: "Печь быстрее завершает обжиг." },
  gathering: { icon: Sprout, activity: "Выращивайте и собирайте урожай.", benefit: "Урожай созревает быстрее." },
  forestry: { icon: Trees, activity: "Заготавливайте древесину и получайте её у Лопоуха.", benefit: "Лесные работы заканчиваются быстрее." },
  mining: { icon: Pickaxe, activity: "Добывайте камень и руду, забирайте готовую добычу.", benefit: "Шахтёр быстрее добывает материалы." },
  building: { icon: House, activity: "Улучшайте хозяйство и принимайте готовые постройки.", benefit: "Новые стройки завершаются быстрее." },
};

export function ForestSkillCard({ state, skill, compact = false }: { state: EconomyView; skill: CraftSkillId; compact?: boolean }) {
  const progress = skillProgress(state, skill, state.catalog);
  const detail = details[skill], Icon = detail.icon, percent = Math.min(100, Math.max(0, Math.floor(progress.progress * 100)));
  const maximum = progress.nextLevelSeconds === null;
  const experiment = skill === "cooking" ? state.catalog.recipes.find(recipe => recipe.experiment) : undefined;
  return <article className={styles.card} data-craft-skill={skill} data-compact={compact || undefined}>
    <div className={styles.heading}><span className={styles.icon}><Icon size={compact ? 21 : 26} aria-hidden="true" /></span><div><h3>{craftSkillNames[skill]}</h3><span>Уровень {progress.level} / {state.catalog.skills?.levels.length ?? 10}</span></div></div>
    {!compact && <p className={styles.activity}>{detail.activity}</p>}
    <div className={styles.progressLabel}><span>{maximum ? "Высший уровень" : `К уровню ${progress.level + 1}`}</span><strong>{maximum ? "Освоен" : `${percent}%`}</strong></div>
    <progress value={progress.progress} max={1} aria-label={`${craftSkillNames[skill]}: ${maximum ? "высший уровень" : `${percent}% до следующего уровня`}`} />
    <div className={styles.benefit}><strong>{progress.bonusBps ? "Ваш бонус" : "С развитием навыка"}</strong><p>{detail.benefit}</p>
      {progress.bonusBps > 0 && <span>{skill === "cooking" ? experiment?.experiment ? `Пример: ${experiment.experiment.successBps / 100}% → ${experimentSuccessBps(state, experiment, state.catalog) / 100}%` : "Опыты удаются чаще" : `Пример: ${mealTimeExample(progress.bonusBps)}`}</span>}
      {skill === "cooking" && <small>Итоговый шанс указан перед опытом.</small>}
    </div>
  </article>;
}

export function ForestSkillsPanel({ state }: { state: EconomyView }) {
  return <section className={styles.skills} aria-label="Навыки леса" data-craft-skills>
    <header className={styles.intro}><span><Sprout size={22} aria-hidden="true" /></span><div><h2>Навыки леса</h2><p>Завершайте дела и забирайте результат. Новые уровни дают постоянные бонусы.</p></div></header>
    <div className={styles.grid}>{craftSkillIds.map(skill => <ForestSkillCard key={skill} state={state} skill={skill} />)}</div>
  </section>;
}
