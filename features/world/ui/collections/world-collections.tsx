"use client";

import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { useRef, useState, type KeyboardEvent } from "react";
import { BookOpen, Check, ChevronLeft, ChevronRight, Fish, Mountain, Trees } from "lucide-react";
import { CollectionIcon, ItemIcon } from "@/features/items/item-icon";
import { HiddenFishIcon } from "@/features/economy/ui/fishing/fish-discovery";
import { FishRarityBadge, FishRarityScale } from "@/features/economy/ui/fishing/fish-rarity";
import type { EconomyView } from "@/features/economy/domain/model";
import { worldCatalog, type WorldState } from "@/features/world/domain/model";
import { BOOK_COLLECTION_COUNT, COLLECTION_CHAPTERS, collectionBookEntries, collectionBookProgress, type CollectionChapter } from "@/features/world/domain/collection-book";
import { collectionBookPage, type CollectionBookFilter } from "./collection-book-page";
import styles from "./world-collections.module.css";

const chapterIcons = { travel: Trees, fishing: Fish, quarry: Mountain };
const hours = (seconds: number) => new Intl.NumberFormat("ru", { maximumFractionDigits: 1 }).format(seconds / 3600);
type BookEntry = ReturnType<typeof collectionBookEntries>[number];

export function CollectionBookFinds({ entries, filter, page, onFilterChange, onPageChange }: {
  entries: readonly BookEntry[]; filter: CollectionBookFilter; page: number;
  onFilterChange: (filter: CollectionBookFilter) => void; onPageChange: (page: number) => void;
}) {
  const visible = collectionBookPage(entries, filter, page);
  return <>
    <label className={styles.filter}>Показать<select aria-label="Показать находки" value={filter}
      onChange={event => onFilterChange(event.target.value as CollectionBookFilter)}>
      <option value="all">Все находки</option><option value="owned">Открытые</option><option value="missing">Не открытые</option>
    </select><span>{visible.count}</span></label>
    {visible.count > 0 ? <div className={styles.finds} role="list" aria-label="Находки на странице">{visible.entries.map(entry => <article role="listitem" className={styles.find} key={entry.id} data-owned={entry.owned}>
      <div className={styles.art}>{entry.illustration === "item" ? entry.owned ? <ItemIcon itemId={entry.id} size={64} /> : <HiddenFishIcon size={64} /> : <CollectionIcon findId={entry.id} size={64} />}{entry.owned ? <Check size={15} aria-label="Найдено" /> : <span aria-hidden="true">?</span>}</div>
      <h4>{entry.illustration === "item" && !entry.owned ? "Неизвестная рыба" : entry.name}</h4>{entry.rarity && <FishRarityBadge rarity={entry.rarity} />}<p>{entry.owned ? entry.description : entry.source}</p><small>{entry.owned ? "Записано в книге" : "Ещё не найдено"}</small>
    </article>)}</div> : <p className={styles.empty} role="status">{filter === "owned" ? "В этой главе пока нет открытых находок." : filter === "missing" ? "Все находки главы уже открыты." : "В этой главе пока нет находок."}</p>}
    <nav className={styles.footer} aria-label="Страницы находок">
      <button type="button" disabled={visible.page === 0} onClick={() => { if (visible.page > 0) onPageChange(visible.page - 1); }} aria-label="Предыдущая страница находок"><ChevronLeft size={16} aria-hidden="true" />Назад</button>
      <select className={styles.pageSelect} aria-label="Выбрать страницу находок" value={visible.page} onChange={event => {
        const next = Number(event.target.value);
        if (Number.isInteger(next) && next >= 0 && next < visible.pages && next !== visible.page) onPageChange(next);
      }}>{Array.from({ length: visible.pages }, (_, index) => <option key={index} value={index}>Страница {index + 1} из {visible.pages}</option>)}</select>
      <span className={styles.pageStatus} role="status" aria-live="polite">Страница {visible.page + 1} из {visible.pages}</span>
      <button type="button" disabled={visible.page === visible.pages - 1} onClick={() => { if (visible.page < visible.pages - 1) onPageChange(visible.page + 1); }} aria-label="Следующая страница находок">Далее<ChevronRight size={16} aria-hidden="true" /></button>
    </nav>
  </>;
}

