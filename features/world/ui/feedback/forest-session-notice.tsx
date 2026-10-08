"use client";

import { useRef } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowRight, Pause } from "lucide-react";
import { Dialog, DialogDescription, DialogOverlay, DialogPortal, DialogTitle } from "@/components/ui/dialog";
import type { ForestMemorySyncStatus } from "@/features/world/state/memory/forest-memory-sync";
import { takeOverForestSession } from "@/features/world/state/forest-session";
import { useForestObservation } from "@/features/world/state/use-forest-observation";
import styles from "./forest-session-notice.module.css";

type Props = { presenceKey: string; onExit?: () => void };

/** Only a competing writer pauses this notice; background and network pauses have their own UI. */
export function ForestSessionNotice(props: Props) {
  return <ForestSessionNoticeSession key={props.presenceKey} {...props} />;
}

function ForestSessionNoticeSession({ presenceKey, onExit }: Props) {
  const observation = useForestObservation(presenceKey);
  const returnTarget = useRef<HTMLElement | null>(null);
  return <ForestSessionNoticeContent sync={observation?.memory.sync}
    onTakeOver={() => takeOverForestSession(presenceKey)} onExit={onExit}
    onOpenAutoFocus={() => { returnTarget.current = document.activeElement instanceof HTMLElement ? document.activeElement : null; }}
    onCloseAutoFocus={event => {
      event.preventDefault();
      if (returnTarget.current?.isConnected) returnTarget.current.focus({ preventScroll: true });
    }} />;
}

export function ForestSessionNoticeContent({ sync, onTakeOver, onExit, onOpenAutoFocus, onCloseAutoFocus }: {
  sync?: ForestMemorySyncStatus;
  onTakeOver: () => void;
  onExit?: () => void;
  onOpenAutoFocus?: (event: Event) => void;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const blocked = sync?.mode === "other-device";
  return <Dialog open={blocked}>
    <DialogPortal>
      <DialogOverlay className={styles.scrim} />
      <DialogPrimitive.Content data-slot="dialog-content" data-forest-session-notice className={styles.dialog}
        onOpenAutoFocus={onOpenAutoFocus} onCloseAutoFocus={onCloseAutoFocus}
        onEscapeKeyDown={event => event.preventDefault()} onInteractOutside={event => event.preventDefault()}>
        <span className={styles.symbol} aria-hidden="true"><Pause size={26} /></span>
        <DialogTitle className={styles.title}>Полянка на паузе</DialogTitle>
        <DialogDescription className={styles.description}>
          Управление Мохликом осталось в другой вкладке, на другом устройстве или в предыдущем запуске игры. Поэтому здесь он пока не двигается.
        </DialogDescription>
        <p className={styles.hint}>Продолжи игру здесь — сохранённый прогресс останется.</p>
        <button type="button" className={styles.continue} disabled={!blocked || !sync.canTakeOver}
          onClick={() => { if (blocked && sync.canTakeOver) onTakeOver(); }}>
          Продолжить здесь<ArrowRight size={18} aria-hidden="true" />
        </button>
        {onExit && <button type="button" className={styles.exit} onClick={onExit}>На главный экран</button>}
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
