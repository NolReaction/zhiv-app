"use client";

import { useEffect, useRef } from "react";
import { pleskSprite } from "./plesk-sprite";
import { Fish, Package, RefreshCw, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import type { EconomyController } from "@/features/economy/use-economy";
import { PantrySale } from "@/features/economy/world-pantry-menu";
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

/** Uses the same confirmed inventory and sale command as the pantry. His ambient catch is his own. */
export function PleskConversation({ economy, onFishing, onOpenPantry }: ResidentActions) {
  const state = economy.snapshot;
  const fish = state?.inventory.fish ?? 0;
  const cooldown = Math.max(0, Math.ceil((economy.retryAt - economy.now) / 1000));
  return <div className={styles.conversation} aria-busy={economy.busy || undefined}>
    <blockquote>«Удочку держи крепко, а день не торопи. Хорошая рыба любит терпеливых!»</blockquote>
    <p className={styles.story}>Плёск знает тихие места на берегу, проверяет снасти и скупает улов. Его место — у деревянного пирса выше по берегу.</p>
    {(economy.error || economy.uncertain) && <div className={styles.recovery} role="alert">
      <p>{economy.uncertain ? "Проверяем последнюю продажу. Дождитесь подтверждения, прежде чем торговать снова." : economy.error}</p>
      <button type="button" disabled={economy.busy || cooldown > 0} onClick={() => void economy.retry()}><RefreshCw size={14} aria-hidden="true" />{cooldown ? `Повторить через ${cooldown} с` : economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button>
    </div>}
    {!state ? <p className={styles.hint} role="status">Проверяем ваши запасы…</p>
      : fish > 0 ? <PantrySale economy={{ ...economy, snapshot: state }} itemId="fish" />
        : <div className={styles.empty}><Fish size={23} aria-hidden="true" /><p>«Принесёшь речную рыбу — куплю!»<span>В вашей кладовой пока нет речной рыбы.</span></p></div>}
    <div className={styles.actions}>
      <button type="button" onClick={onFishing}><Fish size={18} aria-hidden="true" /><span>На рыбалку<small>Маршруты побережья</small></span></button>
      <button type="button" onClick={onOpenPantry}><Package size={18} aria-hidden="true" /><span>Другие запасы<small>Открыть кладовую</small></span></button>
    </div>
  </div>;
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
          <div><DialogTitle className={styles.name}>Плёск</DialogTitle><DialogDescription className={styles.role}>Главный рыбак · торговец</DialogDescription></div>
          <button type="button" onClick={onClose} aria-label="Попрощаться с Плёском"><X size={20} aria-hidden="true" /></button>
        </header>
        <PleskConversation {...actions} />
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