export function WorldCollections({ state, economy, gifts }: { state: WorldState; economy?: EconomyView | null; gifts: readonly string[] }) {
  const [chapter, setChapter] = useState<CollectionChapter>("travel");
  const [filter, setFilter] = useState<CollectionBookFilter>("all");
  const [page, setPage] = useState(0);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const entries = collectionBookEntries(chapter, state.collection, economy);
  const found = entries.filter(entry => entry.owned).length;
  const progress = collectionBookProgress(chapter, economy);
  const index = COLLECTION_CHAPTERS.findIndex(entry => entry.id === chapter);
  const active = COLLECTION_CHAPTERS[index];
  const total = COLLECTION_CHAPTERS.reduce((sum, entry) => sum + collectionBookEntries(entry.id, state.collection, economy).filter(find => find.owned).length, 0);
  const legacyRiverFinds = worldCatalog.finds.filter(find => find.group === "fishing" && state.collection.includes(find.id));
  const changeChapter = (next: CollectionChapter) => {
    if (next !== chapter) { playUiCue(getAudioRuntime(), "ui.tab"); setPage(0); }
    setChapter(next);
  };
  const onChapterKey = (event: KeyboardEvent<HTMLButtonElement>, position: number) => {
    const next = event.key === "ArrowRight" ? (position + 1) % COLLECTION_CHAPTERS.length
      : event.key === "ArrowLeft" ? (position + COLLECTION_CHAPTERS.length - 1) % COLLECTION_CHAPTERS.length
        : event.key === "Home" ? 0 : event.key === "End" ? COLLECTION_CHAPTERS.length - 1 : null;
    if (next == null) return;
    event.preventDefault(); changeChapter(COLLECTION_CHAPTERS[next].id); buttons.current[next]?.focus();
  };
  return <section className={styles.library} aria-label="Книга коллекций">
    <header className={styles.heading}><BookOpen size={22} aria-hidden="true" /><div><span>НАХОДКИ И ЗНАКОМСТВА</span><h2>Книга коллекций</h2></div><strong>{total}/{BOOK_COLLECTION_COUNT}</strong></header>
    <p className={styles.intro}>Записи о находках и собственном улове остаются навсегда. Продажа рыбы и материалов их не стирает.</p>
    <div className={styles.chapters} role="tablist" aria-label="Главы книги">{COLLECTION_CHAPTERS.map((entry, position) => {
      const Icon = chapterIcons[entry.id];
      return <button key={entry.id} type="button" ref={button => { buttons.current[position] = button; }} role="tab"
        id={`collection-tab-${entry.id}`} aria-controls={`collection-page-${entry.id}`} aria-selected={chapter === entry.id}
        tabIndex={chapter === entry.id ? 0 : -1} onClick={() => changeChapter(entry.id)} onKeyDown={event => onChapterKey(event, position)}>
        <Icon size={17} aria-hidden="true" />{entry.title}
      </button>;
    })}</div>
    <div className={styles.book}>
      <div className={styles.page} role="tabpanel" id={`collection-page-${chapter}`} aria-labelledby={`collection-tab-${chapter}`}>
        <div className={styles.pageHeading}><span>ГЛАВА {index + 1} · {active.subtitle}</span><h3>{active.title}<small>{found}/{entries.length}</small></h3></div>
        <CollectionBookFinds entries={entries} filter={filter} page={page}
          onFilterChange={next => { setFilter(next); setPage(0); }} onPageChange={next => { setPage(next); playUiCue(getAudioRuntime(), "ui.tab"); }} />
        <details className={styles.rules}><summary>Как открывать находки</summary>
        {found === entries.length ? <p className={styles.complete}><Check size={16} aria-hidden="true" />Глава завершена. Все знакомства сохранены.</p>
          : progress ? <div className={styles.progress}><p>До одной находки за работу. Короткие задания копят прогресс.</p><progress value={progress.completed} max={progress.seconds} aria-label={`До следующей находки: зачтено ${hours(progress.completed)} из ${hours(progress.seconds)} часов`} /><small>Осталось {hours(progress.seconds - progress.completed)} ч. За одну работу учитывается до {hours(progress.seconds)} ч, после получения результата.</small></div>
            : <p className={styles.rule}>Каждый вид открывается после полученного улова. Покупка рыбы в лавке или на рынке главу не заполняет.</p>}
        {chapter === "travel" && <p className={styles.sources}>Лесная разведка, Лесной обход, Старый лес и Лесное нагорье.</p>}
        {chapter === "quarry" && <p className={styles.sources}>Заказы шахты, Вход в пещеру, Глубокий проход, Прибрежные отложения и Заброшенный карьер.</p>}
        {chapter === "fishing" && <FishRarityScale />}
        </details>
        {chapter === "fishing" && legacyRiverFinds.length > 0 && <details className={styles.archive}><summary>Прежние речные находки · {legacyRiverFinds.length}/6</summary><p>Ваши находки из прежних путешествий сохранены.</p><div>{legacyRiverFinds.map(find => <span key={find.id}><CollectionIcon findId={find.id} size={30} />{find.name}</span>)}</div></details>}
      </div>
    </div>
    {(state.inventory.includes("explorer_cap") || state.inventory.includes("willow_rod") || gifts.length > 0) && <p className={styles.kept}>Полученную раньше одежду можно надеть в гардеробе. Ваши прежние удочки и подарки сохранены.</p>}
  </section>;
}
