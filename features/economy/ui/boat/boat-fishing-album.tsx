"use client";

import { useState } from "react";
import { BookOpen, Fish, LockKeyhole, Trophy } from "lucide-react";
import type { EconomyView } from "@/features/economy/domain/model";
import { ItemIcon } from "@/features/items/item-icon";
import { boatAlbumEntries } from "./boat-catch-presentation";
import { boatFishWeightLabel } from "./boat-panels";
import styles from "./boat-fishing-album.module.css";

const rarityLabels = { common: "Обычная", uncommon: "Необычная", rare: "Редкая", epic: "Эпическая", legendary: "Легендарная" } as const;
const filters = [{ id: "all", label: "Все" }, { id: "found", label: "Найденные" }, { id: "unknown", label: "Неизвестные" }] as const;
type Filter = typeof filters[number]["id"];

/** The album reads confirmed catches and permanent server history; it never writes discoveries. */
export function BoatFishingAlbum({ state }: { state: EconomyView }) {
  const [filter, setFilter] = useState<Filter>("all");
  const entries = boatAlbumEntries(state);
  const found = entries.filter(entry => entry.discovered).length;
  const visible = entries.filter(entry => filter === "all" || (filter === "found" ? entry.discovered : !entry.discovered));
  return <section className={styles.album} data-fishing-album aria-label="Коллекция рыб">
    <header className={styles.summary}><span className={styles.seal}><BookOpen size={25} /></span><div><span className={styles.eyebrow}>Речной дневник</span><h3>{found} из {entries.length} видов</h3><p>Каждая находка — новая страница.</p></div></header>
    <progress className={styles.collectionProgress} value={found} max={Math.max(1, entries.length)} aria-label="Открытые виды рыб" />
    <div className={styles.filters} aria-label="Показать виды">{filters.map(entry => <button key={entry.id} type="button" aria-pressed={filter === entry.id} onClick={() => setFilter(entry.id)}>{entry.label}</button>)}</div>
    <div className={styles.pages}>{visible.map(entry => <article key={entry.fishId} className={styles.entry} data-album-fish={entry.fishId} data-discovered={entry.discovered} data-rarity={entry.rarity}>
      <span className={`${styles.portrait} ${entry.discovered ? "" : styles.silhouette}`} aria-hidden="true"><ItemIcon itemId={entry.fishId} size={72} />{!entry.discovered && <LockKeyhole className={styles.lock} size={16} />}</span>
      <div className={styles.description}><span className={styles.rarity}>{rarityLabels[entry.rarity]}</span><h4>{entry.discovered ? entry.name : "Неизвестная рыба"}</h4>
        <p>{entry.discovered ? entry.description : "Её силуэт уже ждёт в дневнике. Найдите этот вид на рыбалке."}</p>
        {entry.discovered && <div className={styles.stats}><span><Fish size={13} />Поймано: {entry.count}</span>{entry.bestWeightGrams > 0 ? <span><Trophy size={13} />{boatFishWeightLabel(entry.bestWeightGrams)}</span> : <span>Вес ещё не записан</span>}</div>}
        {entry.onBoardCount > 0 && <small className={styles.onBoard}>На борту · {entry.onBoardCount}. Разгрузите у причала.</small>}
      </div>
    </article>)}</div>
    {visible.length === 0 && <p className={styles.empty}>{filter === "found" ? "Первые страницы ещё впереди. Поймайте рыбу, чтобы открыть её рисунок." : "Все виды найдены. Осталось побить личные рекорды!"}</p>}
    <p className={styles.note}>Доставленные виды остаются в альбоме после продажи и готовки. Улов на борту отмечен отдельно.</p>
  </section>;
}
