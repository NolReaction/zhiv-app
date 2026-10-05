"use client";
import { useRef, type CSSProperties } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { GameItemId } from "@/features/game/game-rewards";
import type { EconomyController } from "@/features/economy/use-economy";
import type { WorldController } from "./use-world";
import WorldView from "./world-view";
import styles from "./world.module.css";

export type WorldPortalProps = {
  open: boolean; onClose: () => void; origin: CSSProperties; returnFocus: () => void;
  world: WorldController; economy: EconomyController; ownerPublicId: string; timeZone: string; displayName: string; level: number;
  wakeSignal: number;
  isOnline?: boolean; onSessionLost?: () => void;
  bestStreakDays: number; items?: readonly GameItemId[];
};
export default function WorldPortal(props: WorldPortalProps) {
  const escapeHandlerRef = useRef<(() => boolean) | null>(null);
  return <Dialog open={props.open} onOpenChange={open => { if (!open) props.onClose(); }}>
    <DialogPortal>
    <DialogOverlay className={styles.portalScrim} />
    {/* Fullscreen content must not inherit the centered dialog's translate utilities. */}
    <DialogPrimitive.Content data-slot="dialog-content" className={styles.portal} style={props.origin}
      onEscapeKeyDown={event => { if (escapeHandlerRef.current?.()) { event.preventDefault(); event.stopPropagation(); } }}
      onCloseAutoFocus={event => { event.preventDefault(); props.returnFocus(); }}
      onOpenAutoFocus={event => { event.preventDefault(); document.getElementById("world-exit")?.focus(); }}>
      <DialogTitle className={styles.sr}>Лес Мохлика</DialogTitle>
      <DialogDescription className={styles.sr}>Исследуйте карту, улучшайте домик и собирайте лесные находки.</DialogDescription>
      <WorldView {...props} escapeHandlerRef={escapeHandlerRef} />
    </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
