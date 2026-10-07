"use client";

import { CircleHelp, Heart, Leaf, Moon, Search, Soup, Sprout } from "lucide-react";
import type { EconomyController } from "@/features/economy/use-economy";
import { pendingMeal } from "@/features/economy/food";
import type { ForestObservation } from "./use-forest-observation";
import styles from "./world-mood-module.module.css";

const feelings = {
  energy: { title: "Силы", Icon: Sprout, labels: ["Пора передохнуть", "На спокойной волне", "Полон сил"] },
  curiosity: { title: "Любопытство", Icon: Search, labels: ["Уже нагулялся", "Присматривается", "Хочется открытий"] },
  comfort: { title: "Уют", Icon: Leaf, labels: ["Ищет место поуютнее", "Устраивается", "Чувствует себя уютно"] },
  attention: { title: "Общение", Icon: Heart, labels: ["Занят своими делами", "Помнит, что ты рядом", "Рад тебя видеть"] },
} as const;

type Props = {
  observation: ForestObservation | null;
  economy: Pick<EconomyController, "snapshot">;
  onCall?: () => void;
  callPulse?: number;
  onOpenHelp?: () => void;
  onOpenFood?: () => void;
};

/** Keep private decision diagnostics out of the player-facing mood module. */
export function WorldMoodModule({ observation, economy, onCall, callPulse = 0, onOpenHelp, onOpenFood }: Props) {
  const snapshot = economy.snapshot;
  const meal = snapshot ? pendingMeal(snapshot, "hero") : null;
  const jobMeal = snapshot?.jobs.find(job => job.kind === "exploration" && job.meal?.consumer === "hero")?.meal;
  const speedBps = meal?.heroSpeedBps ?? jobMeal?.speedBps;
  return <div className={styles.module}>
    {observation ? <>
      <section className={styles.current} aria-label="Настроение Мохлика">
        <span className={styles.moodIcon}>{observation.sleeping ? <Moon size={23} aria-hidden="true" /> : <Leaf size={23} aria-hidden="true" />}</span>
        <div><p>{observation.paused ? "Полянка на паузе" : observation.activity}</p><h3>{observation.mood}</h3></div>
      </section>
      <dl className={styles.feelings} aria-label="Самочувствие Мохлика">
        {(Object.keys(feelings) as (keyof typeof feelings)[]).map(key => {
          const { title, Icon, labels } = feelings[key];
          const value = observation.needs[key];
          return <div key={key}>
            <dt><Icon size={14} aria-hidden="true" />{title}</dt>
            <dd>{labels[value < .3 ? 0 : value < .65 ? 1 : 2]}</dd>
          </div>;
        })}
      </dl>
      <p className={styles.note}>Мохлик сам отдыхает и находит занятия. Возвращаться по расписанию не нужно.</p>
    </> : <p className={styles.waiting}>Состояние появится, когда полянка загрузится.</p>}

    {snapshot?.catalog.food && <section className={styles.food} aria-label="Бонус от еды">
      <Soup size={18} aria-hidden="true" />
      <div><h3>{speedBps ? `Еда: +${speedBps / 100}% к скорости` : "Еда для вылазки"}</h3>
        <p>{meal ? "Бонус ждёт следующую вылазку." : jobMeal ? "Бонус учтён в текущей вылазке." : "Блюдо ускоряет одну вылазку. Силы восстанавливаются во время отдыха."}</p></div>
      {onOpenFood && <button type="button" className={styles.foodAction} onClick={onOpenFood}>Еда</button>}
    </section>}

    {(onCall || onOpenHelp) && <div className={styles.actions}>
      {onCall && <button type="button" className={styles.action} data-called={callPulse > 0 || undefined}
        disabled={!observation || observation.paused} onClick={onCall}>
        <Heart key={callPulse} size={15} aria-hidden="true" />{callPulse > 0 ? "Мохлик, иди сюда!" : observation?.sleeping ? "Разбудить Мохлика" : "Позвать Мохлика"}
      </button>}
      {onOpenHelp && <button type="button" className={styles.help} onClick={onOpenHelp}><CircleHelp size={16} aria-hidden="true" />Как заботиться о Мохлике</button>}
    </div>}
  </div>;
}
