"use client";

import { AudioSettingsPanel } from "@/features/audio/ui/audio-settings";
import { playUiCue } from "@/features/audio/ui/audio-lifecycle";
import { getAudioRuntime } from "@/features/audio/runtime/audio-service";
import { ChevronRight, Heart, Leaf, Settings, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { GameLevelIcon } from "@/features/game/game-level-icon";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import { formatDayCount } from "@/lib/daily-streak";
import { BOOK_COLLECTION_COUNT, COLLECTION_CHAPTERS, collectionBookEntries } from "@/features/world/domain/collection-book";
import type { WorldController } from "@/features/world/state/use-world";
import { useForestObservation, type ForestObservation } from "@/features/world/state/use-forest-observation";
import { takeOverForestSession } from "@/features/world/state/forest-session";
import { WorldMoodDialog } from "./world-mood-dialog";
import { WorldProfileFriends, type WorldFriendsState } from "./world-profile-friends";
import styles from "./world-profile-menu.module.css";

export type WorldProfileTab = "profile" | "friends" | "settings";
/** Older help destinations still open the mood dialog, never a fourth tab. */
export type WorldProfileDestination = WorldProfileTab | "mood";
type Props = {
  world: WorldController;
  economy: EconomyController;
  presenceKey: string;
  displayName: string;
  level: number;
  bestStreakDays: number;
  onCall?: () => void;
  rewards?: ReactNode;
  initialTab?: WorldProfileDestination;
  friends?: WorldFriendsState;
  onOpenPeople?: () => void;
  onOpenHelp?: () => void;
  onOpenFood?: () => void;
};

const tabs = [
  { id: "profile", label: "Профиль" },
  { id: "friends", label: "Друзья" },
  { id: "settings", label: "Настройки" },
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
  const [activeTab, setActiveTab] = useState<WorldProfileTab>(props.initialTab === "mood" ? "profile" : props.initialTab ?? "profile");
  const [moodOpen, setMoodOpen] = useState(props.initialTab === "mood");
  const moodTrigger = useRef<HTMLButtonElement>(null);
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
  return <>
    <WorldProfileContent {...props} observation={observation} onCall={call} callPulse={callPulse}
      activeTab={activeTab} onTabChange={setActiveTab} idPrefix={idPrefix} onTakeOver={() => takeOverForestSession(presenceKey)}
      onOpenMood={() => setMoodOpen(true)} moodTriggerRef={moodTrigger} />
    <WorldMoodDialog open={moodOpen} onOpenChange={setMoodOpen} returnFocusRef={moodTrigger}
      observation={observation} economy={props.economy} onCall={call} callPulse={callPulse}
      onOpenHelp={props.onOpenHelp} onOpenFood={props.onOpenFood} />
  </>;
}

/** Pure contents keep map focus ownership separate from data subscriptions. */
export function WorldProfileContent({ world, economy, displayName, level, bestStreakDays, observation, onCall, onTakeOver,
  rewards, callPulse = 0, initialTab = "profile", activeTab = initialTab === "mood" ? "profile" : initialTab, onTabChange, idPrefix = "world-profile",
  friends, onOpenPeople, onOpenMood, moodTriggerRef }: Omit<Props, "presenceKey"> & {
  observation: ForestObservation | null;
  onTakeOver?: () => void;
  callPulse?: number;
  activeTab?: WorldProfileTab;
  onTabChange?: (tab: WorldProfileTab) => void;
  idPrefix?: string;
  onOpenMood?: () => void;
  moodTriggerRef?: RefObject<HTMLButtonElement | null>;
}) {
  const state = world.snapshot?.state;
  const houseLevel = economy.snapshot?.buildings.home ?? state?.houseLevel;
  const bookCount = state && economy.snapshot ? COLLECTION_CHAPTERS.reduce((total, chapter) =>
    total + collectionBookEntries(chapter.id, state.collection, economy.snapshot).filter(entry => entry.owned).length, 0) : null;
  const sync = observation?.memory.sync;
  const memoryWarning = sync ? ["offline", "other-device", "error"].includes(sync.mode) : observation?.memory.status === "unavailable";
  const changeTab = (tab: WorldProfileTab) => {
    if (tab === activeTab || !onTabChange) return;
    playUiCue(getAudioRuntime(), "ui.tab");
    onTabChange(tab);
  };
  const changeWithKeyboard = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
      : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    changeTab(tabs[next].id);
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
      {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" aria-label={tab.label} title={tab.id === "settings" ? tab.label : undefined} id={`${idPrefix}-tab-${tab.id}`}
        aria-selected={activeTab === tab.id} aria-controls={`${idPrefix}-panel-${tab.id}`} tabIndex={activeTab === tab.id ? 0 : -1}
        onClick={() => changeTab(tab.id)} onKeyDown={event => changeWithKeyboard(event, index)}>{tab.id === "settings" ? <Settings size={19} aria-hidden="true" /> : tab.label}</button>)}
    </div>
    {memoryWarning && memory}
    <div className={styles.panel} role="tabpanel" id={`${idPrefix}-panel-${activeTab}`} aria-labelledby={`${idPrefix}-tab-${activeTab}`} tabIndex={0}>
      {activeTab === "profile" && <>
        <div className={styles.identity}>
          <span className={styles.levelIcon}><GameLevelIcon level={level} size={27} /></span>
          <div><h2>{displayName}</h2><p>Уровень {level}</p></div>
        </div>
        <button ref={moodTriggerRef} type="button" className={styles.moodPreview} onClick={onOpenMood} aria-label="Как Мохлик?" aria-haspopup="dialog" data-audio-cue="ui.open">
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
      {activeTab === "friends" && <WorldProfileFriends friends={friends} onOpenPeople={onOpenPeople} />}
      {activeTab === "settings" && <AudioSettingsPanel tone="forest" />}
    </div>
    {!memoryWarning && memory}
  </div>;
}
