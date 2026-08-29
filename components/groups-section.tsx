"use client";

import type { CSSProperties } from "react";
import { useMemo, useState } from "react";
import {
  Check,
  ChevronRight,
  LogOut,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserMinus,
  UsersRound,
  X,
} from "lucide-react";
import type { Group, GroupsResponse, PeopleResponse, Person } from "@/lib/check-in-contract";
import {
  actOnGroupInvite,
  ApiError,
  createGroup,
  deleteGroup,
  inviteToGroup,
  removeGroupMember,
  revokeGroupInvite,
  updateGroup,
  updateGroupSharing,
} from "@/lib/check-in-api";
import { createUuidV4 } from "@/lib/browser-uuid";
import { formatPersonCheckIn, getCheckInAgeMs, getCheckInColor } from "@/lib/check-in-presentation";
import {
  isValidGroupEmoji,
  isValidGroupTitle,
  matchesGroupPeopleSearch,
  normalizeGroupEmoji,
  normalizeGroupTitle,
} from "@/lib/group-input";
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
import styles from "./groups-section.module.css";

type GroupsSectionProps = {
  data: GroupsResponse | null;
  people: PeopleResponse | null;
  error: string | null;
  loading: boolean;
  nowMs: number;
  onRefresh: () => Promise<void>;
  onAudienceRefresh: () => Promise<void>;
  onSessionLost: () => void;
};

type ConfirmAction =
  | { kind: "delete"; group: Group }
  | { kind: "leave"; group: Group; membershipId: string }
  | { kind: "remove"; group: Group; membershipId: string; name: string };

const PRESETS = [
  { emoji: "👨‍👩‍👧‍👦", title: "Семья" },
  { emoji: "🤝", title: "Друзья" },
  { emoji: "✨", title: "Своя группа" },
] as const;

const PENDING_GROUP_CREATION_STORAGE_KEY = "zhiv.pending-group-creation.v1";
const PENDING_GROUP_CREATION_TTL_MS = 24 * 60 * 60_000;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type PendingGroupCreation = {
  fingerprint: string;
  idempotencyKey: string;
  expiresAt: number;
};

function pendingGroupCreationKey(fingerprint: string): string {
  if (typeof window !== "undefined") {
    try {
      const raw = window.sessionStorage.getItem(PENDING_GROUP_CREATION_STORAGE_KEY);
      const saved = raw ? JSON.parse(raw) as Partial<PendingGroupCreation> : null;
      if (
        saved?.fingerprint === fingerprint &&
        typeof saved.idempotencyKey === "string" &&
        UUID_V4_PATTERN.test(saved.idempotencyKey) &&
        typeof saved.expiresAt === "number" &&
        saved.expiresAt > Date.now()
      ) {
        return saved.idempotencyKey;
      }
    } catch {
      // A malformed or unavailable sessionStorage must not block group creation.
    }
  }

  const pending: PendingGroupCreation = {
    fingerprint,
    idempotencyKey: createUuidV4(),
    expiresAt: Date.now() + PENDING_GROUP_CREATION_TTL_MS,
  };
  if (typeof window !== "undefined") {
    try {
      window.sessionStorage.setItem(PENDING_GROUP_CREATION_STORAGE_KEY, JSON.stringify(pending));
    } catch {
      // The request still remains idempotent for this click.
    }
  }
  return pending.idempotencyKey;
}

function clearPendingGroupCreation() {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(PENDING_GROUP_CREATION_STORAGE_KEY);
  } catch {
    // Storage cleanup is best-effort after a confirmed response.
  }
}

function initials(name: string): string {
  return Array.from(name.trim())[0]?.toUpperCase() ?? "Я";
}

