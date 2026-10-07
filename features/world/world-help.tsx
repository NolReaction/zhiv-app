"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, BookOpen, ChevronRight, CircleHelp, Compass, Hammer, Leaf, Search, Soup, Sprout, Users, X } from "lucide-react";
import type { EconomyController } from "@/features/economy/use-economy";
import type { WorldController } from "./use-world";
import { useForestObservation } from "./use-forest-observation";
import { worldHelpAdvice } from "./world-help-advice";
import { searchWorldHelpWithStatus, worldHelpGroups, worldHelpTopics } from "./world-help-content";
import type { WorldHelpContext, WorldHelpSuggestion, WorldHelpTarget } from "./world-help-types";
import styles from "./world-help.module.css";

const topics = worldHelpTopics();
const groupIcons = { start: Sprout, economy: Hammer, travel: Compass, food: Soup, mochlik: Leaf, account: Users };
type GroupId = keyof typeof groupIcons;
export type WorldHelpProps = {
  economy?: EconomyController;
  world?: WorldController;
  presenceKey?: string;
  isOnline?: boolean;
  context?: WorldHelpContext;
  initialTopicId?: string;
  onNavigate?: (target: WorldHelpTarget) => void;
};

function retryWait(target: WorldHelpTarget, props: WorldHelpProps) {
  return target.kind === "retry-economy" && props.economy
    ? Math.max(0, Math.ceil((props.economy.retryAt - props.economy.now) / 1000)) : 0;
}

function HelpAction({ action, ...props }: WorldHelpProps & { action: NonNullable<WorldHelpSuggestion["action"]> }) {
  if (!props.onNavigate) return null;
  const retry = action.target.kind === "retry-economy" || action.target.kind === "retry-world";
  const controller = action.target.kind === "retry-economy" ? props.economy : props.world;
  const wait = retryWait(action.target, props);
  const disabled = retry && (!controller || controller.busy || wait > 0 || props.isOnline === false);
  return <button type="button" className={styles.action} disabled={disabled} onClick={() => { if (!disabled) props.onNavigate?.(action.target); }}>
    {wait ? `Повторить через ${wait} с` : action.label}<ArrowRight size={15} aria-hidden="true" />
  </button>;
}

