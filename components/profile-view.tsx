"use client";

import type { FormEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Camera, Check, Clock3, Flame, Gamepad2, ShieldCheck, ShieldPlus, Trash2, Trophy, UserRound } from "lucide-react";
import type { MeResponse, RecoveryContactsResponse } from "@/lib/check-in-contract";
import type { ClickerLevel, ClickerLevelProgress } from "@/lib/clicker-story";
import {
  ApiError,
  addRecoveryContact,
  getRecoveryContacts,
  isDisplayNameCooldownResponse,
  removeRecoveryContact,
  updateMyDisplayName,
} from "@/lib/check-in-api";
import {
  isValidDisplayName,
  limitDisplayNameInput,
  normalizeDisplayName,
} from "@/lib/check-in-presentation";
import { createUuidV4 } from "@/lib/browser-uuid";
import { RecoveryStarter } from "./recovery-starter";
import styles from "./profile-view.module.css";

type ProfileViewProps = {
  me: MeResponse;
  nowMs: number;
  isOnline: boolean;
  clickerStats: {
    bestSeries: number;
    lifetimeTaps: number;
    level: ClickerLevel;
    levelProgress: ClickerLevelProgress;
  };
  onUpdated: (response: MeResponse) => void;
  onRecovered: (response: MeResponse) => void;
  onSessionLost: () => void;
};

function initials(name: string): string {
  const parts = normalizeDisplayName(name).split(" ").filter(Boolean);
  return parts.slice(0, 2).map((part) => Array.from(part)[0]?.toUpperCase()).join("") || "Я";
}

function formatRemaining(availableAt: string, nowMs: number): string {
  const remainingMs = Math.max(0, Date.parse(availableAt) - nowMs);
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours >= 24) return `${Math.ceil(hours / 24)} дн.`;
  if (hours > 0) return minutes > 0 ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  return `${Math.max(1, minutes)} мин`;
}

