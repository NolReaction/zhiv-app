"use client";

import { useEffect, useRef } from "react";
import { pleskSprite } from "./plesk-sprite";
import { X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { EconomyController } from "@/features/economy/use-economy";
import { PleskFishingShop } from "@/features/economy/plesk-fishing-shop";
import styles from "./world-resident-dialog.module.css";

function PleskPortrait() {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const ctx = canvas.current?.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, 96, 96); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(pleskSprite("greet", "front", 0, .3, true), 6, 6, 84, 84);
  }, []);
  return <canvas ref={canvas} className={styles.emblem} width={96} height={96} aria-hidden="true" />;
}

type ResidentActions = { economy: EconomyController; onFishing: () => void; onOpenPantry: () => void };

/** All stock, gear and discoveries come from the player's confirmed account. */
export function PleskConversation({ economy, onFishing, onOpenPantry }: ResidentActions) {
  return <PleskFishingShop key={economy.snapshot?.ownerPublicId ?? "loading"} economy={economy} onFishing={onFishing} onOpenPantry={onOpenPantry} />;
}

export function WorldResidentDialog({ open, onClose, onCloseAutoFocus, ...actions }: ResidentActions & {
  open: boolean; onClose: () => void; onCloseAutoFocus: (event: Event) => void;
}) {
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogPortal>
      <DialogOverlay className={styles.scrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={styles.dialog} onCloseAutoFocus={onCloseAutoFocus}>
        <header className={styles.header}>
          <PleskPortrait />
          <div><DialogTitle className={styles.name}>Плёска</DialogTitle><DialogDescription className={styles.role}>Рыбачка · рыба, наживка и снасти</DialogDescription></div>
          <button type="button" onClick={onClose} aria-label="Попрощаться с Плёской"><X size={20} aria-hidden="true" /></button>
        </header>
        <PleskConversation {...actions} />
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
