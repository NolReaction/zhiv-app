"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Check, CloudUpload, LockKeyhole, Plus } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import { productionSlotCount, productionSlotOffer, productionStationSupported } from "@/features/economy/domain/production-slots";
import { productionCollectionRewards, readyProductionJobs } from "@/features/economy/domain/production-collection";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { formatPearls } from "@/features/economy/domain/money";
import { ProductIcon, itemName, Work } from "@/features/economy/ui/shared/world-economy-parts";
import { worldJobProgress } from "@/features/economy/ui/shared/world-stations";
import styles from "./world-production-slots.module.css";

type SlotConfirmation = { stationId: string; owner: string; slot: number; pricePearls: number };

/** Active places, including the basic campfire, retain finished orders until the ordinary claim. */
export function WorldProductionSlots({ economy, stationId, compact = false, openPantry }: { economy: ReadyEconomy; stationId: string; compact?: boolean; openPantry?: () => void }) {
  const dialogId = useId();
  const [confirmation, setConfirmation] = useState<SlotConfirmation | null>(null);
  const cancelButton = useRef<HTMLButtonElement>(null);
  const slotsSection = useRef<HTMLElement>(null);
  const purchaseTrigger = useRef<HTMLButtonElement | null>(null);
  const wasConfirming = useRef(false);
  const purchasePending = useRef<{ owner: string; revision: number } | null>(null);
  const claimPending = useRef<{ owner: string; revision: number } | null>(null);
  const [claimFeedback, setClaimFeedback] = useState<string | null>(null);
  const state = economy.productionSnapshot ?? economy.snapshot;
  const capacity = productionSlotCount(state, stationId), offer = productionSlotOffer(state, stationId);
  const jobs = state.jobs.filter(job => job.kind === "production" && job.targetId === stationId);
  const visibleSlotCount = Math.max(capacity, Math.min(3, jobs.length), ...state.catalog.productionSlots.upgrades
    .filter(tier => tier.requiredHomeLevel <= (state.buildings.home ?? 1)).map(tier => tier.slots));
  const futureTier = state.catalog.productionSlots.upgrades.find(tier => tier.slots > visibleSlotCount);
  const readyJobs = readyProductionJobs(economy.snapshot.jobs, stationId, economy.now);
  const claimQuantity = Object.values(productionCollectionRewards(readyJobs)).reduce((sum, quantity) => sum + quantity, 0);
  const claimShortfall = Math.max(0, claimQuantity - economy.snapshot.storage.available);
  const construction = state.jobs.some(job => job.kind === "construction" && job.targetId === stationId);
  const basicCampfire = stationId === "dryer" && !(state.buildings[stationId] > 0);
  const unavailable = construction || !basicCampfire && !(state.buildings[stationId] > 0);
  const currentConfirmation = !basicCampfire && confirmation?.stationId === stationId && confirmation.owner === state.ownerPublicId && confirmation.slot === capacity + 1 ? confirmation : null;
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
  useEffect(() => {
    const pending = claimPending.current;
    if (pending && (pending.owner !== state.ownerPublicId || pending.revision !== state.revision || economy.error)) claimPending.current = null;
  }, [state.ownerPublicId, state.revision, economy.error]);
  if (!productionStationSupported(stationId) || unavailable) return null;
  function cancelPurchase() {
    setConfirmation(null);
    (purchaseTrigger.current?.isConnected ? purchaseTrigger.current : slotsSection.current)?.focus({ preventScroll: true });
  }
  const free = Math.max(0, capacity - jobs.length);
  return <section ref={slotsSection} tabIndex={-1} className={`${styles.slots} ${compact ? styles.compact : ""}`} aria-label="Места производства" data-production-slots={stationId}
    data-section-guide-target="workshop-queue" data-running-orders={jobs.some(job => !economy.pendingProductionIds?.includes(job.id) && !worldJobProgress(state, job, economy.now).ready) ? stationId : undefined}>
    <header className={styles.heading}><h3>Производство</h3><span aria-live="polite" aria-atomic="true">Свободно {free} из {capacity}</span></header>
    {readyJobs.length > 1 && <div className={styles.collectAll}>
      <button type="button" data-collect-production={stationId} disabled={locked(economy) || claimShortfall > 0} onClick={() => {
        if (locked(economy) || claimPending.current || economy.snapshot.ownerPublicId !== state.ownerPublicId || economy.snapshot.revision !== state.revision) return;
        const current = readyProductionJobs(economy.snapshot.jobs, stationId, economy.now);
        const quantity = Object.values(productionCollectionRewards(current)).reduce((sum, amount) => sum + amount, 0);
        if (current.length < 2 || quantity > economy.snapshot.storage.available) return;
        claimPending.current = { owner: state.ownerPublicId, revision: state.revision };
        const accepted = economy.act("claim_production", stationId);
        if (accepted === false) claimPending.current = null;
        setClaimFeedback(accepted === false ? "Сбор не отправлен. Попробуйте ещё раз." : null);
      }}><Check size={15} aria-hidden="true" />Собрать всё ({readyJobs.length})</button>
      {claimShortfall > 0 && <p role="status">Освободите {claimShortfall.toLocaleString("ru-RU")} мест в кладовой.{openPantry && <button type="button" onClick={openPantry}>Открыть кладовую</button>}</p>}
      {claimFeedback && <p role="status">{claimFeedback}</p>}
    </div>}
    <div className={styles.track} data-slot-columns={basicCampfire ? capacity : visibleSlotCount}>{Array.from({ length: basicCampfire ? capacity : visibleSlotCount }, (_, index) => {
      const job = jobs[index], opened = index < capacity;
      const queued = Boolean(job && economy.pendingProductionIds?.includes(job.id));
      const tier = state.catalog.productionSlots.upgrades.find(entry => entry.slots === index + 1);
      const nextLocked = !opened && index === capacity;
      const slotState = queued ? "pending" : job ? worldJobProgress(state, job, economy.now).ready ? "ready" : "working" : !opened ? "locked" : "free";
      return job ? <div key={index} className={`${styles.slot} ${styles.job}`} data-production-slot={index + 1} data-state={slotState}>
        <span className={styles.slotNumber}>Место {index + 1}</span>{queued ? <div className={styles.pending} role="status" data-production-pending={job.id}><ProductIcon state={state} itemId={Object.keys(job.rewards)[0]} size={28} /><strong title={itemName(state, Object.keys(job.rewards)[0])}>{itemName(state, Object.keys(job.rewards)[0])}</strong><span><CloudUpload size={12} aria-hidden="true" /> Сохранено</span></div> : <Work economy={economy} job={job} openPantry={openPantry} compact />}
      </div> : opened ? <div key={index} className={styles.slot} data-production-slot={index + 1} data-state={slotState}>
        <span className={styles.slotNumber}>Место {index + 1}</span><Plus size={25} aria-hidden="true" /><strong>{unavailable ? "Недоступно" : "Свободно"}</strong><span>{unavailable ? construction ? "Идёт улучшение" : "Нужно обустроить" : "Выберите рецепт"}</span>
      </div> : <button key={index} type="button" className={`${styles.slot} ${styles.closed}`} data-production-slot={index + 1} data-state="locked"
        disabled={!nextLocked} aria-label={nextLocked ? `Открыть место ${index + 1} за ${formatPearls(tier?.pricePearls ?? 0)} жемчужин` : `Место ${index + 1}: закрыто`}
        aria-haspopup={nextLocked ? "dialog" : undefined} aria-expanded={nextLocked ? currentConfirmation?.slot === index + 1 : undefined} aria-controls={confirming && currentConfirmation?.slot === index + 1 ? dialogId : undefined}
        onClick={event => { if (index !== productionSlotCount(economy.snapshot, stationId)) return; purchaseTrigger.current = event.currentTarget; setConfirmation({ stationId, owner: state.ownerPublicId, slot: index + 1, pricePearls: tier?.pricePearls ?? 0 }); }}>
        <span className={styles.slotNumber}>Место {index + 1}</span><span className={styles.lock}><LockKeyhole size={24} aria-hidden="true" /></span><strong>{nextLocked ? "Открыть" : "Закрыто"}</strong>{nextLocked && <span className={styles.price}>{formatPearls(tier?.pricePearls ?? 0)}<ItemIcon itemId="pearls" size={16} /></span>}
      </button>;
    })}</div>
    {!basicCampfire && futureTier && <p className={styles.hint}>Место {futureTier.slots} появится с домом {futureTier.requiredHomeLevel} уровня.</p>}
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
          void economy.act("buy_production_slot", stationId, 1, currentConfirmation.pricePearls);
        }}>Купить за {formatPearls(currentConfirmation.pricePearls)}<ItemIcon itemId="pearls" size={16} /></button>
      </div>
    </div>}
    {jobs.length > 3 && <div className={styles.legacy} aria-label="Ранее запущенные заказы"><h4>Ранее запущенные заказы</h4>{jobs.slice(3).map(job => <Work key={job.id} economy={economy} job={job} openPantry={openPantry} compact />)}</div>}
  </section>;
}