/** The map supplies navigation; help itself never spends items or starts jobs. */
export function WorldHelp(props: WorldHelpProps) {
  const [query, setQuery] = useState("");
  const [group, setGroup] = useState<GroupId | null>(null);
  const [topicId, setTopicId] = useState<string | null>(props.initialTopicId ?? null);
  const [moreAdvice, setMoreAdvice] = useState(false);
  const observation = useForestObservation(props.presenceKey);
  const searchId = useId(), headingId = useId(), searchHintId = useId();
  const search = useRef<HTMLInputElement>(null), body = useRef<HTMLDivElement>(null), heading = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);
  const selected = topics.find(topic => topic.id === topicId);
  const searching = Boolean(query.trim());
  const { results, status: searchStatus } = searchWorldHelpWithStatus(topics, query);
  const activeGroup = worldHelpGroups.find(entry => entry.id === group);
  const advice = worldHelpAdvice({ ...props, observation });
  const visible = searching ? results : group ? topics.filter(topic => topic.group === group)
    : topics.filter(topic => ["start", "resources", "production", "saving"].includes(topic.id));
  useEffect(() => {
    if (!navigated.current) return;
    navigated.current = false;
    body.current?.scrollTo({ top: 0 });
    heading.current?.focus({ preventScroll: true });
  }, [group, topicId]);
  const openTopic = (id: string) => { navigated.current = true; setTopicId(id); };
  const openGroup = (id: GroupId) => { navigated.current = true; setGroup(id); setTopicId(null); };
  const changeQuery = (value: string) => { setQuery(value); setTopicId(null); setGroup(null); body.current?.scrollTo({ top: 0 }); };
  const clearSearch = () => { setQuery(""); setTopicId(null); setGroup(null); body.current?.scrollTo({ top: 0 }); search.current?.focus(); };
  const back = () => {
    navigated.current = true;
    if (selected) setTopicId(null);
    else setGroup(null);
  };
  const topicList = <ul className={styles.topics}>{visible.map(topic => <li key={topic.id}>
    <button type="button" className={styles.topicLink} onClick={() => openTopic(topic.id)}><span><strong>{topic.title}</strong><small>{topic.summary}</small></span><ChevronRight size={17} aria-hidden="true" /></button>
  </li>)}</ul>;

  const adviceContent = advice.length > 0 && <section className={styles.advice} aria-label="Помощь по текущей ситуации">
      <h3><CircleHelp size={17} aria-hidden="true" />Сейчас пригодится</h3>
      {(moreAdvice ? advice : advice.slice(0, 1)).map(item => <article className={styles.adviceCard} key={item.id} data-help-advice={item.id} data-severity={item.severity}>
        <h4>{item.title}</h4><p>{item.message}</p>
        <div className={styles.adviceActions}>{item.action && <HelpAction {...props} action={item.action} />}<button type="button" className={styles.explain} onClick={() => openTopic(item.topicId)}>Подробнее</button></div>
      </article>)}
      {advice.length > 1 && <button type="button" className={styles.moreAdvice} aria-expanded={moreAdvice} onClick={() => setMoreAdvice(value => !value)}>{moreAdvice ? "Свернуть подсказки" : `Ещё подсказки · ${advice.length - 1}`}</button>}
        </section>;

  return <div className={styles.help}>
    <div className={styles.search} role="search" aria-label="Поиск по справке">
      <label htmlFor={searchId}>Что не получается?</label>
      <div className={styles.searchField}><Search size={18} aria-hidden="true" />
        <input ref={search} id={searchId} type="search" value={query} onChange={event => changeQuery(event.target.value)} placeholder="Например, не хватает монет" aria-describedby={searchHintId} autoComplete="off" maxLength={100} />
        {query && <button type="button" aria-label="Очистить поиск" onClick={clearSearch}><X size={18} aria-hidden="true" /></button>}
      </div>
      <p id={searchHintId} className={styles.searchHint}>Можно написать начало слова или вопрос своими словами.</p>
    </div>
    <div ref={body} className={styles.body} data-help-scroll>
      {(selected || group) && <button type="button" className={styles.back} onClick={back}><ArrowLeft size={16} aria-hidden="true" />{selected ? searching ? "К результатам поиска" : activeGroup?.title ?? "Все разделы" : "Все разделы"}</button>}
      {selected ? <article className={styles.article} aria-labelledby={headingId} data-help-topic={selected.id}>
        <h3 ref={heading} id={headingId} tabIndex={-1}>{selected.title}</h3>
        {selected.paragraphs?.map(paragraph => <p key={paragraph}>{paragraph}</p>)}
        {selected.steps && <ol>{selected.steps.map(step => <li key={step}>{step}</li>)}</ol>}
        {selected.note && <p className={styles.note}>{selected.note}</p>}
        {selected.action && <HelpAction {...props} action={selected.action} />}
        {!!selected.relatedIds?.length && <nav className={styles.related} aria-label="По этой теме"><h4>Ещё по теме</h4>{selected.relatedIds.map(id => {
          const topic = topics.find(entry => entry.id === id);
          return topic && <button type="button" key={id} onClick={() => openTopic(id)}>{topic.title}<ChevronRight size={15} aria-hidden="true" /></button>;
        })}</nav>}
      </article> : searching ? <section aria-label="Результаты поиска">
        <h3 ref={heading} id={headingId} tabIndex={-1} className={styles.resultCount} role="status" aria-atomic="true">{searchStatus === "frequent" || searchStatus === "short" ? "Частые вопросы" : `Найдено ответов: ${results.length}`}</h3>
        {(searchStatus === "frequent" || searchStatus === "short") && <p className={styles.searchPrompt}>{searchStatus === "short" ? "Введите ещё пару букв. Пока можно выбрать частый вопрос." : "Уточните, что хотите сделать, или выберите вопрос ниже."}</p>}
        {results.length ? topicList : <div className={styles.empty}><Search size={25} aria-hidden="true" /><h3>Не нашли ответ</h3><p>Попробуйте название предмета или короткий вопрос:</p><div className={styles.searchExamples}>{["ягоды", "строитель занят", "нет места"].map(example => <button type="button" key={example} onClick={() => { changeQuery(example); search.current?.focus(); }}>{example}</button>)}</div><button type="button" onClick={clearSearch}>Открыть разделы</button></div>}
      </section> : group ? <section aria-labelledby={headingId}>
        <h3 ref={heading} id={headingId} tabIndex={-1} className={styles.groupTitle}>{activeGroup?.title}</h3>
        {topicList}
      </section> : <>
        {props.context && adviceContent}
        <section aria-labelledby={headingId}>
          <h3 ref={heading} id={headingId} tabIndex={-1} className={styles.groupTitle}><BookOpen size={17} aria-hidden="true" />Разделы</h3>
          <div className={styles.groups}>{worldHelpGroups.map(entry => {
            const Icon = groupIcons[entry.id];
            return <button key={entry.id} type="button" onClick={() => openGroup(entry.id)} data-help-group={entry.id}><Icon size={20} aria-hidden="true" /><span><strong>{entry.title}</strong><small>{entry.description}</small></span></button>;
          })}</div>
        </section>
        {!props.context && adviceContent}
        <section className={styles.firstSteps} aria-label="Частые вопросы"><h3>Частые вопросы</h3>{topicList}</section>
      </>}
    </div>
  </div>;
}
