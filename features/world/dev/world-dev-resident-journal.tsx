"use client";

import type { WorldDevSceneActor } from "./forest-scene-preview";
import { WORLD_DEV_SCENE_ACTORS } from "./forest-scene-preview";
import { RESIDENT_JOURNAL_LIMITS, type ResidentJournalSnapshot } from "./resident-incident-journal";
import styles from "./world-dev-resident-journal.module.css";

const names = (value: string | boolean | null) => typeof value === "boolean" ? value ? "да" : "нет"
  : value === null ? "—" : WORLD_DEV_SCENE_ACTORS.find(actor => actor.id === value)?.label ?? (value === "obstacle" ? "предмет" : value);
const fields = { goal: "Цель", target: "Место", phase: "Фаза", blockingNeighbour: "Мешает", available: "Доступен" };
const kinds = { initial: "Начало записи", change: "Изменение", blocked: "Проход занят", released: "Проход освободился", interruption: "Возможное прерывание" };

export function WorldDevResidentJournal({ journal, actor, available, notice, manualJSON, onRecord, onClear, onDownload, onCopy }: {
  journal: ResidentJournalSnapshot; actor: WorldDevSceneActor; available: boolean; notice: string; manualJSON: string | null;
  onRecord: (recording: boolean) => void; onClear: () => void; onDownload: () => void; onCopy: () => void;
}) {
  const events = journal.events.filter(event => event.actor === actor).slice(-12);
  return <section className={styles.journal} aria-label="Журнал решений жителей">
    <h4>Последовательность событий</h4>
    <p className={styles.hint}>Включите запись перед проверкой. Храним изменения целей, фаз и помех за {RESIDENT_JOURNAL_LIMITS.seconds} активных секунд,
      до {RESIDENT_JOURNAL_LIMITS.events} событий. Новая запись заменяет предыдущую; закрытие этой вкладки DEV очищает журнал.</p>
    <div className={styles.actions}>
      <button type="button" data-journal-record aria-pressed={journal.recording} onClick={() => onRecord(!journal.recording)}>
        {journal.recording ? "Остановить запись" : "Начать запись"}</button>
      <button type="button" data-journal-clear disabled={!journal.events.length} onClick={onClear}>Очистить</button>
      <button type="button" data-journal-download disabled={!available} onClick={onDownload}>Скачать JSON</button>
      <button type="button" data-journal-copy disabled={!available} onClick={onCopy}>Копировать JSON</button>
    </div>
    <p className={styles.status}><span role="status" aria-live="polite">{notice || `${journal.recording ? "Запись включена" : "Запись выключена"} · ${journal.events.length} событий`}</span>
      {journal.elapsed !== null && <time> · {journal.elapsed} с</time>}</p>
    {journal.capture > 0 && <p className={styles.hint}>Сеанс {journal.capture} · {journal.source === "rehearsal" ? "копия мира" : journal.source === "world" ? "текущий мир" : "ожидает сцену"}.
      {journal.dropped > 0 && ` Удалено старых событий: ${journal.dropped}.`} Смена сцены начинает новую последовательность.</p>}
    {events.length ? <ol className={styles.events}>
      {events.map(event => <li key={event.id} data-journal-kind={event.kind}>
        <strong><time>{event.at} с</time> · {kinds[event.kind]}</strong>
        {event.changes.map(change => <span key={change.field}>{fields[change.field]}: {names(change.before)} → {names(change.after)}</span>)}
      </li>)}
    </ol> : <p className={styles.hint}>Событий выбранного жителя пока нет. Его обычные шаги по тому же пути не создают записи.</p>}
    {events.some(event => event.inferred) && <p className={styles.hint}>Прерывание предполагается по смене маршрута или занятия; точная причина не подтверждена.</p>}
    <p className={styles.hint}>Экспорт содержит снимок записи и события всех жителей, условия DEV и seed. Идентификатор аккаунта, экономика и сетевые запросы не включаются.
      Остановленная запись сохраняет свой последний снимок, пока вы смотрите живую сцену.</p>
    {manualJSON !== null && <label className={styles.manual}>JSON для ручного копирования
      <textarea readOnly rows={8} value={manualJSON} onFocus={event => event.currentTarget.select()} />
    </label>}
  </section>;
}
