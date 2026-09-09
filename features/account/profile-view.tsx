"use client";

import type { FormEvent } from "react";
import { useRef, useState } from "react";
import { Switch } from "@/components/ui/switch";
import { GameLevelIcon } from "@/features/game/game-level-icon";
import { Check, Clock3, Flame, Settings2, ShieldCheck, Trophy, UserRound } from "lucide-react";
import type { MeResponse } from "@/lib/check-in-contract";
import type { ClickerLevel, ClickerLevelProgress } from "@/features/game/clicker-story";
import {
  ApiError,
  isDisplayNameCooldownResponse,
  updateMyDisplayName,
} from "@/lib/check-in-api";
import {
  isValidDisplayName,
  limitDisplayNameInput,
  normalizeDisplayName,
} from "@/lib/check-in-presentation";
import { createUuidV4 } from "@/lib/browser-uuid";
import { RecoveryCodeCard } from "./recovery-code-card";
import { RecoveryStarter } from "./recovery-starter";
import { TransientNotice } from "@/components/app-notifications";
import { AccountAccess } from "./account-access";
import { TimeZoneSetting } from "./time-zone-setting";
import { GameAchievementsButton } from "@/features/game/game-achievements";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import styles from "./profile-view.module.css";

type ProfileViewProps = {
  simpleView: boolean;
  onSimpleViewChange: (value: boolean) => void;
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
  onOpenCalendar: (trigger: HTMLButtonElement) => void;
  onOpenGame: (trigger: HTMLButtonElement) => void;
  onRefreshGame: () => void;
  gameNotice: string;
  gameLoaded: boolean;
  gamePendingTaps: number;
  legacyGame: { lifetimeTaps: number; bestSeries: number };
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
  simpleView,
  onSimpleViewChange,
  me,
  nowMs,
  isOnline,
  clickerStats,
  onUpdated,
  onRecovered,
  onSessionLost,
  onOpenCalendar,
  onOpenGame,
  onRefreshGame,
  gameNotice,
  gameLoaded,
  gamePendingTaps,
  legacyGame,
}: ProfileViewProps) {
  const [draftState, setDraftState] = useState({
    sourceName: me.user.displayName,
    value: me.user.displayName,
  });
  const [panel, setPanel] = useState(() => {
    try {
      return ["email", "merge", "delete"].includes(window.sessionStorage.getItem("zhiv:account-action") ?? "") ? "management" : "";
    } catch { return ""; }
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [cooldownAvailableAt, setCooldownAvailableAt] = useState<string | null>(null);
  const requestKey = useRef<string | null>(null);
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

  return (
    <section id="profile-panel" className={styles.view} aria-labelledby="profile-title">
      <div className={styles.heading}><h1 id="profile-title">Профиль</h1></div>
      <TransientNotice message={error} kind="error" />
      <TransientNotice message={success} kind="success" />
      <div className={styles.columns}>
        <div className={styles.overviewColumn}>
          <div className={styles.profileCard}>
            <div className={styles.avatar} aria-hidden="true">
              {me.profile.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={me.profile.avatarUrl} alt="" />
              ) : <strong>{initials(me.user.displayName)}</strong>}
            </div>
            <div className={styles.identity}>
              <div className={styles.identityTitle}>
                <strong>{me.user.displayName}</strong>
                <GameAchievementsButton key={me.user.publicId} ownerPublicId={me.user.publicId} isOnline={isOnline} onSessionLost={onSessionLost} />
              </div>
              <span>{me.user.publicId}</span>
              <button type="button" className={styles.editLink} onClick={() => setPanel(panel === "name" ? "" : "name")}>Изменить имя</button>
            </div>
          </div>
          <div className={styles.stats} aria-label="Статистика профиля">
            <button type="button" onClick={event => onOpenCalendar(event.currentTarget)} aria-haspopup="dialog" aria-label="Открыть календарь моих отметок">
              <Flame size={18} aria-hidden="true" /><strong>{me.streak.currentDays}</strong>
              <span>{russianNoun(me.streak.currentDays, "день", "дня", "дней")} подряд</span>
            </button>
            <div><Check size={18} aria-hidden="true" /><strong>{me.checkInCount}</strong>
              <span>{russianNoun(me.checkInCount, "отметка", "отметки", "отметок")}</span></div>
            <button type="button" onClick={event => onOpenGame(event.currentTarget)} aria-haspopup="dialog" aria-label="Открыть игровой рейтинг"><Trophy size={18} aria-hidden="true" /><strong>{gameLoaded ? `×${clickerStats.bestSeries.toLocaleString("ru-RU")}` : "—"}</strong><span>{gamePendingTaps > 0 ? "сохраняем…" : "рекорд игры"}</span></button>
          </div>
        </div>
        <Accordion type="single" collapsible value={panel} onValueChange={setPanel} className={styles.settingsList}>
          <AccordionItem value="name" className={styles.settingsItem}>
            <AccordionTrigger className={styles.settingsTrigger}><span><UserRound size={20} aria-hidden="true" /><span>Личные данные<small>Имя и часовой пояс</small></span></span></AccordionTrigger>
            <AccordionContent forceMount hidden={panel !== "name"} className={styles.settingsContent}>
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
              {!isOnline && !error ? <p className={styles.offline}>Офлайн · изменения временно недоступны</p> : null}
            </div>
          </form>
              <TimeZoneSetting me={me} isOnline={isOnline} onUpdated={onUpdated} onSessionLost={onSessionLost} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="appearance" className={styles.settingsItem}>
            <AccordionTrigger className={styles.settingsTrigger}><span><Settings2 size={20} aria-hidden="true" /><span>Внешний вид<small>{simpleView ? "Простая кнопка" : "Живая полянка Мохлика"}</small></span></span></AccordionTrigger>
            <AccordionContent className={styles.settingsContent}>
              <div className={styles.appearanceSetting}>
                <label htmlFor="simple-view"><strong>Простой вид</strong><span>Знакомая кнопка без полянки. Вход в игру остаётся доступным.</span></label>
                <Switch id="simple-view" checked={simpleView} onCheckedChange={onSimpleViewChange} />
              </div>
              <p className={styles.hint}>Настройка сохраняется на этом устройстве.</p>
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="security" className={styles.settingsItem}>
            <AccordionTrigger className={styles.settingsTrigger}><span><ShieldCheck size={20} aria-hidden="true" /><span>Вход и безопасность<small>Способы входа, устройства, восстановление</small></span></span></AccordionTrigger>
            <AccordionContent forceMount hidden={panel !== "security"} className={styles.settingsContent}>
              <AccountAccess mode="access" active={panel === "security"} isOnline={isOnline} onSessionLost={onSessionLost} onUpdated={onUpdated} />
              <RecoveryCodeCard isOnline={isOnline} onSessionLost={onSessionLost} />
              <RecoveryStarter context="profile" isOnline={isOnline} onRecovered={onRecovered} />
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="game" className={styles.settingsItem}>
            <AccordionTrigger className={styles.settingsTrigger}><span><GameLevelIcon level={clickerStats.level.level} /><span>Игровой прогресс<small>{gameLoaded ? `Уровень ${clickerStats.level.level} · ${clickerStats.level.title}` : "Синхронизация с аккаунтом"}</small></span></span></AccordionTrigger>
            <AccordionContent forceMount hidden={panel !== "game"} className={styles.settingsContent}>
              {gameLoaded && <div className={styles.gameStats} aria-label="Игровой прогресс">
            <span aria-hidden="true"><GameLevelIcon level={clickerStats.level.level} /></span>
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

          }
          <p className={styles.localProgressNote} role="status">{gameNotice}</p>
          <div className={styles.gameActions}>
            <button type="button" onClick={event => onOpenGame(event.currentTarget)} aria-haspopup="dialog"><Trophy size={17} aria-hidden="true" />Открыть рейтинг</button>
            <button type="button" onClick={onRefreshGame} disabled={!isOnline}>Обновить</button>
          </div>
          {legacyGame.lifetimeTaps > 0 && <details className={styles.legacyGame}>
            <summary>Прогресс до сетевой игры</summary>
            <p>На этом устройстве: {legacyGame.lifetimeTaps.toLocaleString("ru-RU")} тапов, рекорд ×{legacyGame.bestSeries.toLocaleString("ru-RU")}. Эти результаты сохранены отдельно и не участвуют в рейтинге.</p>
          </details>}
            </AccordionContent>
          </AccordionItem>
          <AccordionItem value="management" className={styles.settingsItem}>
            <AccordionTrigger className={styles.settingsTrigger}><span><Settings2 size={20} aria-hidden="true" /><span>Управление профилем<small>Смена почты, объединение, удаление</small></span></span></AccordionTrigger>
            <AccordionContent forceMount hidden={panel !== "management"} className={styles.settingsContent}>
              <AccountAccess mode="manage" active={panel === "management"} isOnline={isOnline} onSessionLost={onSessionLost} onUpdated={onUpdated} />
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>
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
