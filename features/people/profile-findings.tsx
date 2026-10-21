"use client";

import { useId, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight, Fish, Mountain, Trees } from "lucide-react";
import { CollectionIcon, ItemIcon } from "@/features/items/item-icon";
import { COLLECTION_CHAPTERS, type CollectionChapter } from "@/features/world/domain/collection-book";
import { worldCatalog } from "@/features/world/domain/model";
import { collectionCatalog } from "@/features/world/domain/collection-book";
import { economyCatalog } from "@/features/economy/domain/model";
import type { GuestProfile } from "./guest-profile-model";
import styles from "./profile-findings.module.css";

const names = new Map([...worldCatalog.finds, ...collectionCatalog.quarry.finds, ...economyCatalog.items].map(item => [item.id, item.name]));
const icons = { travel: Trees, fishing: Fish, quarry: Mountain };
const titles = { travel: "Походы", fishing: "Рыбалка", quarry: "Шахта" };

function FindingsTrack({ chapter, finds }: { chapter: CollectionChapter; finds: readonly string[] }) {
  const track = useRef<HTMLUListElement>(null);
  const [index, setIndex] = useState(0);
  const id = useId();
  const current = Math.min(index, Math.max(0, finds.length - 1));
  const move = (next: number) => {
    const list = track.current;
    if (!list || !list.children.length) return;
    const target = Math.max(0, Math.min(finds.length - 1, next));
    const item = list.children[target] as HTMLElement;
    const first = list.children[0] as HTMLElement;
    list.scrollTo({ left: item.offsetLeft - first.offsetLeft,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  const onKey = (event: KeyboardEvent<HTMLUListElement>) => {
    const next = event.key === "ArrowLeft" ? current - 1 : event.key === "ArrowRight" ? current + 1
      : event.key === "Home" ? 0 : event.key === "End" ? finds.length - 1 : null;
    if (next === null) return;
    event.preventDefault(); move(next);
  };
  return <>
    {finds.length === 0 ? <p className={styles.empty}>В этой главе пока нет находок.</p> : <>
      <ul ref={track} id={id} className={styles.track} tabIndex={0} aria-label="Находки — листайте влево и вправо"
        onKeyDown={onKey} onScroll={event => {
          const list = event.currentTarget, first = list.children[0] as HTMLElement;
          if (!first) return;
          const positions = Array.from(list.children, child => Math.abs((child as HTMLElement).offsetLeft - first.offsetLeft - list.scrollLeft));
          setIndex(positions.indexOf(Math.min(...positions)));
        }}>
        {finds.map(find => <li key={find} className={styles.card}>
          {chapter === "fishing" ? <ItemIcon itemId={find} size={52} /> : <CollectionIcon findId={find} size={52} />}
          <span>{names.get(find) ?? find}</span>
        </li>)}
      </ul>
      <div className={styles.navigation}>
        <button type="button" aria-label="Предыдущая находка" aria-controls={id} disabled={current === 0} onClick={() => move(current - 1)}><ChevronLeft size={17} aria-hidden="true" /></button>
        <span aria-live="polite">{current + 1} / {finds.length}</span>
        <button type="button" aria-label="Следующая находка" aria-controls={id} disabled={current >= finds.length - 1} onClick={() => move(current + 1)}><ChevronRight size={17} aria-hidden="true" /></button>
      </div>
    </>}
  </>;
}

/** Native horizontal scrolling keeps touch gestures and the surrounding page independent. */
export function ProfileFindings({ collections }: { collections: GuestProfile["collections"] }) {
  const [chapter, setChapter] = useState<CollectionChapter>("travel");
  return <section className={styles.findings} aria-label="Коллекции друга">
    <h4>Книга находок</h4>
    <div className={styles.filters} role="group" aria-label="Главы находок">
      {COLLECTION_CHAPTERS.map(entry => {
        const Icon = icons[entry.id];
        return <button type="button" key={entry.id} aria-pressed={chapter === entry.id} aria-label={`${entry.title}: ${collections[entry.id].length} находок`} onClick={() => setChapter(entry.id)}>
          <Icon size={15} aria-hidden="true" /><span>{titles[entry.id]}</span><small>{collections[entry.id].length}</small>
        </button>;
      })}
    </div>
    <FindingsTrack key={`${chapter}:${collections[chapter].join(",")}`} chapter={chapter} finds={collections[chapter]} />
  </section>;
}
