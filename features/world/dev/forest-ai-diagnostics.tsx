import type { ForestObservation } from "../use-forest-observation";
import styles from "./world-dev-panel.module.css";

const NEEDS = [
  ["energy", "Энергия"], ["curiosity", "Любопытство"],
  ["comfort", "Комфорт"], ["attention", "Внимание к игроку"],
] as const;
const MEMORY_LABELS: Record<ForestObservation["memory"]["status"], string> = {
  session: "Память текущей сессии",
  saved: "Сохранено на этом устройстве",
  restored: "Восстановлено на этом устройстве",
  unavailable: "Хранилище недоступно — память только до закрытия",
};
const percent = (value: number) => Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100);
const scoreText = (score: number) => Number.isFinite(score) ? score.toFixed(2) : "—";
const text = (value: string) => value.slice(0, 512);

/** Session time, not the wall clock; pauses never age a decision. */
export function decisionTime(seconds: number) {
  const total = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(total / 60), remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/** Explicit allowlist: a debug report never copies account/session identifiers or credentials. */
export function createForestAiReport(observation: ForestObservation, exportedAt = Date.now()) {
  return {
    schemaVersion: 1,
    kind: "forest-ai-observation",
    exportedAt: new Date(exportedAt).toISOString(),
    note: "Снимок состояния и последних решений. Не содержит записи для воспроизведения сцены.",
    activity: text(observation.activity), detail: text(observation.detail), mood: text(observation.mood),
    sleeping: observation.sleeping, paused: observation.paused,
    needs: Object.fromEntries(NEEDS.map(([key]) => [key, observation.needs[key]])),
    memory: { status: observation.memory.status, savedAt: observation.memory.savedAt },
    diagnostics: {
      reason: text(observation.diagnostics.reason),
      candidates: observation.diagnostics.candidates.slice(0, 32).map(candidate => ({
        id: text(candidate.id), label: text(candidate.label), score: candidate.score,
        available: candidate.available, reason: text(candidate.reason),
      })),
      events: observation.diagnostics.events.slice(-24).map(event => ({
        id: event.id, at: event.at, type: text(event.type), label: text(event.label), reason: text(event.reason),
      })),
    },
  };
}

/** Pure view: reading diagnostics cannot advance or interrupt the simulation. */
export function ForestAiDiagnostics({ observation, onExport }: {
  observation: ForestObservation | null;
  onExport?: () => void;
}) {
  if (!observation) return <p className={styles.hint}>Данные появятся, когда сцена леса будет готова.</p>;
  const candidates = observation.diagnostics.candidates.slice(0, 32)
    .sort((a, b) => Number(b.available) - Number(a.available) || b.score - a.score);
  const events = observation.diagnostics.events.slice(-24).reverse();
  const savedAt = observation.memory.savedAt;
  const savedDate = savedAt !== null && Number.isFinite(savedAt) ? new Date(savedAt) : null;
  const validSavedDate = savedDate && Number.isFinite(savedDate.getTime()) ? savedDate : null;
  return <div className={styles.aiDiagnostics}>
    <div className={styles.aiIntention}>
      <div className={styles.aiHeadline}><strong>{observation.activity}</strong>
        {observation.paused && <span className={styles.aiBadge}>Пауза</span>}</div>
      <p>{observation.detail}</p>
      <p className={styles.hint}>{observation.mood}</p>
      {observation.diagnostics.reason && <p className={styles.aiReason}><b>Почему:</b> {observation.diagnostics.reason}</p>}
    </div>
    <div className={styles.aiNeeds} aria-label="Внутреннее состояние Мохлика">
      {NEEDS.map(([key, label]) => {
        const value = percent(observation.needs[key]);
        return <label key={key} className={styles.aiNeed}>
          <span>{label}<b>{value}%</b></span>
          <meter aria-label={label} min={0} max={100} value={value}>{value}%</meter>
        </label>;
      })}
    </div>
    <p className={styles.hint}>Внутренние мотивы влияют на выбор занятий. Эти показатели не требуют обязательного ухода.</p>
    <div className={styles.aiMemory}>
      <strong>Память</strong><span>{MEMORY_LABELS[observation.memory.status]}</span>
      {validSavedDate && <time dateTime={validSavedDate.toISOString()}>
        Последняя запись: {validSavedDate.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
      </time>}
    </div>
    <div className={styles.aiChoices}>
      <h3>Последний выбор занятия</h3>
      <p className={styles.hint}>Оценка — полезность занятия, а не вероятность. Варианты обновляются при новом решении.</p>
      {candidates.length ? <ol className={styles.aiList} tabIndex={0} aria-label="Рассмотренные занятия">
        {candidates.map(candidate => <li key={candidate.id} data-available={candidate.available}>
          <div className={styles.aiHeadline}><strong>{candidate.label}</strong>
            <span className={styles.aiScore}>{candidate.available ? scoreText(candidate.score) : "Недоступно"}</span></div>
          <p>{candidate.reason}</p>
        </li>)}
      </ol> : <p className={styles.hint}>Мохлик ещё не выбирал новое занятие.</p>}
    </div>
    <div className={styles.aiJournal}>
      <h3>Последние события · {events.length}</h3>
      <p className={styles.hint}>Новые — сверху. Время указано от начала симуляции; пауза его останавливает.</p>
      {events.length ? <ol className={styles.aiList} tabIndex={0} aria-label="Журнал решений">
        {events.map((event, index) => <li key={`${event.id}:${index}`}>
          <div className={styles.aiHeadline}><strong>{event.label}</strong>
            <span className={styles.aiTime} aria-label={`${decisionTime(event.at)} от начала симуляции`}>{decisionTime(event.at)}</span></div>
          {event.reason && <p>{event.reason}</p>}
        </li>)}
      </ol> : <p className={styles.hint}>События появятся по мере жизни леса.</p>}
    </div>
    {onExport && <div className={styles.aiExport}>
      <button type="button" onClick={onExport}>Скачать диагностику JSON</button>
      <p className={styles.hint}>Снимок состояния и решений для разбора бага. Не является записью для воспроизведения.</p>
    </div>}
  </div>;
}
