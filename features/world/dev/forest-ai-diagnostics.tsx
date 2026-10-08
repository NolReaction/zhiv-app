import type { ForestObservation } from "@/features/world/state/use-forest-observation";
import type { ForestMemorySyncStatus } from "@/features/world/state/memory/forest-memory-sync";
import type { ForestGardenObservation } from "@/features/world/state/forest-observer";
import styles from "./world-dev-panel.module.css";

const NEEDS = [
  ["energy", "Энергия"], ["curiosity", "Любопытство"],
  ["comfort", "Комфорт"], ["attention", "Внимание к игроку"],
] as const;
const MOTIVES = [
  ["arousal", "Возбуждение"], ["saturation", "Насыщение впечатлениями"], ["variety", "Потребность в смене занятий"],
] as const;
const MEMORY_LABELS: Record<ForestObservation["memory"]["status"], string> = {
  session: "Память текущей сессии",
  saved: "Сохранено на этом устройстве",
  restored: "Восстановлено на этом устройстве",
  unavailable: "Хранилище недоступно — память только до закрытия",
};
const SYNC_LABELS: Record<ForestMemorySyncStatus["mode"], string> = {
  loading: "Загрузка памяти аккаунта", synced: "Синхронизация подключена", saving: "Сохранение в аккаунт",
  offline: "Нет связи с сервером памяти", "other-device": "Право записи у другого устройства",
  error: "Ошибка подключения памяти", disabled: "DEV-сценарий — запись отключена",
};
const percent = (value: number) => Math.round(Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0)) * 100);
const scoreText = (score: number) => Number.isFinite(score) ? score.toFixed(2) : "—";
const text = (value: string) => value.slice(0, 512);
const count = (value: number, max: number) => Math.floor(Math.max(0, Math.min(max, Number.isFinite(value) ? value : 0)));
const GARDEN_PHASES: Record<string, string> = {
  "approach-basket": "Идёт за корзинкой", "take-basket": "Берёт корзинку", "approach-bush": "Подходит к кусту",
  water: "Поливает корни", collect: "Собирает ягоды", "return-basket": "Возвращает корзинку",
  deposit: "Ставит корзинку", settle: "Завершает занятие",
};
export type ForestAiEventFilter = "all" | "selected" | "completed" | "issues" | "context";
const EVENT_FILTERS = [
  ["all", "Все события"], ["selected", "Выбор занятия"], ["completed", "Завершённые занятия"],
  ["issues", "Прерывания и отказы"], ["context", "Внимание и память"],
] as const satisfies readonly (readonly [ForestAiEventFilter, string])[];
const EVENT_KINDS: Record<string, { label: string; group: ForestAiEventFilter }> = {
  selected: { label: "Выбор занятия", group: "selected" }, completed: { label: "Завершено", group: "completed" },
  interrupted: { label: "Прервано", group: "issues" }, failed: { label: "Не удалось", group: "issues" },
  attention: { label: "Отклик на игрока", group: "context" }, restored: { label: "Восстановление памяти", group: "context" },
};
const EVENT_EMPTY: Record<ForestAiEventFilter, string> = {
  all: "События появятся по мере жизни леса.", selected: "В последних событиях нет нового выбора занятия.",
  completed: "В последних событиях нет завершённых занятий.", issues: "В последних событиях нет прерываний или отказов.",
  context: "В последних событиях нет отклика на игрока или восстановления памяти.",
};
const eventKind = (type: string) => EVENT_KINDS[type] ?? { label: "Событие", group: "all" as const };

function gardenReport(garden: ForestGardenObservation) {
  return {
    ...(garden.managed ? { managed: true } : {}),
    bushes: garden.bushes.slice(0, 32).map(bush => ({ id: text(bush.id), growth: percent(bush.growth) / 100,
      moisture: percent(bush.moisture) / 100, waterIn: count(bush.waterIn, 3600) })),
    basket: garden.basket ? { berries: count(garden.basket.berries, 12), capacity: count(garden.basket.capacity, 12) } : null,
    activity: garden.activity ? { kind: text(garden.activity.kind), phase: text(garden.activity.phase), carryingBasket: Boolean(garden.activity.carryingBasket) } : null,
    cooldown: count(garden.cooldown, 3600), waterReason: garden.waterReason ? text(garden.waterReason) : null,
    harvestReason: garden.harvestReason ? text(garden.harvestReason) : null,
  };
}

