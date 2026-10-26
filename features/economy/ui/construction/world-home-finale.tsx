"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { ArrowLeft, Clapperboard, Pause, Play, RotateCcw, Sprout, Trophy } from "lucide-react";
import styles from "./world-home-finale.module.css";

const AUTHOR = "Сломов Дмитрий";
const ROLES = [
  "Автор идеи и ещё одной идеи",
  "Режиссёр лесной жизни",
  "Главный по всему",
  "Художник всего, что поместилось",
  "Постановщик красивых закатов",
  "Хранитель последнего печенья",
  "Организатор тихого часа",
  "Ответственный за «ещё пять минут»",
  "Специалист по внезапным идеям",
  "Отдел «а давайте ещё вот это»",
  "Испытатель собственного терпения",
  "Бухгалтер последней жемчужины",
  "Продюсер и спонсор чаепитий",
  "Весь остальной штат",
] as const;

function subscribeVisibility(notify: () => void) {
  document.addEventListener("visibilitychange", notify);
  return () => document.removeEventListener("visibilitychange", notify);
}

function isHidden() { return document.visibilityState === "hidden"; }
function subscribeMotion(notify: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}
function prefersReducedMotion() { return window.matchMedia("(prefers-reduced-motion: reduce)").matches; }
function serverFalse() { return false; }

/** A repeatable joke at the home's current level cap; no gameplay state changes. */
export function WorldHomeFinale() {
  const [showCredits, setShowCredits] = useState(false);
  const [paused, setPaused] = useState(false);
  const [ended, setEnded] = useState(false);
  const [run, setRun] = useState(0);
  const switched = useRef(false);
  const watchButton = useRef<HTMLButtonElement>(null);
  const creditsHeading = useRef<HTMLHeadingElement>(null);
  const screen = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const hintId = useId();
  const hidden = useSyncExternalStore(subscribeVisibility, isHidden, serverFalse);
  const reducedMotion = useSyncExternalStore(subscribeMotion, prefersReducedMotion, serverFalse);

  useEffect(() => {
    // The surrounding Dialog owns its initial focus. Move it only after a view switch.
    if (switched.current) (showCredits ? creditsHeading.current : watchButton.current)?.focus({ preventScroll: true });
  }, [showCredits]);

  function openCredits() {
    switched.current = true;
    setPaused(false);
    setEnded(false);
    setRun(value => value + 1);
    setShowCredits(true);
  }

  function restart() {
    setPaused(false);
    setEnded(false);
    setRun(value => value + 1);
    if (screen.current) screen.current.scrollTop = 0;
  }

  return <section className={styles.finale} data-home-finale={showCredits ? "credits" : "celebration"}>
    {!showCredits ? <div className={styles.congratulations}>
      <span className={styles.trophy} aria-hidden="true"><Trophy size={34} strokeWidth={1.5} /><Sprout size={18} className={styles.trophySprout} /></span>
      <span className={styles.eyebrow}>Дом мечты построен</span>
      <h3 className={styles.title}>Поздравляем!<br />Дом мечты готов.</h3>
      <p className={styles.description}>Главная стройка завершена. Можно наконец-то пожить. А съёмочная группа уже ждёт оваций.</p>
      <p className={styles.aside}>Лесная жизнь продолжается: мастерские, кладовая, новые рецепты и доверие жителей ещё ждут своего часа.</p>
      <button ref={watchButton} type="button" className={`${styles.button} ${styles.primary}`} onClick={openCredits}><Clapperboard size={17} aria-hidden="true" />Смотреть титры</button>
    </div> : <div className={styles.cinema}>
      <div className={styles.cinemaHeading}>
        <Clapperboard size={17} aria-hidden="true" />
        <h3 id={titleId} ref={creditsHeading} tabIndex={-1}>Над лесом работали</h3>
        <span className={styles.episode}>Финал дома</span>
      </div>
      <div ref={screen} className={styles.screen} tabIndex={reducedMotion ? 0 : undefined} aria-labelledby={titleId} aria-describedby={hintId} data-credits-viewport data-static={reducedMotion || undefined} data-ended={ended || undefined}>
        <div key={run} className={styles.reel} data-credits-reel style={{ animationPlayState: paused || hidden ? "paused" : "running" }} onAnimationEnd={event => { if (event.target === event.currentTarget) setEnded(true); }}>
          <div className={styles.opening}>
            <Sprout size={28} aria-hidden="true" />
            <strong>Я живой</strong>
            <span>Один человек. Целый лес.</span>
          </div>
          <ul className={styles.credits}>{ROLES.map(role => <li key={role}><span>{role}</span><strong>{AUTHOR}</strong></li>)}</ul>
          <div className={styles.closing}><span>Особая благодарность</span><strong>{AUTHOR}</strong><p>А ещё вам - за то, что довели дом до титров.</p><Sprout size={24} aria-hidden="true" /><b>Продолжение следует.<br />Брёвна сами себя не принесут.</b></div>
        </div>
        {ended && !reducedMotion && <div className={styles.endCard} role="status"><Sprout size={30} aria-hidden="true" /><strong>Спасибо за игру!</strong><p>Мохлик ждёт. У него там целый лес.</p></div>}
      </div>
      <p id={hintId} className={styles.hint}>{reducedMotion ? "Титры можно прокрутить вручную." : ended ? "Все роли закрыты. Вакансий пока нет." : "Можно поставить на паузу или вернуться в лес в любой момент."}</p>
      <div className={styles.controls}>
        {!reducedMotion && !ended && <button type="button" className={styles.button} onClick={() => setPaused(value => !value)} aria-pressed={paused}>{paused ? <Play size={15} aria-hidden="true" /> : <Pause size={15} aria-hidden="true" />}{paused ? "Продолжить" : "Пауза"}</button>}
        <button type="button" className={styles.button} onClick={restart}><RotateCcw size={15} aria-hidden="true" />Сначала</button>
        <button type="button" className={`${styles.button} ${styles.back}`} onClick={() => { switched.current = true; setShowCredits(false); }}><ArrowLeft size={15} aria-hidden="true" />К поздравлению</button>
      </div>
    </div>}
  </section>;
}
