"use client";

import { useRef, useState } from "react";
import { BookOpen, Check, ChevronLeft, ChevronRight, Compass, Handshake, Landmark, Trees } from "lucide-react";
import { EARTH_ATLAS_ENTRIES, earthAtlasCandidate, type EarthAtlasEntry, type EarthAtlasView } from "./earth-atlas";
import type { useEarthAtlas } from "./use-earth-atlas";
import styles from "./earth-atlas-panel.module.css";

type Filter = "all" | "landmark" | "region";
type Props = { atlas: ReturnType<typeof useEarthAtlas>; view: EarthAtlasView | null; onFocus: (entry: EarthAtlasEntry) => void };
const FILTERS = [{ id: "all", title: "Все" }, { id: "landmark", title: "Места" }, { id: "region", title: "Биомы" }] as const;

function EntryIcon({ entry, size = 20 }: { entry: EarthAtlasEntry; size?: number }) {
  const Icon = entry.kind === "landmark" ? Landmark : entry.kind === "meeting" ? Handshake : Trees;
  return <Icon size={size} aria-hidden="true" />;
}

export function EarthAtlasPanel({ atlas, view, onFocus }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const rail = useRef<HTMLUListElement>(null);
  const opened = new Set(atlas.snapshot.ids);
  const candidate = earthAtlasCandidate(view);
  // Keep card positions stable when a discovery is recorded mid-swipe.
  const entries = EARTH_ATLAS_ENTRIES.filter(entry => filter === "all" || entry.kind === filter);
  const scroll = (direction: number) => {
    const target = rail.current;
    if (!target) return;
    const reduced = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    target.scrollBy({ left: direction * Math.max(180, target.clientWidth * 0.85), behavior: reduced ? "instant" : "smooth" });
  };

  return <section className={styles.atlas} aria-label="Личный атлас">
    <div className={styles.intro}><BookOpen size={19} aria-hidden="true" /><strong>Твой атлас</strong>
      <span aria-label={`Открыто ${opened.size} из ${EARTH_ATLAS_ENTRIES.length}`}>{opened.size} / {EARTH_ATLAS_ENTRIES.length}</span></div>
    <p className={styles.explanation}>Исследуй глобус и отмечай открытия. Это просмотр карты, а не отметки о поездках.</p>
    <div className={styles.candidate} aria-live="polite" aria-atomic="true">
      {candidate ? <>
        <span className={styles.candidateIcon}><EntryIcon entry={candidate} /></span>
        <div><strong>{candidate.title}</strong><span>{candidate.subtitle} · в центре карты</span></div>
        <button type="button" data-audio-cue="ui.click" disabled={!atlas.snapshot.loaded || opened.has(candidate.id)}
          aria-label={opened.has(candidate.id) ? `${candidate.title}: уже в атласе` : `Открыть в атласе: ${candidate.title}`}
          onClick={() => atlas.discover(candidate.id)}>
          {opened.has(candidate.id) ? <Check size={18} aria-hidden="true" /> : <BookOpen size={18} aria-hidden="true" />}
          <span>{opened.has(candidate.id) ? "Открыто" : "Открыть"}</span>
        </button>
      </> : <><Compass size={22} aria-hidden="true" /><p>Выбери место в ленте или приблизь регион в центре карты, чтобы открыть его.</p></>}
    </div>
    <div className={styles.toolbar}>
      <div className={styles.filters} role="group" aria-label="Что показать в атласе">
        {FILTERS.map(item => <button type="button" key={item.id} data-audio-cue="ui.click" aria-pressed={filter === item.id}
          onClick={() => { setFilter(item.id); rail.current?.scrollTo({ left: 0, behavior: "instant" }); }}>{item.title}</button>)}
      </div>
      <div className={styles.arrows}>
        <button type="button" aria-label="Предыдущие открытия" data-audio-cue="ui.click" onClick={() => scroll(-1)}><ChevronLeft size={18} aria-hidden="true" /></button>
        <button type="button" aria-label="Следующие открытия" data-audio-cue="ui.click" onClick={() => scroll(1)}><ChevronRight size={18} aria-hidden="true" /></button>
      </div>
    </div>
    <ul ref={rail} className={styles.rail} aria-label="Открытия на глобусе" tabIndex={0}>
      {entries.map(entry => <li key={entry.id} className={styles.card} data-opened={opened.has(entry.id) || undefined} data-kind={entry.kind}>
        <button type="button" disabled={!entry.center} data-audio-cue="ui.click" onClick={() => { if (entry.center) onFocus(entry); }}
          aria-label={`${entry.title}: ${opened.has(entry.id) ? "открыто" : "ещё не открыто"}${entry.center ? ", показать на карте" : ""}`}>
          <span className={styles.art} data-biome={entry.biome}><EntryIcon entry={entry} size={26} />
            {opened.has(entry.id) && <span className={styles.badge}><Check size={13} aria-hidden="true" /></span>}</span>
          <strong>{entry.title}</strong><span className={styles.subtitle}>{entry.subtitle}</span>
          <span className={styles.cardAction}>{entry.kind === "meeting" ? opened.has(entry.id) ? "Встреча отмечена" : "Отметь через значок друга" : "Показать на карте"}</span>
        </button>
      </li>)}
    </ul>
    <p className={styles.storage} role="status">{!atlas.snapshot.loaded ? "Загружаем атлас…" : atlas.snapshot.persistent
      ? "Атлас сохраняется на этом устройстве."
      : "Хранилище недоступно. Открытия останутся до закрытия этой карты."}</p>
  </section>;
}
