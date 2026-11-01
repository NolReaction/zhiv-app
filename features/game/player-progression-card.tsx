"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Gem, Leaf, Sparkles } from "lucide-react";
import type { EconomyProgression } from "@/features/economy/domain/model";
import { getCooperationSeason, getPlayerIconStage, getPlayerLevelProgress, getPlayerProgression, playerProgressionCatalog, PLAYER_LEVELS } from "@/features/economy/domain/player-progression";
import { playerXpFillFrames } from "./player-xp-playback";
import { GameLevelIcon } from "./game-level-icon";
import styles from "./player-progression-card.module.css";

const number = (value: number) => value.toLocaleString("ru-RU");
const sourceNames: Record<string, string> = {
  construction: "Строительство", production: "Производство", exploration: "Добыча и исследования", order: "Помощь жителям", ship: "Корабельная поставка",
};

type Props = {
  progression: EconomyProgression | null | undefined;
  now: number;
  ownerKey?: string;
  displayName?: string;
  compact?: boolean;
  showSeason?: boolean;
  presentation?: "card" | "profile";
};

/** The first loaded snapshot is a baseline. Hidden/restored cards never celebrate. */
function usePlayerCelebration(xp: number, level: number, ratio: number, ownerKey: string, loaded: boolean) {
  const emblem = useRef<HTMLSpanElement>(null), fill = useRef<HTMLSpanElement>(null);
  const previous = useRef({ xp, level, ratio, ownerKey, loaded });
  useEffect(() => {
    const before = previous.current;
    previous.current = { xp, level, ratio, ownerKey, loaded };
    const element = fill.current;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const bounds = element?.getBoundingClientRect();
    if (!element || !bounds || !element.getClientRects().length || bounds.bottom < 0 || bounds.top > window.innerHeight
      || document.hidden || motion.matches || !loaded || !before.loaded || before.ownerKey !== ownerKey || xp <= before.xp) return;
    const animations: Animation[] = [];
    const progressAnimation = element.animate?.(playerXpFillFrames(before, { level, ratio }), {
      duration: level > before.level ? 1000 : 500, easing: "ease-out",
    });
    if (progressAnimation) animations.push(progressAnimation);
    if (level > before.level) {
      const animation = emblem.current?.animate?.([
        { transform: "scale(1)", filter: "brightness(1)" },
        { transform: "scale(1.14)", filter: "brightness(1.4)", offset: 0.4 },
        { transform: "scale(1)", filter: "brightness(1)" },
      ], { duration: 650, easing: "ease-out" });
      if (animation) animations.push(animation);
    }
    const cancel = () => animations.forEach(animation => animation.cancel());
    const visibility = () => { if (document.hidden) cancel(); };
    const changedMotion = () => { if (motion.matches) cancel(); };
    document.addEventListener("visibilitychange", visibility); motion.addEventListener("change", changedMotion);
    return () => { cancel(); document.removeEventListener("visibilitychange", visibility); motion.removeEventListener("change", changedMotion); };
  }, [xp, level, ratio, ownerKey, loaded]);
  return { emblem, fill };
}

