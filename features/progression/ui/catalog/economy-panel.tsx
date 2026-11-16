"use client";

import { useEffect, useMemo } from "react";
import { Search } from "lucide-react";
import { PlayerItemIcon } from "@/features/economy/ui/fishing/fish-discovery";

import styles from "@/features/progression/ui/shared/economy-reference.module.css";

import { data, byId, number, searchWords, categoryNames } from "@/features/progression/ui/shared/reference-parts";
import { ItemDetails } from "./item-details";
import { useBranchState } from "@/features/progression/ui/shell/branch-session";
const PAGE_SIZE = 24;
const itemSearch = new Map(data.items.map(item => [item.id, searchWords(`${item.name} ${item.id} ${categoryNames[item.category] ?? ""} ${item.sources.map(source => source.name).join(" ")}`)]));
export function EconomyPanel({ itemId }: { itemId?: string }) {
  const [query, setQuery] = useBranchState("catalog.query", "");
  const [home, setHome] = useBranchState("catalog.home", 0);
  const [category, setCategory] = useBranchState("catalog.category", "all");
  const [selectedId, setSelectedId] = useBranchState("catalog.selectedId", "berries");

  const [page, setPage] = useBranchState("catalog.page", 0);
  useEffect(() => {
    if (!itemId || !byId.has(itemId)) return;
    setQuery(""); setCategory("all"); setHome(0); setSelectedId(itemId);
    setPage(Math.floor(data.items.findIndex(item => item.id === itemId) / PAGE_SIZE));
  }, [itemId, setQuery, setCategory, setHome, setSelectedId, setPage]);
  const filtered = useMemo(() => {
    const search = searchWords(query);
    return data.items.filter(item => (category === "all" || (category === "fish" ? item.kind === "fish-species" || item.category === "raw" || item.id === "fish" : item.category === category))
      && (!home || item.sources.some(source => source.homeLevel <= home))
      && (!search.length || search.every(word => itemSearch.get(item.id)!.some(candidate => candidate.startsWith(word)))));
  }, [query, home, category]);
  const lastPage = Math.max(0, Math.ceil(filtered.length / PAGE_SIZE) - 1);
  const currentPage = Math.min(page, lastPage);
  const visible = filtered.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const selected = filtered.find(item => item.id === selectedId) ?? filtered[0];
  useEffect(() => {
    if (!itemId || selected?.id !== itemId) return;
    // Run after the target card commits; the route-change effect above may
    // initially render a previously selected item from the saved session.
    const frame = requestAnimationFrame(() => {
      const details = document.getElementById("economy-item-details");
      details?.scrollIntoView({ block: "start" }); details?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [itemId, selected?.id]);

  function selectItem(id: string) {
    if (!byId.has(id)) return;
    setQuery(""); setCategory("all"); setHome(0); setSelectedId(id); setPage(Math.floor(data.items.findIndex(item => item.id === id) / PAGE_SIZE));
    if (typeof window !== "undefined") window.requestAnimationFrame(() => {
      const details = document.getElementById("economy-item-details");
      details?.scrollIntoView({ block: "start" });
      details?.focus({ preventScroll: true });
    });
  }
  function selectFromList(id: string) {
    setSelectedId(id);
    if (typeof window !== "undefined" && window.matchMedia?.("(max-width: 780px)").matches) window.requestAnimationFrame(() => document.getElementById("economy-item-details")?.scrollIntoView({ block: "start" }));
  }
  return <section className={styles.panel} aria-label="Ингредиенты и расчёты экономики">
    <div className={styles.catalogHeading}><div><h2>Каталог предметов</h2><p>Источники, рецепты и расчёт нужного количества.</p></div><span>{data.items.length} предмета · {data.recipes.length} рецептов</span></div>
    <section id="economy-ingredients" className={styles.library}>
      <div className={styles.sectionHeading}><div><h3>Ингредиенты и готовые товары</h3></div><span role="status">{filtered.length} из {data.items.length}</span></div>
      <div className={styles.filters}><label className={styles.search}><Search size={17} aria-hidden="true" /><input type="search" value={query} placeholder="Малина, балка, уха…" aria-label="Найти ингредиент" onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><label>Источники по дому<select aria-label="Уровень дома для справочника" value={home} onChange={event => { setHome(Number(event.target.value)); setPage(0); }}><option value={0}>Все уровни</option>{[1, 2, 3, 4, 5].map(level => <option key={level} value={level}>До дома {level}</option>)}</select></label><label>Категория<select aria-label="Категория ингредиентов" value={category} onChange={event => { setCategory(event.target.value); setPage(0); }}><option value="all">Все предметы</option><option value="material">Материалы</option><option value="crafted">Переработка</option><option value="provisions">Еда и запасы</option><option value="fish">Вся рыба</option><option value="produce">Урожай и находки</option><option value="fishing">Наживка</option><option value="special">Реликвии</option></select></label></div>
      <div className={styles.libraryGrid}><div className={styles.itemBrowser}>{selected && <a className={styles.detailLink} href="#economy-item-details">К карточке ингредиента →</a>}<ul className={styles.itemList} aria-label="Предметы каталога">{visible.map(item => <li key={item.id}><button type="button" data-item-id={item.id} aria-pressed={selected?.id === item.id} onClick={() => selectFromList(item.id)}><PlayerItemIcon itemId={item.id} size={32} /><span><strong>{item.name}</strong><small>{item.kind === "fish-species" ? "Вид рыбы" : categoryNames[item.category] ?? "Предмет"}</small></span><span className={styles.listPrice}>{item.npcSellPrice === null ? "-" : number(item.npcSellPrice)}<small>NPC</small></span></button></li>)}</ul>{filtered.length > PAGE_SIZE && <nav className={styles.pagination} aria-label="Страницы каталога"><button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Назад</button><span role="status">{currentPage + 1} / {lastPage + 1}</span><button type="button" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}>Далее</button></nav>}{!filtered.length && <p className={styles.empty}>Ничего не найдено. Измените поиск или фильтры.</p>}</div>{selected ? <ItemDetails key={selected.id} item={selected} home={home} onSelect={selectItem} /> : <div className={styles.empty}>Выберите другой поиск, чтобы увидеть источники и рецепты.</div>}</div>
    </section>
  </section>;
}
