"use client";

import { useEffect, useRef, useState } from "react";
import { Award, Check, LockKeyhole, RefreshCw } from "lucide-react";
import { ApiError } from "@/lib/check-in-api";
import { getGameAchievements, type GameAchievementId, type GameAchievements } from "@/lib/game-api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "./ui/dialog";
import boardStyles from "./game-leaderboard.module.css";
import styles from "./game-achievements.module.css";

const QUESTS: Record<GameAchievementId, { title: string; description: string; hint: string }> = {
  seven_day_streak: {
    title: "В ритме",
    description: "Достигните серии из 7 дней с отметками.",
    hint: "Учитывается лучшая серия, как в календаре: между отметками — не больше 24 часов.",
  },
  thousand_taps: {
    title: "Тысяча искр",
    description: "Наберите 1 000 игровых тапов.",
    hint: "Можно за несколько серий. Учитываются тапы, подтверждённые сервером.",
  },
  five_friends: {
    title: "Свой круг",
    description: "Соберите круг из 5 друзей.",
    hint: "Нужны 5 принятых связей одновременно. Заявки и общие группы не считаются.",
  },
};

export function GameAchievementsButton({ ownerPublicId, isOnline, onSessionLost }: {
  ownerPublicId: string; isOnline: boolean; onSessionLost: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<GameAchievements | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOnline) return;
    const controller = new AbortController();
    let active = true;
    void getGameAchievements(controller.signal).then(result => {
      if (!active) return;
      if (result.ownerPublicId !== ownerPublicId) { onSessionLost(); return; }
      setData(result); setError("");
    }).catch(cause => {
      if (!active) return;
      if (cause instanceof ApiError && cause.status === 401) onSessionLost();
      else setError("Не удалось загрузить достижения. Попробуйте ещё раз.");
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [ownerPublicId, reload, isOnline, onSessionLost]);

  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) { setLoading(true); setReload(value => value + 1); }
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, []);

  const visible = data?.ownerPublicId === ownerPublicId ? data : null;
  const earned = visible?.achievements.filter(item => item.unlockedAt !== null).length;

  return <>
    <button type="button" ref={trigger} className={styles.trigger} aria-haspopup="dialog"
      onClick={() => { setLoading(true); setReload(value => value + 1); setOpen(true); }}>
      <Award size={17} aria-hidden="true" />Достижения
      {earned !== undefined && <span>{earned}/3</span>}
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className={`${boardStyles.dialog} ${styles.dialog}`} onCloseAutoFocus={event => {
        event.preventDefault(); trigger.current?.focus({ preventScroll: true });
      }}>
        <DialogHeader>
          <DialogTitle className={boardStyles.title}><Award size={23} aria-hidden="true" />Достижения</DialogTitle>
          <DialogDescription className={styles.description}>Ваши маленькие победы. Полученные награды остаются с вами.</DialogDescription>
        </DialogHeader>
        <div className={styles.summary}>
          <span>{earned === undefined ? "Три цели для начала" : `Получено ${earned} из 3`}</span>
          <button type="button" disabled={loading || !isOnline} aria-label="Обновить достижения"
            onClick={() => { setLoading(true); setReload(value => value + 1); }}><RefreshCw size={17} aria-hidden="true" /></button>
        </div>
        {!isOnline ? <p className={styles.notice} role="status">{visible ? "Офлайн · показаны последние загруженные достижения." : "Для загрузки достижений нужен интернет."}</p>
          : error ? <p className={styles.error} role="status">{error}</p>
          : !visible && loading ? <p className={styles.notice} role="status">Загружаем достижения…</p> : null}
        <div className={styles.quests} aria-busy={loading && isOnline}>
          {(Object.keys(QUESTS) as GameAchievementId[]).map(id => {
            const quest = QUESTS[id];
            const state = visible?.achievements.find(item => item.id === id);
            const unlocked = Boolean(state?.unlockedAt);
            return <article className={styles.quest} key={id} data-unlocked={unlocked || undefined}>
              <div className={styles.art} aria-hidden="true">
                {/* These local SVGs are small, original achievement illustrations. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={`/achievements/${id}.svg`} width={80} height={80} alt="" />
                <span>{unlocked ? <Check size={13} /> : <LockKeyhole size={12} />}</span>
              </div>
              <div className={styles.questBody}>
                <h3>{quest.title}</h3>
                <p>{quest.description}</p>
                <div className={styles.progressMeta}>
                  <span>{state ? unlocked ? "Получено" : "В процессе" : "Не загружено"}</span>
                  <strong>{state ? `${state.progress.toLocaleString("ru-RU")} / ${state.target.toLocaleString("ru-RU")}` : "—"}</strong>
                </div>
                <progress value={state?.progress ?? 0} max={state?.target ?? 1} aria-label={`Прогресс достижения «${quest.title}»`} />
              </div>
              <p className={styles.questHint}>{quest.hint}</p>
            </article>;
          })}
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
