"use client";

import { useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ChevronRight, Heart, Leaf, Search, Sprout, X } from "lucide-react";
import { Dialog, DialogClose, DialogDescription, DialogPortal, DialogOverlay, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useForestObservation } from "./use-forest-observation";
import type { ForestObservation } from "./forest-observer";
import { takeOverForestSession } from "./forest-session";
import glass from "@/components/glass-dialog.module.css";
import styles from "./mochlik-state.module.css";

type Props = { presenceKey: string };

const feelingLabels = {
  energy: { title: "Силы", Icon: Sprout, labels: ["Пора передохнуть", "На спокойной волне", "Полон сил"] },
  curiosity: { title: "Любопытство", Icon: Search, labels: ["Уже нагулялся", "Присматривается", "Хочется открытий"] },
  comfort: { title: "Уют", Icon: Leaf, labels: ["Ищет место поуютнее", "Устраивается", "Чувствует себя уютно"] },
  attention: { title: "Общение", Icon: Heart, labels: ["Занят своими делами", "Помнит, что ты рядом", "Рад тебя видеть"] },
} as const;

/** Words, rather than percentages, describe the visible character without turning care into a task. */
export function MochlikStateDetails({ observation, onTakeOver }: {
  observation: ForestObservation | null; onTakeOver?: () => void;
}) {
  if (!observation) return <p className={styles.waiting}>Состояние появится, когда полянка загрузится.</p>;
  const sync = observation.memory.sync;
  const memoryText = sync ? {
    loading: "Загружаем память Мохлика из аккаунта…",
    synced: sync.serverSavedAt !== null
      ? "Память Мохлика сохранена в аккаунте. Его занятия и отдых можно продолжить на другом устройстве."
      : "Готовим первое сохранение памяти Мохлика в аккаунте…",
    saving: "Сохраняем память Мохлика в аккаунте…",
    offline: "Нет связи с памятью аккаунта. После восстановления связи загрузится последнее подтверждённое сохранение.",
    "other-device": "Мохлик сейчас живёт на другом устройстве или в другой вкладке. Здесь полянка на паузе. Можно продолжить его жизнь здесь.",
    error: "Не удалось подключить память аккаунта. Перезагрузи приложение, чтобы попробовать снова.",
    disabled: "Включён просмотр DEV-сценария. Его изменения не сохраняются в память Мохлика.",
  }[sync.mode] : observation.memory.status === "saved" || observation.memory.status === "restored"
    ? "Память Мохлика пока сохранена только на этом устройстве."
    : observation.memory.status === "unavailable"
      ? "Сейчас не получается сохранить память на этом устройстве. Пока приложение открыто, жизнь полянки продолжается."
      : "Сейчас память Мохлика сохраняется только на время этой сессии.";
  return <>
    <section className={styles.current} aria-label="Настроение Мохлика">
      <span className={styles.eyebrow}>{observation.paused ? "Полянка на паузе" : "Настроение"}</span>
      <h3>{observation.mood}</h3>
    </section>
    <dl className={styles.feelings} aria-label="Самочувствие Мохлика">
      {(Object.keys(feelingLabels) as (keyof typeof feelingLabels)[]).map(key => {
        const { title, Icon, labels } = feelingLabels[key];
        const value = observation.needs[key];
        const label = labels[value < .3 ? 0 : value < .65 ? 1 : 2];
        return <div key={key}>
          <dt><Icon size={15} aria-hidden="true" />{title}</dt>
          <dd>{label}</dd>
        </div>;
      })}
    </dl>
    <p className={styles.note}>Мохлик сам отдыхает и находит занятия. Заходи, когда хочется: забота о нём не требует расписания.</p>
    <div className={styles.memory}>
      <p>{memoryText}</p>
      {sync?.canTakeOver && onTakeOver && <button type="button" className={styles.takeOver} onClick={onTakeOver}>
        Продолжить здесь
      </button>}
    </div>
  </>;
}

/** Remount the entire dialog when the account changes, including focus and open state. */
export function MochlikState(props: Props) {
  return <MochlikStateDialog key={props.presenceKey} {...props} />;
}

function MochlikStateDialog({ presenceKey }: Props) {
  const observation = useForestObservation(presenceKey);
  const [open, setOpen] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  return <Dialog open={open} onOpenChange={setOpen}>
    <DialogTrigger asChild>
      <button type="button" className={styles.chip}>
        <Leaf size={16} aria-hidden="true" /><span>Как Мохлик?</span><ChevronRight size={15} aria-hidden="true" />
      </button>
    </DialogTrigger>
    <DialogPortal>
      <DialogOverlay className={styles.scrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={`${glass.dialog} ${styles.dialog}`}
        onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus(); }}>
        <div className={styles.header}>
          <DialogTitle ref={titleRef} tabIndex={-1} className={glass.title}><Leaf size={22} aria-hidden="true" />Как Мохлик?</DialogTitle>
          <DialogClose className={styles.close} aria-label="Закрыть состояние Мохлика"><X size={20} aria-hidden="true" /></DialogClose>
        </div>
        <DialogDescription className={styles.description}>Его настроение и самочувствие на полянке.</DialogDescription>
        <MochlikStateDetails observation={observation} onTakeOver={() => takeOverForestSession(presenceKey)} />
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
