"use client";

import { useId, useState } from "react";
import { BookOpen, ChevronDown, Compass, Fish, Hammer, House, Sparkles } from "lucide-react";
import type { UpgradeBenefitCard } from "./upgrade-benefit-carousel";
import styles from "./world-upgrade-dialog.module.css";

const sections = [
  { id: "buildings", title: "Постройки и рынок", icon: House },
  { id: "routes", title: "Вылазки и добыча", icon: Compass },
  { id: "production", title: "Производство", icon: Hammer },
  { id: "cooking", title: "Рецепты костра", icon: BookOpen },
  { id: "fishing", title: "Рыбацкие снасти", icon: Fish },
] as const;

function Benefit({ card }: { card: UpgradeBenefitCard }) {
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  return <div data-upgrade-benefit={card.id}>
    {card.details ? <>
      <button type="button" className={`${styles.benefitCard} ${styles.benefitDisclosure}`} aria-expanded={expanded}
        aria-controls={expanded ? id : undefined} data-recipe={card.recipeId} onClick={() => setExpanded(!expanded)}>
        {card.content}
        <span className={styles.benefitDetailLink}>{expanded ? "Свернуть" : card.detailLabel ?? "Подробнее и условия"}<ChevronDown size={14} aria-hidden="true" /></span>
      </button>
      {expanded && <div id={id}>{card.details}</div>}
    </> : <div className={styles.benefitCard}>{card.content}</div>}
  </div>;
}

export function HomeUpgradeBenefits({ cards }: { cards: UpgradeBenefitCard[] }) {
  return <section className={`${styles.section} ${styles.benefits}`} aria-label="Что изменится">
    <h3><Sparkles size={15} aria-hidden="true" />После улучшения</h3>
    {cards.filter(card => !card.group).map(card => <Benefit key={card.id} card={card} />)}
    {sections.map(({ id, title, icon: Icon }) => {
      const entries = cards.filter(card => card.group === id);
      if (!entries.length) return null;
      const count = entries.reduce((total, card) => total + (card.count ?? 1), 0);
      return <details key={id} className={styles.benefitGroup} data-benefit-group={id}>
        <summary><Icon size={18} aria-hidden="true" /><strong>{title}</strong><span>{count}</span><ChevronDown size={16} aria-hidden="true" /></summary>
        <div className={styles.benefitGroupEntries}>{entries.map(card => <Benefit key={card.id} card={card} />)}</div>
      </details>;
    })}
  </section>;
}
