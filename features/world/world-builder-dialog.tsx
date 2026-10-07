"use client";

import { ArrowLeft, ArrowRight, Check, Clock3, Hammer, Soup, ClipboardList, X } from "lucide-react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { Dialog, DialogPortal, DialogOverlay, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { economyBuilderStatus } from "@/features/economy/builder-status";
import { WorldMealBoost } from "@/features/economy/world-meal-boost";
import { ConstructionSpeedup } from "@/features/economy/construction-speedup";
import type { EconomyController } from "@/features/economy/use-economy";
import { worldDuration } from "@/features/economy/world-stations";
import { BUILDER } from "./builder-types";
import { BuilderPortrait } from "./builder-portrait";
import { ResidentSpeech } from "./forest-speech";
import styles from "./world-builder-dialog.module.css";

type BuilderActions = { economy: EconomyController; onOpenConstruction: (stationId: string) => void; onOpenMeals?: () => void; onOpenOrders?: () => void; onNavigateStation?: (stationId: string, recipeId?: string) => void; isOnline?: boolean };

/** The resident shows confirmed work; completing early uses the building's quoted action. */
export function BuilderConversation({ economy, onOpenConstruction, onNavigateStation, onOpenMeals, isOnline }: BuilderActions) {
  const state = economy.snapshot;
  const retryBlocked = economy.busy || economy.now < economy.retryAt;
  const retry = () => { if (!economy.busy && economy.now >= economy.retryAt) void economy.retry(); };
  if (!state) return <section className={styles.status} aria-label="Работа строителя">
    <p role={economy.error ? "alert" : "status"}>{economy.error ?? "Смотрим, как идут дела…"}</p>
    {economy.error && <button type="button" className={styles.action} disabled={retryBlocked} onClick={retry}>Попробовать ещё раз</button>}
  </section>;
  const feedback = (economy.error || economy.uncertain) && <div className={styles.feedback} role="alert">
    <p>{economy.uncertain ? "Проверяем последнее действие." : economy.error}</p>
    <button type="button" disabled={retryBlocked} onClick={retry}>{economy.uncertain ? "Проверить результат" : "Попробовать ещё раз"}</button>
  </div>;
  const status = economyBuilderStatus(state, economy.now);
  if (!status) return <section className={styles.status} aria-label="Работа строителя" data-builder-status="free">
    {feedback}
    <span className={styles.badge}><Hammer size={15} aria-hidden="true" />Свободен</span>
    <p>Готов помочь с постройками. Выберите здание для улучшения.</p>
    <WorldMealBoost economy={economy} consumer="builder" isOnline={isOnline} onNavigateStation={onNavigateStation} onOpenMeals={onOpenMeals} />
  </section>;
  const remaining = status.seconds < 60 ? `${status.seconds} с` : worldDuration(status.seconds);
  return <section className={styles.status} aria-label="Работа строителя" data-builder-status={status.ready ? "ready" : "working"}>
    {feedback}
    <span className={styles.badge}>{status.ready ? <Check size={15} aria-hidden="true" /> : <Hammer size={15} aria-hidden="true" />}{status.ready ? "Готово" : "Занят улучшением"}</span>
    <div className={styles.building}><strong>{status.stationName}</strong>{status.job.targetLevel !== null && <span>Уровень {status.job.targetLevel}</span>}</div>
    {status.ready ? <p>Работа закончена — завершите улучшение.</p> : <div className={styles.timerRow}><p className={styles.timer}><Clock3 size={16} aria-hidden="true" />Осталось {remaining}</p><WorldMealBoost economy={economy} consumer="builder" jobId={status.job.id} isOnline={isOnline} onNavigateStation={onNavigateStation} onOpenMeals={onOpenMeals} /></div>}
    {!status.ready && <ConstructionSpeedup key={status.job.id} economy={{ ...economy, snapshot: state }} job={status.job} />}
    <button type="button" className={styles.action} onClick={() => onOpenConstruction(status.stationId)}>{status.ready ? "Завершить улучшение" : "К постройке"}<ArrowRight size={16} aria-hidden="true" /></button>
  </section>;
}

export function WorldBuilderDialog({ open, onClose, onBack, onCloseAutoFocus, ...actions }: BuilderActions & {
  open: boolean; onClose: () => void; onBack?: () => void; onCloseAutoFocus: (event: Event) => void;
}) {
  return <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <DialogPortal>
      <DialogOverlay className={styles.scrim} />
      <DialogPrimitive.Content data-slot="dialog-content" className={styles.dialog} onCloseAutoFocus={onCloseAutoFocus}>
        {onBack && <button type="button" className={styles.back} onClick={onBack}><ArrowLeft size={16} aria-hidden="true" />К персонажам</button>}
        <header className={styles.header}>
          <BuilderPortrait animated className={styles.emblem} />
          <div><DialogTitle className={styles.name}>{BUILDER.name}</DialogTitle><DialogDescription className={styles.role}>Ёжик-строитель</DialogDescription></div>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Попрощаться с Шишколапом"><X size={20} aria-hidden="true" /></button>
        </header>
        <ResidentSpeech owner={actions.economy.snapshot?.ownerPublicId} speaker="builder" />
        <BuilderConversation {...actions} />
        {(actions.onOpenMeals || actions.onOpenOrders) && <nav className={styles.foodActions} aria-label="Еда и заказы Шишколапа">
          {actions.onOpenMeals && <button type="button" onClick={actions.onOpenMeals}><Soup size={17} aria-hidden="true" />Угостить</button>}
          {actions.onOpenOrders && <button type="button" onClick={actions.onOpenOrders}><ClipboardList size={17} aria-hidden="true" />Заказы</button>}
        </nav>}
      </DialogPrimitive.Content>
    </DialogPortal>
  </Dialog>;
}
