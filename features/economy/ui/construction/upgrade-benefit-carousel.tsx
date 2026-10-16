"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import styles from "./world-upgrade-dialog.module.css";

export type UpgradeBenefitCard = { id: string; label: string; content: ReactNode; details?: ReactNode };

/** Native scrolling keeps touch, trackpad and keyboard navigation on the same cards. */
export function UpgradeBenefitCarousel({ cards, onCardChange }: { cards: UpgradeBenefitCard[]; onCardChange: (id: string) => void }) {
  const track = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const id = useId();
  const multiple = cards.length > 1;
  const moveTo = (index: number, smooth = true) => {
    const element = track.current;
    const card = element?.children.item(index) as HTMLElement | null;
    if (!element || !card) return;
    element.scrollTo({ left: card.offsetLeft - (element.children.item(0) as HTMLElement).offsetLeft,
      behavior: smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant" });
  };
  const updateActive = () => {
    const element = track.current;
    if (!element) return;
    const first = (element.children.item(0) as HTMLElement).offsetLeft;
    const nearest = Array.from(element.children).reduce((best, card, index, all) =>
      Math.abs((card as HTMLElement).offsetLeft - first - element.scrollLeft)
        < Math.abs((all[best] as HTMLElement).offsetLeft - first - element.scrollLeft) ? index : best, 0);
    if (nearest !== active) { setActive(nearest); onCardChange(cards[nearest].id); }
  };

  return <><section className={`${styles.section} ${styles.benefits}`} aria-label="Что изменится">
    <div className={styles.benefitHeading}>
      <h3 id={`${id}-heading`}><Sparkles size={15} aria-hidden="true" />После улучшения</h3>
      {multiple && <div className={styles.benefitNavigation}>
        <button type="button" aria-label="Предыдущая возможность" aria-controls={id} disabled={active === 0} onClick={() => moveTo(active - 1)}><ChevronLeft size={17} aria-hidden="true" /></button>
        <span className={styles.benefitCounter} aria-live="polite" aria-atomic="true">{active + 1} / {cards.length}</span>
        <button type="button" aria-label="Следующая возможность" aria-controls={id} disabled={active === cards.length - 1} onClick={() => moveTo(active + 1)}><ChevronRight size={17} aria-hidden="true" /></button>
      </div>}
    </div>
    {multiple && <p id={`${id}-hint`} className={styles.benefitHint}>Листайте карточки или нажимайте стрелки</p>}
    <div ref={track} id={id} className={styles.benefitTrack} data-single={!multiple || undefined}
      role="region" aria-roledescription="карусель" aria-labelledby={`${id}-heading`} aria-describedby={multiple ? `${id}-hint` : undefined}
      tabIndex={multiple ? 0 : undefined} onScroll={updateActive}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return;
        const index = event.key === "ArrowRight" ? Math.min(cards.length - 1, active + 1)
          : event.key === "ArrowLeft" ? Math.max(0, active - 1)
          : event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : null;
        if (index === null) return;
        event.preventDefault(); event.stopPropagation(); moveTo(index);
      }}>
      {cards.map((card, index) => <div key={card.id} className={styles.benefitSlide} role="group" aria-roledescription="карточка"
        aria-label={`${index + 1} из ${cards.length}: ${card.label}`} data-upgrade-benefit={card.id}
        onFocusCapture={event => { if (index !== active && event.target.matches(":focus-visible")) moveTo(index, false); }}
        onClickCapture={() => { if (index !== active) moveTo(index); }}>{card.content}</div>)}
    </div>
  </section>{cards[active]?.details && <section aria-label={`Подробнее: ${cards[active].label}`}>{cards[active].details}</section>}</>;
}
