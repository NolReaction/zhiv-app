"use client";

import { useEffect, useRef, useState } from "react";
import { Award, Check, LockKeyhole, RefreshCw } from "lucide-react";
import { AchievementMedal } from "./achievement-medal";
import { VISIBLE_GAME_ACHIEVEMENTS, type GameAchievementDefinition } from "./game-rewards";
import { ApiError } from "@/lib/check-in-api";
import { getGameAchievements, type GameAchievement, type GameAchievements, type GameAchievementTier } from "./game-api";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import boardStyles from "./game-leaderboard.module.css";
import styles from "./game-achievements.module.css";

const roman = ["I", "II", "III", "IV"];

/** Only confirmed award dates open a tier, including manual grants. */
export function achievementPresentation(quest: GameAchievementDefinition, state?: GameAchievement) {
  const tiers: readonly GameAchievementTier[] = state?.tiers?.length ? state.tiers : quest.tiers.map((target, index) => ({
    level: index + 1, target, progress: state ? Math.min(state.progress, target) : 0,
    unlockedAt: quest.tiers.length === 1 ? state?.unlockedAt ?? null : null,
  }));
  const earned = tiers.filter(tier => tier.unlockedAt !== null).length;
  const next = tiers.find(tier => tier.unlockedAt === null);
  return { tiers, earned, next, unlocked: earned > 0, complete: Boolean(state && earned === tiers.length),
    progress: state?.progress, target: state?.target ?? next?.target ?? quest.target };
}

export function achievementSummary(data: GameAchievements | null) {
  let earned = 0, tiers = 0;
  for (const quest of VISIBLE_GAME_ACHIEVEMENTS) {
    const state = data?.achievements.find(item => item.id === quest.id);
    const view = achievementPresentation(quest, state);
    if (view.unlocked) earned++;
    tiers += view.earned;
  }
  return { earned, tiers, total: VISIBLE_GAME_ACHIEVEMENTS.length,
    totalTiers: VISIBLE_GAME_ACHIEVEMENTS.reduce((sum, quest) => sum + quest.tiers.length, 0) };
}

export function AchievementCard({ quest, state }: { quest: GameAchievementDefinition; state?: GameAchievement }) {
  const view = achievementPresentation(quest, state), multi = quest.tiers.length > 1;
  const stage = view.complete ? "Все ступени получены" : multi && view.unlocked ? `Далее · ступень ${roman[(view.next?.level ?? 1) - 1]}`
    : view.unlocked ? "Получено" : state ? "В процессе" : "Нет данных";
  return <article className={styles.quest} data-achievement-id={quest.id} data-unlocked={view.unlocked || undefined} data-complete={view.complete || undefined}>
    <div className={styles.art} aria-hidden="true">
      <AchievementMedal id={quest.id} level={view.earned} className={styles.medal} />
      <span>{view.unlocked ? multi ? roman[view.earned - 1] : <Check size={12} /> : <LockKeyhole size={11} />}</span>
    </div>
    <div className={styles.questBody}>
      <h3>{quest.title}</h3>
      <p>{quest.description}</p>
      {multi && state && <span className={styles.levelStatus}>{view.earned === 0 ? `Ступеней: ${quest.tiers.length}` : `Получено ступеней: ${view.earned} из ${quest.tiers.length}`}</span>}
    </div>
    <div className={styles.progressBlock}>
      <div className={styles.progressMeta}>
        <span>{view.complete && !multi ? "Получено" : stage}</span>
        <strong>{state ? `${view.progress!.toLocaleString("ru-RU")} / ${view.target.toLocaleString("ru-RU")}` : "—"}</strong>
      </div>
      {state && <progress value={view.progress} max={view.target} aria-label={`Прогресс достижения «${quest.title}»${multi && view.next ? `, ступень ${roman[view.next.level - 1]}` : ""}`} />}
      {multi && <ol className={styles.tierTrack} aria-label={`Ступени достижения «${quest.title}»`}>
        {view.tiers.map(tier => <li key={tier.level} data-earned={tier.unlockedAt !== null || undefined}
          aria-current={state && view.next?.level === tier.level ? "step" : undefined}
          aria-label={`Ступень ${roman[tier.level - 1]}: ${quest.id === "home_builder" ? "дом уровня " : "цель "}${tier.target}${tier.unlockedAt ? ", получена" : ", ещё не получена"}`}>
          {tier.unlockedAt && <Check size={10} aria-hidden="true" />}
          <span>{quest.id === "home_builder" ? `Дом ${tier.target}` : tier.target.toLocaleString("ru-RU")}</span>
        </li>)}
      </ol>}
    </div>
    <details className={styles.questDetails}><summary>Как получить</summary><p>{quest.hint}</p></details>
  </article>;
}