/** Crop progress and cosmetic care are separate from the character's needs. */
export function ForestGardenDiagnostics({ garden }: { garden?: ForestGardenObservation }) {
  if (!garden) return <p className={styles.hint}>Состояние ягодного куста появится после загрузки сцены.</p>;
  const snapshot = gardenReport(garden);
  return <div className={styles.gardenDiagnostics} aria-label="Ягодный куст и корзинка">
    <dl className={styles.gardenSummary}>
      <div><dt>Корзинка</dt><dd>{snapshot.basket ? snapshot.managed ? "Реквизит сбора" : `${snapshot.basket.berries} / ${snapshot.basket.capacity} ягод` : "Место не найдено"}</dd></div>
      <div><dt>Занятие</dt><dd>{snapshot.activity ? GARDEN_PHASES[snapshot.activity.phase] ?? "Заботится о кусте" : "Свободен"}</dd></div>
    </dl>
    {snapshot.bushes.length ? <ul className={styles.gardenBushes}>
      {snapshot.bushes.map(bush => <li key={bush.id}><strong>{bush.id}</strong><div className={styles.aiNeeds}>
        {([["Созревание", bush.growth], ["Влажность почвы", bush.moisture]] as const).map(([label, value]) => <label key={label} className={styles.aiNeed}>
          <span>{label}<b>{percent(value)}%</b></span>
          <meter aria-label={`${label}: ${bush.id}`} min={0} max={100} value={percent(value)}>{percent(value)}%</meter>
        </label>)}
      </div>{bush.waterIn > 0 && <p className={styles.hint}>Отдых после полива: {Math.ceil(bush.waterIn / 60)} мин.</p>}</li>)}
    </ul> : <p className={styles.hint}>На карте нет подходящих ягодных кустов.</p>}
    <p className={styles.hint}>{snapshot.managed
      ? "Рост следует таймеру хозяйства; дождь и полив меняют только влажность. Для проверки завершите ожидание производства во вкладке «Читы», затем нажмите «Собрать» в меню куста. Новая фаза сбора длится минимум 8 секунд; урожай поступает в кладовую после подтверждения сервера."
      : "Изолированная декоративная сцена: ягоды растут во время симуляции, а корзинка не выдаёт предметы. В игре рост и получение урожая определяются заданиями хозяйства."}</p>
  </div>;
}

