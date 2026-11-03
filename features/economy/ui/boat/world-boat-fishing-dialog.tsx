"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Anchor, ArrowRight, Clock3, Coins, Fish, FishingRod, Sailboat, Trophy, X } from "lucide-react";
import { boatConfig, boatDepartureReason, boatPhase, boatState } from "@/features/economy/domain/boat-fishing";
import type { BoatReelCommand, BoatUpgradeId } from "@/features/economy/domain/boat-model";
import type { EconomyCommand } from "@/features/economy/domain/model";
import { fishingState } from "@/features/economy/domain/fishing";
import { BoatDevControls } from "@/features/economy/dev/boat-dev-controls";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { WorldTacklePicker } from "@/features/economy/ui/fishing/world-tackle-picker";
import { number } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration } from "@/features/economy/ui/shared/world-stations";
import { BoatRecords, BoatWork } from "./boat-panels";
import { BoatGarage } from "./boat-garage";
import { BoatVoyagePanel } from "./boat-voyage-panel";
import { BoatFishingMap } from "./boat-fishing-map";
import mapStyles from "./boat-fishing-map.module.css";
import styles from "./boat-fishing.module.css";

const tabs = [{ id: "boat", label: "Лодка", icon: Sailboat }, { id: "records", label: "Рекорды", icon: Trophy }] as const;
type Tab = typeof tabs[number]["id"];
type Props = { economy: ReadyEconomy; onClose: () => void; onOpenPantry?: () => void; appearance?: { palette: string; head: string | null; neck: string | null } };
export type BoatSend = (action: EconomyCommand["action"], targetId: string, reel?: BoatReelCommand) => boolean;

export function WorldBoatFishingDialog(props: Props) {
  if (!props.economy.snapshot.catalog.boat) return <BoatUnavailableDialog economy={props.economy} onClose={props.onClose} />;
  const view = boatPhase(boatState(props.economy.snapshot), props.economy.now) === "fishing" ? "river" : "dock";
  return <BoatDialogSession key={`${props.economy.snapshot.ownerPublicId}.${view}`} {...props} />;
}

/** Cached catalogs and older API versions cannot quote the new boat's costs or actions. */
function BoatUnavailableDialog({ economy, onClose }: Pick<Props, "economy" | "onClose">) {
  const id = useId();
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Overlay className={styles.overlay} onPointerDown={event => event.stopPropagation()} />
    <Dialog.Content className={styles.dialog} style={{ maxWidth: 440 }} aria-describedby={id} data-boat-unavailable
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => event.stopPropagation()}>
      <header className={styles.header}><Anchor size={25} /><div><Dialog.Title>Рыбацкая лодка</Dialog.Title></div><button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть лодку"><X size={22} /></button></header>
      <div className={styles.body}><section className={styles.trip}><h3>Данные о лодке пока недоступны</h3><Dialog.Description id={id} className={styles.muted}>Обновите сведения о мире, чтобы продолжить.</Dialog.Description>
        <button type="button" className={styles.primary} disabled={economy.busy} onClick={() => economy.refresh()}>Обновить</button>
      </section></div>
    </Dialog.Content>
  </Dialog.Root>;
}

