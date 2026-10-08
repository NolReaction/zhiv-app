"use client";

import { useId, useRef, useState } from "react";
import { Anchor, BookOpen, Bug, Check, ChevronLeft, ChevronRight, Fish, FishingRod } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { FishingRodIcon } from "@/features/world/activities/fishing/fishing-rod-icon";
import type { EconomyView } from "@/features/economy/domain/model";
import { fishingState } from "@/features/economy/domain/fishing";
import { HiddenFishIcon, PlayerItemIcon } from "./fish-discovery";
import { FishRarityBadge } from "./fish-rarity";
import { itemName, number } from "@/features/economy/ui/shared/world-economy-parts";
import styles from "./plesk-fishing-book.module.css";

type FishingCatalog = NonNullable<EconomyView["catalog"]["fishing"]>;
type BookProps = { state: EconomyView; catalog: FishingCatalog };
export type FishingBookChapter = "fish" | "rods" | "hooks" | "baits";
type BookEntry = { id: string; name: string; known: boolean; rarity: FishingCatalog["fish"][number]["rarity"]; status: string; description?: string };
export const FISHING_BOOK_PAGE_SIZE = 6;
const chapters = [
  { id: "fish", name: "Рыбы", icon: Fish, title: "Рыбацкая коллекция", progress: "Виды рыб", note: "Забирайте улов, чтобы открывать виды. Проданная рыба остаётся в коллекции." },
  { id: "rods", name: "Удочки", icon: FishingRod, title: "Мои удочки", progress: "Собрано удочек", note: "У каждой удочки свой характер. Выбирайте снасти перед рыбалкой." },
  { id: "hooks", name: "Снасти", icon: Anchor, title: "Мои крючки", progress: "Собрано крючков", note: "Небольшая деталь для большого улова. Крючки остаются с вами навсегда." },
  { id: "baits", name: "Наживки", icon: Bug, title: "Запас наживок", progress: "Видов в запасе", note: "Здесь ваш текущий запас. На одну рыбалку расходуется одна наживка." },
] as const;

/** Gear comes from permanent ownership; bait reflects current stock, not invented discovery history. */
export function fishingBookEntries(state: EconomyView, catalog: FishingCatalog, chapter: FishingBookChapter): BookEntry[] {
  const gear = fishingState(state);
  if (chapter === "fish") return catalog.fish.map(fish => {
    const caught = gear.catches[fish.itemId] ?? 0;
    return { id: fish.itemId, name: caught > 0 ? itemName(state, fish.itemId) : "Неизвестная рыба", known: caught > 0,
      rarity: fish.rarity, status: caught > 0 ? `Поймано: ${number(caught)}` : "Пока скрыта" };
  });
  if (chapter === "baits") return catalog.baits.map(bait => {
    const stock = state.inventory[bait.itemId] ?? 0;
    return { id: bait.itemId, name: stock > 0 ? itemName(state, bait.itemId) : "Неизвестная наживка", known: stock > 0,
      rarity: bait.rarity, status: stock > 0 ? `В запасе: ${number(stock)}` : "Нет в запасе", description: stock > 0 ? bait.description : undefined };
  });
  const owned = chapter === "rods" ? gear.ownedRods : gear.ownedHooks;
  return (chapter === "rods" ? catalog.rods : catalog.hooks).map(entry => ({ id: entry.id,
    name: owned.includes(entry.id) ? entry.name : chapter === "rods" ? "Неизвестная удочка" : "Неизвестная снасть",
    known: owned.includes(entry.id), rarity: entry.rarity, status: owned.includes(entry.id) ? "В коллекции" : "Ещё не найдена",
    description: owned.includes(entry.id) ? entry.description : undefined,
  }));
}

export function fishingBookPage(entries: BookEntry[], requestedPage: number) {
  const pages = Math.max(1, Math.ceil(entries.length / FISHING_BOOK_PAGE_SIZE));
  const page = Math.min(pages - 1, Math.max(0, Number.isFinite(requestedPage) ? Math.trunc(requestedPage) : 0));
  return { page, pages, entries: entries.slice(page * FISHING_BOOK_PAGE_SIZE, (page + 1) * FISHING_BOOK_PAGE_SIZE) };
}

function HiddenGearIcon({ chapter }: { chapter: FishingBookChapter }) {
  const Icon = chapter === "rods" ? FishingRod : chapter === "hooks" ? Anchor : Bug;
  return <span className={styles.hiddenGear} data-hidden-gear="true" aria-hidden="true"><Icon size={44} /><span>?</span></span>;
}

