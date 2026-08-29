"use client";

import type { CSSProperties, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Flame, HeartPulse, Share2, UserRound, Users } from "lucide-react";
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
  getCheckInColor,
  isValidDisplayName,
  limitDisplayNameInput,
  normalizeDisplayName,
} from "@/lib/check-in-presentation";
import {
  advanceClickerRun,
  CLICKER_IDLE_RESET_MS,
  CLICKER_MAX_TAP_COUNT,
  clickerSeedFromPublicId,
  createClickerRun,
  expireClickerSeries,
  getClickerFrame,
  getClickerLevel,
  mergeClickerProgress,
  parseClickerProgress,
  planClickerTap,
  serializeClickerProgress,
  type ClickerEffect,
  type ClickerExpiry,
  type ClickerFinishedSeries,
  type ClickerRun,
} from "@/lib/clicker-story";
import { formatDayCount, getDailyStreakMessage } from "@/lib/daily-streak";
import { PeopleView } from "./people-view";
import { ProfileView } from "./profile-view";
import styles from "./check-in-app.module.css";
import { createUuidV4 } from "@/lib/browser-uuid";
import { getIdentitySharingNotice, shareIdentity } from "@/lib/identity-sharing";

type Screen = "loading" | "load-error" | "onboarding" | "home" | "session-lost";
type ActiveView = "check-in" | "people" | "profile";

type PendingBootstrap = {
  version: 1;
  kind: "bootstrap";
  idempotencyKey: string;
  displayName: string;
  createdAt: number;
  expiresAt: number;
};

type PendingCheckIn = {
  version: 1;
  kind: "check-in";
  idempotencyKey: string;
  previousLastCheckInAt: string | null;
  createdAt: number;
  expiresAt: number;
};

const PENDING_BOOTSTRAP_STORAGE_KEY = "zhiv.pending-bootstrap.v1";
const PENDING_CHECK_IN_STORAGE_KEY = "zhiv.pending-check-in.v1";
const CLICKER_PROGRESS_STORAGE_PREFIX = "zhiv.clicker-progress.v2";
const LEGACY_CLICKER_PROGRESS_STORAGE_PREFIX = "zhiv.clicker-progress.v1";
const PENDING_BOOTSTRAP_TTL_MS = 10 * 60_000;
const PENDING_CHECK_IN_TTL_MS = 24 * 60 * 60_000;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

