"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Link2, ShieldCheck } from "lucide-react";
import type {
  DirectInvitePreview,
  RecoveryApprovalPreview,
} from "@/lib/check-in-contract";
import {
  ApiError,
  confirmRecoveryApproval,
  previewDirectInvite,
  previewRecoveryApproval,
  redeemDirectInvite,
} from "@/lib/check-in-api";
import { isCapabilityToken } from "@/lib/capability-token";
import { createUuidV4 } from "@/lib/browser-uuid";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import styles from "./capability-landing.module.css";

const INVITE_KEY = "zhiv.pending-direct-invite.v1";
const INVITE_REDEEM_KEY = "zhiv.pending-direct-invite-redeem.v1";
const RECOVERY_APPROVAL_KEY = "zhiv.pending-recovery-approval.v2";
const RECOVERY_CONFIRM_KEY = "zhiv.pending-recovery-confirm.v1";
const LEGACY_RECOVERY_KEY = "zhiv.pending-recovery-link.v1";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type PendingCapability =
  | { kind: "invite"; token: string }
  | { kind: "recover"; token: string };

type InviteRedeemResume = {
  version: 1;
  token: string;
  idempotencyKey: string;
};

type RecoveryConfirmResume = InviteRedeemResume & {
  contactId: string;
};

function capabilityStorageKey(kind: PendingCapability["kind"]): string {
  return kind === "invite" ? INVITE_KEY : RECOVERY_APPROVAL_KEY;
}

function storeCapability(value: PendingCapability) {
  try {
    window.sessionStorage.setItem(capabilityStorageKey(value.kind), value.token);
  } catch {
    // The capability remains usable in memory for the current page.
  }
}

function storedCapability(kind: PendingCapability["kind"]): PendingCapability | null {
  try {
    const key = capabilityStorageKey(kind);
    const token = window.sessionStorage.getItem(key);
    if (token && isCapabilityToken(token)) return { kind, token };
    if (token) window.sessionStorage.removeItem(key);
    return null;
  } catch {
    return null;
  }
}

function removeStoredCapability(kind: PendingCapability["kind"]) {
  try {
    window.sessionStorage.removeItem(capabilityStorageKey(kind));
  } catch {
    // An unavailable sessionStorage does not block the in-memory flow.
  }
}

function readInviteRedeemResume(token: string): InviteRedeemResume | null {
  try {
    const raw = window.sessionStorage.getItem(INVITE_REDEEM_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1 &&
      "token" in value &&
      value.token === token &&
      "idempotencyKey" in value &&
      typeof value.idempotencyKey === "string" &&
      UUID_PATTERN.test(value.idempotencyKey)
    ) return value as InviteRedeemResume;
    window.sessionStorage.removeItem(INVITE_REDEEM_KEY);
    return null;
  } catch {
    clearInviteRedeemResume();
    return null;
  }
}

function persistInviteRedeemResume(value: InviteRedeemResume) {
  try {
    window.sessionStorage.setItem(INVITE_REDEEM_KEY, JSON.stringify(value));
  } catch {
    // The mounted component still reuses its in-memory request key.
  }
}

function clearInviteRedeemResume() {
  try {
    window.sessionStorage.removeItem(INVITE_REDEEM_KEY);
  } catch {
    // Storage may be unavailable.
  }
}

function readRecoveryConfirmResume(token: string): RecoveryConfirmResume | null {
  try {
    const raw = window.sessionStorage.getItem(RECOVERY_CONFIRM_KEY);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === "object" &&
      value !== null &&
      "version" in value &&
      value.version === 1 &&
      "token" in value &&
      value.token === token &&
      "idempotencyKey" in value &&
      typeof value.idempotencyKey === "string" &&
      UUID_PATTERN.test(value.idempotencyKey) &&
      "contactId" in value &&
      typeof value.contactId === "string" &&
      UUID_PATTERN.test(value.contactId)
    ) return value as RecoveryConfirmResume;
    window.sessionStorage.removeItem(RECOVERY_CONFIRM_KEY);
    return null;
  } catch {
    clearRecoveryConfirmResume();
    return null;
  }
}

