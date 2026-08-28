"use client";

import type { CSSProperties, FormEvent } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, HeartPulse, Share2, Users } from "lucide-react";
import type { CooldownResponse, MeResponse, PeopleResponse } from "@/lib/check-in-contract";
import { ApiError, bootstrap, createCheckIn, getMe, getPeople } from "@/lib/check-in-api";
import {
  BURST_RESET_MS,
  formatLastCheckIn,
  getBurstMessage,
  getCheckInAgeMs,
  getCheckInColor,
  isValidDisplayName,
  normalizeDisplayName,
} from "@/lib/check-in-presentation";
import { PeopleView } from "./people-view";
import styles from "./check-in-app.module.css";
import { createUuidV4 } from "@/lib/browser-uuid";

type Screen = "loading" | "load-error" | "onboarding" | "home" | "session-lost";
type ActiveView = "check-in" | "people";

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

export function CheckInApp() {
  const [screen, setScreen] = useState<Screen>("loading");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [systemError, setSystemError] = useState<string | null>(null);
  const [lastCheckInAt, setLastCheckInAt] = useState<string | null>(null);
  const [nextAllowedAt, setNextAllowedAt] = useState<string | null>(null);
  const [clockOffsetMs, setClockOffsetMs] = useState(0);
  const [clientNowMs, setClientNowMs] = useState(() => Date.now());
  const [isSending, setIsSending] = useState(false);
  const [isOnline, setIsOnline] = useState(() =>
    typeof navigator === "undefined" ? true : navigator.onLine,
  );
  const [tapCount, setTapCount] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [confettiBurst, setConfettiBurst] = useState(0);
  const [activeView, setActiveView] = useState<ActiveView>("check-in");
  const [people, setPeople] = useState<PeopleResponse | null>(null);
  const [peopleLoading, setPeopleLoading] = useState(false);
  const [peopleError, setPeopleError] = useState<string | null>(null);
  const [identityNotice, setIdentityNotice] = useState<string | null>(null);
  const burstTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingCheckIn = useRef<PendingCheckIn | null>(null);
  const pendingBootstrap = useRef<PendingBootstrap | null>(null);
  const homeHeading = useRef<HTMLHeadingElement | null>(null);

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
    setNextAllowedAt(null);
    setTapCount(0);
    setNotice(null);
    setConfettiBurst(0);
  }, []);

  const loseSession = useCallback(() => {
    clearPendingCheckIn();
    clearPendingBootstrap();
    resetTransientCheckIn();
    setPeople(null);
    setActiveView("check-in");
    setScreen("session-lost");
  }, [clearPendingBootstrap, clearPendingCheckIn, resetTransientCheckIn]);

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
      setPeopleError(error instanceof Error ? error.message : "Не удалось загрузить своих");
    } finally {
      setPeopleLoading(false);
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
    setMe(identity);
    setLastCheckInAt(identity.lastCheckInAt);
    setClockOffsetMs(serverOffset(identity.serverTime));
    setClientNowMs(Date.now());
    setNameError(null);
    setSystemError(null);
    setActiveView("check-in");
    setScreen("home");
  }, [clearPendingBootstrap, clearPendingCheckIn, resetTransientCheckIn]);

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
    window.addEventListener("online", markOnline);
    window.addEventListener("offline", markOffline);

    const clock = window.setInterval(() => setClientNowMs(Date.now()), 60_000);

    return () => {
      active = false;
      window.removeEventListener("online", markOnline);
      window.removeEventListener("offline", markOffline);
      window.clearInterval(clock);
      if (burstTimer.current) clearTimeout(burstTimer.current);
    };
  }, [adoptMe, clearPendingCheckIn, resetTransientCheckIn]);

  useEffect(() => {
    if (screen === "home" && activeView === "check-in") homeHeading.current?.focus();
  }, [activeView, screen]);

  useEffect(() => {
    if (screen !== "home") return;
    const controller = new AbortController();
    const initialRefresh = window.setTimeout(() => void refreshPeople(controller.signal), 0);

    const refresh = () => {
      if (!document.hidden && navigator.onLine) void refreshPeople();
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
  }, [refreshPeople, screen]);

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

  const resetBurstLater = useCallback(() => {
    if (burstTimer.current) clearTimeout(burstTimer.current);
    burstTimer.current = setTimeout(() => {
      setTapCount(0);
      setNotice(null);
    }, BURST_RESET_MS);
  }, []);

  const registerTap = useCallback(
    (firstAccepted = false) => {
      const next = firstAccepted ? 1 : Math.max(2, tapCount + 1);
      setTapCount(next);
      setNotice(getBurstMessage(next));
      if (next === 5) setConfettiBurst((value) => value + 1);
      resetBurstLater();
    },
    [resetBurstLater, tapCount],
  );

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
    const adjustedNow = Date.now() + clockOffsetMs;
    if (nextAllowedAt && adjustedNow < Date.parse(nextAllowedAt)) {
      registerTap(false);
      return;
    }
    if (isSending) return;

    setIsSending(true);
    setNotice("Отправляю…");
    try {
      if (pendingCheckIn.current?.expiresAt && pendingCheckIn.current.expiresAt <= Date.now()) {
        clearPendingCheckIn();
      }
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
      registerTap(true);
    } catch (error) {
      if (error instanceof ApiError && error.status === 429 && error.body) {
        const cooldown = error.body as CooldownResponse;
        clearPendingCheckIn();
        setLastCheckInAt(cooldown.checkedAt);
        setNextAllowedAt(cooldown.nextAllowedAt);
        setClockOffsetMs(serverOffset(cooldown.serverTime));
        registerTap(false);
      } else if (error instanceof ApiError && error.status === 401) {
        loseSession();
      } else {
        setNotice("Связь оборвалась · нажмите ещё раз для проверки");
        resetBurstLater();
      }
    } finally {
      setIsSending(false);
    }
  }

  const adjustedNow = clientNowMs + clockOffsetMs;
  const ageMs = getCheckInAgeMs(lastCheckInAt, clockOffsetMs, clientNowMs);
  const buttonColor = getCheckInColor(ageMs);
  const status = notice ?? formatLastCheckIn(lastCheckInAt, adjustedNow);
  const pulseClass = tapCount >= 2 ? styles[`tap${Math.min(tapCount, 5)}`] : "";
  const buttonStyle = useMemo(
    () => ({ "--check-in-color": buttonColor }) as CSSProperties,
    [buttonColor],
  );

  async function shareIdentity() {
    if (!me) return;
    const text = `${me.user.displayName} в «Жив» · ${me.user.publicId}`;
    try {
      if (navigator.share) {
        await navigator.share({ title: "Мой ID в «Жив»", text });
        setIdentityNotice("ID отправлен");
      } else {
        await navigator.clipboard.writeText(me.user.publicId);
        setIdentityNotice("ID скопирован");
      }
      window.setTimeout(() => setIdentityNotice(null), 1_800);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      setIdentityNotice("Не удалось поделиться");
      window.setTimeout(() => setIdentityNotice(null), 1_800);
    }
  }

  if (screen === "loading") {
    return (
      <main className={styles.centered} aria-busy="true">
        <div className={styles.loadingMark} role="status" aria-label="Загрузка приложения">
          Ж
        </div>
      </main>
    );
  }

  if (screen === "load-error") {
    return (
      <main className={styles.centered}>
        <section className={styles.onboarding} aria-labelledby="load-error-title">
          <p className={styles.eyebrow}>ЖИВ</p>
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
          <p className={styles.eyebrow}>ЖИВ</p>
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
          <p className={styles.eyebrow}>ЖИВ</p>
          <h1 id="welcome-title">Как тебя зовут?</h1>
          <p className={styles.intro}>Только имя. Остальное приложение сделает само.</p>
          <form onSubmit={handleBootstrap} className={styles.form} noValidate>
            <label htmlFor="display-name" className={styles.srOnly}>
              Имя
            </label>
            <input
              id="display-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Например, Дима"
              autoComplete="name"
              autoFocus
              required
              maxLength={50}
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
    <main className={styles.shell}>
      <header className={styles.header}>
        <span className={styles.wordmark}>ЖИВ</span>
        <div className={styles.identityWrap}>
          <button
            type="button"
            className={styles.identity}
            aria-label="Поделиться своим ID"
            onClick={() => void shareIdentity()}
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
        <section className={styles.action} aria-labelledby="main-action-title">
          <h1
            id="main-action-title"
            className={styles.srOnly}
            ref={homeHeading}
            tabIndex={-1}
          >
            Отметиться
          </h1>
          <div className={styles.buttonStage}>
            <button
              type="button"
              className={`${styles.checkInButton} ${pulseClass}`}
              style={buttonStyle}
              onClick={handleCheckIn}
              aria-busy={isSending}
            >
              <span>Я ЖИВ</span>
            </button>
            {tapCount >= 2 ? (
              <span className={styles.tapCounter} aria-hidden="true">
                ×{tapCount}
              </span>
            ) : null}
            {confettiBurst > 0 && tapCount === 5 ? (
              <div key={confettiBurst} className={styles.confetti} aria-hidden="true">
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
          </div>

          <div className={styles.statusBlock}>
            <p className={styles.status} role="status" aria-live="polite">
              {status}
            </p>
            {people ? (
              <p className={styles.audience}>
                {people.audienceCount === 0
                  ? "Эту отметку пока видите только вы"
                  : `Новую отметку увидят: ${people.audienceCount}`}
              </p>
            ) : null}
            {!isOnline ? <p className={styles.offline}>Данные могут быть устаревшими</p> : null}
          </div>
        </section>
      ) : (
        <PeopleView
          data={people}
          error={peopleError}
          loading={peopleLoading}
          nowMs={adjustedNow}
          onRefresh={() => refreshPeople()}
          onSessionLost={loseSession}
        />
      )}

      <footer className={styles.footer}>
        {activeView === "check-in" ? (
          <span className={styles.colorHint}>Цвет меняется от зелёного к красному за 24 часа</span>
        ) : null}
        <nav className={styles.bottomNav} aria-label="Основные разделы">
          <button
            type="button"
            className={activeView === "check-in" ? styles.navActive : undefined}
            aria-current={activeView === "check-in" ? "page" : undefined}
            onClick={() => setActiveView("check-in")}
          >
            <HeartPulse size={20} />
            <span>Я жив</span>
          </button>
          <button
            type="button"
            className={activeView === "people" ? styles.navActive : undefined}
            aria-current={activeView === "people" ? "page" : undefined}
            onClick={() => setActiveView("people")}
          >
            <span className={styles.navIcon}>
              <Users size={20} />
              {people && people.incomingRequests.length > 0 ? (
                <i>{Math.min(people.incomingRequests.length, 9)}</i>
              ) : null}
            </span>
            <span>Свои</span>
          </button>
        </nav>
      </footer>
    </main>
  );
}
