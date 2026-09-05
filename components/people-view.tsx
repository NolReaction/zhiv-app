"use client";

import type { CSSProperties, FormEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useMemo, useReducer, useRef, useState } from "react";
import { Check, ClipboardPaste, Copy, Link2, Plus, QrCode, RefreshCw, Search, Share2, Trash2, UserRound, X } from "lucide-react";
import QRCode from "react-qr-code";
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
  createDirectInviteLink,
  lookupUser,
  removePerson,
  sendDirectRequest,
  updatePersonSharing,
} from "@/lib/check-in-api";
import {
  capabilityUrl,
  createCapabilityToken,
  type ShareOriginUnavailableReason,
} from "@/lib/capability-token";
import {
  formatDirectPersonCheckIn,
  formatPublicIdInput,
  getCheckInAgeMs,
  getCheckInColor,
  isValidPublicId,
  normalizePublicId,
} from "@/lib/check-in-presentation";
import { copyText, shareContent } from "@/lib/identity-sharing";
import {
  INVITE_IMPORT_EVENT,
  inviteCode,
  parseInviteToken,
} from "@/lib/invite-import";
import {
  initialInviteDialogState,
  inviteDialogReducer,
  type InviteMode,
} from "@/lib/invite-dialog-state";
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
import { SharingSwitch as Switch } from "@/components/sharing-switch";
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

type PeopleSection = "people" | "groups";

const DIALOG_EXIT_MS = 220;

type InviteShare = {
  token: string;
  url: string | null;
  unavailableReason: ShareOriginUnavailableReason | null;
  expiresAt: string;
};

const PEOPLE_SECTIONS: readonly PeopleSection[] = ["people", "groups"];

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
      return "Вы уже на связи";
    case "INCOMING_REQUEST":
      return "Этот человек уже отправил вам заявку";
    case "OUTGOING_REQUEST":
      return "Заявка уже отправлена";
    default:
      return null;
  }
}

