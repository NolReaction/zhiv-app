"use client";

import { Heart, Leaf, Search, Sprout } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { GameLevelIcon } from "@/features/game/game-level-icon";
import type { EconomyController } from "@/features/economy/use-economy";
import { formatDayCount } from "@/lib/daily-streak";
import { BOOK_COLLECTION_COUNT, COLLECTION_CHAPTERS, collectionBookEntries } from "./collection-book";
import type { WorldController } from "./use-world";
import { useForestObservation, type ForestObservation } from "./use-forest-observation";
import { takeOverForestSession } from "./forest-session";
import styles from "./world-profile-menu.module.css";

type Props = {
  world: WorldController;
  economy: EconomyController;
  presenceKey: string;
  displayName: string;
  level: number;
  bestStreakDays: number;
  onCall?: () => void;
  rewards?: ReactNode;
};

const feelings = {
  energy: { title: "Силы", Icon: Sprout, labels: ["Пора передохнуть", "На спокойной волне", "Полон сил"] },
  curiosity: { title: "Любопытство", Icon: Search, labels: ["Уже нагулялся", "Присматривается", "Хочется открытий"] },
  comfort: { title: "Уют", Icon: Leaf, labels: ["Ищет место поуютнее", "Устраивается", "Чувствует себя уютно"] },
  attention: { title: "Общение", Icon: Heart, labels: ["Занят своими делами", "Помнит, что ты рядом", "Рад тебя видеть"] },
} as const;

function memoryMessage(observation: ForestObservation) {
  const sync = observation.memory.sync;
  if (sync) return {
    loading: "Загружаем память Мохлика…",
    synced: sync.serverSavedAt === null ? "Готовим первое сохранение в аккаунте…" : "Память сохранена в аккаунте.",
    saving: "Сохраняем память в аккаунте…",
    offline: "Нет связи с аккаунтом. Когда она вернётся, загрузится последнее подтверждённое сохранение.",
    "other-device": "Мохлик на другом устройстве или в другой вкладке. Здесь полянка на паузе.",
    error: "Не удалось загрузить память аккаунта. Попробуй перезагрузить приложение.",
    disabled: "Просмотр DEV: память Мохлика не сохраняется.",
  }[sync.mode];
  if (observation.memory.status === "saved" || observation.memory.status === "restored") return "Память сохранена только на этом устройстве.";
  if (observation.memory.status === "unavailable") return "Не удаётся сохранить память на устройстве. Полянка продолжает жить, пока приложение открыто.";
  return "Память сохраняется только на время этой сессии.";
}

/** Content for the profile popover; the map owns its frame, focus and dismissal. */
export function WorldProfileMenu({ presenceKey, ...props }: Props) {
  const observation = useForestObservation(presenceKey);
  const [callPulse, setCallPulse] = useState(0);
  const callTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (callTimer.current) clearTimeout(callTimer.current); }, []);
  const call = props.onCall ? () => {
    if (callTimer.current) clearTimeout(callTimer.current);
    setCallPulse(value => value + 1);
    try { navigator.vibrate?.(12); } catch { /* Visual feedback works without device vibration. */ }
    props.onCall?.();
    callTimer.current = setTimeout(() => setCallPulse(0), 1200);
  } : undefined;
  return <WorldProfileContent {...props} observation={observation} onCall={call} callPulse={callPulse} onTakeOver={() => takeOverForestSession(presenceKey)} />;
}

export function WorldProfileContent({ world, economy, displayName, level, bestStreakDays, observation, onCall, onTakeOver, rewards, callPulse = 0 }: Omit<Props, "presenceKey"> & {
  observation: ForestObservation | null;
  onTakeOver?: () => void;
  callPulse?: number;
}) {
  const state = world.snapshot?.state;
  const houseLevel = economy.snapshot?.buildings.home ?? state?.houseLevel;
  const bookCount = state && economy.snapshot ? COLLECTION_CHAPTERS.reduce((total, chapter) =>
    total + collectionBookEntries(chapter.id, state.collection, economy.snapshot).filter(entry => entry.owned).length, 0) : null;
  const sync = observation?.memory.sync;
  const memoryWarning = sync ? ["offline", "other-device", "error"].includes(sync.mode) : observation?.memory.status === "unavailable";

  return <div className={styles.profile}>
    <div className={styles.identity}>
      <span className={styles.levelIcon}><GameLevelIcon level={level} size={27} /></span>
      <div><h2>{displayName}</h2><p>Уровень {level}</p></div>
    </div>

    {observation ? <>
      <section className={styles.mood} aria-label="Настроение Мохлика">
        <span>{observation.paused ? "Полянка на паузе" : "Настроение"}</span>
        <h3>{observation.mood}</h3>
      </section>
      <dl className={styles.feelings} aria-label="Самочувствие Мохлика">
        {(Object.keys(feelings) as (keyof typeof feelings)[]).map(key => {
          const { title, Icon, labels } = feelings[key];
          const value = observation.needs[key];
          return <div key={key}>
            <dt><Icon size={13} aria-hidden="true" />{title}</dt>
            <dd>{labels[value < .3 ? 0 : value < .65 ? 1 : 2]}</dd>
          </div>;
        })}
      </dl>
    </> : <p className={styles.waiting}>Состояние появится, когда полянка загрузится.</p>}

    <dl className={styles.stats} aria-label="Достижения Мохлика">
      <div><dt>Дом</dt><dd>{houseLevel === undefined ? "—" : `${houseLevel} ур.`}</dd></div>
      <div><dt>Исследования</dt><dd>{economy.snapshot?.completedExplorations ?? "—"}</dd></div>
      <div><dt>Книга находок</dt><dd>{bookCount === null ? "—" : `${bookCount} / ${BOOK_COLLECTION_COUNT}`}</dd></div>
      {!!state?.completedJourneys && <div><dt>Прежние походы</dt><dd>{state.completedJourneys}</dd></div>}
      <div><dt>Лучшая серия отметок</dt><dd>{formatDayCount(bestStreakDays)}</dd></div>
    </dl>

    {observation && <div className={styles.memory} data-warning={memoryWarning || undefined}>
      <p>{memoryMessage(observation)}</p>
      {sync?.canTakeOver && onTakeOver && <button type="button" className={styles.action} onClick={onTakeOver}>Продолжить здесь</button>}
    </div>}
    {(rewards || onCall) && <div className={styles.actions}>{rewards}
      {onCall && <button type="button" className={styles.action} data-called={callPulse > 0 || undefined} disabled={!observation || observation.paused} onClick={onCall}>
        <Heart key={callPulse} size={15} aria-hidden="true" />{callPulse > 0 ? "Мохлик, иди сюда!" : "Позвать Мохлика"}
      </button>}
    </div>}
  </div>;
}