export function CooperationSeasonCard({ progression, now }: Pick<Props, "progression" | "now">) {
  const [fallbackNow] = useState(() => Date.now());
  if (!progression) return null;
  const season = getCooperationSeason(progression, Number.isFinite(now) ? now : fallbackNow);
  const badges = getPlayerProgression(progression).badges.flatMap(entry => {
    const match = /^(\d{4}-(?:0[1-9]|1[0-2])):(.+)$/.exec(entry);
    const award = playerProgressionCatalog.season.milestones.find(item => item.badge === match?.[2]);
    return match && award ? [{ id: entry, month: match[1], title: award.title }] : [];
  });
  const last = season.milestones.at(-1);
  const next = season.milestones.find(milestone => season.points < milestone.points);
  const ratio = last ? Math.min(1, season.points / last.points) : 0;
  const endDate = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long", timeZone: "UTC" })
    .format(new Date(Date.parse(season.endsAt) - 1));
  return <section className={styles.season} aria-label="Сотрудничество с жителями в этом месяце">
    <div className={styles.seasonHeading}>
      <span className={styles.seasonIcon}><Leaf size={19} aria-hidden="true" /></span>
      <div><small>Дела леса · до {endDate}</small><h4>{season.title}</h4></div>
      <strong>{number(season.points)}<small>вклад</small></strong>
    </div>
    <div className={styles.seasonTrack} role="progressbar" aria-label="Вклад в дела леса"
      aria-valuemin={0} aria-valuemax={last?.points ?? 1} aria-valuenow={Math.min(season.points, last?.points ?? 1)}
      aria-valuetext={next ? `До следующей награды: ${number(next.points - season.points)} очков вклада` : "Все награды месяца открыты"}>
      <span style={{ width: `${ratio * 100}%` }} />
    </div>
    <p className={styles.seasonHint}>{next
      ? <>Ещё <strong>{number(next.points - season.points)}</strong> вклада до награды · <Gem size={13} aria-hidden="true" /> {next.rewardPearls} жемч.</>
      : <><Check size={14} aria-hidden="true" /> Все цели месяца выполнены</>}</p>
    <details className={styles.seasonDetails}>
      <summary>Награды и правила месяца</summary>
      <p>Помогайте жителям и загружайте корабль в удобное время. Каждый месяц начинается новый вклад; опыт, дружба и полученные награды сохраняются.</p>
      <ul>{season.milestones.map(milestone => <li key={milestone.points} data-earned={milestone.awarded || undefined}>
        <span>{milestone.awarded ? <Check size={15} aria-label="Получено" /> : <Leaf size={15} aria-hidden="true" />}<strong>{number(milestone.points)}</strong></span>
        <span>{milestone.title}</span><span><Gem size={13} aria-hidden="true" /> {milestone.rewardPearls}</span>
      </li>)}</ul>
      <p className={styles.seasonFootnote}>Награды начисляются автоматически. Новый месяц в 00:00 UTC.</p>
      {badges.length > 0 && <section className={styles.badges} aria-label="Полученные сезонные значки">
        <h5>Память о сезонах · {badges.length}</h5>
        <ul>{badges.slice(-12).reverse().map(badge => <li key={badge.id}>
          <span className={styles.badgeIcon}><Leaf size={16} aria-hidden="true" /></span>
          <span><strong>{badge.title}</strong><small>{new Intl.DateTimeFormat("ru-RU", { month: "long", year: "numeric", timeZone: "UTC" }).format(new Date(`${badge.month}-01T00:00:00Z`))}</small></span>
        </li>)}</ul>
        {badges.length > 12 && <p className={styles.seasonFootnote}>Показаны последние 12 значков. Все полученные значки сохранены.</p>}
      </section>}
    </details>
  </section>;
}

export function PlayerProgressionCard({ progression, now, ownerKey = "player", displayName, compact = false, showSeason = true, presentation = "card" }: Props) {
  const player = getPlayerProgression(progression ?? undefined);
  const progress = getPlayerLevelProgress(player.xp);
  const { emblem, fill } = usePlayerCelebration(player.xp, progress.level, progress.ratio, ownerKey, Boolean(progression));
  const nextReward = PLAYER_LEVELS.find(level => level.level > progress.level && level.rewardPearls > 0);
  if (!progression) return <section className={styles.loading} role="status">Загружаем игровой опыт…</section>;
  const atMax = progress.remaining === 0 && progress.level === PLAYER_LEVELS.at(-1)?.level;
  const label = atMax ? "Все уровни открыты" : `До уровня ${progress.level + 1}: ${number(progress.remaining)} XP`;
  return <div className={styles.wrapper} data-compact={compact || undefined} data-presentation={presentation === "profile" ? presentation : undefined}>
    <section className={styles.card} data-stage={getPlayerIconStage(progress.level)} aria-label="Общий игровой опыт">
      <div className={styles.heading}>
        <span className={styles.emblem} ref={emblem}><GameLevelIcon level={progress.level} size={31} /></span>
        <div className={styles.identity}><span>Уровень <strong>{progress.level}</strong></span><h3>{displayName ?? progress.title}</h3></div>
        <span className={styles.total}>{number(player.xp)}<small>всего XP</small></span>
      </div>
      <div className={styles.progressLine}><span>{atMax ? "Путь продолжается" : `${number(progress.levelXp)} / ${number(progress.requiredXp)} XP`}</span>
        <span>{atMax ? "100 уровней" : `Уровень ${progress.level + 1}`}</span></div>
      <div className={styles.track} role="progressbar" aria-label="Опыт до следующего уровня" aria-valuemin={0} aria-valuemax={100}
        aria-valuenow={Math.round(progress.ratio * 100)} aria-valuetext={label}>
        <span ref={fill} style={{ width: `${progress.ratio * 100}%` }} />
      </div>
      <p className={styles.remaining}>{label}</p>
      {!compact && presentation !== "profile" && <p className={styles.explanation}>Стройте, производите, открывайте новое и помогайте жителям.</p>}
      {nextReward && <div className={styles.nextReward}><Sparkles size={15} aria-hidden="true" />
        <span>На уровне {nextReward.level}</span><strong><Gem size={14} aria-hidden="true" /> {nextReward.rewardPearls} жемч.</strong>
      </div>}
      {!compact && player.lastAward && <p className={styles.lastAward}>
        Последнее: <strong>+{number(player.lastAward.xp)} XP</strong> · {sourceNames[player.lastAward.source] ?? "Развитие хозяйства"}
      </p>}
    </section>
    {showSeason && <CooperationSeasonCard progression={progression} now={now} />}
  </div>;
}
