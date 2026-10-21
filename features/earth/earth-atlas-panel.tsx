"use client";

import { useState } from "react";
import { Check, ChevronRight, Landmark, Search, X } from "lucide-react";
import type { EarthAtlasEntry } from "./earth-atlas";
import { earthAtlasPlaceProgress, earthAtlasPlaces } from "./earth-atlas-visible";
import type { useEarthAtlas } from "./use-earth-atlas";
import styles from "./earth-atlas-panel.module.css";

type Props = {
  atlas: ReturnType<typeof useEarthAtlas>;
  onFocus: (entry: EarthAtlasEntry) => void;
  recentDiscoveryId?: string | null;
};

/** A small place catalogue chooses a view; saving belongs to its map card. */
export function EarthAtlasPanel({ atlas, onFocus, recentDiscoveryId }: Props) {
  const [query, setQuery] = useState("");
  const opened = new Set(atlas.snapshot.ids), entries = earthAtlasPlaces(query);
  const progress = earthAtlasPlaceProgress(atlas.snapshot.ids);

  return <section className={styles.atlas} aria-label="Каталог атласа" data-earth-atlas-catalog>
    <label className={styles.search}><Search size={17} aria-hidden="true" /><span className={styles.srOnly}>Поиск по атласу</span>
      <input type="search" value={query} maxLength={100} autoComplete="off" placeholder="Название места"
        onChange={event => setQuery(event.target.value)} />
      {query && <button type="button" aria-label="Очистить поиск" onClick={() => setQuery("")}><X size={16} aria-hidden="true" /></button>}
    </label>
    <div className={styles.results}>
      <ul className={styles.entries} aria-label="Места на глобусе">
        {entries.map(entry => <li key={entry.id} data-recent={recentDiscoveryId === entry.id || undefined}>
          <button type="button" data-audio-cue="ui.click" onClick={() => onFocus(entry)}
            aria-label={`${entry.title}: ${opened.has(entry.id) ? "сохранено в атласе" : "показать на карте"}`}>
            <span className={styles.icon}><Landmark size={19} aria-hidden="true" /></span>
            <span className={styles.identity}><strong>{entry.title}</strong></span>
            {opened.has(entry.id) ? <Check size={17} className={styles.opened} aria-hidden="true" /> : <ChevronRight size={17} aria-hidden="true" />}
          </button>
        </li>)}
      </ul>
      {entries.length === 0 && <p className={styles.empty} role="status">Ничего не найдено. Попробуй другое название.</p>}
      <p className={styles.hint}>Выбери место, чтобы рассмотреть его на карте. Встреча с близким отмечается через значок друга.</p>
      {progress.otherSaved > 0 && <p className={styles.storage}>Ранние отметки: {progress.otherSaved}.</p>}
      <p className={styles.storage} role="status">{!atlas.snapshot.loaded ? "Загружаем сохранённые открытия…" : atlas.snapshot.persistent
        ? "Сохраняется на этом устройстве. Это не отметки о поездках."
        : "Хранилище недоступно. Открытия останутся до закрытия карты."}</p>
    </div>
  </section>;
}
