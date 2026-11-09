"use client";

import { useId } from "react";
import { Dialog } from "radix-ui";
import { Anchor, X } from "lucide-react";
import { boatConfig, boatPhase, boatReturnsAt, boatState } from "@/features/economy/domain/boat-fishing";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { useFishingCommand } from "@/features/economy/ui/fishing/use-fishing-command";
import { worldCountdown } from "@/features/economy/ui/shared/world-stations";
import { BoatCatchList, BoatWork } from "./boat-panels";
import { BoatVoyagePanel } from "./boat-voyage-panel";
import styles from "./boat-fishing.module.css";

type Props = { economy: ReadyEconomy; onClose: () => void; onOpenPantry?: () => void };

/** Finish already-paid work and deliver saved catches while new boat gameplay is paused. */
export function BoatRecoveryDialog({ economy, onClose, onOpenPantry }: Props) {
  const description = useId();
  const state = economy.snapshot, boat = boatState(state), voyage = boat.voyage;
  const phase = boatPhase(boat, economy.now);
  const { blocked, send } = useFishingCommand({ economy, state });
  const disabled = blocked || economy.snapshotConfirmed === false;
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Overlay className={styles.overlay} onPointerDown={event => event.stopPropagation()} />
    <Dialog.Content className={styles.dialog} aria-describedby={description} data-boat-recovery
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}>
      <header className={styles.header}><Anchor size={25} /><Dialog.Title>Возвращение к причалу</Dialog.Title>
        <button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть"><X size={22} /></button></header>
      <div className={styles.body}>
        <Dialog.Description id={description}>Можно завершить оплаченную работу или забрать улов прежнего выхода.</Dialog.Description>
        {voyage && <section className={styles.trip}>
          {phase === "ready"
            ? <BoatVoyagePanel economy={economy} disabled={disabled} send={(action, id) => send(action, id)} onOpenPantry={onOpenPantry} />
            : <>
              <p>До возвращения: {worldCountdown(Math.ceil((boatReturnsAt(voyage) - economy.now) / 1000))}</p>
              {phase === "fishing" && <button type="button" className={styles.primary} disabled={disabled} onClick={() => send("return_boat", voyage.id)}>Вернуться с уловом</button>}
              <BoatCatchList state={state} boat={boat} />
            </>}
        </section>}
        <BoatWork boat={boat} config={state.catalog.boat ?? boatConfig()} now={economy.now} disabled={disabled} onClaim={id => send("claim_boat_upgrade", id)} />
        {economy.error && <p className={styles.error} role="alert">{economy.error}</p>}
        {economy.uncertain && <button type="button" className={styles.secondary} disabled={economy.busy} onClick={() => economy.retry()}>Проверить последнее действие</button>}
      </div>
    </Dialog.Content>
  </Dialog.Root>;
}
