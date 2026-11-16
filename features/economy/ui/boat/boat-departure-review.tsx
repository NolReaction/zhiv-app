import { useState } from "react";
import { Dialog } from "radix-ui";
import { ArrowRight, Fuel, Sailboat, X } from "lucide-react";
import { boatConfig } from "@/features/economy/domain/boat-fishing";
import { fishingState } from "@/features/economy/domain/fishing";
import type { ReadyEconomy } from "@/features/economy/sync/controller-state";
import { WorldTacklePicker } from "@/features/economy/ui/fishing/world-tackle-picker";
import { worldDuration } from "@/features/economy/ui/shared/world-stations";
import { itemName } from "@/features/economy/ui/shared/world-economy-parts";
import type { BoatSend } from "./world-boat-fishing-dialog";
import shared from "./boat-fishing.module.css";
import styles from "./boat-departure-review.module.css";

type Props = { economy: ReadyEconomy; disabled: boolean; reason: string | null; send: BoatSend };

export function BoatDepartureReview({ economy, disabled, reason, send }: Props) {
  const [open, setOpen] = useState(false);
  const state = economy.snapshot, config = boatConfig(state.catalog), bait = fishingState(state).equippedBaitId;
  return <Dialog.Root open={open} onOpenChange={setOpen}>
    <Dialog.Trigger asChild>
      <button className={shared.primary} type="button" disabled={disabled}>
        <Sailboat size={16} /><span>Отправиться на рыбалку<small>Проверить снасти</small></span><ArrowRight size={15} />
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className={styles.overlay} onPointerDown={event => event.stopPropagation()} />
      <Dialog.Content className={styles.review} data-boat-departure-review onPointerDown={event => event.stopPropagation()}
        onWheel={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onEscapeKeyDown={event => event.stopPropagation()}>
        <header><Dialog.Title>Снасти перед выходом</Dialog.Title>
          <Dialog.Close asChild><button type="button" className={shared.close} aria-label="Закрыть проверку снастей"><X size={19} /></button></Dialog.Close></header>
        <div className={styles.choices}>
          <Dialog.Description>{config.name} · {worldDuration(config.activeSeconds)} на воде</Dialog.Description>
          <WorldTacklePicker state={state} economy={economy} disabled={disabled}
            onChoose={(kind, itemId) => send(kind === "rod" ? "equip_fishing_rod" : kind === "hook" ? "equip_fishing_hook" : "equip_fishing_bait", itemId)} />
          {reason && <p className={shared.note}>{reason}</p>}
          {economy.error && <p role="alert">{economy.error}</p>}
          {economy.uncertain && <button type="button" className={shared.secondary} disabled={economy.busy} onClick={() => economy.retry()}>Проверить последнее действие</button>}
        </div>
        <footer><p><Fuel size={15} aria-hidden="true" />1 ячейка бензина · {bait ? `${itemName(state, bait)} ×1` : "без наживки"}</p>
          <button type="button" className={shared.primary} data-confirm-boat-departure disabled={disabled || Boolean(reason)}
            onClick={() => send("depart_boat", config.routeId)}>Подтвердить выход<ArrowRight size={16} /></button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
