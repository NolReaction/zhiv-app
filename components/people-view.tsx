"use client";

import type { CSSProperties, FormEvent } from "react";
import { useMemo, useState } from "react";
import { Check, Copy, Plus, RefreshCw, Search, Trash2, UserRound, X } from "lucide-react";
import type {
  DirectRequest,
  GroupsResponse,
  PeopleResponse,
  Person,
  UserLookupResponse,
} from "@/lib/check-in-contract";
import {
  actOnDirectRequest,
  ApiError,
  lookupUser,
  removePerson,
  sendDirectRequest,
  updatePersonSharing,
} from "@/lib/check-in-api";
import {
  formatPersonCheckIn,
  getCheckInAgeMs,
  getCheckInColor,
  isValidPublicId,
  normalizePublicId,
} from "@/lib/check-in-presentation";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import styles from "./people-view.module.css";
import { createUuidV4 } from "@/lib/browser-uuid";
import { GroupsSection } from "./groups-section";

type PeopleViewProps = {
  data: PeopleResponse | null;
  groups: GroupsResponse | null;
  error: string | null;
  groupsError: string | null;
  loading: boolean;
  groupsLoading: boolean;
  nowMs: number;
  onRefresh: () => Promise<void>;
  onGroupsRefresh: () => Promise<void>;
  onSessionLost: () => void;
};

function initials(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "Ж";
}

function requestExpiry(expiresAt: string): string {
  const days = Math.max(0, Math.ceil((Date.parse(expiresAt) - Date.now()) / 86_400_000));
  return days <= 1 ? "до завтра" : `ещё ${days} дн.`;
}

function stateMessage(result: UserLookupResponse): string | null {
  switch (result.relationshipState) {
    case "SELF":
      return "Это вы 😄";
    case "CONNECTED":
      return "Уже в ваших";
    case "INCOMING_REQUEST":
      return "Этот человек уже отправил вам заявку";
    case "OUTGOING_REQUEST":
      return "Заявка уже отправлена";
    default:
      return null;
  }
}

