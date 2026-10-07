"use client";

import { ChevronRight, Heart, Leaf, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { GameLevelIcon } from "@/features/game/game-level-icon";
import type { EconomyController } from "@/features/economy/use-economy";
import { formatDayCount } from "@/lib/daily-streak";
import { BOOK_COLLECTION_COUNT, COLLECTION_CHAPTERS, collectionBookEntries } from "./collection-book";
import type { WorldController } from "./use-world";
import { useForestObservation, type ForestObservation } from "./use-forest-observation";
import { takeOverForestSession } from "./forest-session";
import { WorldMoodModule } from "./world-mood-module";
import { WorldProfileFriends, type WorldFriendsState } from "./world-profile-friends";
import styles from "./world-profile-menu.module.css";

export type WorldProfileTab = "profile" | "mood" | "friends";
type Props = {
  world: WorldController;
  economy: EconomyController;
  presenceKey: string;
  displayName: string;
  level: number;
  bestStreakDays: number;
  onCall?: () => void;
  rewards?: ReactNode;
  initialTab?: WorldProfileTab;
  friends?: WorldFriendsState;
  onOpenPeople?: () => void;
  onOpenHelp?: () => void;
  onOpenFood?: () => void;
};

const tabs = [
  { id: "profile", label: "Профиль" },
  { id: "mood", label: "Настроение" },
  { id: "friends", label: "Друзья" },
] as const;

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

/** A new owner or requested destination resets the local tab and call feedback. */
export function WorldProfileMenu(props: Props) {
  return <WorldProfileSession key={`${props.presenceKey}:${props.initialTab ?? "profile"}`} {...props} />;
}

function WorldProfileSession({ presenceKey, ...props }: Props) {
  const observation = useForestObservation(presenceKey);
  const [activeTab, setActiveTab] = useState<WorldProfileTab>(props.initialTab ?? "profile");
  const [callPulse, setCallPulse] = useState(0);
  const idPrefix = useId();
  const callTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (callTimer.current) clearTimeout(callTimer.current); }, []);
  const call = props.onCall ? () => {
    if (callTimer.current) clearTimeout(callTimer.current);
    setCallPulse(value => value + 1);
    try { navigator.vibrate?.(12); } catch { /* Visual feedback works without device vibration. */ }
    props.onCall?.();
    callTimer.current = setTimeout(() => setCallPulse(0), 1200);
  } : undefined;
  return <WorldProfileContent {...props} observation={observation} onCall={call} callPulse={callPulse}
    activeTab={activeTab} onTabChange={setActiveTab} idPrefix={idPrefix} onTakeOver={() => takeOverForestSession(presenceKey)} />;
}

/** Pure contents keep map focus ownership separate from data subscriptions. */
export function WorldProfileContent({ world, economy, displayName, level, bestStreakDays, observation, onCall, onTakeOver,
  rewards, callPulse = 0, initialTab = "profile", activeTab = initialTab, onTabChange, idPrefix = "world-profile",
  friends, onOpenPeople, onOpenHelp, onOpenFood }: Omit<Props, "presenceKey"> & {
  observation: ForestObservation | null;
  onTakeOver?: () => void;
  callPulse?: number;
  activeTab?: WorldProfileTab;
  onTabChange?: (tab: WorldProfileTab) => void;
  idPrefix?: string;
}) {
  const state = world.snapshot?.state;
  const houseLevel = economy.snapshot?.buildings.home ?? state?.houseLevel;
  const bookCount = state && economy.snapshot ? COLLECTION_CHAPTERS.reduce((total, chapter) =>
    total + collectionBookEntries(chapter.id, state.collection, economy.snapshot).filter(entry => entry.owned).length, 0) : null;
  const sync = observation?.memory.sync;
  const memoryWarning = sync ? ["offline", "other-device", "error"].includes(sync.mode) : observation?.memory.status === "unavailable";
  const changeWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    onTabChange?.(tabs[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };
  const memoryConfirmed = sync ? sync.mode === "synced" && sync.serverSavedAt !== null
    : observation?.memory.status === "saved" || observation?.memory.status === "restored";
  const memory = observation && <div className={styles.memory} data-warning={memoryWarning || undefined}>
    <p>{memoryConfirmed && <ShieldCheck size={13} aria-hidden="true" />}{memoryMessage(observation)}</p>
    {sync?.canTakeOver && onTakeOver && <button type="button" className={styles.action} onClick={onTakeOver}>Продолжить здесь</button>}
  </div>;

  return <div className={styles.profile}>
    <div className={styles.tabs} role="tablist" aria-label="Разделы профиля">
      {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`${idPrefix}-tab-${tab.id}`}
        aria-selected={activeTab === tab.id} aria-controls={`${idPrefix}-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1}
        onClick={() => onTabChange?.(tab.id)} onKeyDown={event => changeWithKeyboard(event, index)}>{tab.label}</button>)}
    </div>
    {memoryWarning && memory}
    <div className={styles.panel} role="tabpanel" id={`${idPrefix}-panel-${activeTab}`} aria-labelledby={`${idPrefix}-tab-${activeTab}`} tabIndex={0}>
      {activeTab === "profile" && <>
        <div className={styles.identity}>
          <span className={styles.levelIcon}><GameLevelIcon level={level} size={27} /></span>
          <div><h2>{displayName}</h2><p>Уровень {level}</p></div>
        </div>
        <button type="button" className={styles.moodPreview} onClick={() => onTabChange?.("mood")} aria-label="Открыть настроение Мохлика">
          <Leaf size={18} aria-hidden="true" /><span><small>{observation?.paused ? "Полянка на паузе" : "Как Мохлик?"}</small>
            <strong>{observation?.mood ?? "Полянка загружается"}</strong></span><ChevronRight size={16} aria-hidden="true" />
        </button>
        <dl className={styles.stats} aria-label="Достижения Мохлика">
          <div><dt>Дом</dt><dd>{houseLevel === undefined ? "—" : `${houseLevel} ур.`}</dd></div>
          <div><dt>Исследования</dt><dd>{economy.snapshot?.completedExplorations ?? "—"}</dd></div>
          <div><dt>Книга находок</dt><dd>{bookCount === null ? "—" : `${bookCount} / ${BOOK_COLLECTION_COUNT}`}</dd></div>
          {!!state?.completedJourneys && <div><dt>Прежние походы</dt><dd>{state.completedJourneys}</dd></div>}
          <div><dt>Лучшая серия отметок</dt><dd>{formatDayCount(bestStreakDays)}</dd></div>
        </dl>
        {(rewards || onCall) && <div className={styles.actions}>{rewards}
          {onCall && <button type="button" className={styles.action} data-called={callPulse > 0 || undefined} disabled={!observation || observation.paused} onClick={onCall}>
            <Heart key={callPulse} size={15} aria-hidden="true" />{callPulse > 0 ? "Мохлик, иди сюда!" : observation?.sleeping ? "Разбудить Мохлика" : "Позвать Мохлика"}
          </button>}
        </div>}
      </>}
      {activeTab === "mood" && <WorldMoodModule observation={observation} economy={economy} onCall={onCall} callPulse={callPulse} onOpenHelp={onOpenHelp} onOpenFood={onOpenFood} />}
      {activeTab === "friends" && <WorldProfileFriends friends={friends} onOpenPeople={onOpenPeople} />}
    </div>
    {!memoryWarning && memory}
  </div>;
}
