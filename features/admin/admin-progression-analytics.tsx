"use client";

import type { AdminAnalytics, AdminProgression } from "./admin-analytics-api";
import { economyTime, type AdminEconomyTarget } from "./admin-economy-panel";
import { analyticsCount, downloadAnalyticsCsv } from "./admin-analytics-utils";
import styles from "./admin-analytics.module.css";

const stageNames: Record<AdminProgression["cohort"]["stages"][number]["id"], string> = {
  first_action: "Первая операция в хозяйстве",
  first_work_started: "Первое занятие начато",
  first_work_claimed: "Первый результат занятия получен",
  first_construction_started: "Первая стройка начата",
  first_construction_claimed: "Первая стройка завершена и получена",
};
const signalNames: Record<AdminProgression["snapshot"]["review"][number]["signals"][number], string> = {
  no_action_72h: "72 ч без операций в хозяйстве",
  ready_24h: "Готовый результат ждёт более 24 ч",
  awaiting_collection_24h: "Урожай ждёт начала сбора более 24 ч",
};
const percent = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });
export function progressionShare(players: number, total: number) { return total ? `${percent.format(players / total * 100)}%` : "—"; }
export function progressionDuration(seconds: number | null) {
  if (seconds === null) return "Нет измерения";
  if (seconds < 60) return `${analyticsCount(seconds)} с`;
  const minutes = Math.floor(seconds / 60), hours = Math.floor(minutes / 60), days = Math.floor(hours / 24);
  return days ? `${analyticsCount(days)} д ${hours % 24} ч` : hours ? `${analyticsCount(hours)} ч ${minutes % 60} мин` : `${analyticsCount(minutes)} мин`;
}
export function progressionCohortCsvRows(data: AdminAnalytics, progression: AdminProgression) {
  const c = progression.cohort;
  const share = (players: number) => c.players ? Math.round(players / c.players * 1000) / 10 : null;
  const meta = [data.from, data.to, data.q, data.scope === "players" ? "Без администраторов" : "Все аккаунты", progression.observedUntil];
  return [
    ["Показатель", "Тип", "Игроки", "Все новые аккаунты", "Доля новых аккаунтов, %", "Медиана секунд от регистрации", "Регистрация с UTC", "Регистрация по UTC", "Поиск", "Аудитория", "Наблюдение до UTC"],
    ["Новые аккаунты", "Регистрация в периоде", c.players, c.players, share(c.players), null, ...meta],
    ["Хозяйство заведено", "Текущее состояние", c.initializedPlayers, c.players, share(c.initializedPlayers), null, ...meta],
    ["Дом уровня 2 или выше", "Текущее состояние", c.home2Players, c.players, share(c.home2Players), null, ...meta],
    ...c.stages.map(stage => [stageNames[stage.id], "Первое сохранённое событие", stage.players, c.players, share(stage.players), stage.medianSeconds, ...meta]),
  ];
}
export function progressionReviewCsvRows(data: AdminAnalytics, progression: AdminProgression) {
  return [
    ["ID игрока", "Игрок", "Текущий уровень дома", "Последняя операция UTC", "Результат готов с UTC", "Урожай ждёт начала сбора с UTC", "Причины проверки", "Снимок UTC", "Поиск", "Аудитория", "Список сокращён"],
    ...progression.snapshot.review.map(player => [player.publicId, player.displayName, player.homeLevel,
      player.lastActionAt, player.readySince, player.awaitingCollectionSince, player.signals.map(signal => signalNames[signal]).join("; "),
      progression.observedUntil, data.q, data.scope === "players" ? "Без администраторов" : "Все аккаунты", progression.snapshot.reviewTruncated ? "Да, первые 100 игроков" : "Нет"]),
  ];
}