export function GroupsSection({
  data,
  people,
  error,
  loading,
  nowMs,
  onRefresh,
  onAudienceRefresh,
  onSessionLost,
}: GroupsSectionProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editGroup, setEditGroup] = useState<Group | null>(null);
  const [inviteGroup, setInviteGroup] = useState<Group | null>(null);
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const [title, setTitle] = useState("Семья");
  const [emoji, setEmoji] = useState<string | null>("👨‍👩‍👧‍👦");
  const [selectedPeople, setSelectedPeople] = useState<Set<string>>(new Set());
  const [peopleQuery, setPeopleQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);
  const [localError, setLocalError] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);

  const incomingCount = data?.incomingInvites.length ?? 0;

  async function refreshAll() {
    await Promise.all([onRefresh(), onAudienceRefresh()]);
  }

  function handleError(cause: unknown, fallback: string) {
    if (cause instanceof ApiError && cause.status === 401) {
      onSessionLost();
      return;
    }
    setLocalError(cause instanceof Error ? cause.message : fallback);
  }

  async function runMutation(key: string, operation: () => Promise<unknown>) {
    if (pending) return;
    setPending(key);
    setLocalError(null);
    try {
      await operation();
      await refreshAll();
    } catch (cause) {
      handleError(cause, "Не удалось изменить группу");
    } finally {
      setPending(null);
    }
  }

  function resetCreate() {
    setTitle("Семья");
    setEmoji("👨‍👩‍👧‍👦");
    setSelectedPeople(new Set());
    setPeopleQuery("");
    setLocalError(null);
  }

  async function handleCreate() {
    const normalizedTitle = normalizeGroupTitle(title);
    const normalizedEmoji = normalizeGroupEmoji(emoji);
    if (!isValidGroupTitle(normalizedTitle) || !isValidGroupEmoji(normalizedEmoji)) {
      setLocalError("Название — от 1 до 64 символов");
      return;
    }
    const inviteeCircleIds = [...selectedPeople].sort();
    const fingerprint = JSON.stringify({
      title: normalizedTitle,
      emoji: normalizedEmoji,
      inviteeCircleIds,
    });
    const idempotencyKey = pendingGroupCreationKey(fingerprint);
    await runMutation("create", async () => {
      try {
        await createGroup(
          normalizedTitle,
          normalizedEmoji,
          inviteeCircleIds,
          idempotencyKey,
        );
      } catch (cause) {
        if (cause instanceof ApiError && cause.status < 500) clearPendingGroupCreation();
        throw cause;
      }
      clearPendingGroupCreation();
      setCreateOpen(false);
      resetCreate();
    });
  }

  async function handleEdit() {
    if (!editGroup) return;
    const normalizedTitle = normalizeGroupTitle(title);
    const normalizedEmoji = normalizeGroupEmoji(emoji);
    if (!isValidGroupTitle(normalizedTitle) || !isValidGroupEmoji(normalizedEmoji)) {
      setLocalError("Название — от 1 до 64 символов");
      return;
    }
    await runMutation(`edit:${editGroup.groupId}`, async () => {
      await updateGroup(
        editGroup.groupId,
        normalizedTitle,
        normalizedEmoji,
        createUuidV4(),
      );
      setEditGroup(null);
    });
  }

  async function handleConfirm() {
    if (!confirmAction) return;
    const action = confirmAction;
    await runMutation(`${action.kind}:${action.group.groupId}`, async () => {
      if (action.kind === "delete") {
        await deleteGroup(action.group.groupId, createUuidV4());
      } else {
        await removeGroupMember(action.group.groupId, action.membershipId, createUuidV4());
      }
      setConfirmAction(null);
      setExpandedGroupId(null);
    });
  }

  const availablePeople = useMemo(() => {
    if (!inviteGroup || !people) return [];
    const unavailable = new Set([
      ...inviteGroup.members.map((member) => member.user.publicId),
      ...inviteGroup.pendingInvites.map((invite) => invite.user.publicId),
    ]);
    return people.people.filter((person) => !unavailable.has(person.user.publicId));
  }, [inviteGroup, people]);

  const visibleCreatePeople = useMemo(() => {
    if (!people) return [];
    return people.people.filter((person) =>
      matchesGroupPeopleSearch(person.user.displayName, peopleQuery));
  }, [people, peopleQuery]);

  return (
    <section className={styles.section} aria-labelledby="groups-title">
      <div className={styles.headingRow}>
        <div className={styles.titleRow}>
          <h2 id="groups-title">Группы</h2>
          {(data?.groups.length ?? 0) > 0 ? <span>{data?.groups.length}</span> : null}
        </div>
        <button
          className={styles.createButton}
          type="button"
          onClick={() => {
            resetCreate();
            setCreateOpen(true);
          }}
        >
          <Plus size={16} /> Создать
        </button>
      </div>

      {data?.incomingInvites.map((invite) => (
        <article className={styles.inviteCard} key={invite.inviteId}>
          <div className={styles.groupIcon}>{invite.groupEmoji ?? "👥"}</div>
          <div className={styles.cardText}>
            <strong>{invite.groupTitle}</strong>
            <span>{invite.user.displayName} зовёт в группу</span>
          </div>
          <div className={styles.inviteActions}>
            <button
              className={styles.acceptButton}
              type="button"
              aria-label={`Вступить в группу ${invite.groupTitle}`}
              disabled={Boolean(pending)}
              onClick={() => void runMutation(`accept:${invite.inviteId}`, () =>
                actOnGroupInvite(invite.inviteId, "accept", createUuidV4()))}
            >
              <Check size={18} />
            </button>
            <button
              className={styles.iconButton}
              type="button"
              aria-label={`Отклонить приглашение в ${invite.groupTitle}`}
              disabled={Boolean(pending)}
              onClick={() => void runMutation(`reject:${invite.inviteId}`, () =>
                actOnGroupInvite(invite.inviteId, "reject", createUuidV4()))}
            >
              <X size={18} />
            </button>
          </div>
        </article>
      ))}

      {loading && !data ? <div className={styles.state}>Загружаем группы…</div> : null}
      {error && !data ? <div className={styles.state}>{error}</div> : null}

      {data && data.groups.length === 0 && incomingCount === 0 ? (
        <div className={styles.empty}>
          <UsersRound size={28} />
          <strong>Пока без групп</strong>
          <p>Создайте семейную, дружескую или свою. Люди вступят только после согласия.</p>
        </div>
      ) : null}

      <div className={styles.groupList}>
        {data?.groups.map((group) => {
          const expanded = expandedGroupId === group.groupId;
          const mine = group.members.find((member) => member.isMe);
          return (
            <article className={styles.groupCard} key={group.groupId}>
              <button
                className={styles.groupSummary}
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpandedGroupId(expanded ? null : group.groupId)}
              >
                <span className={styles.groupIcon}>{group.emoji ?? "👥"}</span>
                <span className={styles.cardText}>
                  <strong>{group.title}</strong>
                  <span>
                    {group.members.length} участн. · {group.myRole === "OWNER" ? "вы создатель" : "вы участник"}
                  </span>
                </span>
                <ChevronRight className={expanded ? styles.chevronOpen : undefined} size={19} />
              </button>

              {expanded ? (
                <div className={styles.groupDetails}>
                  <label className={styles.sharingLabel}>
                    <span>
                      <strong>Показывать через эту группу</strong>
                      <small>Только новые отметки после включения</small>
                    </span>
                    <Switch
                      checked={group.mySharingMode !== "OFF"}
                      disabled={Boolean(pending)}
                      onCheckedChange={(checked) => void runMutation(
                        `sharing:${group.groupId}`,
                        () => updateGroupSharing(
                          group.groupId,
                          checked ? "LATEST_ONLY" : "OFF",
                          createUuidV4(),
                        ),
                      )}
                      aria-label={`Показывать мои отметки через группу ${group.title}`}
                    />
                  </label>

                  <div className={styles.members}>
                    {group.members.map((member) => {
                      const sharing = member.sharingMode !== "OFF";
                      const ageMs = getCheckInAgeMs(member.lastCheckInAt, 0, nowMs);
                      const color = sharing ? getCheckInColor(ageMs) : "#5d6258";
                      return (
                        <div className={styles.memberRow} key={member.membershipId}>
                          <span
                            className={styles.avatar}
                            style={{ "--member-color": color } as CSSProperties}
                          >
                            {initials(member.user.displayName)}
                          </span>
                          <span className={styles.cardText}>
                            <strong>{member.user.displayName}{member.isMe ? " · вы" : ""}</strong>
                            <span>
                              {member.isMe
                                ? (group.mySharingMode === "OFF" ? "Ваши отметки скрыты" : "Ваши новые отметки видны")
                                : formatPersonCheckIn(member.lastCheckInAt, nowMs, sharing)}
                            </span>
                          </span>
                          {group.myRole === "OWNER" && !member.isMe ? (
                            <button
                              className={styles.iconButton}
                              type="button"
                              aria-label={`Удалить ${member.user.displayName} из группы`}
                              onClick={() => setConfirmAction({
                                kind: "remove",
                                group,
                                membershipId: member.membershipId,
                                name: member.user.displayName,
                              })}
                            >
                              <UserMinus size={16} />
                            </button>
                          ) : null}
                        </div>
                      );
                    })}
                  </div>

                  {group.pendingInvites.length > 0 ? (
                    <div className={styles.pendingList}>
                      <strong>Ждём ответа</strong>
                      {group.pendingInvites.map((invite) => (
                        <div key={invite.inviteId}>
                          <span>{invite.user.displayName}</span>
                          <button
                            type="button"
                            disabled={Boolean(pending)}
                            onClick={() => void runMutation(`revoke:${invite.inviteId}`, () =>
                              revokeGroupInvite(group.groupId, invite.inviteId, createUuidV4()))}
                          >
                            Отозвать
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : null}

                  <div className={styles.groupActions}>
                    {group.myRole === "OWNER" ? (
                      <>
                        <button type="button" onClick={() => setInviteGroup(group)}>
                          <Plus size={15} /> Пригласить
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setTitle(group.title);
                            setEmoji(group.emoji);
                            setLocalError(null);
                            setEditGroup(group);
                          }}
                        >
                          <Pencil size={15} /> Изменить
                        </button>
                        <button
                          className={styles.dangerText}
                          type="button"
                          onClick={() => setConfirmAction({ kind: "delete", group })}
                        >
                          <Trash2 size={15} /> Удалить
                        </button>
                      </>
                    ) : mine ? (
                      <button
                        className={styles.dangerText}
                        type="button"
                        onClick={() => setConfirmAction({
                          kind: "leave",
                          group,
                          membershipId: mine.membershipId,
                        })}
                      >
                        <LogOut size={15} /> Выйти
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
            </article>
          );
        })}
      </div>

      {localError ? <p className={styles.error} role="alert">{localError}</p> : null}

      <Dialog open={createOpen} onOpenChange={(open) => {
        setCreateOpen(open);
        if (!open) resetCreate();
      }}>
        <DialogContent className={styles.dialog}>
          <DialogHeader>
            <DialogTitle>Новая группа</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              Выбранные люди получат приглашения. Никого не добавляем молча.
            </DialogDescription>
          </DialogHeader>
          <div className={styles.presetRow}>
            {PRESETS.map((preset) => (
              <button
                key={preset.title}
                type="button"
                className={emoji === preset.emoji ? styles.presetActive : undefined}
                onClick={() => {
                  setEmoji(preset.emoji);
                  setTitle(preset.title);
                }}
              >
                <span>{preset.emoji}</span>{preset.title}
              </button>
            ))}
          </div>
          <label className={styles.field}>
            <span>Название</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={64} />
          </label>
          {people && people.people.length > 0 ? (
            <div className={styles.peopleSelection}>
              <label className={styles.field}>
                <span>Поиск по имени</span>
                <span className={styles.peopleSearch}>
                  <Search size={17} aria-hidden="true" />
                  <input
                    type="search"
                    value={peopleQuery}
                    onChange={(event) => setPeopleQuery(event.target.value)}
                    placeholder="Начните вводить имя"
                    autoComplete="off"
                    aria-controls="new-group-people"
                  />
                </span>
              </label>
              <fieldset className={styles.peoplePicker} id="new-group-people">
                <legend>
                  Кого пригласить{selectedPeople.size > 0 ? ` · выбрано ${selectedPeople.size}` : ""}
                </legend>
                {visibleCreatePeople.map((person) => (
                  <label key={person.circleId}>
                    <input
                      type="checkbox"
                      checked={selectedPeople.has(person.circleId)}
                      onChange={(event) => setSelectedPeople((current) => {
                        const next = new Set(current);
                        if (event.target.checked) next.add(person.circleId);
                        else next.delete(person.circleId);
                        return next;
                      })}
                    />
                    <span>{initials(person.user.displayName)}</span>
                    <strong>{person.user.displayName}</strong>
                  </label>
                ))}
                {visibleCreatePeople.length === 0 ? (
                  <p className={styles.noPeopleFound} role="status">
                    По этому имени никого не нашли.
                  </p>
                ) : null}
              </fieldset>
            </div>
          ) : (
            <p className={styles.helper}>Сначала добавьте людей — группу можно создать и без них.</p>
          )}
          <button className={styles.primaryButton} type="button" disabled={Boolean(pending)} onClick={() => void handleCreate()}>
            {pending === "create" ? "Создаём…" : "Создать группу"}
          </button>
          {localError ? <p className={styles.dialogError} role="alert">{localError}</p> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(editGroup)} onOpenChange={(open) => {
        if (!open) setEditGroup(null);
      }}>
        <DialogContent className={styles.dialog}>
          <DialogHeader>
            <DialogTitle>Изменить группу</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>Название и значок видят все участники.</DialogDescription>
          </DialogHeader>
          <label className={styles.field}>
            <span>Значок</span>
            <input value={emoji ?? ""} onChange={(event) => setEmoji(event.target.value)} maxLength={16} />
          </label>
          <label className={styles.field}>
            <span>Название</span>
            <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={64} />
          </label>
          <button className={styles.primaryButton} type="button" disabled={Boolean(pending)} onClick={() => void handleEdit()}>
            Сохранить
          </button>
          {localError ? <p className={styles.dialogError} role="alert">{localError}</p> : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(inviteGroup)} onOpenChange={(open) => {
        if (!open) setInviteGroup(null);
      }}>
        <DialogContent className={styles.dialog}>
          <DialogHeader>
            <DialogTitle>Пригласить в {inviteGroup?.title}</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>Только люди из подтверждённых личных связей.</DialogDescription>
          </DialogHeader>
          <div className={styles.invitePicker}>
            {availablePeople.length === 0 ? <p className={styles.helper}>Все доступные люди уже внутри или приглашены.</p> : null}
            {availablePeople.map((person: Person) => (
              <button
                key={person.circleId}
                type="button"
                disabled={Boolean(pending)}
                onClick={() => void runMutation(`invite:${person.circleId}`, async () => {
                  if (!inviteGroup) return;
                  await inviteToGroup(inviteGroup.groupId, person.circleId, createUuidV4());
                  setInviteGroup(null);
                })}
              >
                <span>{initials(person.user.displayName)}</span>
                <strong>{person.user.displayName}</strong>
                <Plus size={17} />
              </button>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <AlertDialog open={Boolean(confirmAction)} onOpenChange={(open) => {
        if (!open && !pending) setConfirmAction(null);
      }}>
        <AlertDialogContent className={styles.confirmDialog}>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction?.kind === "delete"
                ? "Удалить группу?"
                : confirmAction?.kind === "leave"
                  ? "Выйти из группы?"
                  : `Удалить ${confirmAction?.kind === "remove" ? confirmAction.name : "участника"}?`}
            </AlertDialogTitle>
            <AlertDialogDescription className={styles.dialogDescription}>
              Старые снимки доступа останутся частью истории, а новые отметки через эту группу больше не передадутся.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className={styles.cancelButton}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              className={styles.dangerButton}
              disabled={Boolean(pending)}
              onClick={(event) => {
                event.preventDefault();
                void handleConfirm();
              }}
            >
              Подтвердить
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
