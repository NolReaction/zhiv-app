"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, Trophy } from "lucide-react";
import { ApiError } from "@/lib/check-in-api";
import { getGameLeaderboard, getGameProgress, updateGameVisibility, type GameLeaderboard, type GameProgress } from "@/lib/game-api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import { SharingSwitch } from "./sharing-switch";
import styles from "./game-leaderboard.module.css";

export function GameLeaderboardDialog({ open, onOpenChange, ownerPublicId, progress, onProgress, onSessionLost, isOnline, returnFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; ownerPublicId: string;
  progress: GameProgress | null; onProgress: (progress: GameProgress) => void;
  onSessionLost: () => void; isOnline: boolean; returnFocus: () => void;
}) {
  const [data, setData] = useState<GameLeaderboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const writeEpoch = useRef(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    void Promise.all([getGameLeaderboard(controller.signal), getGameProgress(controller.signal)]).then(([result, own]) => {
      if (!active || result.ownerPublicId !== ownerPublicId || own.ownerPublicId !== ownerPublicId) return;
      setData(result); setError("");
      onProgress(own);
    }).catch(cause => {
      if (!active) return;
      if (cause instanceof ApiError && cause.status === 401) onSessionLost();
      else setError("Не удалось обновить рейтинг. Попробуйте ещё раз.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [open, ownerPublicId, reload, progress?.monthlyTaps, progress?.visibilityVersion, progress?.month, onSessionLost, onProgress]);

  useEffect(() => {
    if (!open) return;
    const refresh = () => { if (!document.hidden) { setLoading(true); setReload(value => value + 1); } };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    // UTC month boundaries come from the server snapshot, never the phone clock.
    const serverAt = data ? Date.parse(data.serverTime) : NaN;
    const date = new Date(serverAt);
    const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    const delay = Math.max(250, Math.min(2_147_000_000, nextMonth - serverAt + 200));
    const timer = Number.isFinite(serverAt) ? window.setTimeout(refresh, delay) : undefined;
    return () => {
      window.removeEventListener("focus", refresh); window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh); window.clearTimeout(timer);
    };
  }, [open, data]);

  useEffect(() => () => { writeEpoch.current += 1; }, [ownerPublicId]);

  async function setParticipation(enabled: boolean) {
    if (!progress || saving || !isOnline) return;
    const epoch = ++writeEpoch.current;
    setSaving(true); setError("");
    try {
      const result = await updateGameVisibility({ ownerPublicId, leaderboardOptIn: enabled, expectedVersion: progress.visibilityVersion });
      if (epoch !== writeEpoch.current || result.ownerPublicId !== ownerPublicId) return;
      onProgress(result);
      setData(previous => previous ? { ...previous, leaderboardOptIn: result.leaderboardOptIn,
        entries: result.leaderboardOptIn ? previous.entries : previous.entries.filter(entry => !entry.isMe),
        myRank: result.leaderboardOptIn ? previous.myRank : null } : null);
      setLoading(true); setReload(value => value + 1);
    } catch (cause) {
      if (epoch !== writeEpoch.current) return;
      if (cause instanceof ApiError && cause.status === 401) onSessionLost();
      else setError(cause instanceof ApiError && cause.status === 409
        ? "Настройка уже изменилась на другом устройстве. Нажмите обновление рейтинга и повторите."
        : "Не удалось сохранить участие. Повторите попытку.");
    } finally { if (epoch === writeEpoch.current) setSaving(false); }
  }

  const month = data?.month ?? progress?.month;
  const monthLabel = month ? new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`)) : "Текущий месяц";
  const optedIn = data?.leaderboardOptIn ?? progress?.leaderboardOptIn ?? false;

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className={styles.dialog} onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader>
        <DialogTitle className={styles.title}><Trophy size={23} aria-hidden="true" />Рейтинг</DialogTitle>
        <DialogDescription className={styles.month}>{monthLabel} · по UTC</DialogDescription>
      </DialogHeader>
      <div className={styles.score}>
        <div><small>Тапы за месяц</small><strong>{(data?.monthlyTaps ?? progress?.monthlyTaps)?.toLocaleString("ru-RU") ?? "—"}</strong></div>
        <div><small>Ваше место</small><strong>{optedIn && data?.myRank ? `#${data.myRank}` : "—"}</strong></div>
      </div>
      <label className={styles.participation}>
        <span><strong>Участвовать в рейтинге</strong><small id="game-visibility-hint">Другие игроки увидят ваше имя и игровые тапы.</small></span>
        <SharingSwitch checked={optedIn} disabled={!progress || saving || !isOnline} aria-describedby="game-visibility-hint" aria-label="Участвовать в месячном рейтинге" onCheckedChange={value => void setParticipation(value)} />
      </label>
      <div className={styles.listHeader}><strong>Топ 100</strong><button type="button" disabled={loading || !isOnline} onClick={() => { setLoading(true); setReload(value => value + 1); }} aria-label="Обновить рейтинг"><RefreshCw size={17} aria-hidden="true" /></button></div>
      {error && <p className={styles.error} role="status">{error}</p>}
      {!data && loading ? <p className={styles.empty} role="status">Загружаем рейтинг…</p>
        : data?.entries.length ? <ol className={styles.list} aria-label="Игроки месяца" aria-busy={loading}>
          {data.entries.map(entry => <li key={entry.rank} data-me={entry.isMe || undefined}>
            <span className={styles.rank} data-podium={entry.rank <= 3 || undefined}>{entry.rank <= 3 ? <Trophy size={14} aria-hidden="true" /> : null}{entry.rank}</span>
            <span className={styles.name}>{entry.displayName}{entry.isMe && <small>Вы</small>}</span>
            <strong>{entry.taps.toLocaleString("ru-RU")}</strong>
          </li>)}
        </ol> : !error ? <p className={styles.empty}>В этом месяце ещё нет участников. Можно стать первым.</p> : null}
      <p className={styles.hint}>Новый месяц — новый старт. Уровень и общий прогресс сохраняются. Очень быстрые нажатия ограничены; без интернета можно играть без рейтинга.</p>
    </DialogContent>
  </Dialog>;
}
