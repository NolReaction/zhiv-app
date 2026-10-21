"use client";

import { useState } from "react";
import { Check, ChevronRight, Landmark, Search, Trees, X } from "lucide-react";
import { EARTH_ATLAS_ENTRIES, type EarthAtlasEntry } from "./earth-atlas";
import { EarthAtlasJourneys } from "./earth-atlas-journey-panel";
import type { EarthAtlasJourneyState } from "./earth-atlas-journeys";
import type { useEarthAtlas } from "./use-earth-atlas";
import styles from "./earth-atlas-panel.module.css";

type Filter = "landmark" | "region" | "journeys";
type Props = {
  atlas: ReturnType<typeof useEarthAtlas>;
  onFocus: (entry: EarthAtlasEntry) => void;
  onStartJourney: (journeyId: string) => void;
  journeyState?: EarthAtlasJourneyState;
  onSelectStop?: (index: number) => void;
  recentDiscoveryId?: string | null;
  initialSection?: "discoveries" | "journeys";
};
const FILTERS = [{ id: "landmark", title: "Места" }, { id: "region", title: "Биомы" }, { id: "journeys", title: "Маршруты" }] as const;
const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase("ru-RU").replaceAll("ё", "е").trim();

/** A catalogue chooses a view. Only the separate explorer can save a discovery. */
export function EarthAtlasPanel({ atlas, onFocus, onStartJourney, journeyState = null, onSelectStop,
  recentDiscoveryId, initialSection = "discoveries" }: Props) {
  const [filter, setFilter] = useState<Filter>(initialSection === "journeys" ? "journeys" : "landmark");
  const [query, setQuery] = useState("");
  const opened = new Set(atlas.snapshot.ids), search = normalize(query);
  const entries = EARTH_ATLAS_ENTRIES.filter(entry => entry.kind === filter
    && (!search || normalize(`${entry.title} ${entry.subtitle}`).includes(search)));

  return <section className={styles.atlas} aria-label="Каталог атласа" data-earth-atlas-catalog>
    <label className={styles.search}><Search size={17} aria-hidden="true" /><span className={styles.srOnly}>Поиск по атласу</span>
      <input type="search" value={query} maxLength={100} autoComplete="off" placeholder={filter === "journeys" ? "Маршрут или остановка" : "Название места или биома"}
        onChange={event => setQuery(event.target.value)} />
      {query && <button type="button" aria-label="Очистить поиск" onClick={() => setQuery("")}><X size={16} aria-hidden="true" /></button>}
    </label>
    <div className={styles.filters} role="group" aria-label="Что показать в атласе">
      {FILTERS.map(item => <button type="button" key={item.id} data-audio-cue="ui.click" aria-pressed={filter === item.id}
        onClick={() => setFilter(item.id)}>{item.title}</button>)}
    </div>
    <div className={styles.results} key={filter}>
      {filter === "journeys" ? <EarthAtlasJourneys query={query} openedIds={atlas.snapshot.ids} journeyState={journeyState}
        onStartJourney={onStartJourney} onSelectStop={onSelectStop} /> : <>
        <ul className={styles.entries} aria-label={filter === "landmark" ? "Места на глобусе" : "Биомы на глобусе"}>
          {entries.map(entry => {
            const Icon = entry.kind === "landmark" ? Landmark : Trees;
            return <li key={entry.id} data-recent={recentDiscoveryId === entry.id || undefined}>
              <button type="button" data-audio-cue="ui.click" onClick={() => onFocus(entry)}
                aria-label={`${entry.title}: ${opened.has(entry.id) ? "сохранено в атласе" : "показать на карте"}`}>
                <span className={styles.icon} data-biome={entry.biome}><Icon size={20} aria-hidden="true" /></span>
                <span className={styles.identity}><strong>{entry.title}</strong><small>{entry.subtitle}</small></span>
                {opened.has(entry.id) ? <Check size={17} className={styles.opened} aria-hidden="true" /> : <ChevronRight size={17} aria-hidden="true" />}
              </button>
            </li>;
          })}
        </ul>
        {entries.length === 0 && <p className={styles.empty} role="status">Ничего не найдено. Попробуй другое название.</p>}
        <p className={styles.hint}>Выбери место, чтобы рассмотреть его на карте. Встреча с близким отмечается через значок друга.</p>
      </>}
      <p className={styles.storage} role="status">{!atlas.snapshot.loaded ? "Загружаем сохранённые открытия…" : atlas.snapshot.persistent
        ? "Сохраняется на этом устройстве. Это не отметки о поездках."
        : "Хранилище недоступно. Открытия останутся до закрытия карты."}</p>
    </div>
  </section>;
}