export function GameAchievementsList({ data, loading = false }: { data: GameAchievements | null; loading?: boolean }) {
  return <div className={styles.groups} aria-busy={loading}>
    {([{ id: "world", title: "Мир и хозяйство" }, { id: "personal", title: "Ритм и связи" }] as const).map(group => <section className={styles.group} key={group.id} aria-label={group.title}>
      <h3 className={styles.groupTitle}>{group.title}</h3>
      <ol className={styles.quests} aria-label={`Достижения: ${group.title}`}>
        {VISIBLE_GAME_ACHIEVEMENTS.filter(quest => quest.category === group.id).map(quest => <li key={quest.id}>
          <AchievementCard quest={quest} state={data?.achievements.find(item => item.id === quest.id)} />
        </li>)}
      </ol>
    </section>)}
  </div>;
}

/** A stale response for another account never becomes visible or retained. */
export async function loadGameAchievements(ownerPublicId: string, signal: AbortSignal): Promise<GameAchievements> {
  const result = await getGameAchievements(signal);
  if (result.ownerPublicId !== ownerPublicId) throw new ApiError("Сеанс аккаунта изменился", 401);
  return result;
}

export function GameAchievementsButton({ ownerPublicId, isOnline, onSessionLost }: {
  ownerPublicId: string; isOnline: boolean; onSessionLost: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<GameAchievements | null>(null);
  const [completedLoad, setCompletedLoad] = useState<{ ownerPublicId: string; reload: number } | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const trigger = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isOnline) return;
    const controller = new AbortController();
    let active = true;
    void loadGameAchievements(ownerPublicId, controller.signal).then(result => {
      if (!active) return;
      setData(result); setError("");
    }).catch(cause => {
      if (!active) return;
      if (cause instanceof ApiError && cause.status === 401) { setData(null); setError(""); onSessionLost(); }
      else setError("Не удалось обновить достижения. Попробуйте ещё раз.");
    }).finally(() => { if (active) setCompletedLoad({ ownerPublicId, reload }); });
    return () => { active = false; controller.abort(); };
  }, [ownerPublicId, reload, isOnline, onSessionLost]);

  useEffect(() => {
    const refresh = () => {
      if (isOnline && !document.hidden) setReload(value => value + 1);
    };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [isOnline]);

  const visible = data?.ownerPublicId === ownerPublicId ? data : null;
  const loading = isOnline && (completedLoad?.ownerPublicId !== ownerPublicId || completedLoad?.reload !== reload);
  const visibleError = completedLoad?.ownerPublicId === ownerPublicId ? error : "";
  const summary = achievementSummary(visible);
  const refresh = () => { if (isOnline && !loading) setReload(value => value + 1); };
  return <>
    <button type="button" ref={trigger} className={styles.trigger} aria-haspopup="dialog"
      onClick={() => { if (isOnline) setReload(value => value + 1); setOpen(true); }}>
      <Award size={17} aria-hidden="true" />Достижения
      {visible && <span>{summary.earned}/{summary.total}</span>}
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className={`${boardStyles.dialog} ${styles.dialog}`} onCloseAutoFocus={event => {
        event.preventDefault(); trigger.current?.focus({ preventScroll: true });
      }}>
        <DialogHeader>
          <DialogTitle className={boardStyles.title}><Award size={23} aria-hidden="true" />Достижения</DialogTitle>
          <DialogDescription className={styles.description}>Открывайте новые ступени. Полученные медали остаются с вами.</DialogDescription>
        </DialogHeader>
        <div className={styles.summary}>
          <div className={styles.summaryText}>
            <strong>{visible ? `Получено ${summary.earned} из ${summary.total}` : `${summary.total} достижений для Мохлика`}</strong>
            <span>{visible ? `Ступени: ${summary.tiers} из ${summary.totalTiers}` : "Исследования, хозяйство и личные победы"}</span>
          </div>
          <button type="button" disabled={loading || !isOnline} aria-label="Обновить достижения" onClick={refresh}><RefreshCw size={17} aria-hidden="true" /></button>
        </div>
        {!isOnline ? <p className={styles.notice} role="status">{visible ? "Офлайн · показаны последние загруженные достижения." : "Для загрузки достижений нужен интернет."}</p>
          : visibleError ? <p className={styles.error} role="status">{visibleError}{visible && " Показаны последние загруженные данные."}</p>
            : !visible && loading ? <p className={styles.notice} role="status">Загружаем достижения…</p> : null}
        <GameAchievementsList data={visible} loading={loading && isOnline} />
      </DialogContent>
    </Dialog>
  </>;
}
