"use client";

import { ArrowRight, Check, Info, Route } from "lucide-react";
import { earthAtlasEntry } from "./earth-atlas";
import { EARTH_ATLAS_JOURNEYS, earthAtlasJourneyStop, type EarthAtlasJourneyState } from "./earth-atlas-journeys";
import styles from "./earth-atlas-journeys.module.css";

type Props = {
  openedIds: readonly string[];
  onStartJourney: (journeyId: string) => void;
  journeyState?: EarthAtlasJourneyState;
  onSelectStop?: (index: number) => void;
  query?: string;
};
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();

/** Stateless selection only: the explorer owns the active stop outside this catalogue. */
export function EarthAtlasJourneys({ openedIds, onStartJourney, journeyState = null, onSelectStop, query = "" }: Props) {
  const current = earthAtlasJourneyStop(journeyState), search = normalize(query);
  const routes = EARTH_ATLAS_JOURNEYS.filter(journey => !search || normalize(`${journey.title} ${journey.description}`).includes(search)
    || journey.stops.some(stop => { const entry = earthAtlasEntry(stop.entryId); return entry && normalize(`${entry.title} ${entry.subtitle}`).includes(search); }));
  const stops = current?.journey.stops.map((stop, index) => ({ stop, index, entry: earthAtlasEntry(stop.entryId) }))
    .filter(item => item.entry && (!search || normalize(`${item.entry.title} ${item.entry.subtitle} ${current.journey.title}`).includes(search))) ?? [];

  return <div className={styles.journeys}>
    {current && onSelectStop && <section className={styles.active} aria-label="Остановки текущего маршрута">
      <details className={styles.note} key={`${current.journey.id}:${current.stopIndex}`}>
        <summary aria-label={`Заметка об остановке: ${current.entry.title}`}><span className={styles.heading}><span>Текущий маршрут</span><strong>{current.journey.title}</strong></span><Info size={18} aria-hidden="true" /></summary>
        <p><strong>{current.entry.title}</strong>{current.stop.note}</p>
      </details>
      <ol className={styles.stops} aria-label="Выбрать остановку маршрута">{stops.map(({ index, entry }) => entry && <li key={`${current.journey.id}:${index}`}>
        <button type="button" data-audio-cue="ui.click" aria-current={journeyState?.stopIndex === index ? "step" : undefined}
          aria-label={`Остановка ${index + 1}: ${entry.title}`} onClick={() => onSelectStop(index)}>
          <span className={styles.index}>{openedIds.includes(entry.id) ? <Check size={14} aria-hidden="true" /> : index + 1}</span>
          <span className={styles.identity}><strong>{entry.title}</strong><small>{entry.subtitle}</small></span>
          {journeyState?.stopIndex === index && <span className={styles.current}>Сейчас</span>}
        </button>
      </li>)}</ol>
      {stops.length === 0 && <p className={styles.hint}>Таких остановок в текущем маршруте нет.</p>}
    </section>}
    <ul className={styles.routes} aria-label="Мини-путешествия по атласу">{routes.map(journey => <li key={journey.id} data-accent={journey.accent}>
      <button type="button" data-audio-cue="ui.click" aria-label={`Начать маршрут: ${journey.title}`} onClick={() => onStartJourney(journey.id)}>
        <span className={styles.routeIcon}><Route size={20} aria-hidden="true" /></span>
        <span className={styles.identity}><strong>{journey.title}</strong><small>{journey.stops.length} остановок · {journey.description}</small></span>
        <ArrowRight size={17} aria-hidden="true" />
      </button>
    </li>)}</ul>
    {routes.length === 0 && <p className={styles.hint} role="status">Маршрут не найден. Попробуй другое название.</p>}
    <p className={styles.hint}>Выбери маршрут и рассматривай места в своём темпе. Сохранение каждого открытия — отдельной кнопкой на карте.</p>
  </div>;
}
