"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  LoaderCircle,
  RefreshCw,
  Share2,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import type { MeResponse, RecoveryAttempt } from "@/lib/check-in-contract";
import {
  ApiError,
  cancelCurrentRecoveryAttempt,
  completeCurrentRecoveryAttempt,
  getCurrentRecoveryAttempt,
  getMe,
  startRecoveryAttempt,
} from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import {
  capabilityUrl,
  createCapabilityToken,
  isCapabilityToken,
} from "@/lib/capability-token";
import { copyText } from "@/lib/identity-sharing";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import styles from "./recovery-starter.module.css";

const RECOVERY_RESUME_KEY = "zhiv.recovery-attempt.v2";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type RecoveryResume = {
  version: 1;
  approvalToken: string;
  startIdempotencyKey: string;
  completionIdempotencyKey?: string;
};

type RecoveryStarterProps = {
  context: "onboarding" | "session-lost" | "profile";
  isOnline: boolean;
  onRecovered: (identity: MeResponse) => void;
};

function readRecoveryResume(): RecoveryResume | null {
  try {
    const raw = window.sessionStorage.getItem(RECOVERY_RESUME_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1 &&
      "approvalToken" in value &&
      typeof value.approvalToken === "string" &&
      isCapabilityToken(value.approvalToken) &&
      "startIdempotencyKey" in value &&
      typeof value.startIdempotencyKey === "string" &&
      UUID_PATTERN.test(value.startIdempotencyKey) &&
      (
        !("completionIdempotencyKey" in value) ||
        (
          typeof value.completionIdempotencyKey === "string" &&
          UUID_PATTERN.test(value.completionIdempotencyKey)
        )
      )
    ) {
      return value as RecoveryResume;
    }
    window.sessionStorage.removeItem(RECOVERY_RESUME_KEY);
    return null;
  } catch {
    try {
      window.sessionStorage.removeItem(RECOVERY_RESUME_KEY);
    } catch {
      // Storage itself may be unavailable.
    }
    return null;
  }
}

function persistRecoveryResume(value: RecoveryResume) {
  try {
    window.sessionStorage.setItem(RECOVERY_RESUME_KEY, JSON.stringify(value));
  } catch {
    // The active component still keeps the token and request key in memory.
  }
}

function clearRecoveryResume() {
  try {
    window.sessionStorage.removeItem(RECOVERY_RESUME_KEY);
  } catch {
    // There may be nothing to clear when storage is unavailable.
  }
}

