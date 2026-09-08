"use client";

import dynamic from "next/dynamic";
import { AppNavigation, appViews, type AppView } from "@/features/app/navigation";

import { GameLevelIcon } from "./game-level-icon";

import type {
  CSSProperties,
  FormEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Flame, Copy, Trophy, Map } from "lucide-react";
import type {
  DailyStreak,
  GroupsResponse,
  MeResponse,
  PeopleResponse,
} from "@/lib/check-in-contract";
import {
  ApiError,
  bootstrap,
  createCheckIn,
  getGroups,
  getMe,
  getPeople,
  isCheckInCooldownResponse,
  reportClickerSeries,
} from "@/lib/check-in-api";
import {
  formatLastCheckIn,
  getCheckInAgeMs,
  getCheckInPalette,
  isValidDisplayName,
  limitDisplayNameInput,
  normalizeDisplayName,
} from "@/lib/check-in-presentation";
import {
  advanceClickerRun,
  CLICKER_IDLE_RESET_MS,
  clickerSeedFromPublicId,
  combineLegacyClickerProgress,
  createClickerRun,
  expireClickerSeries,
  getClickerLevel,
  getClickerLevelProgress,
  getClickerSeriesTimer,
  mergeClickerProgress,
  parseClickerProgress,
  planClickerTap,
  serializeClickerProgress,
  type ClickerEffect,
  type ClickerExpiry,
  type ClickerFinishedSeries,
  type ClickerRun,
} from "@/lib/clicker-story";
import {
  isWithinGameTapArea,
  shouldCountGameClick,
  shouldCountGamePointer,
} from "@/lib/tap-input";
import { formatDayCount, getDailyStreakMessage } from "@/lib/daily-streak";
import { PeopleView } from "./people-view";
import { ProfileView } from "./profile-view";
import { CheckInCalendar } from "./check-in-calendar";
import { GameLeaderboardDialog } from "./game-leaderboard";
import { useGameProgress } from "@/hooks/use-game-progress";
import { CapabilityLanding } from "./capability-landing";
import { RecoveryStarter } from "./recovery-starter";
import { AccountEntry, AuthReturnNotice } from "./account-entry";
import { StatusEditor } from "./status-editor";
import { CheckInReceipt } from "./check-in-receipt";
import { useSimpleView } from "@/hooks/use-simple-view";
import { useWorldPortal } from "@/hooks/use-world-portal";
import { useWorld } from "@/features/world/use-world";
import { MochlikTerrarium } from "./mochlik-terrarium";
import styles from "./check-in-app.module.css";
import glass from "./glass-action.module.css";
import { notify, TransientNotice } from "./app-notifications";
import { createUuidV4 } from "@/lib/browser-uuid";
import { copyText } from "@/lib/identity-sharing";

type Screen = "loading" | "load-error" | "onboarding" | "home" | "session-lost";
type ActiveView = AppView;
const WorldPortal = dynamic(() => import("@/features/world/world-portal"), { ssr: false });

type PendingBootstrap = {
  version: 1;
  kind: "bootstrap";
  idempotencyKey: string;
  displayName: string;
  createdAt: number;
  expiresAt: number;
};

type PendingCheckIn = {
  version: 2;
  kind: "check-in";
  idempotencyKey: string;
  ownerPublicId: string;
  previousLastCheckInAt: string | null;
  createdAt: number;
  expiresAt: number;
};

const PENDING_BOOTSTRAP_STORAGE_KEY = "zhiv.pending-bootstrap.v1";
const PENDING_CHECK_IN_STORAGE_KEY = "zhiv.pending-check-in.v2";
const LEGACY_PENDING_CHECK_IN_STORAGE_KEY = "zhiv.pending-check-in.v1";
const CLICKER_PROGRESS_STORAGE_PREFIX = "zhiv.clicker-progress.v3";
const LEGACY_V2_CLICKER_PROGRESS_STORAGE_PREFIX = "zhiv.clicker-progress.v2";
const LEGACY_V1_CLICKER_PROGRESS_STORAGE_PREFIX = "zhiv.clicker-progress.v1";
const PENDING_BOOTSTRAP_TTL_MS = 10 * 60_000;
const PENDING_CHECK_IN_TTL_MS = 24 * 60 * 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_ID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){2}$/;

const CONFETTI = [
  { x: -118, y: -118, r: -100, color: "#f5e85b" },
  { x: -54, y: -154, r: 80, color: "#f49e4c" },
  { x: 18, y: -164, r: -45, color: "#e85d75" },
  { x: 92, y: -132, r: 120, color: "#63c7b2" },
  { x: 142, y: -62, r: -70, color: "#f5e85b" },
  { x: 154, y: 24, r: 90, color: "#f49e4c" },
  { x: 108, y: 104, r: -110, color: "#e85d75" },
  { x: 28, y: 150, r: 60, color: "#63c7b2" },
  { x: -62, y: 142, r: -80, color: "#f5e85b" },
  { x: -132, y: 84, r: 100, color: "#f49e4c" },
  { x: -156, y: 4, r: -60, color: "#e85d75" },
  { x: -146, y: -68, r: 75, color: "#63c7b2" },
] as const;

const STORY_EFFECT_DURATION_MS: Record<ClickerEffect, number> = {
  confetti: 1_150,
  rings: 1_400,
  sparks: 1_150,
  finale: 1_650,
  orbit: 1_650,
  comet: 1_750,
  legend: 2_100,
  champion: 2_500,
};

function serverOffset(serverTime: string): number {
  return Date.parse(serverTime) - Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasValidPendingEnvelope(
  value: Record<string, unknown>,
  version: 1 | 2,
): boolean {
  return (
    value.version === version &&
    typeof value.idempotencyKey === "string" &&
    UUID_PATTERN.test(value.idempotencyKey) &&
    typeof value.createdAt === "number" &&
    Number.isFinite(value.createdAt) &&
    typeof value.expiresAt === "number" &&
    Number.isFinite(value.expiresAt) &&
    value.expiresAt > value.createdAt
  );
}

function isPendingBootstrap(value: unknown): value is PendingBootstrap {
  return (
    isRecord(value) &&
    hasValidPendingEnvelope(value, 1) &&
    value.kind === "bootstrap" &&
    typeof value.displayName === "string" &&
    value.displayName === normalizeDisplayName(value.displayName) &&
    isValidDisplayName(value.displayName)
  );
}

function isPendingCheckIn(value: unknown): value is PendingCheckIn {
  return (
    isRecord(value) &&
    hasValidPendingEnvelope(value, 2) &&
    value.kind === "check-in" &&
    typeof value.ownerPublicId === "string" &&
    PUBLIC_ID_PATTERN.test(value.ownerPublicId) &&
    (value.previousLastCheckInAt === null ||
      typeof value.previousLastCheckInAt === "string")
  );
}

function removePending(storageKey: string) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(storageKey);
  } catch {
    // A disabled or quota-constrained sessionStorage must not block check-in.
  }
}

function readPending<T>(
  storageKey: string,
  validate: (value: unknown) => value is T,
): T | null {
  if (typeof window === "undefined") return null;

  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (!validate(value) || (value as { expiresAt: number }).expiresAt <= Date.now()) {
      removePending(storageKey);
      return null;
    }
    return value;
  } catch {
    removePending(storageKey);
    return null;
  }
}

function persistPending(storageKey: string, value: PendingBootstrap | PendingCheckIn) {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.setItem(storageKey, JSON.stringify(value));
  } catch {
    // The in-memory ref still preserves idempotency for this mounted session.
  }
}

function clickerStorageKey(publicId: string, prefix = CLICKER_PROGRESS_STORAGE_PREFIX): string {
  return `${prefix}:${publicId}`;
}

