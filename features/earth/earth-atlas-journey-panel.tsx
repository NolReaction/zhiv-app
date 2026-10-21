"use client";

import { useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, Check, Compass, Route, X } from "lucide-react";
import { earthAtlasCandidate, earthAtlasEntry, type EarthAtlasEntry, type EarthAtlasView } from "./earth-atlas";
import { EARTH_ATLAS_JOURNEYS, earthAtlasJourneyStop, transitionEarthAtlasJourney, type EarthAtlasJourneyAction, type EarthAtlasJourneyState } from "./earth-atlas-journeys";
import styles from "./earth-atlas-journeys.module.css";

type Props = {
  view: EarthAtlasView | null;
  openedIds: readonly string[];
  loaded: boolean;
  onFocus: (entry: EarthAtlasEntry) => void;
  onDiscover: (entry: EarthAtlasEntry) => void;
};

export function EarthAtlasJourneys({ view, openedIds, loaded, onFocus, onDiscover }: Props) {
  const [state, setState] = useState<EarthAtlasJourneyState>(null);
  const [finishedTitle, setFinishedTitle] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const chooser = useRef<HTMLDivElement>(null);
  const swipe = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const current = earthAtlasJourneyStop(state);
  const navigate = (action: EarthAtlasJourneyAction) => {
    const next = transitionEarthAtlasJourney(state, action);
    if (next === state) return;
    if (action.type === "stop") setFinishedTitle(current?.journey.title ?? null);
    else setFinishedTitle(null);
    setState(next);
    const stop = earthAtlasJourneyStop(next);
    if (stop) onFocus(stop.entry);
    // The previous control may disappear on start/end. Return keyboard focus to
    // the new content without scrolling or stealing focus on ordinary renders.
    if (action.type === "start" || action.type === "stop") {
      requestAnimationFrame(() => (next ? heading.current : chooser.current)?.focus({ preventScroll: true }));
    }
  };

  if (!current || !state) return <div className={styles.journeys}>
    <div ref={chooser} tabIndex={-1} className={styles.chooserIntro}>
      <Route size={17} aria-hidden="true" /><span>Выбери короткий маршрут</span>
    </div>
    <p className={styles.hint}>Листай остановки в своём темпе. Открытия отмечаются отдельной кнопкой.</p>
    <ul className={styles.routes} aria-label="Мини-путешествия по атласу" tabIndex={0}>
      {EARTH_ATLAS_JOURNEYS.map(journey => <li key={journey.id} data-accent={journey.accent}>
        <span className={styles.routeCount}>{journey.stops.length} {journey.stops.length === 5 ? "остановок" : "остановки"}</span>
        <strong>{journey.title}</strong><p>{journey.description}</p>
        <button type="button" data-audio-cue="ui.click" aria-label={`Начать маршрут: ${journey.title}`}
          onClick={() => navigate({ type: "start", journeyId: journey.id })}>Начать <ArrowRight size={16} aria-hidden="true" /></button>
      </li>)}
    </ul>
    {finishedTitle && <p className={styles.finished} role="status">«{finishedTitle}» завершён. Ракурс можно исследовать дальше.</p>}
  </div>;

  const { journey, stop, entry } = current;
  const opened = openedIds.includes(entry.id), centered = earthAtlasCandidate(view)?.id === entry.id;
  const last = state.stopIndex === journey.stops.length - 1;
  return <div className={styles.journeys} data-accent={journey.accent}>
    <span className={styles.srOnly} role="status">Остановка {state.stopIndex + 1} из {journey.stops.length}: {entry.title}</span>
    <div className={styles.activeHeader}>
      <div><span>Мини-путешествие · {state.stopIndex + 1} / {journey.stops.length}</span><strong>{journey.title}</strong></div>
      <button type="button" data-audio-cue="ui.close" aria-label="Закончить маршрут" title="Закончить маршрут"
        onClick={() => navigate({ type: "stop" })}><X size={18} aria-hidden="true" /></button>
    </div>
    <ol className={styles.steps} aria-label="Остановки маршрута">
      {journey.stops.map((item, index) => {
        const target = earthAtlasEntry(item.entryId);
        return <li key={item.entryId}><button type="button" data-audio-cue="ui.click"
          aria-current={state.stopIndex === index ? "step" : undefined} aria-label={`Остановка ${index + 1}: ${target?.title ?? "Место"}`}
          onClick={() => navigate({ type: "select", stopIndex: index })}><span>{openedIds.includes(item.entryId) ? <Check size={15} aria-hidden="true" /> : index + 1}</span></button></li>;
      })}
    </ol>
    <article className={styles.stop} aria-label={`Текущая остановка: ${entry.title}`}
      onPointerDown={event => {
        if (event.pointerType === "mouse" || (event.target instanceof Element && event.target.closest("button"))) return;
        swipe.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      }}
      onPointerCancel={() => { swipe.current = null; }}
      onPointerUp={event => {
        const start = swipe.current;
        swipe.current = null;
        if (!start || start.pointerId !== event.pointerId) return;
        const dx = event.clientX - start.x, dy = event.clientY - start.y;
        if (Math.abs(dx) >= 40 && Math.abs(dx) > Math.abs(dy) * 1.5) navigate({ type: dx < 0 ? "next" : "previous" });
      }}>
      <div className={styles.stopHeading}>
        <h3 ref={heading} tabIndex={-1}><button type="button" data-audio-cue="ui.click" aria-label={`Показать остановку: ${entry.title}`}
          onClick={() => onFocus(entry)}><Compass size={17} aria-hidden="true" /><span>{entry.title}</span></button></h3>
        <span>{entry.subtitle}</span>
      </div>
      <p>{stop.note}</p>
      <div className={styles.discovery}>
        <span>{opened ? "Открытие сохранено" : centered ? "Хочешь оставить в атласе?" : "Вернись к остановке, чтобы открыть её"}</span>
        <button type="button" data-audio-cue="ui.click" disabled={!loaded || opened || !centered}
          aria-label={opened ? `${entry.title}: уже в атласе` : `Открыть в атласе: ${entry.title}`}
          onClick={() => { if (loaded && !opened && centered) onDiscover(entry); }}>
          {opened ? <Check size={16} aria-hidden="true" /> : <BookOpen size={16} aria-hidden="true" />}{opened ? "Открыто" : "Открыть"}</button>
      </div>
    </article>
    <p className={styles.swipeHint}>Листай карточку жестом или кнопками</p>
    <div className={styles.navigation}>
      <button type="button" data-audio-cue="ui.click" disabled={state.stopIndex === 0} onClick={() => navigate({ type: "previous" })}><ArrowLeft size={16} aria-hidden="true" />Назад</button>
      <button type="button" data-audio-cue="ui.click" onClick={() => navigate(last ? { type: "stop" } : { type: "next" })}>
        {last ? "Закончить" : "Далее"}{last ? <Check size={16} aria-hidden="true" /> : <ArrowRight size={16} aria-hidden="true" />}</button>
    </div>
  </div>;
}
