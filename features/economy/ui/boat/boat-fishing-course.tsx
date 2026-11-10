"use client";

import type { RefObject } from "react";
import { Dialog } from "radix-ui";
import { Fish, FishingRod, Waves } from "lucide-react";
import styles from "./boat-fishing-coach.module.css";

type Props = { open: boolean; river: RefObject<HTMLElement | null>; onClose: (practice: boolean) => void };

export function BoatFishingCourse({ open, river, onClose }: Props) {
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose(false); }}>
    <Dialog.Portal>
      <Dialog.Overlay className={styles.shade} />
      <Dialog.Content className={styles.course} data-boat-fishing-course onEscapeKeyDown={event => event.stopPropagation()}
        onCloseAutoFocus={event => {
          const water = river.current?.querySelector<HTMLButtonElement>('[data-fishing-action="cast"]:enabled');
          if (water) { event.preventDefault(); water.focus({ preventScroll: true }); }
        }}>
        <Dialog.Title className={styles.title}>Как ловить с лодки</Dialog.Title>
        <Dialog.Description asChild><ol className={styles.steps}>
          <li><FishingRod aria-hidden="true" /><div><strong>Забросьте удочку</strong><p>Зажмите кнопку заброса, воду или пробел. Отпустите, когда метка войдёт в зелёную зону.</p></div></li>
          <li><Waves aria-hidden="true" /><div><strong>Подсеките при нырке</strong><p>Поплавок может слегка качнуться. Когда он уйдёт под воду, один раз нажмите на воду или пробел.</p></div></li>
          <li><Fish aria-hidden="true" /><div><strong>Подведите рыбу к борту</strong><p>Удерживайте «Тянуть снасть», чтобы поднять зелёную зону. Отпускайте, чтобы опустить её вслед за рыбой.</p></div></li>
        </ol></Dialog.Description>
        <div className={styles.actions}>
          <button type="button" className={styles.start} data-fishing-action="course-start" onClick={() => onClose(true)}>Ловить с подсказками</button>
          <button type="button" className={styles.skip} data-fishing-action="course-skip" onClick={() => onClose(false)}>Пропустить</button>
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