/** Session time, not the wall clock; pauses never age a decision. */
export function decisionTime(seconds: number) {
  const total = Math.floor(Math.max(0, Number.isFinite(seconds) ? seconds : 0));
  const minutes = Math.floor(total / 60), remainder = total % 60;
  return `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/** Explicit allowlist: a debug report never copies account/session identifiers or credentials. */
export function createForestAiReport(observation: ForestObservation, exportedAt = Date.now(), capturedAt?: number) {
  return {
    schemaVersion: 1,
    kind: "forest-ai-observation",
    exportedAt: new Date(exportedAt).toISOString(),
    ...(capturedAt !== undefined && Number.isFinite(capturedAt) && Number.isFinite(new Date(capturedAt).getTime())
      ? { capturedAt: new Date(capturedAt).toISOString() } : {}),
    note: "Снимок состояния и последних решений. Не содержит записи для воспроизведения сцены.",
    activity: text(observation.activity), detail: text(observation.detail), mood: text(observation.mood),
    sleeping: observation.sleeping, paused: observation.paused,
    needs: Object.fromEntries(NEEDS.map(([key]) => [key, observation.needs[key]])),
    memory: { status: observation.memory.status, savedAt: observation.memory.savedAt,
      ...(observation.memory.sync ? { sync: { mode: observation.memory.sync.mode,
        revision: observation.memory.sync.revision, serverSavedAt: observation.memory.sync.serverSavedAt } } : {}) },
    diagnostics: {
      reason: text(observation.diagnostics.reason),
      ...(observation.diagnostics.motives ? { motives: Object.fromEntries(MOTIVES.map(([key]) =>
        [key, percent(observation.diagnostics.motives![key]) / 100])) } : {}),
      ...(observation.diagnostics.garden ? { garden: gardenReport(observation.diagnostics.garden) } : {}),
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
export function ForestAiDiagnostics({ observation, onExport, eventFilter = "all", onEventFilterChange }: {
  observation: ForestObservation | null;
  onExport?: () => void;
  eventFilter?: ForestAiEventFilter;
  onEventFilterChange?: (filter: ForestAiEventFilter) => void;
}) {
  if (!observation) return <p className={styles.hint}>Данные появятся, когда сцена леса будет готова.</p>;
  const candidates = observation.diagnostics.candidates.slice(0, 32)
    .sort((a, b) => Number(b.available) - Number(a.available) || b.score - a.score);
  const recentEvents = observation.diagnostics.events.slice(-24);
  const events = recentEvents.filter(event => eventFilter === "all" || eventKind(event.type).group === eventFilter).reverse();
  const savedAt = observation.memory.sync ? observation.memory.sync.serverSavedAt : observation.memory.savedAt;
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
    {observation.diagnostics.motives && <details className={styles.aiChoices}>
      <summary>Скрытые мотивы</summary>
      <p className={styles.hint}>Возбуждение меняет предпочтение активных и спокойных занятий. Впечатления насыщают интерес, а повторы побуждают попробовать другое.</p>
      <div className={styles.aiNeeds} aria-label="Скрытые мотивы Мохлика">
        {MOTIVES.map(([key, label]) => {
          const value = percent(observation.diagnostics.motives![key]);
          return <label key={key} className={styles.aiNeed}>
            <span>{label}<b>{value}%</b></span>
            <meter aria-label={label} min={0} max={100} value={value}>{value}%</meter>
          </label>;
        })}
      </div>
      <p className={styles.hint}>Это кратковременное состояние и выводы из недавних занятий. Нулевое внимание к игроку означает, что Мохлик занят своими делами.</p>
    </details>}
    {observation.diagnostics.garden && <details className={styles.aiChoices}>
      <summary>Ягодный куст и корзинка</summary>
      <ForestGardenDiagnostics garden={observation.diagnostics.garden} />
    </details>}
    <div className={styles.aiMemory}>
      <strong>Память</strong><span>{MEMORY_LABELS[observation.memory.status]}</span>
      {observation.memory.sync && <span>{SYNC_LABELS[observation.memory.sync.mode]} · revision {observation.memory.sync.revision ?? "—"}</span>}
      {validSavedDate && <time dateTime={validSavedDate.toISOString()}>
        {observation.memory.sync ? "Последняя серверная запись" : "Последняя запись"}: {validSavedDate.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
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
      <h3>Последние события · {eventFilter === "all" ? events.length : `${events.length} из ${recentEvents.length}`}</h3>
      <p className={styles.hint}>Новые — сверху. Время указано от начала симуляции; пауза его останавливает.</p>
      {onEventFilterChange && <label className={styles.field}>
        <span>Показать в журнале</span>
        <select value={eventFilter} onChange={event => onEventFilterChange(event.target.value as ForestAiEventFilter)}>
          {EVENT_FILTERS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
      </label>}
      {events.length ? <ol className={styles.aiList} tabIndex={0} aria-label="Журнал решений">
        {events.map((event, index) => <li key={`${event.id}:${index}`}>
          <div className={styles.aiEventMeta}>
            <span className={styles.aiEventKind} data-kind={event.type}>{eventKind(event.type).label}</span>
            <span className={styles.aiTime} aria-label={`${decisionTime(event.at)} от начала симуляции`}>{decisionTime(event.at)}</span></div>
          <strong>{event.label}</strong>
          {event.reason && <p>{event.reason}</p>}
        </li>)}
      </ol> : <p className={styles.aiEmpty}>{recentEvents.length ? EVENT_EMPTY[eventFilter] : EVENT_EMPTY.all}
        {recentEvents.length > 0 && eventFilter !== "all" && " Выберите «Все события», чтобы увидеть остальные записи."}</p>}
      {eventFilter === "issues" && events.length > 0 && <p className={styles.hint}>Прерывание бывает обычной реакцией на игрока или смену условий. Причина указана под занятием.</p>}
    </div>
    {onExport && <div className={styles.aiExport}>
      <button type="button" onClick={onExport}>Скачать диагностику JSON</button>
      <p className={styles.hint}>Снимок состояния и решений для разбора бага. Не является записью для воспроизведения.</p>
    </div>}
  </div>;
}