function expiryLabel(expiresAt: string): string {
  return new Intl.DateTimeFormat("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(Date.parse(expiresAt));
}

function triggerLabel(context: RecoveryStarterProps["context"]): string {
  if (context === "profile") return "Вернуть прежний профиль";
  if (context === "session-lost") return "Начать восстановление";
  return "У меня уже был профиль";
}

export function RecoveryStarter({
  context,
  isOnline,
  onRecovered,
}: RecoveryStarterProps) {
  const [open, setOpen] = useState(false);
  const [attempt, setAttempt] = useState<RecoveryAttempt | null>(null);
  const [approvalToken, setApprovalToken] = useState<string | null>(null);
  const [busy, setBusy] = useState<"start" | "refresh" | "complete" | "cancel" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const resumeRef = useRef<RecoveryResume | null>(null);
  const completeRequestKey = useRef<string | null>(null);

  const forgetAttempt = useCallback(() => {
    clearRecoveryResume();
    setAttempt(null);
    setApprovalToken(null);
    resumeRef.current = null;
    completeRequestKey.current = null;
  }, []);

  const refreshAttempt = useCallback(async (
    silent = false,
    discardOnUnauthorized = true,
  ) => {
    if (!silent) setBusy("refresh");
    try {
      const response = await getCurrentRecoveryAttempt();
      setAttempt(response);
      if (!silent) setError(null);
      return response;
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        (cause.status === 401 || cause.status === 404 || cause.status === 410)
      ) {
        if (cause.status === 401 && !discardOnUnauthorized) return null;
        clearRecoveryResume();
        setAttempt(null);
        setApprovalToken(null);
        resumeRef.current = null;
        completeRequestKey.current = null;
        if (cause.status === 401 && discardOnUnauthorized) setOpen(false);
        else if (!silent) setError("Запрос уже недействителен. Создайте новый.");
        return null;
      }
      if (!silent) {
        setError(cause instanceof Error ? cause.message : "Не удалось проверить запрос");
      }
      return null;
    } finally {
      if (!silent) setBusy(null);
    }
  }, []);

  useEffect(() => {
    const initialize = window.setTimeout(() => {
      const resume = readRecoveryResume();
      if (!resume) return;
      resumeRef.current = resume;
      completeRequestKey.current = resume.completionIdempotencyKey ?? null;
      setApprovalToken(resume.approvalToken);
      setOpen(true);
      void refreshAttempt(true);
    }, 0);
    return () => window.clearTimeout(initialize);
  }, [refreshAttempt]);

  useEffect(() => {
    if (attempt?.status !== "PENDING") return;
    let active = true;
    let requestRunning = false;
    const poll = async () => {
      if (!active || requestRunning || document.visibilityState === "hidden") return;
      requestRunning = true;
      try {
        const response = await getCurrentRecoveryAttempt();
        if (active) {
          setAttempt(response);
          if (response.status === "APPROVED") {
            setNotice("Друг подтвердил запрос. Теперь восстановление можно завершить.");
            setError(null);
          }
        }
      } catch (cause) {
        if (
          active &&
          cause instanceof ApiError &&
          (cause.status === 401 || cause.status === 404 || cause.status === 410)
        ) {
          forgetAttempt();
          if (cause.status === 401) setOpen(false);
          else setError("Время запроса истекло. Создайте новый.");
        }
      } finally {
        requestRunning = false;
      }
    };
    const timer = window.setInterval(() => void poll(), 2_500);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      active = false;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [attempt?.status, forgetAttempt]);

  async function beginAttempt() {
    if (busy || !isOnline) return;
    setBusy("start");
    setError(null);
    setNotice(null);

    const existing = resumeRef.current ?? readRecoveryResume();
    const resume: RecoveryResume = existing ?? {
      version: 1,
      approvalToken: createCapabilityToken(),
      startIdempotencyKey: createUuidV4(),
    };
    resumeRef.current = resume;
    persistRecoveryResume(resume);
    setApprovalToken(resume.approvalToken);

    try {
      const response = await startRecoveryAttempt(
        resume.approvalToken,
        resume.startIdempotencyKey,
      );
      setAttempt(response);
    } catch (cause) {
      const current = await refreshAttempt(true, false);
      if (!current) {
        setError(cause instanceof Error ? cause.message : "Не удалось начать восстановление");
      }
    } finally {
      setBusy(null);
    }
  }

  async function shareApprovalRequest() {
    if (!approvalToken || busy) return;
    setError(null);
    setNotice(null);
    const link = capabilityUrl("recover", approvalToken);
    if (!link.url) {
      setError(
        link.reason === "loopback-origin"
          ? "Ссылка с localhost не откроется у друга. Откройте приложение по LAN-адресу или задайте NEXT_PUBLIC_APP_ORIGIN."
          : "Не удалось определить безопасный адрес приложения для ссылки восстановления.",
      );
      return;
    }
    if (typeof navigator.share !== "function") {
      setNotice("Системная отправка недоступна. Используйте отдельную кнопку копирования ниже.");
      return;
    }
    try {
      await navigator.share({
        title: "Подтвердить восстановление «Я живой»",
        text: "Открой ссылку в своём авторизованном приложении «Я живой» и подтверди, что это мой запрос.",
        url: link.url,
      });
      setNotice("Запрос отправлен. Ждём подтверждение друга.");
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === "AbortError") return;
      setError("Не удалось открыть системную отправку. Ссылку можно скопировать отдельно.");
    }
  }

  async function copyApprovalRequest() {
    if (!approvalToken || busy) return;
    setError(null);
    const link = capabilityUrl("recover", approvalToken);
    if (!link.url) {
      setNotice(null);
      setError(
        link.reason === "loopback-origin"
          ? "Ссылка с localhost не откроется у друга. Откройте приложение по LAN-адресу или задайте NEXT_PUBLIC_APP_ORIGIN."
          : "Не удалось определить безопасный адрес приложения для ссылки восстановления.",
      );
      return;
    }
    const copied = await copyText(link.url);
    setNotice(copied ? "Ссылка скопирована" : null);
    if (!copied) setError("Не удалось скопировать ссылку");
  }

  async function completeRecovery() {
    if (!attempt || busy || !isOnline) return;
    setBusy("complete");
    setError(null);
    if (!completeRequestKey.current) {
      const completionIdempotencyKey = createUuidV4();
      completeRequestKey.current = completionIdempotencyKey;
      if (resumeRef.current) {
        const resume = { ...resumeRef.current, completionIdempotencyKey };
        resumeRef.current = resume;
        persistRecoveryResume(resume);
      }
    }
    try {
      const identity = await completeCurrentRecoveryAttempt(completeRequestKey.current);
      forgetAttempt();
      setOpen(false);
      onRecovered(identity);
    } catch (cause) {
      const currentIdentity = await getMe().catch(() => null);
      if (
        currentIdentity &&
        attempt.target &&
        currentIdentity.user.publicId === attempt.target.publicId
      ) {
        forgetAttempt();
        setOpen(false);
        onRecovered(currentIdentity);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Не удалось завершить восстановление");
    } finally {
      setBusy(null);
    }
  }

  async function cancelRecovery() {
    if (!attempt || busy) return;
    setBusy("cancel");
    setError(null);
    try {
      await cancelCurrentRecoveryAttempt();
      forgetAttempt();
      setOpen(false);
    } catch (cause) {
      if (
        cause instanceof ApiError &&
        (cause.status === 401 || cause.status === 404 || cause.status === 410)
      ) {
        forgetAttempt();
        setOpen(false);
      } else {
        setError(cause instanceof Error ? cause.message : "Не удалось отменить запрос");
      }
    } finally {
      setBusy(null);
    }
  }

  const targetName = attempt?.target?.displayName;
  const canComplete = attempt?.status === "APPROVED" || attempt?.status === "COMPLETED";

  return (
    <>
      <button
        type="button"
        className={styles.trigger}
        data-context={context}
        onClick={() => setOpen(true)}
      >
        <ShieldCheck size={18} aria-hidden="true" />
        {triggerLabel(context)}
      </button>

      <Dialog
        open={open}
        onOpenChange={(nextOpen) => {
          if (busy) return;
          setOpen(nextOpen);
          if (!nextOpen) {
            setError(null);
            setNotice(null);
          }
        }}
      >
        <DialogContent className={styles.dialog} aria-busy={Boolean(busy)}>
          <DialogHeader>
            <span className={styles.icon} aria-hidden="true"><ShieldCheck /></span>
            <DialogTitle className={styles.title}>Восстановление через друга</DialogTitle>
            <DialogDescription className={styles.description}>
              {!attempt
                ? "Создадим запрос. Отправьте ссылку одному из заранее выбранных доверенных людей — подтвердить её сможет только доверенный человек."
                : canComplete
                  ? `${targetName ? `Профиль «${targetName}»` : "Профиль"} подтверждён другом. Завершите возврат на этом устройстве.`
                  : "Ссылка не возвращает профиль сама по себе. Друг только подтверждает запрос, а завершаете восстановление вы здесь."}
            </DialogDescription>
          </DialogHeader>

          {!attempt ? (
            <div className={styles.explanation}>
              <ol>
                <li>Создайте запрос на этом устройстве.</li>
                <li>Отправьте ссылку доверенному человеку.</li>
                <li>После его подтверждения вернитесь сюда и завершите вход.</li>
              </ol>
              <button
                type="button"
                className={styles.primary}
                disabled={Boolean(busy) || !isOnline}
                onClick={() => void beginAttempt()}
              >
                {busy === "start" ? <LoaderCircle className={styles.spinner} size={18} /> : <ShieldCheck size={18} />}
                {busy === "start" ? "Создаём запрос…" : "Создать запрос"}
              </button>
            </div>
          ) : canComplete ? (
            <div className={styles.approved}>
              <span><Check size={22} aria-hidden="true" /></span>
              <div>
                <strong>Друг подтвердил запрос</strong>
                <p>Текущий случайный профиль не объединится со старым. Приложение переключится на прежний профиль.</p>
              </div>
              <button
                type="button"
                className={styles.primary}
                disabled={Boolean(busy) || !isOnline}
                onClick={() => void completeRecovery()}
              >
                {busy === "complete" ? <LoaderCircle className={styles.spinner} size={18} /> : <ShieldCheck size={18} />}
                {busy === "complete" ? "Восстанавливаем…" : `Вернуть ${targetName ? `«${targetName}»` : "профиль"}`}
              </button>
            </div>
          ) : (
            <div className={styles.pending}>
              <div className={styles.pendingState} role="status" aria-live="polite">
                <LoaderCircle className={styles.spinner} size={18} aria-hidden="true" />
                <span>
                  <strong>Ждём подтверждение друга</strong>
                  <small>Запрос действует до {expiryLabel(attempt.expiresAt)}</small>
                </span>
              </div>
              <button
                type="button"
                className={styles.primary}
                disabled={Boolean(busy)}
                onClick={() => void shareApprovalRequest()}
              >
                <Share2 size={18} /> Поделиться ссылкой
              </button>
              <button
                type="button"
                className={styles.copyButton}
                disabled={Boolean(busy)}
                onClick={() => void copyApprovalRequest()}
              >
                <Copy size={17} /> Скопировать ссылку
              </button>
              <button
                type="button"
                className={styles.refreshButton}
                disabled={Boolean(busy) || !isOnline}
                onClick={() => void refreshAttempt()}
              >
                <RefreshCw className={busy === "refresh" ? styles.spinner : undefined} size={15} />
                Проверить сейчас
              </button>
            </div>
          )}

          {!isOnline ? <p className={styles.offline}>Для восстановления нужен интернет.</p> : null}
          {notice ? <p className={styles.notice} role="status">{notice}</p> : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}

          {attempt ? (
            <button
              type="button"
              className={styles.cancelButton}
              disabled={Boolean(busy)}
              onClick={() => void cancelRecovery()}
            >
              <Trash2 size={15} /> {busy === "cancel" ? "Отменяем…" : "Отменить запрос"}
            </button>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}
