"use client";

import { useState, type ReactNode } from "react";
import { Check, LockKeyhole } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { CLICKER_LEVELS, getClickerLevel } from "./clicker-story";
import { GameLevelIcon } from "./game-level-icon";
import board from "./game-leaderboard.module.css";
import styles from "./game-levels.module.css";

export function GameLevelsButton({ lifetimeTaps, className, children }: {
  lifetimeTaps: number; className?: string; children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const current = getClickerLevel(lifetimeTaps);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild><button type="button" className={className} aria-label={`Все уровни. Сейчас уровень ${current.level}`}>
      {children ?? <><GameLevelIcon level={current.level} size={17} /><span>ур. {current.level}</span></>}
    </button></DialogTrigger>
    <DialogContent className={`${board.dialog} ${styles.dialog}`}>
      <DialogHeader>
        <DialogTitle className={board.title}><GameLevelIcon level={current.level} size={24} />Уровни Мохлика</DialogTitle>
        <DialogDescription className={styles.description}>Уровень растёт от общего числа подтверждённых тапов. Сейчас: {lifetimeTaps.toLocaleString("ru-RU")}.</DialogDescription>
      </DialogHeader>
      <ol className={styles.levels} aria-label="Уровни и условия получения">
        {CLICKER_LEVELS.map(level => {
          const earned = lifetimeTaps >= level.minimumLifetimeTaps;
          return <li key={level.level} data-current={level.level === current.level || undefined} data-earned={earned || undefined} aria-current={level.level === current.level ? "step" : undefined}>
            <GameLevelIcon level={level.level} size={26} />
            <div><strong>{level.level}. {level.title}</strong><span>{level.minimumLifetimeTaps.toLocaleString("ru-RU")} тапов всего</span></div>
            {earned ? <Check size={16} aria-label="Получен" /> : <LockKeyhole size={15} aria-label="Пока закрыт" />}
          </li>;
        })}
      </ol>
    </DialogContent>
  </Dialog>;
}
