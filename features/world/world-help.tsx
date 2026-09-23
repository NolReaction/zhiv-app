"use client";

import { useId, useState } from "react";
import { BookOpen, ChevronDown, Search, Sprout, X } from "lucide-react";
import { WORLD_PRESENTATION } from "./presentation";
import { searchWorldHelp, worldHelpTopics } from "./world-help-content";
import styles from "./world-help.module.css";

const topics = worldHelpTopics();

export function WorldHelp() {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const results = searchWorldHelp(topics, query);
  const searching = Boolean(query.trim());

  return <div className={styles.help}>
    <div className={styles.intro}>
      <BookOpen size={25} aria-hidden="true" />
      <div><h3>Путеводитель по лесу</h3><p>Выберите тему или найдите ответ по слову.</p></div>
    </div>
    {WORLD_PRESENTATION.rebuilding && <aside className={styles.status} aria-label="Состояние игры">
      <Sprout size={19} aria-hidden="true" /><div><strong>Лес обновляется</strong><p>Карта, гардероб и коллекции доступны. Новые путешествия и строительство вернутся позже; полученный прогресс сохраняется.</p></div>
    </aside>}
    <div className={styles.search} role="search" aria-label="Поиск по справке">
      <label htmlFor={searchId}>Что хотите узнать?</label>
      <div className={styles.searchField}>
        <Search size={18} aria-hidden="true" />
        <input id={searchId} type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Например, искры или ночь" autoComplete="off" maxLength={100} />
        {query && <button type="button" aria-label="Очистить поиск" onClick={() => { setQuery(""); document.getElementById(searchId)?.focus(); }}><X size={18} aria-hidden="true" /></button>}
      </div>
    </div>
    <p className={styles.resultCount} role="status">{searching ? `Найдено тем: ${results.length}` : `Все темы · ${topics.length}`}</p>
    {results.length ? <div className={styles.topics}>
      {results.map(topic => <details className={styles.topic} key={`${topic.id}:${searching}`} open={searching || undefined}>
        <summary><span><strong>{topic.title}</strong><small>{topic.summary}</small></span><ChevronDown size={18} aria-hidden="true" /></summary>
        <div className={styles.answer}>
          {topic.paragraphs?.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
          {topic.steps && <ol>{topic.steps.map(step => <li key={step}>{step}</li>)}</ol>}
          {topic.note && <p className={styles.note}>{topic.note}</p>}
        </div>
      </details>)}
    </div> : <div className={styles.empty}>
      <Search size={25} aria-hidden="true" /><h3>Такой темы пока нет</h3><p>Попробуйте другое слово: «тапы», «карта» или «сохранение».</p><button type="button" onClick={() => { setQuery(""); document.getElementById(searchId)?.focus(); }}>Показать все темы</button>
    </div>}
  </div>;
}