function russianNoun(count: number, one: string, few: string, many: string): string {
  const mod100 = Math.abs(count) % 100;
  const mod10 = mod100 % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

export function ProfileView({
  me,
  nowMs,
  isOnline,
  clickerStats,
  onUpdated,
  onRecovered,
  onSessionLost,
}: ProfileViewProps) {
  const [draftState, setDraftState] = useState({
    sourceName: me.user.displayName,
    value: me.user.displayName,
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cooldownAvailableAt, setCooldownAvailableAt] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
  const [recovery, setRecovery] = useState<RecoveryContactsResponse | null>(null);
  const [recoveryPending, setRecoveryPending] = useState<string | null>(null);
  const [recoveryError, setRecoveryError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void getRecoveryContacts().then((value) => {
      if (active) setRecovery(value);
    }).catch((cause) => {
      if (!active) return;
      if (cause instanceof ApiError && cause.status === 401) {
        onSessionLost();
        return;
      }
      setRecoveryError(cause instanceof Error ? cause.message : "Не удалось загрузить восстановление");
    });
    return () => { active = false; };
  }, [onSessionLost]);

  const draft = draftState.sourceName === me.user.displayName
    ? draftState.value
    : me.user.displayName;
  const normalizedDraft = normalizeDisplayName(draft);
  const availableAt = cooldownAvailableAt ?? me.profile.displayNameChangeAvailableAt;
  const locked = Boolean(availableAt && Date.parse(availableAt) > nowMs);
  const unchanged = normalizedDraft === me.user.displayName;

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setSuccess(null);

    if (!isValidDisplayName(draft)) {
      setError("Введите имя длиной до 50 символов без служебных знаков");
      return;
    }
    if (unchanged) return;
    if (locked) {
      setError("Имя пока нельзя изменить повторно");
      return;
    }
    if (!isOnline) {
      setError("Для изменения имени нужен интернет");
      return;
    }

    setPending(true);
    requestKey.current ??= createUuidV4();
    try {
      const response = await updateMyDisplayName(normalizedDraft, requestKey.current);
      requestKey.current = null;
      setCooldownAvailableAt(null);
      setDraftState({
        sourceName: response.user.displayName,
        value: response.user.displayName,
      });
      setSuccess("Имя сохранено");
      onUpdated(response);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onSessionLost();
        return;
      }
      if (
        cause instanceof ApiError &&
        cause.status === 429 &&
        isDisplayNameCooldownResponse(cause.body)
      ) {
        const cooldown = cause.body;
        setCooldownAvailableAt(cooldown.availableAt);
        setError(`Следующее изменение будет доступно через ${formatRemaining(cooldown.availableAt, Date.parse(cooldown.serverTime))}`);
        return;
      }
      setError(cause instanceof Error ? cause.message : "Не удалось сохранить имя");
    } finally {
      setPending(false);
    }
  }

  async function changeRecoveryContact(kind: "add" | "remove", id: string) {
    if (recoveryPending) return;
    setRecoveryPending(`${kind}:${id}`);
    setRecoveryError(null);
    try {
      const response = kind === "add"
        ? await addRecoveryContact(id, createUuidV4())
        : await removeRecoveryContact(id, createUuidV4());
      setRecovery(response);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        onSessionLost();
        return;
      }
      try {
        const current = await getRecoveryContacts();
        const desiredStateReached = kind === "add"
          ? current.contacts.some((contact) => contact.circleId === id)
          : current.contacts.every((contact) => contact.contactId !== id);
        setRecovery(current);
        if (desiredStateReached) return;
      } catch (refreshCause) {
        if (refreshCause instanceof ApiError && refreshCause.status === 401) {
          onSessionLost();
          return;
        }
      }
      setRecoveryError(cause instanceof Error ? cause.message : "Не удалось изменить настройку");
    } finally {
      setRecoveryPending(null);
    }
  }

  return (
    <section id="profile-panel" className={styles.view} aria-labelledby="profile-title">
      <div className={styles.heading}>
        <p>Ваше пространство</p>
        <h1 id="profile-title">Профиль</h1>
      </div>

      <div className={styles.profileCard}>
        <div className={styles.avatar} aria-hidden="true">
          {me.profile.avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={me.profile.avatarUrl} alt="" />
          ) : (
            <strong>{initials(me.user.displayName)}</strong>
          )}
          <span><Camera size={16} /></span>
        </div>
        <div className={styles.identity}>
          <strong>{me.user.displayName}</strong>
          <span>{me.user.publicId}</span>
          <small>Фото профиля появится в одной из следующих версий</small>
        </div>
      </div>

      <div className={styles.stats} aria-label="Статистика профиля">
        <div>
          <Flame size={17} aria-hidden="true" />
          <strong>{me.streak.currentDays}</strong>
          <span>{russianNoun(me.streak.currentDays, "день", "дня", "дней")} подряд</span>
        </div>
        <div>
          <Trophy size={17} aria-hidden="true" />
          <strong>×{clickerStats.bestSeries.toLocaleString("ru-RU")}</strong>
          <span>лучшая серия</span>
        </div>
        <div>
          <Check size={17} aria-hidden="true" />
          <strong>{me.checkInCount}</strong>
          <span>{russianNoun(me.checkInCount, "отметка", "отметки", "отметок")}</span>
        </div>
      </div>

      <div className={styles.gameStats} aria-label="Игровой прогресс">
        <span aria-hidden="true"><Gamepad2 size={20} /></span>
        <div>
          <small>Уровень {clickerStats.level.level}</small>
          <strong>{clickerStats.level.title}</strong>
        </div>
        <div>
          <small>{clickerStats.level.nextMinimumLifetimeTaps ? "До повышения" : "Высший уровень"}</small>
          <strong>
            {clickerStats.level.nextMinimumLifetimeTaps
              ? `${clickerStats.levelProgress.remaining.toLocaleString("ru-RU")} ${russianNoun(clickerStats.levelProgress.remaining, "тап", "тапа", "тапов")}`
              : "Максимум"}
          </strong>
        </div>
        <div className={styles.levelProgressMeta}>
          <span>
            Всего {clickerStats.lifetimeTaps.toLocaleString("ru-RU")} {russianNoun(clickerStats.lifetimeTaps, "тап", "тапа", "тапов")}
          </span>
          <span>{Math.round(clickerStats.levelProgress.ratio * 100)}%</span>
        </div>
        <div
          className={styles.levelProgress}
          role="progressbar"
          aria-label="Прогресс игрового уровня"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(clickerStats.levelProgress.ratio * 100)}
        >
          <i style={{ transform: `scaleX(${clickerStats.levelProgress.ratio})` }} />
        </div>
      </div>

      <form className={styles.formCard} onSubmit={handleSubmit} noValidate>
        <div className={styles.formHeading}>
          <span><UserRound size={18} aria-hidden="true" /> Отображаемое имя</span>
          {locked && availableAt ? (
            <small><Clock3 size={14} aria-hidden="true" /> через {formatRemaining(availableAt, nowMs)}</small>
          ) : (
            <small>можно изменить сейчас</small>
          )}
        </div>

        <label htmlFor="profile-display-name">Имя, которое видят ваши люди</label>
        <input
          id="profile-display-name"
          value={draft}
          onChange={(event) => {
            setDraftState({
              sourceName: me.user.displayName,
              value: limitDisplayNameInput(event.target.value),
            });
            setError(null);
            setSuccess(null);
            requestKey.current = null;
          }}
          autoComplete="name"
          disabled={pending || locked}
          aria-invalid={Boolean(error)}
          aria-describedby="profile-name-hint profile-name-feedback"
        />
        <p id="profile-name-hint" className={styles.hint}>
          После сохранения следующее изменение будет доступно через 24 часа.
          Публичный ID при этом не меняется.
        </p>
        <button
          type="submit"
          disabled={pending || locked || unchanged || !isOnline}
        >
          {pending ? "Сохраняем…" : locked ? "Изменение недоступно" : "Сохранить имя"}
        </button>
        <div id="profile-name-feedback" className={styles.feedback}>
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          {success ? <p className={styles.success} role="status"><Check size={15} /> {success}</p> : null}
          {!isOnline && !error ? <p className={styles.offline}>Офлайн · изменения временно недоступны</p> : null}
        </div>
      </form>

      <section className={styles.recoveryCard} aria-labelledby="recovery-title">
        <div className={styles.recoveryHeading}>
          <span><ShieldCheck size={20} /></span>
          <div>
            <strong id="recovery-title">Восстановление через близкого</strong>
            <p>Выберите до трёх людей. Только они смогут подтвердить ваш запрос на возврат этого профиля.</p>
          </div>
        </div>
        {recovery?.contacts.length ? (
          <div className={styles.recoveryList}>
            {recovery.contacts.map((contact) => (
              <div key={contact.contactId}>
                <span><ShieldCheck size={15} /> {contact.user.displayName}</span>
                <button
                  type="button"
                  aria-label={`Убрать ${contact.user.displayName} из доверенных`}
                  disabled={Boolean(recoveryPending)}
                  onClick={() => void changeRecoveryContact("remove", contact.contactId)}
                ><Trash2 size={15} /></button>
              </div>
            ))}
          </div>
        ) : <p className={styles.recoveryEmpty}>Доверенные люди пока не выбраны.</p>}
        {recovery && recovery.eligible.length > 0 && recovery.contacts.length < 3 ? (
          <div className={styles.recoveryChoices}>
            <small>Можно доверить восстановление:</small>
            <div>
              {recovery.eligible.map((person) => (
                <button
                  type="button"
                  key={person.circleId}
                  disabled={Boolean(recoveryPending)}
                  onClick={() => void changeRecoveryContact("add", person.circleId)}
                ><ShieldPlus size={15} /> {person.user.displayName}</button>
              ))}
            </div>
          </div>
        ) : null}
        <p className={styles.recoveryNote}>
          Уже создали новый профиль случайно? Начните восстановление здесь. Данные не смешаются:
          после подтверждения друга приложение переключится на прежний профиль.
        </p>
        <RecoveryStarter
          context="profile"
          isOnline={isOnline}
          onRecovered={onRecovered}
        />
        {recoveryError ? <p className={styles.error} role="alert">{recoveryError}</p> : null}
      </section>

      <div className={styles.futureCard}>
        <span aria-hidden="true"><UserRound size={20} /></span>
        <div>
          <strong>Основа для аватарки готова</strong>
          <p>Загрузка фотографии появится позже — с безопасным хранением и отдельной настройкой видимости.</p>
        </div>
      </div>

    </section>
  );
}
