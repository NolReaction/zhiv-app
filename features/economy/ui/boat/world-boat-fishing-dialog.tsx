"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Anchor, BookOpen, Coins, Sailboat, Trophy, X } from "lucide-react";
import { boatConfig, boatPhase, boatState } from "@/features/economy/domain/boat-fishing";
import type { BoatCommandInput } from "@/features/economy/sync/session";
import type { BoatUpgradeId } from "@/features/economy/domain/boat-model";
import type { EconomyCommand } from "@/features/economy/domain/model";
import { BoatDockDeparture } from "./boat-dock-departure";
import { BoatWorkshopDevButton } from "@/features/economy/dev/boat-dev-controls";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { number } from "@/features/economy/ui/shared/world-economy-parts";
import { BoatWork } from "./boat-panels";
import { BoatRecords } from "./boat-records";
import { BoatFishingAlbum } from "./boat-fishing-album";
import { boatAccess } from "./boat-access";
import { BoatRecoveryDialog } from "./boat-recovery-dialog";
import { BoatGarage } from "./boat-garage";
import { BoatDeliveryNotice } from "./boat-trip-summary";
import { createBoatTripReceipt, type BoatTripReceipt } from "./boat-trip-summary-data";
import { BoatVoyagePanel } from "./boat-voyage-panel";
import { BoatFishingMap } from "./boat-fishing-map";
import { BoatRiverArrival } from "./boat-river-arrival";
import arrivalStyles from "./boat-river-arrival.module.css";
import mapStyles from "./boat-fishing-map.module.css";
import styles from "./boat-fishing.module.css";

const tabs = [{ id: "boat", label: "Лодка", icon: Sailboat }, { id: "records", label: "Рекорды", icon: Trophy }, { id: "album", label: "Альбом", icon: BookOpen }] as const;
type Tab = typeof tabs[number]["id"];
type Props = { sharedRecordsAvailable?: boolean; economy: ReadyEconomy; onClose: () => void; onOpenPantry?: () => void; suspended?: boolean; timeZone?: string; appearance?: { palette: string; head: string | null; neck: string | null } };
export type BoatSend = (action: EconomyCommand["action"], targetId: string, input?: BoatCommandInput, saleQuote?: number) => boolean;

export function WorldBoatFishingDialog(props: Props) {
  if (boatAccess(props.economy.snapshot) === "recover") return <BoatRecoveryDialog {...props} />;
  return <PlayableBoatFishingDialog key={props.economy.snapshot.ownerPublicId} {...props} />;
}

