"use client";

import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, Gem, LockKeyhole } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import type { EconomyProgression } from "@/features/economy/domain/model";
import { PLAYER_ICON_LEVELS, PLAYER_LEVELS, getPlayerIconStage, getPlayerLevel, getPlayerProgression } from "@/features/economy/domain/player-progression";
import { PlayerProgressionCard } from "./player-progression-card";
import { GameLevelIcon } from "./game-level-icon";
import board from "./game-leaderboard.module.css";
import styles from "./game-levels.module.css";

const GROUP_SIZE = 10;
export const PLAYER_LEVEL_GROUPS = Array.from({ length: Math.ceil(PLAYER_LEVELS.length / GROUP_SIZE) }, (_, index) => {
  const levels = PLAYER_LEVELS.slice(index * GROUP_SIZE, (index + 1) * GROUP_SIZE);
  return { index, label: `${levels[0].level}–${levels.at(-1)!.level}`, levels };
});

export function getLevelGroupIndex(level: number) {
  return Math.max(0, Math.min(PLAYER_LEVEL_GROUPS.length - 1, Math.floor((level - 1) / GROUP_SIZE)));
}

const formatNumber = (value: number) => value.toLocaleString("ru-RU");
export function GameLevelsPanel({ progression, now, groupIndex, onGroupChange }: {
  progression: EconomyProgression | null | undefined; now: number; groupIndex: number; onGroupChange: (index: number) => void;
}) {
  const selectId = useId();
  const current = getPlayerLevel(getPlayerProgression(progression ?? undefined).xp);
  const currentStage = getPlayerIconStage(current.level);
  const group = PLAYER_LEVEL_GROUPS[groupIndex] ?? PLAYER_LEVEL_GROUPS[getLevelGroupIndex(current.level)];
  return <div className={styles.content}>
    <PlayerProgressionCard progression={progression} now={now} showSeason />

    <section className={styles.stages} aria-label="Этапы смены значка">
      <div className={styles.sectionHeading}><h3>Новые значки</h3><span>Открываются с уровнем</span></div>
      <div className={styles.stageList}>
        {PLAYER_ICON_LEVELS.map((level, stageIndex) => {
          const unlocked = current.level >= level;
          const active = currentStage === stageIndex;
          return <button key={level} type="button" className={styles.stage} data-unlocked={unlocked || undefined}
            aria-current={active ? "step" : undefined}
            aria-label={`Значок уровня ${level}: ${active ? "текущий" : unlocked ? "открыт" : "пока закрыт"}. Показать уровни ${PLAYER_LEVEL_GROUPS[getLevelGroupIndex(level)].label}`}
            onClick={() => onGroupChange(getLevelGroupIndex(level))}>
            <span className={styles.stageIcon}><GameLevelIcon level={level} size={23} />
              {!unlocked && <LockKeyhole className={styles.stageLock} size={10} aria-hidden="true" />}
            </span>
            <span>{level}</span>
          </button>;
        })}
      </div>
    </section>

    <section className={styles.groupSection} aria-label="Уровни и условия получения">
      <div className={styles.groupHeader}>
        <label htmlFor={selectId}>Уровни</label>
        <div className={styles.groupSelect}>
          <select id={selectId} value={group.index} onChange={event => onGroupChange(Number(event.target.value))}>
            {PLAYER_LEVEL_GROUPS.map(item => <option key={item.index} value={item.index}>
              {item.label}{item.index === getLevelGroupIndex(current.level) ? " · вы здесь" : ""}
            </option>)}
          </select>
          <ChevronDown size={16} aria-hidden="true" />
        </div>
      </div>
      <p className={styles.groupSummary} aria-live="polite" aria-atomic="true">Уровни {group.label} · открыто {group.levels.filter(level => level.level <= current.level).length} из {group.levels.length}</p>
      <ol className={styles.levels} start={group.levels[0].level} aria-label={`Уровни ${group.label}`}>
        {group.levels.map(level => {
          const earned = level.level <= current.level;
          const active = level.level === current.level;
          const newIcon = PLAYER_ICON_LEVELS.some(start => start === level.level);
          return <li key={level.level} data-current={active || undefined} data-earned={earned || undefined} aria-current={active ? "step" : undefined}>
            <GameLevelIcon level={level.level} size={23} />
            <div><strong>{level.level}. {level.title}</strong><span>{formatNumber(level.minimumXp)} XP{newIcon && <small> · новый значок</small>}{level.rewardPearls > 0 && <small className={styles.levelReward}><Gem size={11} aria-hidden="true" /> {level.rewardPearls} жемч.</small>}</span></div>
            {active ? <span className={styles.currentTag}>Вы здесь</span> : earned ? <Check size={16} aria-label="Получен" /> : <LockKeyhole size={15} aria-label="Пока закрыт" />}
          </li>;
        })}
      </ol>
    </section>
  </div>;
}

export function GameLevelsButton({ progression, now, className, children }: {
  progression: EconomyProgression | null | undefined; now: number; className?: string; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const current = getPlayerLevel(getPlayerProgression(progression ?? undefined).xp);
  const [groupIndex, setGroupIndex] = useState(() => getLevelGroupIndex(current.level));
  function changeOpen(nextOpen: boolean) {
    if (nextOpen) setGroupIndex(getLevelGroupIndex(current.level));
    setOpen(nextOpen);
  }
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><button type="button" className={className} disabled={!progression}
      aria-label={progression ? `Все уровни. Сейчас уровень ${current.level}` : "Игровой опыт загружается"}>
      {children ?? <><GameLevelIcon level={current.level} size={17} /><span>ур. {current.level}</span></>}
    </button></DialogTrigger>
    <DialogContent className={`${board.dialog} ${styles.dialog}`}>
      <DialogHeader>
        <DialogTitle className={`${board.title} ${styles.title}`}><GameLevelIcon level={current.level} size={24} />Развитие Мохлика</DialogTitle>
        <DialogDescription className={styles.description}>Опыт за стройку, производство, открытия и помощь жителям. Уровень сохраняется навсегда.</DialogDescription>
      </DialogHeader>
      <GameLevelsPanel progression={progression} now={now} groupIndex={groupIndex} onGroupChange={setGroupIndex} />
    </DialogContent>
  </Dialog>;
}
