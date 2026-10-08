"use client";

import { useId } from "react";
import { Check, ChevronDown, Clock3, LockKeyhole, Plus } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { productionSlotCount, productionSlotOffer, productionStationSupported } from "@/features/economy/domain/production-slots";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { formatPearls } from "@/features/economy/domain/money";
import styles from "./world-production-slots.module.css";

/** Slots are permanent station capacity; a finished, unclaimed order still uses one. */
export function WorldProductionSlots({ economy, stationId }: { economy: ReadyEconomy; stationId: string }) {
  const hintId = useId();
  const state = economy.snapshot;
  if (!productionStationSupported(stationId)) return null;
  const capacity = productionSlotCount(state, stationId), offer = productionSlotOffer(state, stationId);
  const jobs = state.jobs.filter(job => job.kind === "production" && job.targetId === stationId);
  const construction = state.jobs.some(job => job.kind === "construction" && job.targetId === stationId);
  const reason = !(state.buildings[stationId] > 0) ? "Сначала обустройте это место"
    : construction ? "Дождитесь завершения улучшения"
      : offer && (state.buildings.home ?? 1) < offer.requiredHomeLevel ? `Нужен дом ${offer.requiredHomeLevel} уровня`
        : offer && state.wallet.pearls < offer.pricePearls ? `Не хватает жемчужин: ${formatPearls(offer.pricePearls - state.wallet.pearls)}` : null;
  const slots = Array.from({ length: 3 }, (_, index) => {
    const job = jobs[index], opened = index < capacity, ready = job && Date.parse(job.finishesAt) <= economy.now;
    const unavailable = construction || !(state.buildings[stationId] > 0);
    return { state: !opened ? "locked" : !job ? "free" : ready ? "ready" : "working",
      label: !opened ? "Закрыто" : !job ? unavailable ? "Недоступно" : "Свободно" : ready ? "К сбору" : "В работе",
      Icon: !opened ? LockKeyhole : !job ? Plus : ready ? Check : Clock3 };
  });
  return <details key={stationId} className={styles.slots} aria-label="Места производства" data-production-slots={stationId}>
    <summary className={styles.summary} aria-label={`Места производства: занято ${jobs.length} из ${capacity}. ${offer ? "Расширить" : "Подробнее"}`}>
      <strong>Места <span aria-live="polite" aria-atomic="true">{jobs.length} / {capacity}</span></strong>
      <span className={styles.markers} aria-hidden="true">{slots.map(({ state: slotState, label, Icon }, index) => <span key={index} className={styles.marker} data-state={slotState} title={`Место ${index + 1}: ${label}`}><Icon size={12} /></span>)}</span>
      <span className={styles.action}>{offer ? "Расширить" : "Подробнее"}<ChevronDown size={13} aria-hidden="true" /></span>
    </summary>
    <div className={styles.content}>
    <div className={styles.track}>{slots.map(({ state: slotState, label, Icon }, index) => <span key={index} className={styles.slot} data-state={slotState}><Icon size={13} aria-hidden="true" /><span>{label}</span></span>)}</div>
    {offer && <>
      <button type="button" className={styles.buy} disabled={Boolean(reason) || locked(economy)} aria-describedby={reason ? hintId : undefined}
        aria-label={`Открыть место ${offer.slots} за ${formatPearls(offer.pricePearls)} жемчужин`}
        onClick={() => { if (!reason && !locked(economy)) void economy.act("buy_production_slot", stationId); }}>
        <span><Plus size={14} aria-hidden="true" />Место {offer.slots}</span><strong>{formatPearls(offer.pricePearls)}<ItemIcon itemId="pearls" size={17} /></strong>
      </button>
      {reason && <p id={hintId} className={styles.hint}>{reason}</p>}
    </>}
    </div>
  </details>;
}
