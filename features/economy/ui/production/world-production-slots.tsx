"use client";

import { useEffect, useId, useRef, useState } from "react";
import { LockKeyhole, Plus } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { productionSlotCount, productionSlotOffer, productionStationSupported } from "@/features/economy/domain/production-slots";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { formatPearls } from "@/features/economy/domain/money";
import { Work } from "@/features/economy/ui/shared/world-economy-parts";
import { worldJobProgress } from "@/features/economy/ui/shared/world-stations";
import styles from "./world-production-slots.module.css";

type SlotConfirmation = { stationId: string; owner: string; slot: number; pricePearls: number };

/** Slots stay visible; finished orders keep their place until the ordinary claim. */
export function WorldProductionSlots({ economy, stationId, compact = false, openPantry }: { economy: ReadyEconomy; stationId: string; compact?: boolean; openPantry?: () => void }) {
  const dialogId = useId();
  const [confirmation, setConfirmation] = useState<SlotConfirmation | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const slotsSection = useRef<HTMLElement>(null);
  const purchaseTrigger = useRef<HTMLButtonElement | null>(null);
  const wasConfirming = useRef(false);
  const purchasePending = useRef<{ owner: string; revision: number } | null>(null);
  const state = economy.snapshot;
  const capacity = productionSlotCount(state, stationId), offer = productionSlotOffer(state, stationId);
  const jobs = state.jobs.filter(job => job.kind === "production" && job.targetId === stationId);
  const construction = state.jobs.some(job => job.kind === "construction" && job.targetId === stationId);
  const unavailable = construction || !(state.buildings[stationId] > 0);
  const currentConfirmation = confirmation?.stationId === stationId && confirmation.owner === state.ownerPublicId && confirmation.slot > capacity ? confirmation : null;
  const selectedOffer = state.catalog.productionSlots.upgrades.find(entry => entry.slots === currentConfirmation?.slot);
  const reason = !(state.buildings[stationId] > 0) ? "Сначала обустройте это место"
    : construction ? "Дождитесь завершения улучшения"
      : economy.error ? "Проверьте результат последнего действия перед покупкой"
        : currentConfirmation && offer?.slots !== currentConfirmation.slot ? `Сначала откройте место ${capacity + 1}`
          : currentConfirmation && (selectedOffer?.pricePearls !== currentConfirmation.pricePearls || offer?.pricePearls !== currentConfirmation.pricePearls) ? "Цена изменилась. Откройте место снова, чтобы подтвердить новую цену"
          : offer && (state.buildings.home ?? 1) < offer.requiredHomeLevel ? `Нужен дом ${offer.requiredHomeLevel} уровня`
            : offer && state.wallet.pearls < offer.pricePearls ? `Не хватает жемчужин: ${formatPearls(offer.pricePearls - state.wallet.pearls)}`
              : locked(economy) ? "Дождитесь подтверждения последнего действия" : null;
  const confirming = Boolean(currentConfirmation && selectedOffer);
  useEffect(() => {
    if (confirming) cancelButton.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) (purchaseTrigger.current?.isConnected ? purchaseTrigger.current : slotsSection.current)?.focus({ preventScroll: true });
    wasConfirming.current = confirming;
  }, [confirming, currentConfirmation?.slot]);
  useEffect(() => {
    const pending = purchasePending.current;
    if (pending && (pending.owner !== state.ownerPublicId || pending.revision !== state.revision || economy.error)) purchasePending.current = null;
  }, [state.ownerPublicId, state.revision, economy.error]);
  if (!productionStationSupported(stationId)) return null;
  function cancelPurchase() {
    setConfirmation(null);
    (purchaseTrigger.current?.isConnected ? purchaseTrigger.current : slotsSection.current)?.focus({ preventScroll: true });
  }
  const free = Math.max(0, capacity - jobs.length);
  return <section ref={slotsSection} tabIndex={-1} className={`${styles.slots} ${compact ? styles.compact : ""}`} aria-label="Места производства" data-production-slots={stationId}
    data-section-guide-target="workshop-queue" data-running-orders={jobs.some(job => !worldJobProgress(state, job, economy.now).ready) ? stationId : undefined}>
    <header className={styles.heading}><h3>Производство</h3><span aria-live="polite" aria-atomic="true">Свободно {free} из {capacity}</span></header>
    <div className={styles.track}>{Array.from({ length: 3 }, (_, index) => {
      const job = jobs[index], opened = index < capacity;
      const tier = state.catalog.productionSlots.upgrades.find(entry => entry.slots === index + 1);
      const slotState = job ? worldJobProgress(state, job, economy.now).ready ? "ready" : "working" : !opened ? "locked" : "free";
      return job ? <div key={index} className={`${styles.slot} ${styles.job}`} data-production-slot={index + 1} data-state={slotState}>
        <span className={styles.slotNumber}>Место {index + 1}</span><Work economy={economy} job={job} openPantry={openPantry} compact />
      </div> : opened ? <div key={index} className={styles.slot} data-production-slot={index + 1} data-state={slotState}>
        <span className={styles.slotNumber}>Место {index + 1}</span><Plus size={25} aria-hidden="true" /><strong>{unavailable ? "Недоступно" : "Свободно"}</strong><span>{unavailable ? construction ? "Идёт улучшение" : "Нужно обустроить" : "Выберите рецепт"}</span>
      </div> : <button key={index} type="button" className={`${styles.slot} ${styles.closed}`} data-production-slot={index + 1} data-state="locked"
        aria-label={`Открыть место ${index + 1} за ${formatPearls(tier?.pricePearls ?? 0)} жемчужин`}
        aria-haspopup="dialog" aria-expanded={currentConfirmation?.slot === index + 1} aria-controls={confirming && currentConfirmation?.slot === index + 1 ? dialogId : undefined}
        onClick={event => { purchaseTrigger.current = event.currentTarget; setConfirmation({ stationId, owner: state.ownerPublicId, slot: index + 1, pricePearls: tier?.pricePearls ?? 0 }); }}>
        <span className={styles.slotNumber}>Место {index + 1}</span><span className={styles.lock}><LockKeyhole size={24} aria-hidden="true" /></span><strong>Открыть</strong><span className={styles.price}>{formatPearls(tier?.pricePearls ?? 0)}<ItemIcon itemId="pearls" size={16} /></span>
      </button>;
    })}</div>
    {reason && !confirming && <p className={styles.hint}>{reason}</p>}
    {confirming && currentConfirmation && selectedOffer && <div className={styles.confirmation} role="dialog" id={dialogId} aria-labelledby={`${dialogId}-title`} aria-describedby={`${dialogId}-description`}
      onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelPurchase(); } }}>
      <h4 id={`${dialogId}-title`}>Открыть место {currentConfirmation.slot}?</h4>
      <p id={`${dialogId}-description`}>За {formatPearls(currentConfirmation.pricePearls)} жемчужин вы навсегда получите ещё одно место только на этом производстве.</p>
      {reason && <p className={styles.hint} role="status">{reason}</p>}
      <div className={styles.confirmActions}><button ref={cancelButton} type="button" className={styles.cancel} onClick={cancelPurchase}>Отмена</button>
        <button type="button" className={styles.buy} disabled={Boolean(reason) || locked(economy) || selectedOffer.slots !== offer?.slots} onClick={() => {
          if (reason || locked(economy) || economy.error || selectedOffer.slots !== offer?.slots || selectedOffer.pricePearls !== currentConfirmation.pricePearls || offer?.pricePearls !== currentConfirmation.pricePearls || purchasePending.current) return;
          purchasePending.current = { owner: state.ownerPublicId, revision: state.revision };
          setConfirmation(null);
          void economy.act("buy_production_slot", stationId);
        }}>Купить за {formatPearls(currentConfirmation.pricePearls)}<ItemIcon itemId="pearls" size={16} /></button>
      </div>
    </div>}
    {jobs.length > 3 && <div className={styles.legacy} aria-label="Ранее запущенные заказы"><h4>Ранее запущенные заказы</h4>{jobs.slice(3).map(job => <Work key={job.id} economy={economy} job={job} openPantry={openPantry} compact />)}</div>}
  </section>;
}