function serverOffset(serverTime: string): number {
  return Date.parse(serverTime) - Date.now();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function hasValidPendingEnvelope(value: Record<string, unknown>): boolean {
  return (
    value.version === 1 &&
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
    hasValidPendingEnvelope(value) &&
    value.kind === "bootstrap" &&
    typeof value.displayName === "string" &&
    value.displayName === normalizeDisplayName(value.displayName) &&
    isValidDisplayName(value.displayName)
  );
}

function isPendingCheckIn(value: unknown): value is PendingCheckIn {
  return (
    isRecord(value) &&
    hasValidPendingEnvelope(value) &&
    value.kind === "check-in" &&
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

function restoreClickerRun(publicId: string, storySeed: number): ClickerExpiry {
  if (typeof window === "undefined") {
    return { progress: createClickerRun(storySeed), finishedSeries: null };
  }
  try {
    const stored = window.localStorage.getItem(clickerStorageKey(publicId));
    const legacy = stored
      ? null
      : window.localStorage.getItem(
          clickerStorageKey(publicId, LEGACY_CLICKER_PROGRESS_STORAGE_PREFIX),
        );
    const progress = parseClickerProgress(stored ?? legacy ?? "", storySeed)
      ?? createClickerRun(storySeed);
    return expireClickerSeries(progress, Date.now());
  } catch {
    return { progress: createClickerRun(storySeed), finishedSeries: null };
  }
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
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [clickerRun, setClickerRun] = useState<ClickerRun>(() => createClickerRun());
  const [seriesSummary, setSeriesSummary] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [storyEffect, setStoryEffect] = useState<{
    type: ClickerEffect;
    burst: number;
  } | null>(null);
  const [activeView, setActiveView] = useState<ActiveView>("check-in");
  const [people, setPeople] = useState<PeopleResponse | null>(null);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [groups, setGroups] = useState<GroupsResponse | null>(null);
  const [groupsLoading, setGroupsLoading] = useState(false);
  const [groupsError, setGroupsError] = useState<string | null>(null);
  const [identityNotice, setIdentityNotice] = useState<string | null>(null);
  const [isIdentityActionPending, setIsIdentityActionPending] = useState(false);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const identityNoticeTimer = useRef<number | null>(null);
  const identityActionPending = useRef(false);
  const checkInSending = useRef(false);
  const clickerRunRef = useRef(clickerRun);
  const storyEffectBurst = useRef(0);
  const storyEffectType = useRef<ClickerEffect | null>(null);
  const storyEffectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCheckIn = useRef<PendingCheckIn | null>(null);
  const pendingBootstrap = useRef<PendingBootstrap | null>(null);
  const homeHeading = useRef<HTMLHeadingElement | null>(null);
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
    setSeriesSummary(
      finished.isRecord
        ? `Забег завершён · рекорд ×${finished.tapCount.toLocaleString("ru-RU")}`
        : `Забег завершён · результат ×${finished.tapCount.toLocaleString("ru-RU")}`,
    );
    void reportClickerSeries({
      eventId: finished.eventId ?? createUuidV4(),
      type: "CLICKER_SERIES_FINISHED",
      tapCount: finished.tapCount,
      bestSeries: progress.bestSeries,
      level: getClickerLevel(progress.bestSeries).level,
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

  const clearPendingBootstrap = useCallback(() => {
    pendingBootstrap.current = null;
    removePending(PENDING_BOOTSTRAP_STORAGE_KEY);
  }, []);

  const clearPendingCheckIn = useCallback(() => {
    pendingCheckIn.current = null;
    removePending(PENDING_CHECK_IN_STORAGE_KEY);
  }, []);

  const resetTransientCheckIn = useCallback(() => {
    if (burstTimer.current) {
      clearTimeout(burstTimer.current);
      burstTimer.current = null;
    }
    clearStoryEffect();
    setNextAllowedAt(null);
    commitClickerRun(createClickerRun(), false);
    setStreak(null);
    setNotice(null);
    setSeriesSummary(null);
  }, [clearStoryEffect, commitClickerRun]);

  const loseSession = useCallback(() => {
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
    setScreen("session-lost");
  }, [
    clearPendingBootstrap,
    clearPendingCheckIn,
    persistClickerRun,
    resetTransientCheckIn,
  ]);

  const syncMeSnapshot = useCallback((identity: MeResponse) => {
    setMe(identity);
    setLastCheckInAt(identity.lastCheckInAt);
    setStreak(identity.streak);
    setClockOffsetMs(serverOffset(identity.serverTime));
    setClientNowMs(Date.now());
  }, []);

  const refreshPeople = useCallback(async (signal?: AbortSignal) => {
    setPeopleLoading(true);
    try {
      const response = await getPeople(signal);
      setPeople(response);
      setPeopleError(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof ApiError && error.status === 401) {
        loseSession();
        return;
      }
      setPeopleError(error instanceof Error ? error.message : "Не удалось загрузить личные связи");
    } finally {
      setPeopleLoading(false);
    }
  }, [loseSession]);

  const refreshGroups = useCallback(async (signal?: AbortSignal) => {
    setGroupsLoading(true);
    try {
      const response = await getGroups(signal);
      setGroups(response);
      setGroupsError(null);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      if (error instanceof ApiError && error.status === 401) {
        loseSession();
        return;
      }
      setGroupsError(error instanceof Error ? error.message : "Не удалось загрузить группы");
    } finally {
      setGroupsLoading(false);
    }
  }, [loseSession]);

  const adoptMe = useCallback((identity: MeResponse) => {
    const unresolvedCheckIn = pendingCheckIn.current;
    if (
      unresolvedCheckIn &&
      identity.lastCheckInAt !== unresolvedCheckIn.previousLastCheckInAt
    ) {
      clearPendingCheckIn();
    }
    clearPendingBootstrap();
    resetTransientCheckIn();
    clickerOwnerPublicId.current = identity.user.publicId;
    const restored = restoreClickerRun(
      identity.user.publicId,
      clickerSeedFromPublicId(identity.user.publicId),
    );
    commitClickerRun(restored.progress, false);
    if (restored.finishedSeries) {
      persistClickerRun(restored.progress);
      reportFinishedSeries(restored.finishedSeries, restored.progress);
    }
    syncMeSnapshot(identity);
    setNameError(null);
    setSystemError(null);
    setActiveView("check-in");
    setScreen("home");
  }, [
    clearPendingBootstrap,
    clearPendingCheckIn,
    commitClickerRun,
    persistClickerRun,
    reportFinishedSeries,
    resetTransientCheckIn,
    syncMeSnapshot,
  ]);

  const refreshSelf = useCallback(async () => {
    try {
      const identity = await getMe();
      if (!identity) {
        loseSession();
        return;
      }
      syncMeSnapshot(identity);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) loseSession();
    }
  }, [loseSession, syncMeSnapshot]);

  useEffect(() => {
    let active = true;

    const restoredBootstrap = readPending(
      PENDING_BOOTSTRAP_STORAGE_KEY,
      isPendingBootstrap,
    );
    const restoredCheckIn = readPending(
      PENDING_CHECK_IN_STORAGE_KEY,
      isPendingCheckIn,
    );
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

    const clock = window.setInterval(() => setClientNowMs(Date.now()), 60_000);

    return () => {
      active = false;
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
      window.removeEventListener("pagehide", flushClickerProgress);
      document.removeEventListener("visibilitychange", flushHiddenClickerProgress);
      window.clearInterval(clock);
      if (burstTimer.current) clearTimeout(burstTimer.current);
      if (storyEffectTimer.current) clearTimeout(storyEffectTimer.current);
      if (identityNoticeTimer.current) clearTimeout(identityNoticeTimer.current);
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
    const delay = Date.parse(streak.nextDayAt) - (Date.now() + clockOffsetMs);
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
    }, type === "champion" ? 2_500 : type === "finale" ? 1_900 : type === "rings" ? 1_400 : 1_150);
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
  ]);

  const registerTap = useCallback(
    (steps = 1, tappedAtMs = Date.now()) => {
      const current = clickerRunRef.current;
      const transition = advanceClickerRun(current, tappedAtMs, steps, createUuidV4());
      if (transition.finishedSeries) {
        reportFinishedSeries(transition.finishedSeries, transition.progress);
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
      commitClickerRun,
      persistClickerRun,
      reportFinishedSeries,
      resetClickerLater,
      triggerStoryEffect,
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

    checkInSending.current = true;
    setIsSending(true);
    setNotice("Проверяем сервер · тапы уже считаются");
    try {
      if (!pendingCheckIn.current) {
        const createdAt = Date.now();
        pendingCheckIn.current = {
          version: 1,
          kind: "check-in",
          idempotencyKey: createUuidV4(),
          previousLastCheckInAt: lastCheckInAt,
          createdAt,
          expiresAt: createdAt + PENDING_CHECK_IN_TTL_MS,
        };
        persistPending(PENDING_CHECK_IN_STORAGE_KEY, pendingCheckIn.current);
      }

      const response = await createCheckIn(pendingCheckIn.current.idempotencyKey);
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
      if (
        error instanceof ApiError &&
        error.status === 429 &&
        isCheckInCooldownResponse(error.body)
      ) {
        const cooldown = error.body;
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
        setNotice("Связь оборвалась · нажмите ещё раз для проверки");
      }
    } finally {
      checkInSending.current = false;
      setIsSending(false);
    }
  }

  const adjustedNow = clientNowMs + clockOffsetMs;
  const ageMs = getCheckInAgeMs(lastCheckInAt, clockOffsetMs, clientNowMs);
  const buttonColor = getCheckInColor(ageMs);
  const storyFrame = getClickerFrame(clickerRun);
  const clickerLevel = getClickerLevel(clickerRun.bestSeries);
  const serverStatus = notice ?? formatLastCheckIn(lastCheckInAt, adjustedNow);
  const earlyTapClass =
    storyFrame && storyFrame.tapCount >= 2 && storyFrame.tapCount <= 4
      ? styles[`tap${storyFrame.tapCount}`]
      : "";
  const effectClass = storyEffect
    ? styles[`effect${storyEffect.type[0].toUpperCase()}${storyEffect.type.slice(1)}`]
    : "";
  const pulseClass = effectClass || earlyTapClass;
  const visualTapCount = Math.min(
    clickerRun.activeSeries?.tapCount ?? 0,
    CLICKER_MAX_TAP_COUNT,
  );
  const buttonStyle = useMemo(
    () => ({ "--check-in-color": buttonColor }) as CSSProperties,
    [buttonColor],
  );

  function showIdentityNotice(message: string) {
    if (identityNoticeTimer.current) window.clearTimeout(identityNoticeTimer.current);
    setIdentityNotice(message);
    identityNoticeTimer.current = window.setTimeout(() => {
      setIdentityNotice(null);
      identityNoticeTimer.current = null;
    }, 2_400);
  }

  function handleIdentityAction() {
    if (!me || identityActionPending.current) return;

    identityActionPending.current = true;
    setIsIdentityActionPending(true);
    setIdentityNotice(null);

    void shareIdentity(me.user.publicId)
      .then((result) => showIdentityNotice(getIdentitySharingNotice(result)))
      .catch(() => showIdentityNotice("Не скопировано — зажмите ID"))
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
          <h1 id="session-lost-title">Сессия закончилась</h1>
          <p className={styles.intro}>
            Отметка не потеряна и не дублировалась. Восстановление старого профиля подключим
            отдельным безопасным способом.
          </p>
          <button
            className={styles.retryButton}
            type="button"
            onClick={() => setScreen("onboarding")}
          >
            Создать новый профиль
          </button>
        </section>
      </main>
    );
  }

  if (screen === "onboarding") {
    return (
      <main className={styles.centered}>
        <section className={styles.onboarding} aria-labelledby="welcome-title">
          <p className={styles.eyebrow}>Я ЖИВОЙ</p>
          <h1 id="welcome-title">Как тебя зовут?</h1>
          <p className={styles.intro}>Только имя. Остальное приложение сделает само.</p>
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
              aria-describedby={
                [nameError ? "name-error" : "", systemError ? "system-error" : ""]
                  .filter(Boolean)
                  .join(" ") || undefined
              }
            />
            <button className={styles.continueButton} disabled={isSending} type="submit">
              {isSending ? "Создаём…" : "Продолжить"}
            </button>
          </form>
          {nameError ? (
            <p id="name-error" className={styles.error} role="alert">
              {nameError}
            </p>
          ) : null}
          {systemError ? (
            <p id="system-error" className={styles.error} role="alert">
              {systemError}
            </p>
          ) : null}
        </section>
      </main>
    );
  }

  return (
    <main className={styles.shell} data-active-view={activeView}>
      <header className={styles.header}>
        <span className={styles.wordmark}>Я ЖИВОЙ</span>
        <div className={styles.identityWrap}>
          <button
            type="button"
            className={styles.identity}
            aria-label="Скопировать ID и поделиться"
            aria-busy={isIdentityActionPending}
            disabled={isIdentityActionPending}
            onClick={handleIdentityAction}
          >
            <span className={styles.identityText}>
              <strong>{me?.user.displayName}</strong>
              <span>{me?.user.publicId}</span>
            </span>
            {identityNotice === "ID скопирован" ? <Check size={16} /> : <Share2 size={16} />}
          </button>
          {identityNotice ? <small role="status">{identityNotice}</small> : null}
        </div>
      </header>

      {activeView === "check-in" ? (
        <section id="check-in-panel" className={styles.action} aria-labelledby="main-action-title">
          <h1
            id="main-action-title"
            className={styles.srOnly}
            ref={homeHeading}
            tabIndex={-1}
          >
            Отметиться
          </h1>
          <div className={styles.checkInCluster}>
            {streak ? (
              <div
                className={styles.streakPill}
                data-state={
                  streak.checkedInToday
                    ? "complete"
                    : streak.currentDays > 0
                      ? "waiting"
                      : "empty"
                }
                aria-label={`${formatDayCount(streak.currentDays)} подряд. ${getDailyStreakMessage(streak)}`}
              >
                <Flame size={18} aria-hidden="true" />
                <strong>{formatDayCount(streak.currentDays)}</strong>
              </div>
            ) : null}
            <div className={styles.buttonStage}>
            <button
              type="button"
              className={`${styles.checkInButton} ${pulseClass}`}
              style={buttonStyle}
              onClick={handleCheckIn}
              aria-busy={isSending}
              aria-describedby={visualTapCount >= 1 ? "clicker-total" : undefined}
            >
              <span>Я ЖИВОЙ</span>
            </button>
            {visualTapCount >= 1 ? (
              <span id="clicker-total" className={styles.srOnly}>
                Текущая серия: {visualTapCount.toLocaleString("ru-RU")}
              </span>
            ) : null}
            {visualTapCount >= 1 ? (
              <span className={styles.tapCounter} aria-hidden="true">
                ×{visualTapCount.toLocaleString("ru-RU")}
              </span>
            ) : null}
            {storyEffect?.type === "rings" ||
            storyEffect?.type === "finale" ||
            storyEffect?.type === "champion" ? (
              <div
                key={`rings-${storyEffect.burst}`}
                className={`${styles.storyRings} ${
                  storyEffect.type === "finale" || storyEffect.type === "champion"
                    ? styles.storyRingsFinale
                    : ""
                }`}
                aria-hidden="true"
              >
                <i />
                <i />
                <i />
              </div>
            ) : null}
            {storyEffect?.type === "sparks" ||
            storyEffect?.type === "finale" ||
            storyEffect?.type === "champion" ? (
              <div
                key={`sparks-${storyEffect.burst}`}
                className={styles.storySparks}
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
            {storyEffect?.type === "confetti" ||
            storyEffect?.type === "finale" ||
            storyEffect?.type === "champion" ? (
              <div
                key={`confetti-${storyEffect.burst}`}
                className={`${styles.confetti} ${
                  storyEffect.type === "finale" || storyEffect.type === "champion"
                    ? styles.finaleConfetti
                    : ""
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
            {storyEffect?.type === "finale" || storyEffect?.type === "champion" ? (
              <div
                key={`finale-${storyEffect.burst}`}
                className={styles.finaleGlow}
                aria-hidden="true"
              />
            ) : null}
            {storyEffect?.type === "champion" ? (
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

          <div className={styles.statusBlock} data-story-active={storyFrame ? "true" : "false"}>
            {storyFrame ? (
              <p className={styles.storyLabel}>СЮЖЕТ · {storyFrame.storyTitle}</p>
            ) : null}
            <p
              className={styles.status}
              role="status"
              aria-live="polite"
            >
              {!isOnline
                ? "Офлайн · серия считается на устройстве"
                : notice
                  ? notice
                  : storyFrame?.message ?? seriesSummary ?? serverStatus}
            </p>
            <span className={styles.srOnly}>
              Лучший результат: {clickerRun.bestSeries}. Уровень {clickerLevel.level}, {clickerLevel.title}.
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
          onRefresh={() => refreshPeople()}
          onGroupsRefresh={() => refreshGroups()}
          onSessionLost={loseSession}
        />
      ) : me ? (
        <ProfileView
          me={me}
          nowMs={adjustedNow}
          isOnline={isOnline}
          clickerStats={{
            bestSeries: clickerRun.bestSeries,
            level: clickerLevel,
          }}
          onUpdated={(identity) => {
            syncMeSnapshot(identity);
            void refreshPeople();
            void refreshGroups();
          }}
          onSessionLost={loseSession}
        />
      ) : null}

      <footer className={styles.footer}>
        <nav
          className={styles.bottomNav}
          data-active-view={activeView}
          aria-label="Основные разделы"
        >
          <span className={styles.navLens} aria-hidden="true" />
          <button
            type="button"
            className={activeView === "check-in" ? styles.navActive : undefined}
            aria-current={activeView === "check-in" ? "page" : undefined}
            onClick={() => setActiveView("check-in")}
          >
            <HeartPulse size={20} />
            <span>Я живой</span>
          </button>
          <button
            type="button"
            className={activeView === "people" ? styles.navActive : undefined}
            aria-current={activeView === "people" ? "page" : undefined}
            onClick={() => setActiveView("people")}
          >
            <span className={styles.navIcon}>
              <Users size={20} />
              {(people?.incomingRequests.length ?? 0) + (groups?.incomingInvites.length ?? 0) > 0 ? (
                <i>{Math.min(
                  (people?.incomingRequests.length ?? 0) + (groups?.incomingInvites.length ?? 0),
                  9,
                )}</i>
              ) : null}
            </span>
            <span>Люди</span>
          </button>
          <button
            type="button"
            className={activeView === "profile" ? styles.navActive : undefined}
            aria-current={activeView === "profile" ? "page" : undefined}
            onClick={() => setActiveView("profile")}
          >
            <UserRound size={20} />
            <span>Профиль</span>
          </button>
        </nav>
      </footer>
    </main>
  );
}
