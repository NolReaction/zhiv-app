"use client";

import { useEffect, useRef, useState } from "react";
import { RefreshCw, Trophy, Users } from "lucide-react";
import { ApiError } from "@/lib/check-in-api";
import { getGameLeaderboard, getGameProgress, updateGameVisibility, type GameLeaderboard, type GameLeaderboardMetric, type GameLeaderboardScope, type GameProgress } from "@/features/game/game-api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { SharingSwitch } from "@/components/sharing-switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import styles from "./game-leaderboard.module.css";

export function GameLeaderboardDialog({ open, onOpenChange, ownerPublicId, progress, onProgress, onSessionLost, isOnline, returnFocus }: {
  open: boolean; onOpenChange: (open: boolean) => void; ownerPublicId: string;
  progress: GameProgress | null; onProgress: (progress: GameProgress) => void;
  onSessionLost: () => void; isOnline: boolean; returnFocus: () => void;
}) {
  const [data, setData] = useState<GameLeaderboard | null>(null);
  const [metric, setMetric] = useState<GameLeaderboardMetric>("monthly_taps");
  const [scope, setScope] = useState<GameLeaderboardScope>("global");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [reload, setReload] = useState(0);
  const writeEpoch = useRef(0);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let active = true;
    void Promise.all([getGameLeaderboard(scope, controller.signal, metric), getGameProgress(controller.signal)]).then(([result, own]) => {
      if (!active) return;
      if (result.ownerPublicId !== ownerPublicId || own.ownerPublicId !== ownerPublicId) { onSessionLost(); return; }
      if (result.scope !== scope || result.metric !== metric) throw new Error("Leaderboard scope mismatch");
      setData(result); setError("");
      onProgress(own);
    }).catch(cause => {
      if (!active) return;
      if (cause instanceof ApiError && cause.status === 401) onSessionLost();
      else setError("Не удалось обновить рейтинг. Попробуйте ещё раз.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [open, scope, metric, ownerPublicId, reload, progress?.monthlyTaps, progress?.bestSeries, progress?.visibilityVersion, progress?.month, onSessionLost, onProgress]);

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

  const visibleData = data?.scope === scope && data.metric === metric && data.ownerPublicId === ownerPublicId ? data : null;
  const month = visibleData?.month ?? progress?.month;
  const monthLabel = month ? new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${month}-01T12:00:00Z`)) : "Текущий месяц";
  const optedIn = progress?.leaderboardOptIn ?? visibleData?.leaderboardOptIn ?? false;

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className={styles.dialog} onCloseAutoFocus={event => { event.preventDefault(); returnFocus(); }}>
      <DialogHeader>
        <DialogTitle className={styles.title}><Trophy size={23} aria-hidden="true" />Рейтинг</DialogTitle>
        <DialogDescription className={styles.month}>{metric === "monthly_taps" ? `${monthLabel} · по UTC` : "Лучшая серия · за всё время"}</DialogDescription>
      </DialogHeader>
      <div className={styles.metrics} role="group" aria-label="Вид рейтинга">
        {([ ["monthly_taps", "Тапы за месяц"], ["best_series", "Лучшая серия"] ] as const).map(([value, label]) =>
          <button type="button" key={value} aria-pressed={metric === value} onClick={() => { if (metric === value) return; setMetric(value); setLoading(true); setError(""); }}>{label}</button>)}
      </div>
      <Tabs className={styles.rankingTabs} value={scope} onValueChange={value => {
        if (value !== "global" && value !== "friends") return;
        setScope(value); setLoading(true); setError("");
      }}>
      <div className={styles.score}>
        <div><small>{metric === "monthly_taps" ? "Тапы за месяц" : "Ваш рекорд серии"}</small><strong>{(metric === "monthly_taps" ? visibleData?.monthlyTaps ?? progress?.monthlyTaps : visibleData?.bestSeries ?? progress?.bestSeries)?.toLocaleString("ru-RU") ?? "—"}</strong></div>
        <div><small>{scope === "friends" ? "Среди друзей" : "Ваше место"}</small><strong>{optedIn && visibleData?.myRank ? `#${visibleData.myRank}` : "—"}</strong></div>
      </div>
      <label className={styles.participation}>
        <span><strong>Участвовать в рейтингах</strong><small id="game-visibility-hint">Другие игроки увидят ваше имя, тапы за месяц и рекорд серии.</small></span>
        <SharingSwitch checked={optedIn} disabled={!progress || saving || !isOnline} aria-describedby="game-visibility-hint" aria-label="Участвовать в рейтингах" onCheckedChange={value => void setParticipation(value)} />
      </label>
      <div className={styles.listHeader}>
        <TabsList className={styles.scopes} aria-label="Круг участников рейтинга">
          <TabsTrigger value="global"><Trophy size={15} aria-hidden="true" />Топ 100</TabsTrigger>
          <TabsTrigger value="friends"><Users size={15} aria-hidden="true" />Среди друзей</TabsTrigger>
        </TabsList>
        <button type="button" className={styles.refresh} disabled={loading || !isOnline} onClick={() => { setLoading(true); setReload(value => value + 1); }} aria-label="Обновить рейтинг"><RefreshCw size={17} aria-hidden="true" /></button>
      </div>
      {error && <p className={styles.error} role="status">{error}</p>}
      <TabsContent value={scope} className={styles.rankingContent}>
      {scope === "friends" && <p className={styles.hint}>Вы и добавленные люди, которые включили участие.</p>}
      {!visibleData && loading ? <p className={styles.empty} role="status">Загружаем рейтинг…</p>
        : visibleData?.entries.length ? <ol className={styles.list} tabIndex={0} aria-label={`${scope === "friends" ? "Среди друзей" : "Топ 100"}: ${metric === "monthly_taps" ? "тапы за месяц" : "лучшая серия"}`} aria-busy={loading}>
          {visibleData.entries.map((entry, index) => <li key={`${scope}:${metric}:${index}`} data-me={entry.isMe || undefined}>
            <span className={styles.rank} data-podium={entry.rank <= 3 || undefined}>{entry.rank <= 3 ? <Trophy size={14} aria-hidden="true" /> : null}{entry.rank}</span>
            <span className={styles.name}>{entry.displayName}{entry.isMe && <small>Вы</small>}</span>
            <strong>{entry.score.toLocaleString("ru-RU")}</strong>
          </li>)}
        </ol> : !error ? <p className={styles.empty}>{metric === "best_series" ? "Рекордов участников пока нет. Включите участие и сыграйте серию." : scope === "friends" ? "Пока нет участников среди друзей с игровыми тапами за этот месяц." : "В этом месяце ещё нет участников. Можно стать первым."}</p> : null}
      </TabsContent>
      </Tabs>
      <p className={styles.hint}>{metric === "monthly_taps" ? "Новый месяц — новый старт. Уровень и общий прогресс сохраняются." : "Серия заканчивается после 10 секунд без нажатий. Рекорд сохраняется навсегда; одинаковым рекордам — одинаковое место."} Учитываются подтверждённые сервером тапы. Очень быстрые нажатия ограничены.</p>
    </DialogContent>
  </Dialog>;
}