function persistRecoveryConfirmResume(value: RecoveryConfirmResume) {
  try {
    window.sessionStorage.setItem(RECOVERY_CONFIRM_KEY, JSON.stringify(value));
  } catch {
    // The mounted component still reuses its in-memory request key.
  }
}

function clearRecoveryConfirmResume() {
  try {
    window.sessionStorage.removeItem(RECOVERY_CONFIRM_KEY);
  } catch {
    // Storage may be unavailable.
  }
}

function stripCapabilityFragment() {
  try {
    window.history.replaceState(
      null,
      "",
      `${window.location.pathname}${window.location.search}`,
    );
  } catch {
    // Some embedded browsers can reject history mutations.
  }
}

function readCapability(): PendingCapability | null {
  try {
    window.sessionStorage.removeItem(LEGACY_RECOVERY_KEY);
  } catch {
    // The deprecated credential is also unreachable from the new flow.
  }
  const match = /^#\/(invite|recover)\/([A-Za-z0-9_-]{43})$/.exec(window.location.hash);
  if (match && isCapabilityToken(match[2])) {
    const value = {
      kind: match[1] as PendingCapability["kind"],
      token: match[2],
    };
    stripCapabilityFragment();
    storeCapability(value);
    return value;
  }
  return storedCapability("recover") ?? storedCapability("invite");
}