function unavailableInviteMessage(reason: ShareOriginUnavailableReason | null): string {
  if (reason === "loopback-origin") {
    return "Ссылка и QR с localhost не откроются на другом устройстве. Откройте приложение на компьютере по LAN-адресу или задайте NEXT_PUBLIC_APP_ORIGIN. Пока можно передать одноразовый код ниже.";
  }
  if (reason === "invalid-configured-origin") {
    return "NEXT_PUBLIC_APP_ORIGIN задан неверно. Нужен полный адрес вида https://example.ru или http://192.168.1.232:3000 без пути.";
  }
  return "Не удалось определить адрес приложения для другого устройства. Передайте одноразовый код ниже.";
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
  const [inviteImportOpen, setInviteImportOpen] = useState(false);
  const [inviteImportValue, setInviteImportValue] = useState("");
  const [inviteImportError, setInviteImportError] = useState<string | null>(null);
  const [publicId, setPublicId] = useState("");
  const [lookup, setLookup] = useState<UserLookupResponse | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [removeCandidate, setRemoveCandidate] = useState<Person | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<PeopleSection>("people");
  const [inviteDialog, dispatchInviteDialog] = useReducer(
    inviteDialogReducer,
    initialInviteDialogState,
  );
  const [inviteShare, setInviteShare] = useState<InviteShare | null>(null);
  const [shareNotice, setShareNotice] = useState<string | null>(null);
  const inviteLinkField = useRef<HTMLTextAreaElement>(null);

  function selectSection(section: PeopleSection) {
    setActiveSection(section);
  }

  function handleSectionKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const currentIndex = PEOPLE_SECTIONS.indexOf(activeSection);
    const nextSection = event.key === "Home"
      ? PEOPLE_SECTIONS[0]
      : event.key === "End"
        ? PEOPLE_SECTIONS[PEOPLE_SECTIONS.length - 1]
        : PEOPLE_SECTIONS[
            (currentIndex + (event.key === "ArrowRight" ? 1 : -1) + PEOPLE_SECTIONS.length)
              % PEOPLE_SECTIONS.length
          ];
    selectSection(nextSection);
    window.requestAnimationFrame(() => {
      document.getElementById(`people-section-tab-${nextSection}`)?.focus();
    });
  }

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

  function resetInviteImport() {
    setInviteImportValue("");
    setInviteImportError(null);
  }

  function handleInviteImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const parsed = parseInviteToken(inviteImportValue);
    if (!parsed.ok) {
      setInviteImportError(parsed.error);
      return;
    }

    setInviteImportOpen(false);
    resetInviteImport();
    window.setTimeout(() => {
      const nextUrl = new URL(window.location.href);
      nextUrl.hash = `/invite/${parsed.token}`;
      window.history.replaceState(null, "", nextUrl.toString());
      window.dispatchEvent(new Event(INVITE_IMPORT_EVENT));
    }, DIALOG_EXIT_MS);
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

  function copyId(id: string) {
    setDialogError(null);
    void copyText(id).then((copied) => {
      if (!copied) {
        setDialogError("Не удалось скопировать ID");
        return;
      }
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((value) => (value === id ? null : value)), 1_600);
    });
  }

  async function openInvite(mode: InviteMode, forceRegenerate = false) {
    if (pending) return;
    dispatchInviteDialog({ type: "open", mode });
    setDialogError(null);
    setShareNotice(null);
    if (
      !forceRegenerate &&
      inviteShare &&
      Date.parse(inviteShare.expiresAt) > nowMs
    ) return;
    setInviteShare(null);
    setPending("invite-link");
    try {
      const token = createCapabilityToken();
      const response = await createDirectInviteLink(token, createUuidV4());
      const inviteUrl = capabilityUrl("invite", token);
      setInviteShare({
        token,
        url: inviteUrl.url,
        unavailableReason: inviteUrl.reason,
        expiresAt: response.expiresAt,
      });
    } catch (cause) {
      handleApiError(cause, "Не удалось создать приглашение");
    } finally {
      setPending(null);
    }
  }

  async function copyInvite() {
    if (!inviteShare) return;
    setDialogError(null);
    setShareNotice(null);
    const value = inviteShare.url ?? inviteCode(inviteShare.token);
    const copied = await copyText(value);
    if (copied) {
      setShareNotice(inviteShare.url ? "Ссылка скопирована" : "Код приглашения скопирован");
      return;
    }

    inviteLinkField.current?.focus({ preventScroll: true });
    inviteLinkField.current?.select();
    setDialogError(`Не удалось скопировать автоматически — зажмите ${inviteShare.url ? "ссылку" : "код"} выше и выберите «Скопировать».`);
  }

  async function shareInvite() {
    if (!inviteShare) return;
    setDialogError(null);
    setShareNotice(null);
    const outcome = await shareContent({
      title: "Приглашение в «Я живой»",
      text: inviteShare.url
        ? "Добавь меня в личные связи в «Я живой»."
        : `Открой «Я живой» → «Люди» → «Принять» и введи код: ${inviteCode(inviteShare.token)}`,
      ...(inviteShare.url ? { url: inviteShare.url } : {}),
    });
    if (outcome === "shared") {
      setShareNotice("Приглашение отправлено");
    } else if (outcome !== "cancelled") {
      setDialogError("Системная отправка недоступна — используйте «Скопировать».");
    }
  }

  const content = useMemo(() => {
    if (loading && !data) {
      return <div className={styles.state}>Загружаем личные связи…</div>;
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
    <section id="people-panel" className={styles.view} aria-labelledby="people-title">
      <div className={styles.headingRow}>
        <h1 id="people-title">Личные связи</h1>
      </div>

      <div className={styles.sectionTabs} role="tablist" aria-label="Люди и группы">
        <button
          id="people-section-tab-people"
          type="button"
          role="tab"
          aria-controls="people-section-panel-people"
          aria-selected={activeSection === "people"}
          tabIndex={activeSection === "people" ? 0 : -1}
          className={activeSection === "people" ? styles.sectionTabActive : undefined}
          onClick={() => selectSection("people")}
          onKeyDown={handleSectionKeyDown}
        >
          Люди {data?.incomingRequests.length ? <span>{data.incomingRequests.length}</span> : null}
        </button>
        <button
          id="people-section-tab-groups"
          type="button"
          role="tab"
          aria-controls="people-section-panel-groups"
          aria-selected={activeSection === "groups"}
          tabIndex={activeSection === "groups" ? 0 : -1}
          className={activeSection === "groups" ? styles.sectionTabActive : undefined}
          onClick={() => selectSection("groups")}
          onKeyDown={handleSectionKeyDown}
        >
          Группы {groups?.incomingInvites.length ? <span>{groups.incomingInvites.length}</span> : null}
        </button>
      </div>

      {activeSection === "people" ? (
        <div
          id="people-section-panel-people"
          className={styles.tabPanel}
          role="tabpanel"
          aria-labelledby="people-section-tab-people"
          aria-busy={loading && !data}
        >
          <div className={styles.quickActions} role="group" aria-label="Способы добавить человека">
            <button
              className={styles.addButton}
              type="button"
              disabled={Boolean(pending)}
              onClick={() => { resetLookup(); setAddOpen(true); }}
            >
              <Plus size={18} /> <span>По ID</span>
            </button>
            <button
              type="button"
              aria-label="Пригласить человека по ссылке"
              onClick={() => void openInvite("link")}
              disabled={Boolean(pending)}
            >
              <Link2 size={18} /> <span>Ссылка</span>
            </button>
            <button
              type="button"
              aria-label="Показать QR-код приглашения"
              onClick={() => void openInvite("qr")}
              disabled={Boolean(pending)}
            >
              <QrCode size={18} /> <span>QR</span>
            </button>
            <button
              type="button"
              aria-label="Принять приглашение по ссылке или коду"
              onClick={() => {
                resetInviteImport();
                setInviteImportOpen(true);
              }}
              disabled={Boolean(pending)}
            >
              <ClipboardPaste size={18} /> <span>Принять</span>
            </button>
          </div>

          {content}

          {data ? (
            <div className={styles.sections}>
              {data.incomingRequests.length > 0 ? (
            <section className={styles.section} aria-labelledby="incoming-title">
              <h2 id="incoming-title">Хотят добавить вас</h2>
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
                  const sharingHintId = `sharing-state-${person.circleId}`;
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
                          {person.status ? <p className={styles.userStatus}>{person.status.text}</p> : null}
                          <span className={styles.personStatus}>
                            <i style={{ background: statusColor }} />
                            {formatDirectPersonCheckIn(
                              person.lastCheckInAt,
                              nowMs,
                              person.checkInState,
                            )}
                          </span>
                        </div>
                        <button
                          className={styles.iconButton}
                          type="button"
                          aria-label={`Скопировать ID ${person.user.displayName}`}
                          onClick={() => copyId(person.user.publicId)}
                        >
                          {copiedId === person.user.publicId ? <Check size={17} /> : <Copy size={17} />}
                        </button>
                      </div>
                      <div className={styles.personBottom}>
                        <label className={styles.sharingLabel}>
                          <span>
                            <strong>Показывать через личную связь</strong>
                            <small id={sharingHintId}>
                              {isSharing
                                ? "Включено · новые отметки доступны"
                                : "Выключено · новые отметки скрыты"}
                            </small>
                          </span>
                          <Switch
                            className={styles.sharingSwitch}
                            checked={isSharing}
                            disabled={Boolean(pending)}
                            onCheckedChange={(checked) => void handleSharing(person, checked)}
                            aria-label={`Показывать мои отметки пользователю ${person.user.displayName}`}
                            aria-describedby={sharingHintId}
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
        </div>
      ) : (
        <div
          id="people-section-panel-groups"
          className={`${styles.tabPanel} ${styles.sections}`}
          role="tabpanel"
          aria-labelledby="people-section-tab-groups"
          aria-busy={groupsLoading && !groups}
        >
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
        </div>
      )}

      {dialogError && !addOpen && !inviteDialog.open ? (
        <p className={styles.pageError} role="alert">{dialogError}</p>
      ) : null}

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
                  setPublicId(formatPublicIdInput(event.target.value));
                  setLookup(null);
                  setDialogError(null);
                }}
                placeholder="7K3P-2Q9M-W8ZR"
                aria-describedby="person-public-id-hint"
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
            <p className={styles.searchHint} id="person-public-id-hint">
              Дефисы можно вводить или пропустить — приложение расставит их само.
            </p>
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

      <Dialog open={inviteImportOpen} onOpenChange={(open) => {
        setInviteImportOpen(open);
        if (!open) resetInviteImport();
      }}>
        <DialogContent className={styles.dialog}>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>Принять приглашение</DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              Вставьте ссылку или одноразовый код. Это удобно, если камера открыла QR в Yandex или Safari, а ваш профиль находится в приложении с домашнего экрана.
            </DialogDescription>
          </DialogHeader>
          <form className={styles.inviteImportForm} onSubmit={handleInviteImport} noValidate>
            <label htmlFor="invite-import-value">Ссылка или код приглашения</label>
            <textarea
              id="invite-import-value"
              value={inviteImportValue}
              onChange={(event) => {
                setInviteImportValue(event.target.value);
                setInviteImportError(null);
              }}
              autoCapitalize="none"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              rows={4}
              placeholder="Вставьте ссылку или код"
              aria-describedby={inviteImportError
                ? "invite-import-hint invite-import-error"
                : "invite-import-hint"}
              aria-invalid={Boolean(inviteImportError)}
              autoFocus
            />
            <p className={styles.searchHint} id="invite-import-hint">
              Приглашение откроется здесь — в текущем профиле. Само открытие ссылки ничего не принимает без вашего подтверждения.
            </p>
            <button type="submit" className={styles.shareButton}>
              <Link2 size={17} /> Проверить приглашение
            </button>
          </form>
          {inviteImportError ? (
            <p className={styles.dialogError} id="invite-import-error" role="alert">{inviteImportError}</p>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={inviteDialog.open} onOpenChange={(open) => {
        if (!open) {
          dispatchInviteDialog({ type: "close" });
          setDialogError(null);
          setShareNotice(null);
        }
      }}>
        <DialogContent className={styles.dialog}>
          <DialogHeader>
            <DialogTitle className={styles.dialogTitle}>
              {!inviteShare || inviteShare.url
                ? inviteDialog.mode === "qr"
                  ? "Приглашение по QR-коду"
                  : "Приглашение по ссылке"
                : "Одноразовый код приглашения"}
            </DialogTitle>
            <DialogDescription className={styles.dialogDescription}>
              Один человек сможет принять приглашение. Ссылка действует 7 дней. После подтверждения будут видны только новые отметки.
            </DialogDescription>
          </DialogHeader>
          {!inviteShare && pending === "invite-link" ? (
            <div className={styles.inviteLoading} role="status">Готовим безопасную ссылку…</div>
          ) : !inviteShare ? (
            <button
              type="button"
              className={styles.shareButton}
              onClick={() => void openInvite(inviteDialog.mode)}
            >
              <RefreshCw size={18} /> Повторить
            </button>
          ) : (
            <div className={styles.inviteShare}>
              {inviteDialog.mode === "qr" && inviteShare.url ? (
                <div className={styles.qrFrame} role="img" aria-label="QR-код одноразового приглашения">
                  <QRCode
                    value={inviteShare.url}
                    size={212}
                    bgColor="#ffffff"
                    fgColor="#11150f"
                    aria-hidden="true"
                  />
                </div>
              ) : null}
              {!inviteShare.url ? (
                <p className={styles.qrUnavailable} role="status">
                  {unavailableInviteMessage(inviteShare.unavailableReason)}
                </p>
              ) : null}
              <textarea
                ref={inviteLinkField}
                className={`${styles.inviteLinkField} ${
                  inviteDialog.mode === "qr" ? styles.inviteLinkFieldCompact : ""
                }`}
                aria-label={inviteShare.url ? "Ссылка приглашения" : "Одноразовый код приглашения"}
                readOnly
                rows={inviteDialog.mode === "qr" ? 2 : 3}
                spellCheck={false}
                value={inviteShare.url ?? inviteCode(inviteShare.token)}
              />
              <div className={styles.inviteActions}>
                <button type="button" className={styles.shareButton} onClick={() => void copyInvite()}>
                  <Copy size={17} /> {inviteShare.url ? "Скопировать" : "Копировать код"}
                </button>
                <button
                  type="button"
                  className={`${styles.shareButton} ${styles.systemShareButton}`}
                  onClick={() => void shareInvite()}
                >
                  <Share2 size={17} /> Поделиться
                </button>
              </div>
              <small>Одно использование · до {new Intl.DateTimeFormat("ru-RU", {
                day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
              }).format(Date.parse(inviteShare.expiresAt))}</small>
              <button
                type="button"
                className={styles.regenerateButton}
                aria-describedby="invite-regenerate-hint"
                disabled={Boolean(pending)}
                onClick={() => void openInvite(inviteDialog.mode, true)}
              >
                <RefreshCw size={15} /> {inviteShare.url ? "Создать новую ссылку" : "Создать новый код"}
              </button>
              <small id="invite-regenerate-hint" className={styles.regenerateHint}>
                {inviteShare.url ? "Прежняя ссылка сразу перестанет работать." : "Прежний код сразу перестанет работать."}
              </small>
            </div>
          )}
          {shareNotice ? <p className={styles.dialogNotice} role="status">{shareNotice}</p> : null}
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