export function PleskFishingBookPage({ state, catalog, chapter, page = 0 }: BookProps & { chapter: FishingBookChapter; page?: number }) {
  const visible = fishingBookPage(fishingBookEntries(state, catalog, chapter), page);
  return <div className={styles.specimens} aria-label={chapters.find(entry => entry.id === chapter)!.title}>
    {visible.entries.map(entry => <article key={entry.id} className={styles.specimen} data-discovered={entry.known} data-book-entry={entry.id}>
      <div className={styles.art} data-gear-rarity={entry.rarity}>
        {chapter === "fish" ? entry.known ? <PlayerItemIcon state={state} itemId={entry.id} size={52} /> : <HiddenFishIcon size={52} />
          : !entry.known ? <HiddenGearIcon chapter={chapter} /> : chapter === "rods" ? <FishingRodIcon rodId={entry.id} size={52} /> : <ItemIcon itemId={entry.id} size={46} />}
        {entry.known && chapter !== "fish" && chapter !== "baits" && <Check size={13} className={styles.collected} aria-hidden="true" />}
      </div>
      <h3>{entry.name}</h3><FishRarityBadge rarity={entry.rarity} /><p>{entry.status}</p>
      {entry.description && <details className={styles.notes}><summary>Особенности</summary><p>{entry.description}</p></details>}
    </article>)}
    {visible.entries.length === 0 && <p className={styles.empty}>Эта глава пока пуста.</p>}
  </div>;
}

export function PleskFishingCollection({ state, catalog }: BookProps) {
  const [chapter, setChapter] = useState<FishingBookChapter>("fish"), [requestedPage, setPage] = useState(0);
  const id = useId(), buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const current = chapters.find(entry => entry.id === chapter)!, entries = fishingBookEntries(state, catalog, chapter);
  const known = entries.filter(entry => entry.known).length, { page, pages } = fishingBookPage(entries, requestedPage);
  function openChapter(next: FishingBookChapter) { setChapter(next); setPage(0); }
  return <section className={styles.book} aria-label="Рыбацкая книга">
    <header className={styles.cover}><BookOpen size={23} aria-hidden="true" /><div><strong>Рыбацкая книга</strong><span>Улов и мои снасти</span></div></header>
    <div className={styles.chapters} role="tablist" aria-label="Главы рыбацкой книги">{chapters.map((entry, index) => {
      const chapterEntries = fishingBookEntries(state, catalog, entry.id), count = chapterEntries.filter(item => item.known).length;
      return <button key={entry.id} type="button" ref={node => { buttons.current[index] = node; }} id={`${id}-${entry.id}`} role="tab" aria-selected={chapter === entry.id}
        aria-controls={`${id}-page`} tabIndex={chapter === entry.id ? 0 : -1} onClick={() => openChapter(entry.id)} onKeyDown={event => {
          let next = index;
          if (event.key === "ArrowRight") next = (index + 1) % chapters.length;
          else if (event.key === "ArrowLeft") next = (index + chapters.length - 1) % chapters.length;
          else if (event.key === "Home") next = 0;
          else if (event.key === "End") next = chapters.length - 1;
          else return;
          event.preventDefault(); openChapter(chapters[next].id); buttons.current[next]?.focus();
        }}><entry.icon size={17} aria-hidden="true" /><span>{entry.name}</span><small>{count} / {chapterEntries.length}</small></button>;
    })}</div>
    <div className={styles.page} role="tabpanel" id={`${id}-page`} aria-labelledby={`${id}-${chapter}`} tabIndex={0}>
      <div className={styles.heading}><h2>{current.title}</h2><span>{current.progress}: {known} / {entries.length}</span></div>
      <progress className={styles.progress} max={Math.max(1, entries.length)} value={known} aria-label={current.progress} />
      <p className={styles.note}>{current.note}</p>
      <PleskFishingBookPage key={`${chapter}-${page}`} state={state} catalog={catalog} chapter={chapter} page={page} />
      <nav className={styles.pagination} aria-label="Страницы главы">
        <button type="button" disabled={page === 0} onClick={() => setPage(page - 1)} aria-label="Предыдущая страница"><ChevronLeft size={20} aria-hidden="true" /></button>
        <span aria-live="polite" aria-atomic="true">Страница {page + 1} из {pages}</span>
        <button type="button" disabled={page + 1 >= pages} onClick={() => setPage(page + 1)} aria-label="Следующая страница"><ChevronRight size={20} aria-hidden="true" /></button>
      </nav>
    </div>
  </section>;
}