export function CapabilityLanding({
  authenticated,
  onInviteAccepted,
}: {
  authenticated: boolean;
  onInviteAccepted: () => void;
}) {
  const [pending, setPending] = useState<PendingCapability | null>(null);
  const [invite, setInvite] = useState<DirectInvitePreview | null>(null);
  const [approval, setApproval] = useState<RecoveryApprovalPreview | null>(null);
  const [selectedContactId, setSelectedContactId] = useState<string | null>(null);
  const [approvalDone, setApprovalDone] = useState(false);
  const [approvedTarget, setApprovedTarget] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inviteRedeemResume = useRef<InviteRedeemResume | null>(null);
  const recoveryConfirmResume = useRef<RecoveryConfirmResume | null>(null);
  const onInviteAcceptedRef = useRef(onInviteAccepted);

  useEffect(() => {
    onInviteAcceptedRef.current = onInviteAccepted;
  }, [onInviteAccepted]);

  const loadPreview = useCallback(async (
    current: PendingCapability,
    canApproveRecovery: boolean,
  ) => {
    setError(null);
    setApprovalDone(false);
    setApprovedTarget(null);
    if (current.kind === "invite") {
      inviteRedeemResume.current = readInviteRedeemResume(current.token);
      setInvite(null);
      setLoading(true);
      try {
        setInvite(await previewDirectInvite(current.token));
      } catch (cause) {
        const replay = inviteRedeemResume.current;
        if (
          canApproveRecovery &&
          replay &&
          cause instanceof ApiError &&
          (cause.status === 409 || cause.status === 410)
        ) {
          try {
            await redeemDirectInvite(current.token, replay.idempotencyKey);
            removeStoredCapability("invite");
            inviteRedeemResume.current = null;
            clearInviteRedeemResume();
            setPending(null);
            onInviteAcceptedRef.current();
          } catch (replayCause) {
            setError(
              replayCause instanceof Error
                ? replayCause.message
                : "Не удалось завершить принятие приглашения",
            );
          }
        } else {
          setError(cause instanceof Error ? cause.message : "Ссылка недействительна");
        }
      } finally {
        setLoading(false);
      }
      return;
    }

    setApproval(null);
    setSelectedContactId(null);
    recoveryConfirmResume.current = readRecoveryConfirmResume(current.token);
    if (!canApproveRecovery) {
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const response = await previewRecoveryApproval(current.token);
      setApproval(response);
      const resumableContactId = recoveryConfirmResume.current?.contactId;
      if (
        resumableContactId &&
        response.eligible.some((candidate) => candidate.contactId === resumableContactId)
      ) {
        setSelectedContactId(resumableContactId);
      } else {
        if (recoveryConfirmResume.current) {
          recoveryConfirmResume.current = null;
          clearRecoveryConfirmResume();
        }
        setSelectedContactId(response.eligible[0]?.contactId ?? null);
      }
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 409) {
        removeStoredCapability("recover");
        recoveryConfirmResume.current = null;
        clearRecoveryConfirmResume();
        setApprovalDone(true);
      } else {
        setError(cause instanceof Error ? cause.message : "Запрос недействителен");
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const initialize = window.setTimeout(() => {
      const current = readCapability();
      setPending(current);
      if (current) void loadPreview(current, authenticated);
    }, 0);
    return () => window.clearTimeout(initialize);
  }, [authenticated, loadPreview]);

  function dismiss() {
    if (pending) {
      removeStoredCapability(pending.kind);
      if (pending.kind === "invite") {
        inviteRedeemResume.current = null;
        clearInviteRedeemResume();
      } else {
        recoveryConfirmResume.current = null;
        clearRecoveryConfirmResume();
      }
    }
    setPending(null);
  }

  function deferUntilProfileExists() {
    // The raw invite or approval token stays in sessionStorage and is offered
    // again after this browser has an authenticated profile.
    setPending(null);
  }

  async function acceptInvite() {
    if (!pending || pending.kind !== "invite" || !authenticated) return;
    setLoading(true);
    setError(null);
    const resume = inviteRedeemResume.current ?? {
      version: 1 as const,
      token: pending.token,
      idempotencyKey: createUuidV4(),
    };
    inviteRedeemResume.current = resume;
    persistInviteRedeemResume(resume);
    try {
      await redeemDirectInvite(pending.token, resume.idempotencyKey);
      removeStoredCapability("invite");
      inviteRedeemResume.current = null;
      clearInviteRedeemResume();
      setPending(null);
      onInviteAccepted();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось принять приглашение");
    } finally {
      setLoading(false);
    }
  }

  async function approveRecovery() {
    if (
      !pending ||
      pending.kind !== "recover" ||
      !authenticated ||
      !selectedContactId
    ) return;

    setLoading(true);
    setError(null);
    const resume = recoveryConfirmResume.current?.token === pending.token &&
      recoveryConfirmResume.current.contactId === selectedContactId
      ? recoveryConfirmResume.current
      : {
          version: 1 as const,
          token: pending.token,
          contactId: selectedContactId,
          idempotencyKey: createUuidV4(),
        };
    recoveryConfirmResume.current = resume;
    persistRecoveryConfirmResume(resume);
    try {
      const response = await confirmRecoveryApproval(
        pending.token,
        selectedContactId,
        resume.idempotencyKey,
      );
      const selected = approval?.eligible.find(
        (candidate) => candidate.contactId === selectedContactId,
      );
      removeStoredCapability("recover");
      recoveryConfirmResume.current = null;
      clearRecoveryConfirmResume();
      setApprovalDone(true);
      setApprovedTarget(
        response.target?.displayName ?? selected?.target.displayName ?? "профиля",
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Не удалось подтвердить восстановление");
    } finally {
      setLoading(false);
    }
  }

  const isRecovery = pending?.kind === "recover";
  const noEligibleRecovery = Boolean(
    isRecovery && authenticated && approval && approval.eligible.length === 0,
  );

  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (open || loading) return;
        if (!authenticated && !approvalDone) deferUntilProfileExists();
        else dismiss();
      }}
    >
      <DialogContent className={styles.dialog} showCloseButton={false} aria-busy={loading}>
        <DialogHeader>
          <span className={styles.icon} aria-hidden="true">
            {isRecovery ? <ShieldCheck /> : <Link2 />}
          </span>
          <DialogTitle className={styles.title}>
            {isRecovery ? "Подтвердить восстановление" : "Личное приглашение"}
          </DialogTitle>
          <DialogDescription className={styles.description}>
            {approvalDone
              ? approvedTarget
                ? `Вы подтвердили возврат профиля «${approvedTarget}». Друг завершит восстановление на своём устройстве.`
                : "Этот запрос уже подтверждён или завершён. Повторных действий не требуется."
              : isRecovery
                ? authenticated
                  ? approval
                    ? approval.eligible.length > 0
                      ? "Выберите знакомый профиль и подтвердите, что запрос действительно отправил его владелец."
                      : "Этот запрос не относится ни к одному профилю, который доверил вам восстановление."
                    : "Проверяем запрос восстановления…"
                  : "Это ссылка для доверенного друга. Откройте её в «Я живой» на устройстве, где вы уже вошли в свой профиль."
                : invite
                  ? `${invite.inviter.displayName} приглашает вас в личные связи.${authenticated ? "" : " Сначала создайте или восстановите профиль — приглашение сохранится."}`
                  : "Проверяем приглашение…"}
          </DialogDescription>
        </DialogHeader>

        {pending?.kind === "invite" && invite ? (
          <p className={styles.note}>
            После принятия вы увидите только новые отметки друг друга. Старая история не откроется.
          </p>
        ) : null}

        {isRecovery && !authenticated ? (
          <p className={styles.warning}>
            Не создавайте здесь новый профиль ради подтверждения. Перешлите ссылку выбранному доверенному человеку или откройте её на его авторизованном устройстве.
          </p>
        ) : null}

        {isRecovery && authenticated && approval?.eligible.length ? (
          <fieldset className={styles.choices}>
            <legend>Кому вы помогаете</legend>
            {approval.eligible.map((candidate) => (
              <label className={styles.choice} key={candidate.contactId}>
                <input
                  type="radio"
                  name="recovery-contact"
                  value={candidate.contactId}
                  checked={selectedContactId === candidate.contactId}
                  disabled={loading || approvalDone}
                  onChange={() => {
                    setSelectedContactId(candidate.contactId);
                    recoveryConfirmResume.current = null;
                    clearRecoveryConfirmResume();
                    setError(null);
                  }}
                />
                <span>
                  <strong>{candidate.target.displayName}</strong>
                  <small>{candidate.target.publicId}</small>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}

        {approvalDone ? (
          <p className={styles.success} role="status">Запрос обработан безопасно.</p>
        ) : null}
        {error ? <p className={styles.error} role="alert">{error}</p> : null}

        {approvalDone ? (
          <button type="button" className={styles.primary} onClick={dismiss}>
            Готово
          </button>
        ) : error && pending ? (
          <button
            type="button"
            className={styles.primary}
            disabled={loading}
            onClick={() => {
              if (
                pending.kind === "recover" &&
                authenticated &&
                approval &&
                selectedContactId
              ) {
                void approveRecovery();
              } else if (
                pending.kind === "invite" &&
                authenticated &&
                inviteRedeemResume.current
              ) {
                void acceptInvite();
              } else {
                void loadPreview(pending, authenticated);
              }
            }}
          >
            {loading
              ? "Проверяем…"
              : pending.kind === "recover" && approval
                ? "Повторить подтверждение"
                : "Повторить"}
          </button>
        ) : pending?.kind === "invite" ? (
          authenticated ? (
            <button
              type="button"
              className={styles.primary}
              disabled={loading || !invite}
              onClick={() => void acceptInvite()}
            >
              {loading ? "Принимаем…" : "Принять приглашение"}
            </button>
          ) : (
            <button
              type="button"
              className={styles.primary}
              disabled={loading || !invite}
              onClick={deferUntilProfileExists}
            >
              {loading ? "Проверяем…" : "Продолжить — ссылка сохранится"}
            </button>
          )
        ) : authenticated ? (
          <button
            type="button"
            className={styles.primary}
            disabled={loading || !selectedContactId || noEligibleRecovery}
            onClick={() => void approveRecovery()}
          >
            {loading ? "Подтверждаем…" : "Да, это мой знакомый"}
          </button>
        ) : (
          <button type="button" className={styles.primary} onClick={deferUntilProfileExists}>
            Понятно — сохранить ссылку
          </button>
        )}

        {!approvalDone ? (
          <button type="button" className={styles.secondary} disabled={loading} onClick={dismiss}>
            {isRecovery
              ? "Удалить этот запрос"
              : !authenticated
                ? "Отказаться от приглашения"
                : "Не сейчас"}
          </button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
