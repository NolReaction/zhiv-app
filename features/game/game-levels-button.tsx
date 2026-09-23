"use client";

import { useId, useState, type ReactNode } from "react";
import { Check, ChevronDown, LockKeyhole } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CLICKER_ICON_LEVELS, CLICKER_LEVELS, getClickerIconStage, getClickerLevel, getClickerLevelProgress } from "./clicker-story";
import { GameLevelIcon } from "./game-level-icon";
import board from "./game-leaderboard.module.css";
import styles from "./game-levels.module.css";

const GROUP_SIZE = 10;
export const CLICKER_LEVEL_GROUPS = Array.from({ length: Math.ceil(CLICKER_LEVELS.length / GROUP_SIZE) }, (_, index) => {
  const levels = CLICKER_LEVELS.slice(index * GROUP_SIZE, (index + 1) * GROUP_SIZE);
  return { index, label: `${levels[0].level}–${levels.at(-1)!.level}`, levels };
});

export function getLevelGroupIndex(level: number) {
  return Math.max(0, Math.min(CLICKER_LEVEL_GROUPS.length - 1, Math.floor((level - 1) / GROUP_SIZE)));
}

const formatNumber = (value: number) => value.toLocaleString("ru-RU");
const tapForms: Record<Intl.LDMLPluralRule, string> = { one: "тап", few: "тапа", many: "тапов", other: "тапов", zero: "тапов", two: "тапа" };
const tapPlural = new Intl.PluralRules("ru-RU");
const formatTaps = (value: number) => `${formatNumber(value)} ${tapForms[tapPlural.select(value)]}`;

export function GameLevelsPanel({ lifetimeTaps, groupIndex, onGroupChange }: {
  lifetimeTaps: number; groupIndex: number; onGroupChange: (index: number) => void;
}) {
  const selectId = useId();
  const progress = getClickerLevelProgress(lifetimeTaps);
  const current = getClickerLevel(progress.current);
  const currentStage = getClickerIconStage(current.level);
  const group = CLICKER_LEVEL_GROUPS[groupIndex] ?? CLICKER_LEVEL_GROUPS[getLevelGroupIndex(current.level)];
  const maxLevel = CLICKER_LEVELS.at(-1)!.level;
  const nextLabel = current.nextMinimumLifetimeTaps === null
    ? "Все уровни открыты"
    : `До уровня ${current.level + 1}: ${formatTaps(progress.remaining)}`;

  return <div className={styles.content}>
    <section className={styles.progressCard} aria-label="Ваш текущий уровень">
      <div className={styles.currentLevel}>
        <span className={styles.currentIcon}><GameLevelIcon level={current.level} size={28} /></span>
        <div><span>Уровень {current.level} из {maxLevel}</span><strong>{current.title}</strong></div>
      </div>
      <div className={styles.progressTrack} role="progressbar" aria-label="Прогресс до следующего уровня"
        aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.ratio * 100)} aria-valuetext={nextLabel}>
        <span style={{ width: `${progress.ratio * 100}%` }} />
      </div>
      <p className={styles.progressHint}>{nextLabel}</p>
    </section>

    <section className={styles.stages} aria-label="Этапы смены значка">
      <div className={styles.sectionHeading}><h3>Новые значки</h3><span>Открываются с уровнем</span></div>
      <div className={styles.stageList}>
        {CLICKER_ICON_LEVELS.map((level, stageIndex) => {
          const unlocked = current.level >= level;
          const active = currentStage === stageIndex;
          return <button key={level} type="button" className={styles.stage} data-unlocked={unlocked || undefined}
            aria-current={active ? "step" : undefined}
            aria-label={`Значок уровня ${level}: ${active ? "текущий" : unlocked ? "открыт" : "пока закрыт"}. Показать уровни ${CLICKER_LEVEL_GROUPS[getLevelGroupIndex(level)].label}`}
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
            {CLICKER_LEVEL_GROUPS.map(item => <option key={item.index} value={item.index}>
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
          const newIcon = CLICKER_ICON_LEVELS.some(start => start === level.level);
          return <li key={level.level} data-current={active || undefined} data-earned={earned || undefined} aria-current={active ? "step" : undefined}>
            <GameLevelIcon level={level.level} size={23} />
            <div><strong>{level.level}. {level.title}</strong><span>{formatTaps(level.minimumLifetimeTaps)}{newIcon && <small> · новый значок</small>}</span></div>
            {active ? <span className={styles.currentTag}>Вы здесь</span> : earned ? <Check size={16} aria-label="Получен" /> : <LockKeyhole size={15} aria-label="Пока закрыт" />}
          </li>;
        })}
      </ol>
    </section>
  </div>;
}

export function GameLevelsButton({ lifetimeTaps, className, children }: {
  lifetimeTaps: number; className?: string; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const current = getClickerLevel(lifetimeTaps);
  const [groupIndex, setGroupIndex] = useState(() => getLevelGroupIndex(current.level));
  function changeOpen(nextOpen: boolean) {
    if (nextOpen) setGroupIndex(getLevelGroupIndex(current.level));
    setOpen(nextOpen);
  }
  return <Dialog open={open} onOpenChange={changeOpen}>
    <DialogTrigger asChild><button type="button" className={className} aria-label={`Все уровни. Сейчас уровень ${current.level}`}>
      {children ?? <><GameLevelIcon level={current.level} size={17} /><span>ур. {current.level}</span></>}
    </button></DialogTrigger>
    <DialogContent className={`${board.dialog} ${styles.dialog}`}>
      <DialogHeader>
        <DialogTitle className={`${board.title} ${styles.title}`}><GameLevelIcon level={current.level} size={24} />Уровни Мохлика</DialogTitle>
        <DialogDescription className={styles.description}>Растут от подтверждённых тапов. Всего: {formatNumber(getClickerLevelProgress(lifetimeTaps).current)}.</DialogDescription>
      </DialogHeader>
      <GameLevelsPanel lifetimeTaps={lifetimeTaps} groupIndex={groupIndex} onGroupChange={setGroupIndex} />
    </DialogContent>
  </Dialog>;
}
