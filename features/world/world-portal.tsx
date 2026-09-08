"use client";
import type { CSSProperties } from "react";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { GameItemId } from "@/lib/game-rewards";
import type { WorldController } from "./use-world";
import WorldView from "./world-view";
import styles from "./world.module.css";

export type WorldPortalProps = {
  open: boolean; onClose: () => void; origin: CSSProperties; returnFocus: () => void;
  world: WorldController; ownerPublicId: string; timeZone: string; displayName: string; level: number;
  wakeSignal: number; lastCheckInLabel: string; onCheckIn: () => void; isCheckingIn: boolean;
  bestStreakDays: number; items?: readonly GameItemId[];
};
export default function WorldPortal(props: WorldPortalProps) {
  return <Dialog open={props.open} onOpenChange={open => { if (!open) props.onClose(); }}>
    <DialogContent className={styles.portal} style={props.origin} showCloseButton={false}
      onCloseAutoFocus={event => { event.preventDefault(); props.returnFocus(); }}
      onOpenAutoFocus={event => { event.preventDefault(); document.getElementById("world-exit")?.focus(); }}>
      <DialogTitle className={styles.sr}>Лес Мохлика</DialogTitle>
      <DialogDescription className={styles.sr}>Исследуйте карту, улучшайте домик и собирайте лесные находки.</DialogDescription>
      <WorldView {...props} />
    </DialogContent>
  </Dialog>;
}
