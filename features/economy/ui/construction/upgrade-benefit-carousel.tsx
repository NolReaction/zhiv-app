"use client";

import { useId, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Sparkles } from "lucide-react";
import styles from "./world-upgrade-dialog.module.css";

export type UpgradeBenefitCard = {
  id: string;
  label: string;
  content: ReactNode;
  details?: ReactNode;
  detailLabel?: string;
  recipeId?: string;
};

/** Browsing previews never opens their conditions; each card is an explicit disclosure. */
export function UpgradeBenefitCarousel({ cards }: { cards: UpgradeBenefitCard[] }) {
  const track = useRef<HTMLDivElement>(null);
  const activeIndex = useRef(0);
  const pointer = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const [active, setActive] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const id = useId();
  const multiple = cards.length > 1;
  const select = (index: number) => {
    if (index === activeIndex.current) return;
    activeIndex.current = index;
    setActive(index);
    setExpanded(null);
  };
  const moveTo = (index: number, smooth = true) => {
    const element = track.current;
    const card = element?.children.item(index) as HTMLElement | null;
    if (!element || !card) return;
    element.scrollTo({ left: card.offsetLeft - (element.children.item(0) as HTMLElement).offsetLeft,
      behavior: smooth && !window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "smooth" : "instant" });
  };
  const updateActive = () => {
    const element = track.current;
    if (!element || !element.children.length) return;
    const first = (element.children.item(0) as HTMLElement).offsetLeft;
    const nearest = Array.from(element.children).reduce((best, card, index, all) =>
      Math.abs((card as HTMLElement).offsetLeft - first - element.scrollLeft)
        < Math.abs((all[best] as HTMLElement).offsetLeft - first - element.scrollLeft) ? index : best, 0);
    select(nearest);
  };
  const selected = cards[active];
  const detailsVisible = selected?.id === expanded && Boolean(selected.details);

  return <><section className={`${styles.section} ${styles.benefits}`} aria-label="Что изменится">
    <div className={styles.benefitHeading}>
      <h3 id={`${id}-heading`}><Sparkles size={15} aria-hidden="true" />После улучшения</h3>
      {multiple && <div className={styles.benefitNavigation}>
        <button type="button" aria-label="Предыдущая возможность" aria-controls={id} disabled={active === 0} onClick={() => moveTo(active - 1)}><ChevronLeft size={17} aria-hidden="true" /></button>
        <span className={styles.benefitCounter} aria-live="polite" aria-atomic="true">{active + 1} / {cards.length}</span>
        <button type="button" aria-label="Следующая возможность" aria-controls={id} disabled={active === cards.length - 1} onClick={() => moveTo(active + 1)}><ChevronRight size={17} aria-hidden="true" /></button>
      </div>}
    </div>
    {multiple && <p id={`${id}-hint`} className={styles.benefitHint}>Листайте карточки или нажимайте стрелки. Нажмите на карточку, чтобы посмотреть подробности.</p>}
    <div ref={track} id={id} className={styles.benefitTrack} data-single={!multiple || undefined}
      role="region" aria-roledescription="карусель" aria-labelledby={`${id}-heading`} aria-describedby={multiple ? `${id}-hint` : undefined}
      tabIndex={multiple ? 0 : undefined} onScroll={updateActive}
      onPointerDownCapture={event => { pointer.current = { x: event.clientX, y: event.clientY, moved: false }; }}
      onPointerMoveCapture={event => {
        if (pointer.current && Math.hypot(event.clientX - pointer.current.x, event.clientY - pointer.current.y) > 8) pointer.current.moved = true;
      }}
      onPointerCancelCapture={() => { if (pointer.current) pointer.current.moved = true; }}
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
        onFocusCapture={event => {
          if (index !== activeIndex.current && event.target.matches(":focus-visible")) { select(index); moveTo(index, false); }
        }}>
        {card.details ? <button type="button" className={`${styles.benefitCard} ${styles.benefitDisclosure}`}
          id={`${id}-trigger-${index}`} aria-label={card.recipeId ? `Рецепт: ${card.label}` : `Подробнее: ${card.label}`}
          aria-expanded={expanded === card.id && active === index} aria-controls={expanded === card.id && active === index ? `${id}-details-${index}` : undefined} data-recipe={card.recipeId}
          onClick={event => {
            if (event.detail !== 0 && pointer.current?.moved) { event.preventDefault(); return; }
            if (index !== activeIndex.current) { select(index); moveTo(index, false); }
            setExpanded(expanded === card.id ? null : card.id);
          }}>
          {card.content}<span className={styles.benefitDetailLink}>{expanded === card.id && active === index ? "Свернуть" : card.detailLabel ?? "Подробнее и условия"}<ChevronDown size={14} aria-hidden="true" /></span>
        </button> : <div className={styles.benefitCard}>{card.content}</div>}
      </div>)}
    </div>
  </section>{detailsVisible && <section id={`${id}-details-${active}`} aria-label={`Подробнее: ${selected.label}`} aria-labelledby={`${id}-trigger-${active}`}>{selected.details}</section>}</>;
}