function archiveLocalGame(publicId: string, progress: ClickerRun) {
  try {
    const key = `zhiv.clicker-archive.v054:${publicId}`;
    const saved = parseClickerProgress(window.localStorage.getItem(key) ?? "", progress.storySeed);
    if (!saved) window.localStorage.setItem(key, serializeClickerProgress(progress));
    const source = saved ?? progress;
    return { lifetimeTaps: source.lifetimeTaps, bestSeries: source.bestSeries };
  } catch { return { lifetimeTaps: progress.lifetimeTaps, bestSeries: progress.bestSeries }; }
}

function restoreClickerRun(publicId: string, storySeed: number): ClickerExpiry {
  if (typeof window === "undefined") {
    return { progress: createClickerRun(storySeed), finishedSeries: null };
  }
  try {
    const stored = parseClickerProgress(
      window.localStorage.getItem(clickerStorageKey(publicId)) ?? "",
      storySeed,
    );
    const legacyV2 = stored ? null : parseClickerProgress(
      window.localStorage.getItem(
        clickerStorageKey(publicId, LEGACY_V2_CLICKER_PROGRESS_STORAGE_PREFIX),
      ) ?? "",
      storySeed,
    );
    const legacyV1 = stored ? null : parseClickerProgress(
      window.localStorage.getItem(
        clickerStorageKey(publicId, LEGACY_V1_CLICKER_PROGRESS_STORAGE_PREFIX),
      ) ?? "",
      storySeed,
    );
    const progress = stored ?? combineLegacyClickerProgress(legacyV2, legacyV1, storySeed);
    if (!stored) {
      window.localStorage.setItem(
        clickerStorageKey(publicId),
        serializeClickerProgress(progress),
      );
    }
    return expireClickerSeries(progress, Date.now());
  } catch {
    return { progress: createClickerRun(storySeed), finishedSeries: null };
  }
}

type SeriesResult = Pick<ClickerFinishedSeries, "eventId" | "tapCount" | "isRecord">;