export function PlayableBoatFishingDialog(props: Props) {
  const [seenDeparture, setSeenDeparture] = useState(props.economy.localBoatDepartureId);
  if (!props.economy.snapshot.catalog.boat?.moduleEffects) return <BoatUnavailableDialog economy={props.economy} onClose={props.onClose} />;
  const phase = boatPhase(boatState(props.economy.snapshot), props.economy.now);
  const view = phase === "fishing" ? "river" : phase === "outbound" || phase === "returning" ? "travelling" : "dock";
  const voyage = props.economy.snapshot.boat?.voyage;
  const arrival = view === "river" && voyage && voyage.castsUsed === 0 && !voyage.challenge
    && props.economy.localBoatDepartureId === voyage.id && seenDeparture !== voyage.id ? voyage.id : undefined;
  return <BoatDialogSession key={`${props.economy.snapshot.ownerPublicId}.${view}`} {...props} arrival={arrival} finishArrival={setSeenDeparture} />;
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

function BoatDialogSession({ sharedRecordsAvailable, economy, onClose, onOpenPantry, appearance, suspended = false, timeZone = "UTC", arrival, finishArrival }: Props & { arrival?: string; finishArrival: (id: string) => void }) {
  const state = economy.snapshot, boat = boatState(state), config = boatConfig(state.catalog), phase = boatPhase(boat, economy.now);
  const [tab, setTab] = useState<Tab>("boat");
  const [claimedTrip, setClaimedTrip] = useState<{ receipt: BoatTripReceipt; completedBefore: number; revisionBefore: number } | null>(null);
  const settlement = economy.localBoatSettlement;
  const deliveredTrip = claimedTrip && !boat.voyage && !economy.busy && !economy.uncertain && economy.snapshotConfirmed !== false
    && settlement?.voyageId === claimedTrip.receipt.voyageId && settlement.revision === claimedTrip.revisionBefore + 1
    && settlement.saleCoins === claimedTrip.receipt.saleCoins && boat.completedVoyages === claimedTrip.completedBefore + 1 ? claimedTrip.receipt : null;
  const sent = useRef(false), content = useRef<HTMLDivElement>(null), id = useId();
  const disabled = locked(economy) || economy.snapshotConfirmed === false;
  const challenge = boat.voyage?.challenge;
  const unloading = phase === "ready";
  const onRiver = phase === "fishing" && Boolean(boat.voyage);
  const localDeparture = onRiver && economy.localBoatDepartureId === boat.voyage?.id;
  const [leaving, setLeaving] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (closeTimer.current !== null) clearTimeout(closeTimer.current); }, []);
  const requestClose = () => {
    if (closeTimer.current !== null) return;
    if (!onRiver || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { onClose(); return; }
    setLeaving(true);
    closeTimer.current = setTimeout(onClose, 260);
  };
  useEffect(() => { if (!economy.busy && !economy.uncertain) sent.current = false; }, [economy.busy, economy.uncertain, economy.error, state.revision, state.ownerPublicId]);
  useEffect(() => { if (challenge?.id) content.current?.scrollTo({ top: 0 }); }, [challenge?.id]);
  useEffect(() => {
    if (!deliveredTrip) return;
    content.current?.scrollTo({ top: 0 });
    if (document.activeElement === document.body) content.current?.focus({ preventScroll: true });
  }, [deliveredTrip]);
  const send: BoatSend = (action, targetId, input, saleQuote = 0) => {
    const localLanding = action === "submit_boat_cast" && input && "deferred" in input && input.deferred === true;
    if ((!localLanding && disabled) || sent.current) return false;
    sent.current = true;
    const receipt = (action === "claim_boat" || action === "sell_boat_catch") && boat.voyage?.id === targetId
      ? { receipt: createBoatTripReceipt(state, boat.voyage, action === "sell_boat_catch" ? saleQuote : undefined), completedBefore: boat.completedVoyages, revisionBefore: state.revision } : null;
    let accepted;
    try { accepted = economy.act(action, targetId, 1, action === "buy_boat_fuel" ? config.fuel.refillPricePearls : saleQuote, undefined, undefined, input); }
    catch (error) { sent.current = false; throw error; }
    if (accepted !== false && receipt) setClaimedTrip(receipt);
    if (accepted === false) sent.current = false;
    return accepted !== false;
  };
  const upgrade = (upgradeId: BoatUpgradeId) => { send("start_boat_upgrade", upgradeId); };
  const phaseName = { broken: "Нужен ремонт корпуса", repairing: "Работа в мастерской", docked: "У причала · готовимся к выходу", outbound: "Курс на речной плёс", fishing: "На рыбалке", returning: "Возвращение к причалу", ready: "Лодка вернулась" }[phase];
  return <Dialog.Root open onOpenChange={open => { if (!open) requestClose(); }}>
    <Dialog.Overlay className={styles.overlay} onPointerDown={event => event.stopPropagation()} />
    <Dialog.Content className={`${styles.dialog} ${onRiver ? mapStyles.viewport : ""} ${localDeparture ? arrivalStyles.departureViewport : ""}`} aria-describedby={`${id}-description`} data-boat-dialog data-boat-phase={phase} data-boat-map-view={onRiver || undefined} data-leaving={leaving || undefined} data-arriving={arrival ? true : undefined}
      onPointerDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
      onPointerDownOutside={event => event.preventDefault()} onEscapeKeyDown={event => { event.stopPropagation(); event.preventDefault(); if (arrival) finishArrival(arrival); else requestClose(); }}>
      {onRiver && boat.voyage ? <>
        <Dialog.Title className={styles.srOnly}>Лодочная рыбалка</Dialog.Title>
        <Dialog.Description id={`${id}-description`} className={styles.srOnly}>Мохлик в лодке на речном плёсе. Зажмите воду или пробел и отпустите, когда метка попадёт в зелёную зону. Когда поплавок нырнёт, коснитесь воды или нажмите пробел для подсечки.</Dialog.Description>
        <div className={arrivalStyles.stage} data-river-stage inert={arrival ? true : undefined}>
          <BoatFishingMap key={`${state.ownerPublicId}.${boat.voyage.id}`} economy={economy} disabled={disabled || Boolean(arrival)} send={send} onClose={requestClose} appearance={appearance} suspended={suspended || leaving || Boolean(arrival)} timeZone={timeZone} />
        </div>
        {arrival && <BoatRiverArrival voyageId={arrival} suspended={suspended} onFinish={finishArrival} />}
      </> : <>
      <header className={styles.header}><Anchor size={25} strokeWidth={1.6} /><div><small>{phaseName}</small><Dialog.Title>{unloading ? "Итоги рыбалки" : boat.voyage ? "Лодочная рыбалка" : "Лодочная мастерская"}</Dialog.Title></div><span className={styles.wallet} aria-label={`${number(state.wallet.coins)} монет`}><Coins size={17} /><strong>{number(state.wallet.coins)}</strong></span><BoatWorkshopDevButton economy={economy} /><button type="button" className={styles.close} onClick={onClose} aria-label="Закрыть лодку"><X size={22} /></button></header>
      <Dialog.Description id={`${id}-description`} className={styles.srOnly}>Лодочная рыбалка, ремонт, улучшения и личные рекорды.</Dialog.Description>
      {!unloading && <nav className={styles.tabs} role="tablist" aria-label="Разделы лодки">{tabs.map((entry, index) => <button key={entry.id} id={`${id}-${entry.id}`} type="button" role="tab" className={styles.tab} aria-selected={tab === entry.id} aria-controls={`${id}-panel`} tabIndex={tab === entry.id ? 0 : -1} onClick={() => setTab(entry.id)} onKeyDown={event => {
        const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
        if (next !== null) { event.preventDefault(); setTab(tabs[next].id); event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=tab]")[next]?.focus(); }
      }}><entry.icon size={17} />{entry.label}</button>)}</nav>}
      {economy.error && <p className={styles.error} role="alert">{economy.error}</p>}
      {economy.uncertain && <div className={styles.recovery}><span>Проверим, сохранилось ли последнее действие.</span><button type="button" className={styles.secondary} disabled={economy.busy} onClick={() => economy.retry()}>Проверить</button></div>}
      <div ref={content} className={styles.body} id={`${id}-panel`} role={unloading ? "region" : "tabpanel"} tabIndex={0}
        aria-label={unloading ? "Улов выхода" : undefined} aria-labelledby={unloading ? undefined : `${id}-${tab}`}>
        {unloading ? <BoatVoyagePanel economy={economy} disabled={disabled} send={send} onOpenPantry={onOpenPantry} />
          : tab === "album" ? <BoatFishingAlbum state={state} /> : tab === "records" ? <BoatRecords state={state} boat={boat} sharedRecordsAvailable={sharedRecordsAvailable} />
          : boat.voyage ? <BoatVoyagePanel economy={economy} disabled={disabled} send={send} /> : <>
            {deliveredTrip && <BoatDeliveryNotice receipt={deliveredTrip} />}
            <BoatGarage receipt={economy.localBoatUpgrade} state={state} boat={boat} config={config} now={economy.now} disabled={disabled} onUpgrade={upgrade} onClaim={workId => send("claim_boat_upgrade", workId)}>
              {boat.level > 0 && <BoatDockDeparture economy={economy} disabled={disabled} send={send} />}
            </BoatGarage>
          </>}
        {!unloading && tab !== "boat" && <BoatWork boat={boat} config={config} now={economy.now} disabled={disabled} onClaim={workId => send("claim_boat_upgrade", workId)} />}
      </div>
      </>}
    </Dialog.Content>
  </Dialog.Root>;
}