export function AdminProgressionAnalytics({ data, onOpen, onPlayer }: {
  data: AdminAnalytics; onOpen?: (target: AdminEconomyTarget) => void; onPlayer?: (target: AdminEconomyTarget) => void;
}) {
  const p = data.progression;
  if (!p) return null;
  const c = p.cohort, s = p.snapshot;
  return <>
    <section className={styles.panel} aria-label="Первые шаги новых игроков">
      <div className={styles.sectionRow}><div className={styles.heading}><h3>Как начинают новые игроки</h3>
        <p>Аккаунты, зарегистрированные {data.from} — {data.to} по UTC, с учётом поиска и аудитории. Их развитие наблюдаем до {economyTime(p.observedUntil)}, включая действия после выбранного периода.</p></div>
        <button type="button" className={styles.button} onClick={() => downloadAnalyticsCsv(`progression-${data.from}-${data.to}.csv`, progressionCohortCsvRows(data, p))}>CSV первых шагов</button></div>
      <div className={styles.resourceMetrics}>
        <div><span>Новые аккаунты</span><strong>{analyticsCount(c.players)}</strong></div>
        <div><span>Хозяйство заведено сейчас</span><strong>{analyticsCount(c.initializedPlayers)} <small>· {progressionShare(c.initializedPlayers, c.players)}</small></strong></div>
        <div><span>Дом ≥2 сейчас</span><strong>{analyticsCount(c.home2Players)} <small>· {progressionShare(c.home2Players, c.players)}</small></strong></div>
      </div>
      {!c.players ? <p className={styles.empty}>Новых аккаунтов с такими фильтрами нет. Расширьте период или измените поиск.</p> : <>
        <p className={styles.note}>Шаги независимы: игроки могут выбирать разные занятия и строить в разном порядке. Доля считается от всех {analyticsCount(c.players)} новых аккаунтов, включая ещё не заведшие хозяйство. Дом ≥2 — уровень сейчас, дата его достижения неизвестна.</p>
        <ul className={styles.progressionStages} aria-label="Подтверждённые первые шаги">{c.stages.map(stage => <li key={stage.id}>
          <span>{stageNames[stage.id]}<small>Медиана от регистрации: {progressionDuration(stage.medianSeconds)}</small></span>
          <strong>{analyticsCount(stage.players)} из {analyticsCount(c.players)} · {progressionShare(stage.players, c.players)}</strong>
          <span className={styles.barTrack} aria-hidden="true"><span style={{ width: `${stage.players / c.players * 100}%` }} /></span>
        </li>)}</ul>
        <p className={styles.note}>Медиана — время, за которое половина достигших шага игроков его прошла. Время игроков без подтверждённого шага не подставляется как ноль. Занятия — вылазка, рыбалка или производство; получение постройки показано отдельно.</p>
      </>}
      <p className={styles.note}>У {analyticsCount(c.playersWithEvents)} из {analyticsCount(c.players)} новых аккаунтов есть сохранённые операции. Самая ранняя: {c.firstRecordedAt ? economyTime(c.firstRecordedAt) : "истории пока нет"}. Удалённые и несохранённые события не восстанавливаются; первое наблюдённое действие может быть не первым за жизнь аккаунта.</p>
    </section>
    <section className={styles.panel} aria-label="Проверка развития игроков">
      <div className={styles.sectionRow}><div className={styles.heading}><h3>Что стоит проверить у игроков</h3>
        <p>Состояние на {economyTime(p.observedUntil)}, независимо от дат регистрации и выбранного периода. Поиск и аудитория применяются: {analyticsCount(s.matchingPlayers)} аккаунтов, из них {analyticsCount(s.initializedPlayers)} с хозяйством.</p></div>
        <button type="button" className={styles.button} disabled={!s.review.length} onClick={() => downloadAnalyticsCsv(`progression-review-${p.observedUntil.slice(0, 10)}.csv`, progressionReviewCsvRows(data, p))}>CSV списка игроков</button></div>
      <div className={`${styles.metrics} ${styles.progressionMetrics}`}>
        <div className={styles.metric}><span>Результат ждёт &gt;24 ч</span><strong>{analyticsCount(s.ready24hPlayers)}</strong><small>Готовая работа или стройка ещё не получена</small></div>
        <div className={styles.metric}><span>Урожай ждёт &gt;24 ч</span><strong>{analyticsCount(s.awaitingCollection24hPlayers)}</strong><small>Созрел, но сбор Мохликом не начат</small></div>
        <div className={styles.metric}><span>Без операций 72 ч</span><strong>{analyticsCount(s.noAction72hPlayers)}</strong><small>Нет подтверждённых операций хозяйства не менее 72 часов</small></div>
        <div className={styles.metric}><span>История неизвестна</span><strong>{analyticsCount(s.unknownHistoryPlayers)}</strong><small>Хозяйство есть, подтверждённых операций нет</small></div>
      </div>
      <p className={styles.note}>Это причины посмотреть хозяйство и журнал, а не доказательство тупика или отсутствия в сети. Операции с ресурсами не отражают все действия в мире и отметки «Я живой». Неизвестная история не считается бездействием. Игрок может иметь несколько причин; показатели не складываются.</p>
      {!s.review.length ? <p className={styles.empty}>Игроков с известными причинами проверки сейчас нет.</p> : <ul className={styles.progressionReview}>{s.review.map(player => <li key={player.publicId}>
        <div className={styles.progressionIdentity}><strong>{player.displayName}</strong><code>{player.publicId}</code><span>Дом: {player.homeLevel === null ? "уровень неизвестен" : player.homeLevel ? `уровень ${analyticsCount(player.homeLevel)}` : "не построен"}</span></div>
        <ul className={styles.progressionSignals} aria-label={`Причины проверки игрока ${player.displayName}`}>{player.signals.map(signal => <li key={signal}>{signalNames[signal]}</li>)}</ul>
        <dl className={styles.progressionDates}>
          <div><dt>Последняя операция</dt><dd>{player.lastActionAt ? economyTime(player.lastActionAt) : "История неизвестна"}</dd></div>
          {player.readySince && <div><dt>Результат готов с</dt><dd>{economyTime(player.readySince)}</dd></div>}
          {player.awaitingCollectionSince && <div><dt>Урожай ждёт сбора с</dt><dd>{economyTime(player.awaitingCollectionSince)}</dd></div>}
        </dl>
        {(onOpen || onPlayer) && <div className={styles.filterFooter}>
          {onOpen && <button type="button" className={styles.button} onClick={() => onOpen(player)} aria-label={`Открыть хозяйство игрока ${player.displayName}`}>Хозяйство игрока</button>}
          {onPlayer && <button type="button" className={styles.button} onClick={() => onPlayer(player)} aria-label={`Открыть операции игрока ${player.displayName}`}>Операции игрока</button>}
        </div>}
      </li>)}</ul>}
      {s.reviewTruncated && <p className={styles.warning}>Показаны первые 100 игроков с причинами проверки. Общие показатели полные. Сузьте поиск по имени или ID, чтобы проверить остальных.</p>}
      <p className={styles.note}>В журнале откроется выбранный выше период. Для более старых действий расширьте даты.</p>
    </section>
  </>;
}
