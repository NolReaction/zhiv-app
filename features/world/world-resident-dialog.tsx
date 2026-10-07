"use client";

import { PleskPortrait } from "./plesk-portrait";
import { ArrowLeft, ClipboardList, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { EconomyController } from "@/features/economy/use-economy";
import { PleskFishingShop } from "@/features/economy/plesk-fishing-shop";
import { ResidentSpeech } from "./forest-speech";
import styles from "./world-resident-dialog.module.css";

type ResidentActions = { economy: EconomyController; onFishing: () => void; onOpenPantry: () => void; onOpenOrders?: () => void };

/** All stock, gear and discoveries come from the player's confirmed account. */
export function PleskConversation({ economy, onFishing, onOpenPantry, onOpenOrders }: ResidentActions) {
  return <PleskFishingShop key={economy.snapshot?.ownerPublicId ?? "loading"} economy={economy} onFishing={onFishing} onOpenPantry={onOpenPantry} onOpenOrders={onOpenOrders} />;
}

export function WorldResidentDialog({ open, onClose, onBack, onCloseAutoFocus, ...actions }: ResidentActions & {
  open: boolean; onClose: () => void; onBack?: () => void; onCloseAutoFocus: (event: Event) => void;
}) {
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogPortal>
      <DialogOverlay className={styles.scrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={styles.dialog} onCloseAutoFocus={onCloseAutoFocus}>
        {onBack && <button type="button" className={styles.back} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />К персонажам</button>}
        <header className={styles.header}>
          <PleskPortrait className={styles.emblem} />
          <div><DialogTitle className={styles.name}>Плёска</DialogTitle><DialogDescription className={styles.role}>Рыбачка · рыба, наживка и снасти</DialogDescription></div>
          <button type="button" onClick={onClose} aria-label="Попрощаться с Плёской"><X size={20} aria-hidden="true" /></button>
        </header>
        <ResidentSpeech owner={actions.economy.snapshot?.ownerPublicId} speaker="plesk" />
        {actions.onOpenOrders && <button type="button" className={styles.orders} onClick={actions.onOpenOrders}><ClipboardList size={17} aria-hidden="true" />Заказы Плёски<span>Обменять припасы на монеты</span></button>}
        <PleskConversation {...actions} />
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