export function PeopleView({
  data,
  groups,
  error,
  groupsError,
  loading,
  groupsLoading,
  nowMs,
  onRefresh,
  onGroupsRefresh,
  onSessionLost,
}: PeopleViewProps) {
  const [addOpen, setAddOpen] = useState(false);
  const [publicId, setPublicId] = useState("");
  const [lookup, setLookup] = useState<UserLookupResponse | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [removeCandidate, setRemoveCandidate] = useState<Person | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const incomingCount = (data?.incomingRequests.length ?? 0) + (groups?.incomingInvites.length ?? 0);
  const title = incomingCount > 0 ? `Свои · ${incomingCount}` : "Свои";

  function handleApiError(cause: unknown, fallback: string) {
    if (cause instanceof ApiError && cause.status === 401) {
      onSessionLost();
      return;
    }
    setDialogError(cause instanceof Error ? cause.message : fallback);
  }

  async function runMutation(key: string, operation: () => Promise<unknown>) {
    if (pending) return;
    setPending(key);
    setDialogError(null);
    try {
      await operation();
      await onRefresh();
    } catch (cause) {
      handleApiError(cause, "Не удалось выполнить действие");
    } finally {
      setPending(null);
    }
  }

  function resetLookup() {
    setPublicId("");
    setLookup(null);
    setDialogError(null);
  }

  async function handleLookup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized = normalizePublicId(publicId);
    setPublicId(normalized);
    setLookup(null);
    setDialogError(null);
    if (!isValidPublicId(normalized)) {
      setDialogError("Введите все 12 символов ID");
      return;
    }

    setPending("lookup");
    try {
      setLookup(await lookupUser(normalized));
    } catch (cause) {
      handleApiError(cause, "Человек не найден");
    } finally {
      setPending(null);
    }
  }

  async function handleSendRequest() {
    if (!lookup || lookup.relationshipState !== "NONE") return;
    await runMutation("send", async () => {
      await sendDirectRequest(lookup.user.publicId, createUuidV4());
      setAddOpen(false);
      resetLookup();
    });
  }

  async function handleRequest(request: DirectRequest, action: "accept" | "reject" | "cancel") {
    await runMutation(`${action}:${request.requestId}`, () =>
      actOnDirectRequest(request.requestId, action, createUuidV4()),
    );
  }

  async function handleSharing(person: Person, enabled: boolean) {
    await runMutation(`sharing:${person.circleId}`, () =>
      updatePersonSharing(
        person.circleId,
        enabled ? "LATEST_ONLY" : "OFF",
          createUuidV4(),
      ),
    );
  }

  async function handleRemove() {
    if (!removeCandidate) return;
    const person = removeCandidate;
    await runMutation(`remove:${person.circleId}`, async () => {
      await removePerson(person.circleId, createUuidV4());
      setRemoveCandidate(null);
    });
  }

  async function copyId(id: string) {
    try {
      await navigator.clipboard.writeText(id);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((value) => (value === id ? null : value)), 1_600);
    } catch {
      setDialogError("Не удалось скопировать ID");
    }
  }

  const content = useMemo(() => {
    if (loading && !data) {
      return <div className={styles.state}>Загружаем своих…</div>;
    }
    if (error && !data) {
      return (
        <div className={styles.state}>
          <p>{error}</p>
          <button className={styles.secondaryButton} type="button" onClick={() => void onRefresh()}>
            <RefreshCw size={17} /> Повторить
          </button>
        </div>
      );
    }
    return null;
  }, [data, error, loading, onRefresh]);

  return (
    <section className={styles.view} aria-labelledby="people-title">
      <div className={styles.headingRow}>
        <div>
          <p className={styles.kicker}>ЛИЧНЫЕ СВЯЗИ</p>
          <h1 id="people-title">{title}</h1>
        </div>
        <button
          className={styles.addButton}
          type="button"
          onClick={() => {
            resetLookup();
            setAddOpen(true);
          }}
        >
          <Plus size={19} /> Добавить
        </button>
      </div>

      {content}

      {data ? (
        <div className={styles.sections}>
          <GroupsSection
            data={groups}
            people={data}
            error={groupsError}
            loading={groupsLoading}
            nowMs={nowMs}
            onRefresh={onGroupsRefresh}
            onAudienceRefresh={onRefresh}
            onSessionLost={onSessionLost}
          />

          {data.incomingRequests.length > 0 ? (
            <section className={styles.section} aria-labelledby="incoming-title">
              <h2 id="incoming-title">Хотят быть своими</h2>
              <div className={styles.list}>
                {data.incomingRequests.map((request) => (
                  <article className={styles.requestCard} key={request.requestId}>
                    <div className={styles.avatar}>{initials(request.user.displayName)}</div>
                    <div className={styles.cardText}>
                      <strong>{request.user.displayName}</strong>
                      <span>{request.user.publicId} · {requestExpiry(request.expiresAt)}</span>
                    </div>
                    <div className={styles.requestActions}>
                      <button
                        className={styles.acceptButton}
                        type="button"
                        aria-label={`Принять заявку от ${request.user.displayName}`}
                        disabled={Boolean(pending)}
                        onClick={() => void handleRequest(request, "accept")}
                      >
                        <Check size={19} />
                      </button>
                      <button
                        className={styles.iconButton}
                        type="button"
                        aria-label={`Отклонить заявку от ${request.user.displayName}`}
                        disabled={Boolean(pending)}
                        onClick={() => void handleRequest(request, "reject")}
                      >
                        <X size={19} />
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          {data.outgoingRequests.length > 0 ? (
            <section className={styles.section} aria-labelledby="outgoing-title">
              <h2 id="outgoing-title">Ждём ответа</h2>
              <div className={styles.list}>
                {data.outgoingRequests.map((request) => (
                  <article className={styles.requestCard} key={request.requestId}>
                    <div className={`${styles.avatar} ${styles.avatarMuted}`}>
                      {initials(request.user.displayName)}
                    </div>
                    <div className={styles.cardText}>
                      <strong>{request.user.displayName}</strong>
                      <span>Заявка отправлена · {requestExpiry(request.expiresAt)}</span>
                    </div>
                    <button
                      className={styles.textButton}
                      type="button"
                      disabled={Boolean(pending)}
                      onClick={() => void handleRequest(request, "cancel")}
                    >
                      Отменить
                    </button>
                  </article>
                ))}
              </div>
            </section>
          ) : null}

          <section className={styles.section} aria-labelledby="connected-title">
            <div className={styles.sectionTitleRow}>
              <h2 id="connected-title">Мои люди</h2>
              {data.people.length > 0 ? <span>{data.people.length}</span> : null}
            </div>
            {data.people.length === 0 ? (
              <div className={styles.empty}>
                <UserRound size={30} />
                <strong>Здесь пока никого</strong>
                <p>Добавьте человека по его ID. Только после взаимного согласия вы увидите отметки друг друга.</p>
              </div>
            ) : (
              <div className={styles.list}>
                {data.people.map((person) => {
                  const theirSharing = person.theirSharingMode !== "OFF";
                  const ageMs = getCheckInAgeMs(person.lastCheckInAt, 0, nowMs);
                  const statusColor = theirSharing ? getCheckInColor(ageMs) : "#5d6258";
                  const isSharing = person.mySharingMode !== "OFF";
                  return (
                    <article className={styles.personCard} key={person.circleId}>
                      <div className={styles.personTop}>
                        <div
                          className={styles.avatar}
                          style={{ "--person-color": statusColor } as CSSProperties}
                        >
                          {initials(person.user.displayName)}
                        </div>
                        <div className={styles.cardText}>
                          <strong>{person.user.displayName}</strong>
                          <span className={styles.personStatus}>
                            <i style={{ background: statusColor }} />
                            {formatPersonCheckIn(person.lastCheckInAt, nowMs, theirSharing)}
                          </span>
                        </div>
                        <button
                          className={styles.iconButton}
                          type="button"
                          aria-label={`Скопировать ID ${person.user.displayName}`}
                          onClick={() => void copyId(person.user.publicId)}
                        >
                          {copiedId === person.user.publicId ? <Check size={17} /> : <Copy size={17} />}
                        </button>
                      </div>
                      <div className={styles.personBottom}>
                        <label className={styles.sharingLabel}>
                          <span>
                            <strong>Показывать через личную связь</strong>
                            <small>{isSharing ? "Новые отметки доступны" : "Новые отметки скрыты"}</small>
                          </span>
                          <Switch
                            checked={isSharing}
                            disabled={Boolean(pending)}
                            onCheckedChange={(checked) => void handleSharing(person, checked)}
                            aria-label={`Показывать мои отметки пользователю ${person.user.displayName}`}
                          />
                        </label>
                        <button
                          className={styles.removeButton}
                          type="button"
                          onClick={() => setRemoveCandidate(person)}
                        >
                          <Trash2 size={15} /> Удалить связь
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>

          <p className={styles.privacyNote}>
            Старые отметки не открываются задним числом. Вы в любой момент решаете, кто видит новые.
          </p>
        </div>
      ) : null}

      {dialogError && !addOpen ? <p className={styles.pageError} role="alert">{dialogError}</p> : null}

      <Dialog open={addOpen} onOpenChange={(open) => {
        setAddOpen(open);
        if (!open) resetLookup();
      }}>
        <DialogContent className={styles.dialog}>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>Добавить своего</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              Введите точный ID. Имя само по себе ничего не связывает.
            </DialogDescription>
          </DialogHeader>
          <form className={styles.searchForm} onSubmit={handleLookup} noValidate>
            <label htmlFor="person-public-id">ID человека</label>
            <div className={styles.searchRow}>
              <input
                id="person-public-id"
                value={publicId}
                onChange={(event) => {
                  setPublicId(normalizePublicId(event.target.value));
                  setLookup(null);
                  setDialogError(null);
                }}
                placeholder="7K3P-2Q9M-W8ZR"
                autoCapitalize="characters"
                autoComplete="off"
                spellCheck={false}
                maxLength={14}
                autoFocus
              />
              <button type="submit" disabled={pending === "lookup"} aria-label="Найти человека">
                <Search size={20} />
              </button>
            </div>
          </form>

          {lookup ? (
            <div className={styles.lookupCard}>
              <div className={styles.avatar}>{initials(lookup.user.displayName)}</div>
              <div className={styles.cardText}>
                <strong>{lookup.user.displayName}</strong>
                <span>{lookup.user.publicId}</span>
              </div>
              {lookup.relationshipState === "NONE" ? (
                <button
                  className={styles.sendButton}
                  type="button"
                  disabled={Boolean(pending)}
                  onClick={() => void handleSendRequest()}
                >
                  Отправить заявку
                </button>
              ) : null}
              {stateMessage(lookup) ? (
                <p className={styles.lookupState}>{stateMessage(lookup)}</p>
              ) : null}
            </div>
          ) : null}
          {dialogError ? <p className={styles.dialogError} role="alert">{dialogError}</p> : null}
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(removeCandidate)} onOpenChange={(open) => {
        if (!open && !pending?.startsWith("remove:")) setRemoveCandidate(null);
      }}>
        <AlertDialogContent className={styles.confirmDialog}>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить связь?</AlertDialogTitle>
            <AlertDialogDescription className={styles.dialogDescription}>
              Вы и {removeCandidate?.user.displayName} перестанете видеть новые отметки друг друга.
              Позже можно будет добавиться заново.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={styles.cancelButton}>Оставить</AlertDialogCancel>
            <AlertDialogAction
              className={styles.dangerButton}
              disabled={Boolean(pending)}
              onClick={(event) => {
                event.preventDefault();
                void handleRemove();
              }}
            >
              Удалить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
