"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { BookOpen, Check, ChevronLeft, ChevronRight, Fish, Mountain, Trees } from "lucide-react";
import { CollectionIcon, ItemIcon } from "@/features/items/item-icon";
import { HiddenFishIcon } from "@/features/economy/fish-discovery";
import { FishRarityBadge, FishRarityScale } from "@/features/economy/fish-rarity";
import type { EconomyView } from "@/features/economy/model";
import { worldCatalog, type WorldState } from "./model";
import { BOOK_COLLECTION_COUNT, COLLECTION_CHAPTERS, collectionBookEntries, collectionBookProgress, type CollectionChapter } from "./collection-book";
import styles from "./world-collections.module.css";

const chapterIcons = { travel: Trees, fishing: Fish, quarry: Mountain };
const hours = (seconds: number) => new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(seconds / 3600);

export function WorldCollections({ state, economy, gifts }: { state: WorldState; economy?: EconomyView | null; gifts: readonly string[] }) {
  const [chapter, setChapter] = useState<CollectionChapter>("travel");
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const entries = collectionBookEntries(chapter, state.collection, economy);
  const found = entries.filter(entry => entry.owned).length;
  const progress = collectionBookProgress(chapter, economy);
  const index = COLLECTION_CHAPTERS.findIndex(entry => entry.id === chapter);
  const active = COLLECTION_CHAPTERS[index];
  const total = COLLECTION_CHAPTERS.reduce((sum, entry) => sum + collectionBookEntries(entry.id, state.collection, economy).filter(find => find.owned).length, 0);
  const legacyRiverFinds = worldCatalog.finds.filter(find => find.group === "fishing" && state.collection.includes(find.id));
  const onChapterKey = (event: KeyboardEvent<HTMLButtonElement>, position: number) => {
    const next = event.key === "ArrowRight" ? (position + 1) % COLLECTION_CHAPTERS.length
      : event.key === "ArrowLeft" ? (position + COLLECTION_CHAPTERS.length - 1) % COLLECTION_CHAPTERS.length
        : event.key === "Home" ? 0 : event.key === "End" ? COLLECTION_CHAPTERS.length - 1 : null;
    if (next == null) return;
    event.preventDefault(); setChapter(COLLECTION_CHAPTERS[next].id); buttons.current[next]?.focus();
  };
  return <section className={styles.library} aria-label="Книга коллекций">
    <header className={styles.heading}><BookOpen size={22} aria-hidden="true" /><div><span>НАХОДКИ И ЗНАКОМСТВА</span><h2>Книга коллекций</h2></div><strong>{total}/{BOOK_COLLECTION_COUNT}</strong></header>
    <p className={styles.intro}>Записи о находках и собственном улове остаются навсегда. Продажа рыбы и материалов их не стирает.</p>
    <div className={styles.chapters} role="tablist" aria-label="Главы книги">{COLLECTION_CHAPTERS.map((entry, position) => {
      const Icon = chapterIcons[entry.id];
      return <button key={entry.id} type="button" ref={button => { buttons.current[position] = button; }} role="tab"
        id={`collection-tab-${entry.id}`} aria-controls={`collection-page-${entry.id}`} aria-selected={chapter === entry.id}
        tabIndex={chapter === entry.id ? 0 : -1} onClick={() => setChapter(entry.id)} onKeyDown={event => onChapterKey(event, position)}>
        <Icon size={17} aria-hidden="true" />{entry.title}
      </button>;
    })}</div>
    <div className={styles.book}>
      <div className={styles.page} role="tabpanel" id={`collection-page-${chapter}`} aria-labelledby={`collection-tab-${chapter}`}>
        <div className={styles.pageHeading}><span>ГЛАВА {index + 1} · {active.subtitle}</span><h3>{active.title}<small>{found}/{entries.length}</small></h3></div>
        {found === entries.length ? <p className={styles.complete}><Check size={16} aria-hidden="true" />Глава завершена. Все знакомства сохранены.</p>
          : progress ? <div className={styles.progress}><p>Новая находка за каждые {hours(progress.seconds)} ч завершённых работ.</p><progress value={progress.completed} max={progress.seconds} aria-label={`До следующей находки: зачтено ${hours(progress.completed)} из ${hours(progress.seconds)} часов`} /><small>До следующей находки: {hours(progress.seconds - progress.completed)} ч работы. Заберите результат, чтобы время зачлось.</small></div>
            : <p className={styles.rule}>Каждый вид открывается после полученного улова. Покупка рыбы в лавке или на рынке главу не заполняет.</p>}
        {chapter === "travel" && <p className={styles.sources}>Лесная разведка, Лесной обход, Старый лес и Лесное нагорье.</p>}
        {chapter === "quarry" && <p className={styles.sources}>Заказы шахты, Вход в пещеру, Глубокий проход, Прибрежные отложения и Заброшенный карьер.</p>}
        {chapter === "fishing" && <FishRarityScale />}
        <div className={styles.finds}>{entries.map(entry => <article className={styles.find} key={entry.id} data-owned={entry.owned}>
          <div className={styles.art}>{entry.illustration === "item" ? entry.owned ? <ItemIcon itemId={entry.id} size={64} /> : <HiddenFishIcon size={64} /> : <CollectionIcon findId={entry.id} size={64} />}{entry.owned ? <Check size={15} aria-label="Найдено" /> : <span aria-hidden="true">?</span>}</div>
          <h4>{entry.illustration === "item" && !entry.owned ? "Неизвестная рыба" : entry.name}</h4>{entry.rarity && <FishRarityBadge rarity={entry.rarity} />}<p>{entry.owned ? entry.description : entry.source}</p><small>{entry.owned ? "Записано в книге" : "Ещё не найдено"}</small>
        </article>)}</div>
        {chapter === "fishing" && legacyRiverFinds.length > 0 && <details className={styles.archive}><summary>Прежние речные находки · {legacyRiverFinds.length}/6</summary><p>Ваши находки из прежних путешествий сохранены.</p><div>{legacyRiverFinds.map(find => <span key={find.id}><CollectionIcon findId={find.id} size={30} />{find.name}</span>)}</div></details>}
        <footer className={styles.footer}><button type="button" disabled={index === 0} onClick={() => setChapter(COLLECTION_CHAPTERS[index - 1].id)} aria-label="Предыдущая глава"><ChevronLeft size={16} />Назад</button><span>{index + 1} / {COLLECTION_CHAPTERS.length}</span><button type="button" disabled={index === COLLECTION_CHAPTERS.length - 1} onClick={() => setChapter(COLLECTION_CHAPTERS[index + 1].id)} aria-label="Следующая глава">Далее<ChevronRight size={16} /></button></footer>
      </div>
    </div>
    {(state.inventory.includes("explorer_cap") || state.inventory.includes("willow_rod") || gifts.length > 0) && <p className={styles.kept}>Полученную раньше одежду можно надеть в гардеробе. Ваши прежние удочки и подарки сохранены.</p>}
  </section>;
}
