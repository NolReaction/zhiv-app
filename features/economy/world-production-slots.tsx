"use client";

import { useId } from "react";
import { Check, Clock3, LockKeyhole, Plus } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { productionSlotCount, productionSlotOffer, productionStationSupported } from "./production-slots";
import { locked, number, type ReadyEconomy } from "./world-economy-parts";
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
        : offer && state.wallet.pearls < offer.pricePearls ? `Не хватает жемчужин: ${number(offer.pricePearls - state.wallet.pearls)}` : null;
  return <section className={styles.slots} aria-label="Места производства" data-production-slots={stationId}>
    <div className={styles.heading}><strong>Одновременно</strong><span aria-live="polite">{jobs.length} / {capacity}</span></div>
    <div className={styles.track}>
      {Array.from({ length: 3 }, (_, index) => {
        const job = jobs[index], opened = index < capacity, ready = job && Date.parse(job.finishesAt) <= economy.now;
        const unavailable = construction || !(state.buildings[stationId] > 0);
        return <span key={index} className={styles.slot} data-state={!opened ? "locked" : !job ? "free" : ready ? "ready" : "working"}>
          {!opened ? <LockKeyhole size={13} aria-hidden="true" /> : !job ? <Plus size={13} aria-hidden="true" /> : ready ? <Check size={13} aria-hidden="true" /> : <Clock3 size={13} aria-hidden="true" />}
          <span>{!opened ? "Закрыто" : !job ? unavailable ? "Недоступно" : "Свободно" : ready ? "К сбору" : "В работе"}</span>
        </span>;
      })}
    </div>
    {offer && <>
      <button type="button" className={styles.buy} disabled={Boolean(reason) || locked(economy)} aria-describedby={reason ? hintId : undefined}
        aria-label={`Открыть место ${offer.slots} за ${number(offer.pricePearls)} жемчужин`}
        onClick={() => { if (!reason && !locked(economy)) void economy.act("buy_production_slot", stationId); }}>
        <span><Plus size={14} aria-hidden="true" />Место {offer.slots}</span><strong>{number(offer.pricePearls)}<ItemIcon itemId="pearls" size={17} /></strong>
      </button>
      {reason && <p id={hintId} className={styles.hint}>{reason}</p>}
    </>}
  </section>;
}
