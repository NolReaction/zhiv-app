"use client";
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { GameItemId } from "@/features/game/game-rewards";
import type { EconomyController } from "@/features/economy/sync/use-economy";
import type { WorldController } from "@/features/world/state/use-world";
import WorldView from "./world-view";
import type { WorldFriendsState } from "@/features/world/ui/profile/world-profile-friends";
import type { WorldNotificationEntry } from "./notification-destination";
import type { MailboxController } from "@/features/mailbox/use-mailbox";
import type { Person } from "@/lib/check-in-contract";
import type { GuestWorldTarget } from "@/features/people/guest-world-model";
import { GuestWorldVisit } from "@/features/people/guest-world-visit";
import { NeighborWorldVisit } from "@/features/economy/ui/neighbor/neighbor-world-visit";
import styles from "./world.module.css";

export type WorldPortalProps = {
  open: boolean; onClose: () => void; origin: CSSProperties; returnFocus: () => void;
  suspended?: boolean;
  connectionStatus?: ReactNode;
  mailbox?: MailboxController;
  onSceneReady?: () => void;
  sceneReady?: boolean; notificationEntry?: WorldNotificationEntry;
  onNotificationHandled?: (request: number) => void;
  world: WorldController; economy: EconomyController; ownerPublicId: string; timeZone: string; displayName: string; level: number;
  wakeSignal: number;
  friends?: WorldFriendsState; onOpenPeople?: () => void;
  onOpenNeighbor?: () => void;
  friendVisit?: GuestWorldTarget; onVisitFriend?: (person: Person) => void; onLeaveFriend?: () => void;
  onDevBotsChanged?: () => void; onDevVisitBot?: (target: GuestWorldTarget) => void;
  isOnline?: boolean; onSessionLost?: () => void;
  bestStreakDays: number; items?: readonly GameItemId[];
};
export default function WorldPortal(props: WorldPortalProps) {
  const escapeHandlerRef = useRef<(() => boolean) | null>(null);
  const previousVisit = useRef(false);
  const [neighborSelection, setNeighborSelection] = useState<{ kind: "world_character"; characterId: "berest"; ownerPublicId: string } | null>(null);
  const invalidNeighbor = Boolean(neighborSelection && (!props.open || props.friendVisit || neighborSelection.ownerPublicId !== props.ownerPublicId));
  // Clear revoked subjects synchronously: returning to an earlier account must not resurrect its visit.
  if (invalidNeighbor) setNeighborSelection(null);
  const neighborVisit = Boolean(neighborSelection && !invalidNeighbor);
  const visiting = Boolean(props.friendVisit) || neighborVisit;
  useEffect(() => {
    if (props.open && previousVisit.current && !visiting) document.getElementById("world-exit")?.focus({ preventScroll: true });
    previousVisit.current = visiting;
  }, [props.open, visiting]);
  const leave = neighborVisit ? () => setNeighborSelection(null) : props.friendVisit ? props.onLeaveFriend ?? props.onClose : props.onClose;
  return <Dialog open={props.open} onOpenChange={open => { if (!open && !props.suspended) leave(); }}>
    <DialogPortal>
    <DialogOverlay className={styles.portalScrim} />
    {/* Fullscreen content must not inherit the centered dialog's translate utilities. */}
    <DialogPrimitive.Content data-slot="dialog-content" className={styles.portal} style={props.origin}
      onEscapeKeyDown={event => {
        if (props.suspended || document.querySelector("[data-activity-gate]")) { event.preventDefault(); event.stopPropagation(); return; }
        if (visiting) { event.preventDefault(); event.stopPropagation(); leave(); }
        else if (escapeHandlerRef.current?.()) { event.preventDefault(); event.stopPropagation(); }
      }}
      onCloseAutoFocus={event => { event.preventDefault(); props.returnFocus(); }}
      onOpenAutoFocus={event => { event.preventDefault(); document.getElementById("world-exit")?.focus(); }}>
      <DialogTitle className={styles.sr}>{neighborVisit ? "В гостях у лесного соседа" : props.friendVisit ? `В гостях: ${props.friendVisit.displayName}` : "Лес Мохлика"}</DialogTitle>
      <DialogDescription className={styles.sr}>{visiting ? "Полянка друга и его лавка. Можно осмотреть мир и купить выставленные товары." : "Исследуйте карту, улучшайте домик и собирайте лесные находки."}</DialogDescription>
      {neighborVisit ? <NeighborWorldVisit key={`neighbor:${props.ownerPublicId}`} ownerPublicId={props.ownerPublicId}
        economy={props.economy} isOnline={props.isOnline} suspended={props.suspended} timeZone={props.timeZone}
        onReturn={leave} onSceneReady={props.onSceneReady} /> : props.friendVisit ? <GuestWorldVisit key={`${props.ownerPublicId}:${props.friendVisit.circleId}:${props.friendVisit.targetPublicId}`}
        ownerPublicId={props.ownerPublicId} target={props.friendVisit} economy={props.economy} isOnline={props.isOnline}
        onSessionLost={props.onSessionLost} suspended={props.suspended} timeZone={props.timeZone} onReturn={leave} onSceneReady={props.onSceneReady} />
         : <WorldView {...props} onOpenNeighbor={() => { if (props.open && !props.suspended) setNeighborSelection({ kind: "world_character", characterId: "berest", ownerPublicId: props.ownerPublicId }); }} escapeHandlerRef={escapeHandlerRef} />}
      {props.connectionStatus}
    </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
