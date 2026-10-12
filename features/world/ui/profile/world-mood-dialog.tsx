"use client";

import { useRef, type ComponentProps, type RefObject } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { ArrowLeft, Leaf, X } from "lucide-react";
import { Dialog, DialogClose, DialogDescription, DialogPortal, DialogOverlay, DialogTitle } from "@/components/ui/dialog";
import { WorldMoodModule } from "./world-mood-module";
import glass from "@/components/glass-dialog.module.css";
import styles from "./mochlik-state.module.css";

type Props = ComponentProps<typeof WorldMoodModule> & {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
};

/** A small optional view; it does not create another observation or history entry. */
export function WorldMoodDialog({ open, onOpenChange, returnFocusRef, ...mood }: Props) {
  const titleRef = useRef<HTMLHeadingElement>(null);
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogPortal>
      <DialogOverlay className={styles.scrim} data-world-mood-overlay />
      <DialogPrimitive.Content data-slot="dialog-content" className={`${glass.dialog} ${styles.dialog}`} data-world-mood
        onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true }); }}
        onEscapeKeyDown={event => { event.preventDefault(); event.stopPropagation(); onOpenChange(false); }}
        onKeyDown={event => { if (event.key === "Escape") event.stopPropagation(); }}>
        <div className={styles.header}>
          <DialogTitle ref={titleRef} tabIndex={-1} className={glass.title}><Leaf size={22} aria-hidden="true" />Как Мохлик?</DialogTitle>
          <DialogClose className={styles.close} aria-label="Закрыть состояние Мохлика" data-world-mood-close data-audio-cue="ui.close"><X size={20} aria-hidden="true" /></DialogClose>
        </div>
        <DialogDescription className={styles.description}>Его настроение, занятия и самочувствие на полянке.</DialogDescription>
        <WorldMoodModule {...mood} />
        <DialogClose className={styles.chip} data-audio-cue="ui.close"><ArrowLeft size={16} aria-hidden="true" />Вернуться в профиль</DialogClose>
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