function TapCounter({ progress, result, count, isRecord }: {
  progress: ClickerRun; result: SeriesResult | null; count: number; isRecord: boolean;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const deadlineMs = progress.activeSeries
    ? progress.activeSeries.lastTapAtMs + CLICKER_IDLE_RESET_MS
    : null;

  useEffect(() => {
    if (deadlineMs === null) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [deadlineMs]);

  const active = progress.activeSeries;
  if (!active && !result) return null;
  const timer = getClickerSeriesTimer(progress, nowMs);
  const seconds = Math.max(0, Math.ceil(timer.remainingMs / 1_000));
  const urgency = timer.remainingRatio <= 0.2
    ? "critical"
    : timer.remainingRatio <= 0.5
      ? "warning"
      : "steady";
  const timerStyle = {
    "--series-remaining": timer.remainingRatio,
  } as CSSProperties;

  return (
    <span
      className={styles.tapCounter}
      data-urgency={urgency}
      data-state={active ? "active" : "finished"}
      style={timerStyle}
      aria-hidden="true"
    >
      <strong>{!active && isRecord ? "Рекорд " : ""}×{count.toLocaleString("ru-RU")}</strong>
      {active ? <small>{seconds}с</small> : null}
      {active ? <i className={styles.tapCounterProgress} /> : null}
    </span>
  );
}

export function CheckInApp() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [lastCheckInAt, setLastCheckInAt] = useState<string | null>(null);
  const [streak, setStreak] = useState<DailyStreak | null>(null);
  const [nextAllowedAt, setNextAllowedAt] = useState<string | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [clientNowMs, setClientNowMs] = useState(() => Date.now());
  const [isSending, setIsSending] = useState(false);
  const [checkInUnconfirmed, setCheckInUnconfirmed] = useState(false);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [clickerRun, setClickerRun] = useState<ClickerRun>(() => createClickerRun());
  const [legacyGame, setLegacyGame] = useState({ lifetimeTaps: 0, bestSeries: 0 });
  const [seriesSummary, setSeriesSummary] = useState<SeriesResult | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storyEffect, setStoryEffect] = useState<{
    type: ClickerEffect;
    burst: number;
  } | null>(null);
  const [tapFeedbackBurst, setTapFeedbackBurst] = useState(0);
  const [tapActive, setTapActive] = useState(false);
  const [seriesBreakBurst, setSeriesBreakBurst] = useState<number | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>("check-in");
  const [viewDirection, setViewDirection] = useState(1);
  const [calendarOpen, setCalendarOpen] = useState(false);
  const [gameOpen, setGameOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const { simpleView, appearanceReady, setSimpleView } = useSimpleView();
  const mochlikVisible = appearanceReady && !simpleView;
  const worldPortal = useWorldPortal(screen === "home" ? me?.user.publicId ?? null : null);
  const [worldMounted, setWorldMounted] = useState(false);
  const closeWorld = worldPortal.close;
  const [mochlikWakeSignal, setMochlikWakeSignal] = useState(0);
  const gameTrigger = useRef<HTMLElement | null>(null);
  const openGame = useCallback((trigger: HTMLButtonElement) => {
    gameTrigger.current = trigger;
    setGameOpen(true);
  }, []);
  const calendarTrigger = useRef<HTMLElement | null>(null);
  const openCalendar = useCallback((trigger: HTMLButtonElement) => {
    calendarTrigger.current = trigger;
    setCalendarOpen(true);
  }, []);
  const selectView = (next: ActiveView) => {
    const order = appViews;
    setViewDirection(order.indexOf(next) >= order.indexOf(activeView) ? 1 : -1);
    setActiveView(next);
    if (next === "profile") void game.refresh();
  };
  const [people, setPeople] = useState<PeopleResponse | null>(null);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [peopleUpdatedAt, setPeopleUpdatedAt] = useState<number | null>(null);
  const [groups, setGroups] = useState<GroupsResponse | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [groupsUpdatedAt, setGroupsUpdatedAt] = useState<number | null>(null);
  const identityEpoch = useRef(0);
  const accountReturn = useRef(false);
  const peopleRequest = useRef(0);
  const groupsRequest = useRef(0);
  const selfRequest = useRef(0);
  const [isIdentityActionPending, setIsIdentityActionPending] = useState(false);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const identityActionPending = useRef(false);
  const checkInSending = useRef(false);
  const clickerRunRef = useRef(clickerRun);
  const recordAtRunStart = useRef<{ runId: string; bestSeries: number | null }>({ runId: "", bestSeries: null });
  const storyEffectBurst = useRef(0);
  const storyEffectType = useRef<ClickerEffect | null>(null);
  const storyEffectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const tapFeedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seriesBreakTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seriesBreakSequence = useRef(0);
  const lastGameTouchAt = useRef(Number.NEGATIVE_INFINITY);
  const pendingCheckIn = useRef<PendingCheckIn | null>(null);
  const pendingBootstrap = useRef<PendingBootstrap | null>(null);
  const homeHeading = useRef<HTMLHeadingElement | null>(null);
  const mainButton = useRef<HTMLButtonElement | null>(null);
  const buttonOrbit = useRef<HTMLDivElement | null>(null);
  const clickerOwnerPublicId = useRef<string | null>(null);
  const clickerPersistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistClickerRun = useCallback((run: ClickerRun) => {
    const publicId = clickerOwnerPublicId.current;
    if (!publicId || typeof window === "undefined") return;
    try {
      const key = clickerStorageKey(publicId);
      const stored = parseClickerProgress(window.localStorage.getItem(key) ?? "");
      const progress = stored ? mergeClickerProgress(stored, run) : run;
      window.localStorage.setItem(key, serializeClickerProgress(progress));
    } catch {
      // Local clicker progress is decorative; storage failure must never block check-in.
    }
  }, []);

  const commitClickerRun = useCallback((run: ClickerRun, persist = true) => {
    clickerRunRef.current = run;
    setClickerRun(run);
    if (!persist) return;
    if (clickerPersistTimer.current) clearTimeout(clickerPersistTimer.current);
    clickerPersistTimer.current = setTimeout(() => {
      persistClickerRun(clickerRunRef.current);
      clickerPersistTimer.current = null;
    }, 650);
  }, [persistClickerRun]);

  const reportFinishedSeries = useCallback((
    finished: ClickerFinishedSeries,
    progress: ClickerRun,
  ) => {
    setSeriesSummary({ eventId: finished.eventId, tapCount: finished.tapCount, isRecord: finished.isRecord });
    void reportClickerSeries({
      eventId: finished.eventId ?? createUuidV4(),
      type: "CLICKER_SERIES_FINISHED",
      tapCount: finished.tapCount,
      bestSeries: progress.bestSeries,
      lifetimeTaps: progress.lifetimeTaps,
      level: getClickerLevel(progress.lifetimeTaps).level,
      storyId: finished.storyId,
      durationMs: finished.durationMs,
      reason: "IDLE_TIMEOUT",
    }).catch(() => {
      // Diagnostic telemetry is best-effort and never changes the game or check-in.
    });
  }, []);

  const clearStoryEffect = useCallback(() => {
    if (storyEffectTimer.current) {
      clearTimeout(storyEffectTimer.current);
      storyEffectTimer.current = null;
    }
    storyEffectType.current = null;
    setStoryEffect(null);
  }, []);

  const clearTapFeedback = useCallback(() => {
    if (tapFeedbackTimer.current) {
      clearTimeout(tapFeedbackTimer.current);
      tapFeedbackTimer.current = null;
    }
    setTapActive(false);
    setTapFeedbackBurst(0);
  }, []);

  const triggerTapFeedback = useCallback(() => {
    if (tapFeedbackTimer.current) clearTimeout(tapFeedbackTimer.current);
    setTapFeedbackBurst((current) => current + 1);
    setTapActive(true);
    tapFeedbackTimer.current = setTimeout(() => {
      setTapActive(false);
      tapFeedbackTimer.current = null;
    }, 110);
  }, []);

  const clearSeriesBreakEffect = useCallback(() => {
    if (seriesBreakTimer.current) {
      clearTimeout(seriesBreakTimer.current);
      seriesBreakTimer.current = null;
    }
    setSeriesBreakBurst(null);
  }, []);

  const triggerSeriesBreakEffect = useCallback(() => {
    if (seriesBreakTimer.current) clearTimeout(seriesBreakTimer.current);
    seriesBreakSequence.current += 1;
    setSeriesBreakBurst(seriesBreakSequence.current);
    seriesBreakTimer.current = setTimeout(() => {
      setSeriesBreakBurst(null);
      seriesBreakTimer.current = null;
    }, 720);
  }, []);

  const clearPendingBootstrap = useCallback(() => {
    pendingBootstrap.current = null;
    removePending(PENDING_BOOTSTRAP_STORAGE_KEY);
  }, []);

  const clearPendingCheckIn = useCallback(() => {
    pendingCheckIn.current = null;
    setCheckInUnconfirmed(false);
    removePending(PENDING_CHECK_IN_STORAGE_KEY);
    removePending(LEGACY_PENDING_CHECK_IN_STORAGE_KEY);
  }, []);

  const resetTransientCheckIn = useCallback(() => {
    if (burstTimer.current) {
      clearTimeout(burstTimer.current);
      burstTimer.current = null;
    }
    clearStoryEffect();
    clearTapFeedback();
    clearSeriesBreakEffect();
    setNextAllowedAt(null);
    commitClickerRun(createClickerRun(), false);
    setStreak(null);
    setNotice(null);
    setSeriesSummary(null);
    setStatusOpen(false);
  }, [
    clearSeriesBreakEffect,
    clearStoryEffect,
    clearTapFeedback,
    commitClickerRun,
  ]);

  const loseSession = useCallback(() => {
    closeWorld();
    setCalendarOpen(false);
    setGameOpen(false);
    identityEpoch.current += 1;
    setPeopleUpdatedAt(null);
    setGroupsUpdatedAt(null);
    if (clickerPersistTimer.current) {
      clearTimeout(clickerPersistTimer.current);
      clickerPersistTimer.current = null;
    }
    persistClickerRun(clickerRunRef.current);
    clearPendingCheckIn();
    clearPendingBootstrap();
    clickerOwnerPublicId.current = null;
    resetTransientCheckIn();
    setPeople(null);
    setGroups(null);
    setActiveView("check-in");
    accountReturn.current = false;
    setScreen("session-lost");
  }, [
    closeWorld,
    clearPendingBootstrap,
    clearPendingCheckIn,
    persistClickerRun,
    resetTransientCheckIn,
  ]);

  const game = useGameProgress({ ownerPublicId: screen === "home" ? me?.user.publicId ?? null : null, isOnline, onSessionLost: loseSession });
  const recordGameTap = game.recordTap;
  const world = useWorld(screen === "home" ? me?.user.publicId ?? null : null, loseSession);
  const worldRefresh = world.refresh;
  useEffect(() => { if (screen === "home" && me) void worldRefresh(); }, [game.progress?.lifetimeTaps, me, screen, worldRefresh]);

  const syncMeSnapshot = useCallback((identity: MeResponse) => {
    // A mutation response supersedes a background read that started before it.
    selfRequest.current += 1;
    const pending = pendingCheckIn.current;
    if (pending && pending.ownerPublicId === identity.user.publicId
      && identity.lastCheckInAt !== pending.previousLastCheckInAt) clearPendingCheckIn();
    setMe(identity);
    setLastCheckInAt(identity.lastCheckInAt);
    setStreak(identity.streak);
    setClockOffsetMs(serverOffset(identity.serverTime));
    setClientNowMs(Date.now());
  }, [clearPendingCheckIn]);

  const refreshPeople = useCallback(async (signal?: AbortSignal) => {
    const epoch = identityEpoch.current;
    const request = ++peopleRequest.current;
    setPeopleLoading(true);
    try {
      const response = await getPeople(signal);
      if (epoch !== identityEpoch.current || request !== peopleRequest.current) return;
      setPeople(response);
      setPeopleUpdatedAt(Date.now());
      setPeopleError(null);
    } catch (error) {
      if (epoch !== identityEpoch.current || request !== peopleRequest.current) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof ApiError && error.status === 401) {
        loseSession();
        return;
      }
      setPeopleError(error instanceof Error ? error.message : "Не удалось загрузить личные связи");
    } finally {
      if (epoch === identityEpoch.current && request === peopleRequest.current) setPeopleLoading(false);
    }
  }, [loseSession]);

  const refreshGroups = useCallback(async (signal?: AbortSignal) => {
    const epoch = identityEpoch.current;
    const request = ++groupsRequest.current;
    setGroupsLoading(true);
    try {
      const response = await getGroups(signal);
      if (epoch !== identityEpoch.current || request !== groupsRequest.current) return;
      setGroups(response);
      setGroupsUpdatedAt(Date.now());
      setGroupsError(null);
    } catch (error) {
      if (epoch !== identityEpoch.current || request !== groupsRequest.current) return;
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof ApiError && error.status === 401) {
        loseSession();
        return;
      }
      setGroupsError(error instanceof Error ? error.message : "Не удалось загрузить группы");
    } finally {
      if (epoch === identityEpoch.current && request === groupsRequest.current) setGroupsLoading(false);
    }
  }, [loseSession]);

  const adoptMe = useCallback((identity: MeResponse) => {
    identityEpoch.current += 1;
    setPeopleUpdatedAt(null);
    setGroupsUpdatedAt(null);
    setPeopleError(null);
    setGroupsError(null);
    const unresolvedCheckIn = pendingCheckIn.current;
    const isAccountSwitch = Boolean(
      clickerOwnerPublicId.current &&
      clickerOwnerPublicId.current !== identity.user.publicId,
    );
    if (
      isAccountSwitch ||
      (
        unresolvedCheckIn &&
        (
          unresolvedCheckIn.ownerPublicId !== identity.user.publicId ||
          identity.lastCheckInAt !== unresolvedCheckIn.previousLastCheckInAt
        )
      )
    ) {
      clearPendingCheckIn();
    }
    if (isAccountSwitch) closeWorld();
    clearPendingBootstrap();
    resetTransientCheckIn();
    setCheckInUnconfirmed(Boolean(pendingCheckIn.current));
    setPeople(null);
    setGroups(null);
    clickerOwnerPublicId.current = identity.user.publicId;
    const restored = restoreClickerRun(
      identity.user.publicId,
      clickerSeedFromPublicId(identity.user.publicId),
    );
    setLegacyGame(archiveLocalGame(identity.user.publicId, restored.progress));
    // A local animation archive is not a receipt for the new transport session.
    // Start a fresh visible run after a reload or account transition.
    commitClickerRun({ ...restored.progress, activeSeries: null }, false);
    recordAtRunStart.current = { runId: "", bestSeries: null };
    syncMeSnapshot(identity);
    setNameError(null);
    setSystemError(null);
    setActiveView(accountReturn.current ? "profile" : "check-in");
    accountReturn.current = false;
    setScreen("home");
  }, [
    closeWorld,
    clearPendingBootstrap,
    clearPendingCheckIn,
    commitClickerRun,
    resetTransientCheckIn,
    syncMeSnapshot,
  ]);

  const refreshSelf = useCallback(async () => {
    const epoch = identityEpoch.current;
    const request = ++selfRequest.current;
    try {
      const identity = await getMe();
      if (epoch !== identityEpoch.current || request !== selfRequest.current) return;
      if (!identity) {
        loseSession();
        return;
      }
      syncMeSnapshot(identity);
    } catch (error) {
      if (epoch !== identityEpoch.current || request !== selfRequest.current) return;
      if (error instanceof ApiError && error.status === 401) loseSession();
    }
  }, [loseSession, syncMeSnapshot]);

  useEffect(() => {
    let active = true;

    accountReturn.current = new URL(window.location.href).searchParams.get("auth") === "account-proof";
    try {
      accountReturn.current ||= ["email", "merge", "delete"].includes(window.sessionStorage.getItem("zhiv:account-action") ?? "");
    } catch { /* A successful callback still opens the profile without browser storage. */ }
    const restoredBootstrap = readPending(
      PENDING_BOOTSTRAP_STORAGE_KEY,
      isPendingBootstrap,
    );
    const restoredCheckIn = readPending(
      PENDING_CHECK_IN_STORAGE_KEY,
      isPendingCheckIn,
    );
    removePending(LEGACY_PENDING_CHECK_IN_STORAGE_KEY);
    pendingBootstrap.current = restoredBootstrap;
    pendingCheckIn.current = restoredCheckIn;

    void getMe()
      .then((identity) => {
        if (!active) return;
        if (identity) adoptMe(identity);
        else {
          if (restoredBootstrap) setName(restoredBootstrap.displayName);
          clearPendingCheckIn();
          resetTransientCheckIn();
          setScreen("onboarding");
        }
      })
      .catch(() => {
        if (!active) return;
        setScreen("load-error");
      });

    const markOnline = () => setIsOnline(true);
    const markOffline = () => setIsOnline(false);
    const flushClickerProgress = () => persistClickerRun(clickerRunRef.current);
    const flushHiddenClickerProgress = () => {
      if (document.hidden) flushClickerProgress();
    };
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);
    window.addEventListener("pagehide", flushClickerProgress);
    document.addEventListener("visibilitychange", flushHiddenClickerProgress);

    const clock = window.setInterval(() => setClientNowMs(Date.now()), 15_000);

    return () => {
      active = false;
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
      window.removeEventListener("pagehide", flushClickerProgress);
      document.removeEventListener("visibilitychange", flushHiddenClickerProgress);
      window.clearInterval(clock);
      if (burstTimer.current) clearTimeout(burstTimer.current);
      if (storyEffectTimer.current) clearTimeout(storyEffectTimer.current);
      if (tapFeedbackTimer.current) clearTimeout(tapFeedbackTimer.current);
      if (seriesBreakTimer.current) clearTimeout(seriesBreakTimer.current);
      if (clickerPersistTimer.current) clearTimeout(clickerPersistTimer.current);
      flushClickerProgress();
    };
  }, [adoptMe, clearPendingCheckIn, persistClickerRun, resetTransientCheckIn]);

  useEffect(() => {
    if (screen === "home" && activeView === "check-in") homeHeading.current?.focus();
  }, [activeView, screen]);

  useEffect(() => {
    if (screen !== "home") return;
    const controller = new AbortController();
    const initialRefresh = window.setTimeout(() => {
      void refreshSelf();
      void refreshPeople(controller.signal);
      void refreshGroups(controller.signal);
    }, 0);

    const refresh = () => {
      if (!document.hidden && navigator.onLine) {
        void refreshSelf();
        void refreshPeople();
        void refreshGroups();
      }
    };
    const poll = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    window.addEventListener("pageshow", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      controller.abort();
      window.clearTimeout(initialRefresh);
      window.clearInterval(poll);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pageshow", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [refreshGroups, refreshPeople, refreshSelf, screen]);

  useEffect(() => {
    if (screen !== "home" || !streak) return;
    if (!streak.renewBy) return;
    const delay = Date.parse(streak.renewBy) - (Date.now() + clockOffsetMs);
    if (!Number.isFinite(delay)) return;
    const timer = window.setTimeout(() => void refreshSelf(), Math.max(250, delay + 250));
    return () => window.clearTimeout(timer);
  }, [clockOffsetMs, refreshSelf, screen, streak]);

  useEffect(() => {
    const availableAt = me?.profile.displayNameChangeAvailableAt;
    if (screen !== "home" || !availableAt) return;
    const delay = Date.parse(availableAt) - (Date.now() + clockOffsetMs);
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setClientNowMs(Date.now()), delay + 100);
    return () => window.clearTimeout(timer);
  }, [clockOffsetMs, me?.profile.displayNameChangeAvailableAt, screen]);

  async function retryIdentity() {
    setScreen("loading");
    try {
      const identity = await getMe();
      if (identity) adoptMe(identity);
      else {
        if (pendingBootstrap.current) {
          setName(pendingBootstrap.current.displayName);
        }
        clearPendingCheckIn();
        resetTransientCheckIn();
        setScreen("onboarding");
      }
    } catch {
      setScreen("load-error");
    }
  }

  const triggerStoryEffect = useCallback((type: ClickerEffect) => {
    if (storyEffectType.current === "champion" && type !== "champion") return;
    if (storyEffectTimer.current) clearTimeout(storyEffectTimer.current);
    storyEffectBurst.current += 1;
    storyEffectType.current = type;
    setStoryEffect({ type, burst: storyEffectBurst.current });
    storyEffectTimer.current = setTimeout(() => {
      storyEffectType.current = null;
      setStoryEffect(null);
      storyEffectTimer.current = null;
    }, STORY_EFFECT_DURATION_MS[type]);
  }, []);

  const resetClickerLater = useCallback(() => {
    if (burstTimer.current) clearTimeout(burstTimer.current);
    const active = clickerRunRef.current.activeSeries;
    if (!active) {
      burstTimer.current = null;
      return;
    }
    const remaining = Math.max(
      0,
      active.lastTapAtMs + CLICKER_IDLE_RESET_MS - Date.now(),
    );
    const finishWhenIdle = () => {
      const expired = expireClickerSeries(clickerRunRef.current, Date.now());
      if (!expired.finishedSeries) {
        const currentActive = clickerRunRef.current.activeSeries;
        if (currentActive) {
          const nextRemaining = Math.max(
            0,
            currentActive.lastTapAtMs + CLICKER_IDLE_RESET_MS - Date.now(),
          );
          burstTimer.current = setTimeout(finishWhenIdle, nextRemaining + 20);
        }
        return;
      }
      commitClickerRun(expired.progress);
      persistClickerRun(expired.progress);
      reportFinishedSeries(expired.finishedSeries, expired.progress);
      triggerSeriesBreakEffect();
      setNotice(null);
      clearStoryEffect();
      burstTimer.current = null;
    };
    burstTimer.current = setTimeout(finishWhenIdle, remaining + 20);
  }, [
    clearStoryEffect,
    commitClickerRun,
    persistClickerRun,
    reportFinishedSeries,
    triggerSeriesBreakEffect,
  ]);

  const registerTap = useCallback(
    (steps = 1, tappedAtMs = Date.now()) => {
      setMochlikWakeSignal(value => value + 1);
      triggerTapFeedback();
      const current = clickerRunRef.current;
      const transition = advanceClickerRun(current, tappedAtMs, steps, createUuidV4());
      const runId = transition.progress.activeSeries?.eventId;
      if (runId && runId !== recordAtRunStart.current.runId) {
        recordAtRunStart.current = { runId, bestSeries: game.progress?.bestSeries ?? null };
      }
      if (runId) recordGameTap(steps, runId);
      if (transition.finishedSeries) {
        reportFinishedSeries(transition.finishedSeries, transition.progress);
        triggerSeriesBreakEffect();
      }
      commitClickerRun(transition.progress);
      setSeriesSummary(null);
      if (
        transition.crossedMilestones.length > 0 ||
        transition.levelAfter.level > transition.levelBefore.level
      ) persistClickerRun(transition.progress);
      if (transition.effect) triggerStoryEffect(transition.effect);
      resetClickerLater();
    },
    [
      recordGameTap,
      game.progress?.bestSeries,
      commitClickerRun,
      persistClickerRun,
      reportFinishedSeries,
      resetClickerLater,
      triggerSeriesBreakEffect,
      triggerStoryEffect,
      triggerTapFeedback,
    ],
  );

  useEffect(() => {
    if (screen !== "home" || !clickerRun.activeSeries) return;
    resetClickerLater();
  }, [clickerRun.activeSeries, resetClickerLater, screen]);

  useEffect(() => {
    if (screen !== "home") return;
    const reconcileSeries = () => {
      if (document.hidden) return;
      const expired = expireClickerSeries(clickerRunRef.current, Date.now());
      if (!expired.finishedSeries) return;
      if (burstTimer.current) {
        clearTimeout(burstTimer.current);
        burstTimer.current = null;
      }
      commitClickerRun(expired.progress);
      persistClickerRun(expired.progress);
      reportFinishedSeries(expired.finishedSeries, expired.progress);
      triggerSeriesBreakEffect();
      clearStoryEffect();
      setNotice(null);
    };
    window.addEventListener("pageshow", reconcileSeries);
    window.addEventListener("focus", reconcileSeries);
    document.addEventListener("visibilitychange", reconcileSeries);
    return () => {
      window.removeEventListener("pageshow", reconcileSeries);
      window.removeEventListener("focus", reconcileSeries);
      document.removeEventListener("visibilitychange", reconcileSeries);
    };
  }, [
    clearStoryEffect,
    commitClickerRun,
    persistClickerRun,
    reportFinishedSeries,
    screen,
    triggerSeriesBreakEffect,
  ]);

  async function handleBootstrap(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (
      pendingBootstrap.current &&
      pendingBootstrap.current.expiresAt <= Date.now()
    ) {
      clearPendingBootstrap();
    }

    const displayName =
      pendingBootstrap.current?.displayName ?? normalizeDisplayName(name);
    if (!isValidDisplayName(displayName)) {
      setNameError("Введите имя длиной до 50 символов");
      return;
    }

    setNameError(null);
    setSystemError(null);
    setIsSending(true);
    try {
      if (!pendingBootstrap.current) {
        const createdAt = Date.now();
        pendingBootstrap.current = {
          version: 1,
          kind: "bootstrap",
          idempotencyKey: createUuidV4(),
          displayName,
          createdAt,
          expiresAt: createdAt + PENDING_BOOTSTRAP_TTL_MS,
        };
        persistPending(PENDING_BOOTSTRAP_STORAGE_KEY, pendingBootstrap.current);
      } else if (name !== pendingBootstrap.current.displayName) {
        setName(pendingBootstrap.current.displayName);
      }

      const identity = await bootstrap(
        pendingBootstrap.current.displayName,
        pendingBootstrap.current.idempotencyKey,
      );
      clearPendingCheckIn();
      adoptMe(identity);
    } catch (error) {
      if (
        error instanceof ApiError &&
        [400, 409, 413, 415, 422].includes(error.status)
      ) {
        clearPendingBootstrap();
      }
      setSystemError(error instanceof Error ? error.message : "Не удалось создать профиль");
    } finally {
      setIsSending(false);
    }
  }

  async function handleCheckIn() {
    const tappedAtMs = Date.now();
    if (pendingCheckIn.current?.expiresAt && pendingCheckIn.current.expiresAt <= tappedAtMs) {
      clearPendingCheckIn();
    }
    const expired = expireClickerSeries(clickerRunRef.current, tappedAtMs);
    const currentRun = expired.progress;
    if (expired.finishedSeries) {
      if (burstTimer.current) {
        clearTimeout(burstTimer.current);
        burstTimer.current = null;
      }
      commitClickerRun(currentRun);
      reportFinishedSeries(expired.finishedSeries, currentRun);
      triggerSeriesBreakEffect();
      clearStoryEffect();
      setNotice(null);
    }
    const adjustedNow = tappedAtMs + clockOffsetMs;
    const tapPlan = planClickerTap(
      currentRun,
      Boolean(nextAllowedAt && adjustedNow < Date.parse(nextAllowedAt)),
      tappedAtMs,
      Boolean(pendingCheckIn.current),
    );
    registerTap(1, tappedAtMs);
    if (tapPlan !== "REQUEST_SERVER") {
      if (tapPlan === "START_LOCAL") setNotice(null);
      return;
    }
    if (checkInSending.current) return;

    await sendCheckIn();
  }

  async function sendCheckIn(retryOnly = false) {
    if (checkInSending.current || !navigator.onLine) return;
    if (retryOnly && (!pendingCheckIn.current || pendingCheckIn.current.expiresAt <= Date.now())) {
      clearPendingCheckIn();
      await refreshSelf();
      setNotice("Время проверки истекло. Если нужна новая отметка, нажмите «Я ЖИВОЙ».");
      return;
    }
    const epoch = identityEpoch.current;

    checkInSending.current = true;
    setIsSending(true);
    try {
      if (!me) {
        loseSession();
        return;
      }
      if (!pendingCheckIn.current) {
        const createdAt = Date.now();
        pendingCheckIn.current = {
          version: 2,
          kind: "check-in",
          idempotencyKey: createUuidV4(),
          ownerPublicId: me.user.publicId,
          previousLastCheckInAt: lastCheckInAt,
          createdAt,
          expiresAt: createdAt + PENDING_CHECK_IN_TTL_MS,
        };
        persistPending(PENDING_CHECK_IN_STORAGE_KEY, pendingCheckIn.current);
      }

      const response = await createCheckIn(pendingCheckIn.current.idempotencyKey);
      if (epoch !== identityEpoch.current) return;
      selfRequest.current += 1;
      clearPendingCheckIn();
      setLastCheckInAt(response.checkedAt);
      setNextAllowedAt(response.nextAllowedAt);
      setClockOffsetMs(serverOffset(response.serverTime));
      setClientNowMs(Date.now());
      setNotice(null);
      setStreak(response.streak);
      setMe((current) => current ? {
        ...current,
        lastCheckInAt: response.checkedAt,
        checkInCount: response.checkInCount,
        streak: response.streak,
        serverTime: response.serverTime,
      } : current);
    } catch (error) {
      if (epoch !== identityEpoch.current) return;
      if (
        error instanceof ApiError &&
        error.status === 429 &&
        isCheckInCooldownResponse(error.body)
      ) {
        const cooldown = error.body;
        selfRequest.current += 1;
        clearPendingCheckIn();
        setLastCheckInAt(cooldown.checkedAt);
        setNextAllowedAt(cooldown.nextAllowedAt);
        setClockOffsetMs(serverOffset(cooldown.serverTime));
        setStreak(cooldown.streak);
        setMe((current) => current ? {
          ...current,
          lastCheckInAt: cooldown.checkedAt,
          streak: cooldown.streak,
          serverTime: cooldown.serverTime,
        } : current);
        setNotice(null);
      } else if (error instanceof ApiError && error.status === 401) {
        loseSession();
      } else {
        setCheckInUnconfirmed(true);
        setNotice("Связь оборвалась · нажмите ещё раз для проверки");
      }
    } finally {
      checkInSending.current = false;
      setIsSending(false);
    }
  }

  function handleGameAreaPointerDown(event: ReactPointerEvent<HTMLElement>) {
    if ((event.target as Element).closest?.("[data-pet-interaction]")) return;
    if (!shouldCountGamePointer(event.pointerType)) return;
    if (mainButton.current?.contains(event.target as Node)) return;
    const bounds = buttonOrbit.current?.getBoundingClientRect();
    if (!bounds || !isWithinGameTapArea(event.clientX, event.clientY, bounds)) return;
    const active = clickerRunRef.current.activeSeries;
    const tappedAtMs = Date.now();
    if (!active || tappedAtMs < active.lastTapAtMs
      || tappedAtMs - active.lastTapAtMs >= CLICKER_IDLE_RESET_MS) return;
    event.preventDefault();
    lastGameTouchAt.current = performance.now();
    registerTap(1, tappedAtMs);
  }

  function handlePrimaryPointerDown(event: ReactPointerEvent<HTMLButtonElement>) {
    if (!shouldCountGamePointer(event.pointerType)) return;
    event.stopPropagation();
    event.preventDefault();
    lastGameTouchAt.current = performance.now();
    void handleCheckIn();
  }

  function handleGameClick(event: ReactMouseEvent<HTMLButtonElement>) {
    const nowMs = performance.now();
    if (!shouldCountGameClick(event.detail, nowMs, lastGameTouchAt.current)) {
      event.preventDefault();
      return;
    }
    void handleCheckIn();
  }

  useEffect(() => {
    const statuses = [me?.status, ...(people?.people.map(person => person.status) ?? []), ...(groups?.groups.flatMap(group => group.members.map(member => member.status)) ?? [])];
    const deadlines = statuses.map(status => status?.expiresAt ? Date.parse(status.expiresAt) : NaN)
      .filter(deadline => Number.isFinite(deadline) && deadline > clientNowMs + clockOffsetMs);
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => setClientNowMs(Date.now()), Math.max(0, Math.min(...deadlines) - Date.now() - clockOffsetMs));
    return () => window.clearTimeout(timer);
  }, [me?.status, people, groups, clientNowMs, clockOffsetMs]);

  const adjustedNow = clientNowMs + clockOffsetMs;
  const ageMs = getCheckInAgeMs(lastCheckInAt, clockOffsetMs, clientNowMs);
  const buttonPalette = getCheckInPalette(ageMs);
  const clickerLevel = getClickerLevel(game.progress?.lifetimeTaps ?? 0);
  const clickerLevelProgress = getClickerLevelProgress(game.progress?.lifetimeTaps ?? 0);
  const serverStatus = formatLastCheckIn(lastCheckInAt, adjustedNow);
  const primaryStatus = !isOnline ? "Офлайн · игровые тапы не сохраняются"
    : game.status === "error" ? "Ждём соединения, чтобы сохранить нажатия"
      : game.run?.interrupted ? "После перерыва связи началась новая игровая серия"
        : game.run?.rejectedTaps ? `Без подтверждения: ${game.run.rejectedTaps.toLocaleString("ru-RU")} нажатий` : null;
  const gameNotice = !isOnline ? "Без интернета новые игровые тапы не сохраняются."
    : game.status === "error" ? "Не удалось синхронизировать игровой прогресс. Повторите обновление."
    : game.status === "loading" ? "Загружаем игровой прогресс…"
    : game.pendingTaps ? `Сохраняем ${game.pendingTaps.toLocaleString("ru-RU")} тапов…`
    : game.rejectedTaps ? `Сохранённый прогресс обновлён. Без подтверждения в этом сеансе: ${game.rejectedTaps.toLocaleString("ru-RU")} нажатий.`
    : "Прогресс сохранён в аккаунте и доступен на других устройствах.";
  const activeTapCount = clickerRun.activeSeries?.tapCount ?? 0;
  const earlyTapClass =
    activeTapCount >= 2 && activeTapCount <= 4
      ? styles[`tap${activeTapCount}`]
      : "";
  const effectClass = storyEffect
    ? styles[`effect${storyEffect.type[0].toUpperCase()}${storyEffect.type.slice(1)}`]
    : "";
  const pulseClass = effectClass || earlyTapClass;
  const effectType = storyEffect?.type ?? null;
  const showEffectRings = effectType !== null && [
    "rings", "finale", "orbit", "legend", "champion",
  ].includes(effectType);
  const showEffectSparks = effectType !== null && [
    "sparks", "finale", "comet", "legend", "champion",
  ].includes(effectType);
  const showEffectConfetti = effectType !== null && [
    "confetti", "finale", "comet", "legend", "champion",
  ].includes(effectType);
  const showEffectGlow = effectType !== null && [
    "finale", "comet", "legend", "champion",
  ].includes(effectType);
  const displayedRunId = clickerRun.activeSeries?.eventId ?? seriesSummary?.eventId;
  const displayedRun = game.run?.runId === displayedRunId ? game.run : null;
  const visualTapCount = (displayedRun?.acceptedTaps ?? 0) + (displayedRun?.pendingTaps ?? 0);
  const isConfirmedRecord = Boolean(seriesSummary && !clickerRun.activeSeries && displayedRun
    && displayedRun.pendingTaps === 0 && recordAtRunStart.current.bestSeries !== null
    && displayedRun.acceptedTaps > recordAtRunStart.current.bestSeries
    && displayedRun.acceptedTaps === game.progress?.bestSeries);
  const buttonStyle = useMemo(
    () => ({
      "--check-in-color": buttonPalette.base,
      "--check-in-highlight": buttonPalette.highlight,
      "--check-in-shadow": buttonPalette.shadow,
      "--check-in-glow": buttonPalette.glow,
    }) as CSSProperties,
    [buttonPalette],
  );

  function handleIdentityAction() {
    if (!me || identityActionPending.current) return;

    identityActionPending.current = true;
    setIsIdentityActionPending(true);

    void copyText(me.user.publicId)
      .then((copied) => notify(copied ? "ID скопирован" : "Не удалось скопировать ID. Зажмите его и выберите «Скопировать».", copied ? "success" : "error"))
      .catch(() => notify("Не скопировано — зажмите ID", "error"))
      .finally(() => {
        identityActionPending.current = false;
        setIsIdentityActionPending(false);
      });
  }

  if (screen === "loading") {
    return (
      <main className={styles.centered} aria-busy="true">
        <div className={styles.loadingMark} role="status" aria-label="Загрузка приложения">
          Я
        </div>
      </main>
    );
  }

  if (screen === "load-error") {
    return (
      <main className={styles.centered}>
        <section className={styles.onboarding} aria-labelledby="load-error-title">
          <p className={styles.eyebrow}>Я ЖИВОЙ</p>
          <h1 id="load-error-title">Сервер молчит</h1>
          <p className={styles.intro}>
            Профиль не изменён. Проверим связь ещё раз — без создания нового пользователя.
          </p>
          <button className={styles.retryButton} type="button" onClick={retryIdentity}>
            Повторить
          </button>
        </section>
      </main>
    );
  }

  if (screen === "session-lost") {
    return (
      <main className={styles.centered}>
        <section className={styles.onboarding} aria-labelledby="session-lost-title">
          <p className={styles.eyebrow}>Я ЖИВОЙ</p>
          <h1 id="session-lost-title">Войдите в свой профиль</h1>
          <p className={styles.intro}>
            Используйте привязанный ВК или почту. Ваши люди и отметки останутся на месте.
          </p>
          <AccountEntry isOnline={isOnline} onAuthenticated={adoptMe}>
            <p className={styles.intro}>Для входа используйте сохранённый резервный код.</p>
          </AccountEntry>
          <RecoveryStarter
            context="session-lost"
            isOnline={isOnline}
            onRecovered={adoptMe}
          />
        </section>
        <CapabilityLanding
          authenticated={false}
          onInviteAccepted={() => undefined}
        />
      </main>
    );
  }

  if (screen === "onboarding") {
    return (
      <main className={styles.centered}>
        <section className={styles.onboarding} aria-labelledby="welcome-title">
          <p className={styles.eyebrow}>Я ЖИВОЙ</p>
          <h1 id="welcome-title">Я здесь</h1>
          <p className={styles.intro}>Выберите удобный способ входа.</p>
          <AccountEntry isOnline={isOnline} onAuthenticated={adoptMe}>
          <form onSubmit={handleBootstrap} className={styles.form} noValidate>
            <label htmlFor="display-name" className={styles.srOnly}>
              Имя
            </label>
            <input
              id="display-name"
              value={name}
              onChange={(event) => setName(limitDisplayNameInput(event.target.value))}
              placeholder="Например, Дима"
              autoComplete="name"
              autoFocus
              required
              className={styles.input}
              aria-invalid={Boolean(nameError)}
            />
            <button className={styles.continueButton} disabled={isSending} type="submit">
              {isSending ? "Создаём…" : "Продолжить"}
            </button>
          </form>
          <TransientNotice message={nameError} kind="error" />
          <TransientNotice message={systemError} kind="error" />
          </AccountEntry>
          <RecoveryStarter context="onboarding" isOnline={isOnline} onRecovered={adoptMe} />
        </section>
        <CapabilityLanding
          authenticated={false}
          onInviteAccepted={() => undefined}
        />
      </main>
    );
  }

  return (
    <main className={styles.shell} data-active-view={activeView}>
      <AuthReturnNotice />
      <TransientNotice message={notice} />
      <header className={styles.header}>
        <span className={styles.wordmark}>Я ЖИВОЙ</span>
        <div className={styles.identityWrap}>
          <button
            type="button"
            className={styles.identity}
            aria-label={`Скопировать ID${game.progress ? `. Уровень ${clickerLevel.level} из 100` : ""}`}
            aria-busy={isIdentityActionPending}
            disabled={isIdentityActionPending}
            onClick={handleIdentityAction}
          >
            <span className={styles.identityText}>
              <span className={styles.nameRow}><strong>{me?.user.displayName}</strong>
                {game.progress && <span className={styles.levelBadge} title={`Уровень ${clickerLevel.level} из 100 · ${clickerLevel.title}`}>
                  <GameLevelIcon level={clickerLevel.level} size={15} /><span>ур. {clickerLevel.level}</span>
                </span>}
              </span>
              <span>{me?.user.publicId}</span>
            </span>
            <Copy size={16} />
          </button>
        </div>
      </header>

      <div key={activeView} className={styles.viewTransition} style={{ "--view-direction": viewDirection } as CSSProperties}>
      {activeView === "check-in" ? (
        <section
          id="check-in-panel"
          className={styles.action}
          aria-labelledby="main-action-title"
        >
          <h1
            id="main-action-title"
            className={styles.srOnly}
            ref={homeHeading}
            tabIndex={-1}
          >
            Отметиться
          </h1>
          <div className={styles.checkInCluster}>
            <div className={styles.gameTools}>
            {streak ? (
              <button
                type="button"
                onClick={event => openCalendar(event.currentTarget)}
                onPointerDown={event => event.stopPropagation()}
                aria-haspopup="dialog"
                className={styles.streakPill}
                data-state={
                  streak.isActive && streak.currentDays > 0 ? "complete" : "empty"
                }
                aria-label={`${formatDayCount(streak.currentDays)} подряд. Открыть календарь отметок. ${getDailyStreakMessage(streak)}`}
              >
                <Flame size={18} aria-hidden="true" />
                <strong>{formatDayCount(streak.currentDays)}</strong>
              </button>
            ) : null}
            <button type="button" className={`${styles.streakPill} ${styles.trophyPill}`} onPointerDown={event => event.stopPropagation()}
              onClick={event => openGame(event.currentTarget)} aria-haspopup="dialog" aria-label="Открыть игровой рейтинг за месяц">
              <Trophy size={18} aria-hidden="true" /><strong>Рейтинг</strong>
            </button>
            </div>
            <div
              className={`${styles.buttonStage} ${mochlikVisible ? styles.habitatStage : ""} ${tapActive ? styles.buttonStageActive : ""} ${
                seriesBreakBurst !== null && !mochlikVisible ? styles.seriesBreaking : ""
              }`}
              onPointerDown={handleGameAreaPointerDown}
            >
            <div className={styles.buttonOrbit} ref={buttonOrbit}>
            {mochlikVisible && <div className={styles.habitatSurface} style={buttonStyle} hidden={!mochlikVisible}>
              <MochlikTerrarium key={me?.user.publicId} suspended={!mochlikVisible || worldPortal.open || calendarOpen || gameOpen || statusOpen}
                wakeSignal={mochlikWakeSignal} nowMs={adjustedNow} timeZone={me?.profile.timeZone ?? "UTC"} userId={me?.user.publicId}
                bestStreakDays={me?.streak.longestDays ?? 0} items={game.progress?.items} worldState={world.snapshot?.state} worldGifts={world.snapshot?.gifts} />
            </div>}
            <button
              type="button"
              className={`${styles.checkInButton} ${mochlikVisible ? "" : pulseClass} ${mochlikVisible ? styles.mochlikButton : ""}`}
              data-pulse={mochlikVisible && tapFeedbackBurst > 0 ? tapFeedbackBurst % 2 ? "odd" : "even" : undefined}
              style={buttonStyle}
              ref={mainButton}
              onPointerDown={handlePrimaryPointerDown}
              onClick={handleGameClick}
              aria-busy={isSending}
              aria-label="Я живой — отметиться и поиграть"
              aria-describedby={visualTapCount >= 1 ? "clicker-total" : undefined}
            >
              <span className={styles.checkInTitle}>Я ЖИВОЙ</span>
              <TapCounter progress={clickerRun} result={seriesSummary} count={visualTapCount}
                isRecord={isConfirmedRecord} />
            </button>
            {visualTapCount >= 1 ? (
              <span id="clicker-total" className={styles.srOnly}>
                Текущая серия: {visualTapCount.toLocaleString("ru-RU")}. Сохранено: {displayedRun?.acceptedTaps ?? 0}.
                {displayedRun?.pendingTaps ? `Ожидают сохранения: ${displayedRun.pendingTaps}.` : ""}
              </span>
            ) : null}
            <span className={styles.srOnly} role="status" aria-live="polite">
              {seriesSummary ? `${displayedRun?.pendingTaps ? "Сохраняем результат" : isConfirmedRecord ? "Рекорд" : "Результат"}: ${visualTapCount.toLocaleString("ru-RU")}` : ""}
            </span>
            {tapFeedbackBurst > 0 ? (
              <i
                key={`tap-wave-${tapFeedbackBurst}`}
                className={styles.tapWave}
                aria-hidden="true"
              />
            ) : null}
            {seriesBreakBurst !== null && !mochlikVisible ? (
              <div
                key={`series-break-${seriesBreakBurst}`}
                className={styles.seriesBreakBurst}
                aria-hidden="true"
              >
                <i /><i /><i /><i /><i /><i />
              </div>
            ) : null}
            {showEffectRings && storyEffect && !mochlikVisible ? (
              <div
                key={`rings-${storyEffect.burst}`}
                className={`${styles.storyRings} ${
                  effectType === "finale" || effectType === "legend" || effectType === "champion"
                    ? styles.storyRingsFinale
                    : ""
                } ${effectType === "orbit" ? styles.storyRingsOrbit : ""}`}
                aria-hidden="true"
              >
                <i />
                <i />
                <i />
              </div>
            ) : null}
            {showEffectSparks && storyEffect && !mochlikVisible ? (
              <div
                key={`sparks-${storyEffect.burst}`}
                className={`${styles.storySparks} ${
                  effectType === "comet" ? styles.storySparksComet : ""
                }`}
                aria-hidden="true"
              >
                {CONFETTI.map((piece, index) => (
                  <i
                    key={index}
                    style={
                      {
                        "--x": `${piece.x}px`,
                        "--y": `${piece.y}px`,
                        "--r": `${piece.r}deg`,
                        "--piece": piece.color,
                      } as CSSProperties
                    }
                  />
                ))}
              </div>
            ) : null}
            {showEffectConfetti && storyEffect && !mochlikVisible ? (
              <div
                key={`confetti-${storyEffect.burst}`}
                className={`${styles.confetti} ${
                  effectType === "finale" || effectType === "legend" || effectType === "champion"
                    ? styles.finaleConfetti
                    : ""
                } ${effectType === "comet" ? styles.cometConfetti : ""}`}
                aria-hidden="true"
              >
                {CONFETTI.map((piece, index) => (
                  <i
                    key={index}
                    style={
                      {
                        "--x": `${piece.x}px`,
                        "--y": `${piece.y}px`,
                        "--r": `${piece.r}deg`,
                        "--piece": piece.color,
                      } as CSSProperties
                    }
                  />
                ))}
              </div>
            ) : null}
            {showEffectGlow && storyEffect && !mochlikVisible ? (
              <div
                key={`finale-${storyEffect.burst}`}
                className={`${styles.finaleGlow} ${
                  effectType === "legend" || effectType === "champion"
                    ? styles.legendGlow
                    : ""
                }`}
                aria-hidden="true"
              />
            ) : null}
            {storyEffect?.type === "champion" && !mochlikVisible ? (
              <span
                key={`champion-${storyEffect.burst}`}
                className={styles.championBurst}
                aria-hidden="true"
              >
                100 000
              </span>
            ) : null}
            </div>
            </div>
          </div>

          <div className={styles.statusBlock}>
            <CheckInReceipt lastCheckInAt={lastCheckInAt} lastCheckInLabel={serverStatus} timeZone={me?.profile.timeZone ?? "UTC"}
              isSending={isSending} unconfirmed={checkInUnconfirmed} isOnline={isOnline} onRetry={() => void sendCheckIn(true)}>
              <button type="button" className={`${glass.button} ${styles.mapEntry}`}
                aria-label="Войти в мир Мохлика" aria-haspopup="dialog"
                onPointerDown={event => event.stopPropagation()} onClick={event => {
                  setWorldMounted(true); worldPortal.enter(event.currentTarget, buttonOrbit.current); void world.refresh();
                }}>
                <Map size={20} aria-hidden="true" /><span>Войти в мир</span>
              </button>
            </CheckInReceipt>
            {me ? <StatusEditor me={me} nowMs={adjustedNow} isOnline={isOnline} onUpdated={syncMeSnapshot} onSessionLost={loseSession} onOpenChange={setStatusOpen} /> : null}
            {primaryStatus ? <p
              className={styles.status}
              role="status"
              aria-live="polite"
            >
              {primaryStatus}
            </p> : null}
            <span className={styles.srOnly}>
              Рекорд в аккаунте: {game.progress?.bestSeries ?? 0}. Уровень {clickerLevel.level}, {clickerLevel.title}.
              Серверная отметка: {serverStatus}.
            </span>
          </div>
        </section>

      ) : activeView === "people" ? (
        <PeopleView
          data={people}
          groups={groups}
          error={peopleError}
          groupsError={groupsError}
          loading={peopleLoading}
          groupsLoading={groupsLoading}
          nowMs={adjustedNow}
          freshnessNowMs={clientNowMs}
          isOnline={isOnline}
          updatedAt={peopleUpdatedAt}
          groupsUpdatedAt={groupsUpdatedAt}
          onRefresh={() => refreshPeople()}
          onGroupsRefresh={() => refreshGroups()}
          onSessionLost={loseSession}
        />
      ) : me ? (
        <ProfileView
          simpleView={simpleView} onSimpleViewChange={setSimpleView}
          me={me}
          onOpenCalendar={openCalendar}
          onOpenGame={openGame}
          gameNotice={gameNotice}
          gameLoaded={Boolean(game.progress)}
          gamePendingTaps={game.pendingTaps}
          legacyGame={legacyGame}
          onRefreshGame={() => { void game.refresh(); }}
          nowMs={adjustedNow}
          isOnline={isOnline}
          clickerStats={{
            bestSeries: game.progress?.bestSeries ?? 0,
            lifetimeTaps: game.progress?.lifetimeTaps ?? 0,
            level: clickerLevel,
            levelProgress: clickerLevelProgress,
          }}
          onUpdated={(identity) => {
            syncMeSnapshot(identity);
            void refreshPeople();
            void refreshGroups();
          }}
          onRecovered={(identity) => {
            adoptMe(identity);
            void refreshPeople();
            void refreshGroups();
          }}
          onSessionLost={loseSession}
        />
      ) : null}
      </div>
      {me && streak ? <CheckInCalendar key={`calendar:${me.user.publicId}`} open={calendarOpen} onOpenChange={setCalendarOpen}
        streak={streak} items={game.progress?.items} lastCheckInAt={lastCheckInAt} timeZone={me.profile.timeZone} onSessionLost={loseSession}
        returnFocus={() => { if (calendarTrigger.current?.isConnected) calendarTrigger.current.focus(); }} /> : null}
      {me && screen === "home" ? <GameLeaderboardDialog key={`game:${me.user.publicId}`} open={gameOpen} onOpenChange={setGameOpen}
        ownerPublicId={me.user.publicId} progress={game.progress} onProgress={game.adoptProgress} onSessionLost={loseSession} isOnline={isOnline}
        returnFocus={() => { if (gameTrigger.current?.isConnected) gameTrigger.current.focus(); }} /> : null}

      {worldMounted && me && <WorldPortal key={`world:${me.user.publicId}`} open={worldPortal.open} onClose={worldPortal.close}
        origin={worldPortal.origin} returnFocus={worldPortal.returnFocus} world={world}
        ownerPublicId={me.user.publicId} timeZone={me.profile.timeZone} displayName={me.user.displayName}
        level={clickerLevel.level} wakeSignal={mochlikWakeSignal} lastCheckInLabel={serverStatus}
        bestStreakDays={me.streak.longestDays} items={game.progress?.items}
        onCheckIn={() => { void handleCheckIn(); }} isCheckingIn={isSending} />}
      <footer className={styles.footer}>
        <AppNavigation active={activeView} onSelect={selectView}
          invitations={(people?.incomingRequests.length ?? 0) + (groups?.incomingInvites.length ?? 0)} />
      </footer>
      <CapabilityLanding
        authenticated={true}
        onInviteAccepted={() => {
          setActiveView("people");
          void refreshPeople();
          void refreshGroups();
        }}
      />
    </main>
  );
}