function BoatDialogSession({ economy, onClose, onOpenPantry, appearance }: Props) {
  const state = economy.snapshot, boat = boatState(state), config = boatConfig(state.catalog), phase = boatPhase(boat, economy.now);
  const [tab, setTab] = useState<Tab>("boat");
  const sent = useRef(false), content = useRef<HTMLDivElement>(null), id = useId();
  const disabled = locked(economy) || economy.snapshotConfirmed === false;
  const challenge = boat.voyage?.challenge;
  const onRiver = phase === "fishing" && Boolean(boat.voyage);
  useEffect(() => { if (!economy.busy && !economy.uncertain) sent.current = false; }, [economy.busy, economy.uncertain, economy.error, state.revision, state.ownerPublicId]);
  useEffect(() => { if (challenge?.id) content.current?.scrollTo({ top: 0 }); }, [challenge?.id]);
  const send: BoatSend = (action, targetId, reel) => {
    if (disabled || sent.current) return false;
    sent.current = true;
    const accepted = economy.act(action, targetId, 1, 0, undefined, undefined, reel);
    if (accepted === false) sent.current = false;
    return accepted !== false;
  };
  const upgrade = (upgradeId: BoatUpgradeId) => { send("start_boat_upgrade", upgradeId); };
  const phaseName = { broken: "Нужен ремонт корпуса", repairing: "Работа в мастерской", docked: "У причала · готовимся к выходу", outbound: "Курс на речной плёс", fishing: "На рыбалке", returning: "Возвращение к причалу", ready: "Лодка вернулась" }[phase];
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Overlay className={styles.overlay} onPointerDown={event => event.stopPropagation()} />
    <Dialog.Content className={`${styles.dialog} ${onRiver ? mapStyles.viewport : ""}`} aria-describedby={`${id}-description`} data-boat-dialog data-boat-phase={phase} data-boat-map-view={onRiver || undefined}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => event.stopPropagation()}>
      {onRiver && boat.voyage ? <>
        <Dialog.Title className={styles.srOnly}>Лодочная рыбалка</Dialog.Title>
        <Dialog.Description id={`${id}-description`} className={styles.srOnly}>Мохлик в лодке на речном плёсе. Забросьте удочку и удерживайте рыбу в зоне снасти.</Dialog.Description>
        <BoatFishingMap key={`${state.ownerPublicId}.${boat.voyage.id}`} economy={economy} disabled={disabled} send={send} onClose={onClose} appearance={appearance} />
      </> : <>
      <header className={styles.header}><Anchor size={25} strokeWidth={1.6} /><div><small>{phaseName}</small><Dialog.Title>{boat.voyage ? "Лодочная рыбалка" : "Лодочная мастерская"}</Dialog.Title></div><span className={styles.wallet} aria-label={`${number(state.wallet.coins)} монет`}><Coins size={17} /><strong>{number(state.wallet.coins)}</strong></span><button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть лодку"><X size={22} /></button></header>
      <Dialog.Description id={`${id}-description`} className={styles.srOnly}>Лодочная рыбалка, ремонт, улучшения и личные рекорды.</Dialog.Description>
      <nav className={styles.tabs} role="tablist" aria-label="Разделы лодки">{tabs.map((entry, index) => <button key={entry.id} id={`${id}-${entry.id}`} type="button" role="tab" className={styles.tab} aria-selected={tab === entry.id} aria-controls={`${id}-panel`} tabIndex={tab === entry.id ? 0 : -1} onClick={() => setTab(entry.id)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
        if (next !== null) { event.preventDefault(); setTab(tabs[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus(); }
      }}><entry.icon size={17} />{entry.label}</button>)}</nav>
      {economy.error && <p className={styles.error} role="alert">{economy.error}</p>}
      {economy.uncertain && <div className={styles.recovery}><span>Проверим, сохранилось ли последнее действие.</span><button type="button" className={styles.secondary} disabled={economy.busy} onClick={() => economy.retry()}>Проверить</button></div>}
      <div ref={content} className={styles.body} id={`${id}-panel`} role="tabpanel" tabIndex={0} aria-labelledby={`${id}-${tab}`}>
        <BoatDevControls economy={economy} compact />
        {tab === "records" ? <BoatRecords state={state} boat={boat} /> : boat.voyage ? <BoatVoyagePanel economy={economy} disabled={disabled} send={send} onOpenPantry={onOpenPantry} /> : <>
            <BoatGarage state={state} boat={boat} config={config} now={economy.now} disabled={disabled} onUpgrade={upgrade} onClaim={workId => send("claim_boat_upgrade", workId)} />
            {boat.level > 0 ? <BoatDockDeparture economy={economy} disabled={disabled} send={send} /> : <p className={styles.dockNote}>Береговая рыбалка на пирсе остаётся доступной во время ремонта.</p>}
          </>}
        {tab !== "boat" && <BoatWork boat={boat} config={config} now={economy.now} disabled={disabled} onClaim={workId => send("claim_boat_upgrade", workId)} />}
      </div>
      </>}
    </Dialog.Content>
  </Dialog.Root>;
}

function BoatDockDeparture({ economy, disabled, send }: { economy: ReadyEconomy; disabled: boolean; send: BoatSend }) {
  const state = economy.snapshot, boat = boatState(state), config = boatConfig(state.catalog);
  const travelSeconds = boat.upgrades.includes("oars") ? config.oarsTravelSeconds : config.outboundSeconds;
  const catches = config.maxCasts + (boat.upgrades.includes("crate") ? 1 : 0), departureReason = boatDepartureReason(state, economy.now);
  return <section className={styles.departure} aria-label="Подготовка к выходу">
    <div className={styles.departureRow}><div><span className={styles.eyebrow}>{config.name}</span><div className={styles.departureStats}><span><Clock3 size={14} />{worldDuration(travelSeconds)} в одну сторону</span><span><Fish size={14} />{catches} {catches < 5 ? "заброса" : "забросов"}</span></div></div>
      <button type="button" className={styles.primary} disabled={disabled || Boolean(departureReason)} onClick={() => send("depart_boat", config.routeId)}><Sailboat size={17} />Отправиться на рыбалку<ArrowRight size={15} /></button></div>
    {departureReason && <p className={styles.note}>{departureReason}</p>}
    <details className={styles.gear}><summary><FishingRod size={16} />Снасти перед выходом</summary><WorldTacklePicker state={state} economy={economy} disabled={disabled} onChoose={(kind, itemId) => send(kind === "rod" ? "equip_fishing_rod" : kind === "hook" ? "equip_fishing_hook" : "equip_fishing_bait", itemId)} /><p className={styles.note}>{fishingState(state).equippedBaitId ? "Одна порция наживки на весь выход." : "Можно отправиться без наживки."}</p></details>
    <p className={styles.note}>На месте лодка ждёт {worldDuration(config.activeSeconds)}, затем возвращается домой.</p>
  </section>;
}
