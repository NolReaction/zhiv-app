"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Clock3, LockKeyhole, Plus } from "lucide-react";
import type { EconomyJob, EconomyView } from "@/features/economy/domain/model";
import { MINING_BATCH_LIMIT, miningBatchProgress } from "@/features/economy/domain/mining-batch";
import { economyMinerConflict, isMinerJob } from "@/features/economy/domain/actor-availability";
import { tradeWorkDuration } from "@/features/economy/domain/trade-relations";
import { locked } from "@/features/economy/sync/controller-state";
import type { WorldHelpContext } from "@/features/world/ui/help/world-help-types";
import { ProductIcon, itemName, number, stationName } from "@/features/economy/ui/shared/world-economy-parts";
import { worldCostShortfalls, worldMissingRequirements, worldRequirements } from "@/features/economy/ui/shared/world-stations";
import { useFishingCommand } from "@/features/economy/ui/fishing/use-fishing-command";
import { jobTapBoostPercent, TapBoostWorkBadge } from "@/features/economy/ui/production/tap-boost-work-badge";
import { ActiveExpedition, expeditionSector, miningProductionRoutes, WorldExpeditionsMenu, type WorldExpeditionsMenuProps } from "./world-expeditions-menu";
import { miningDurationLabel } from "./mining-resource-groups";
import slotStyles from "@/features/economy/ui/production/world-production-slots.module.css";
import cardStyles from "@/features/economy/ui/production/world-production-card.module.css";
import styles from "./world-mining-production.module.css";

type MiningProps = WorldExpeditionsMenuProps & { onHelpContextChange?: (context: WorldHelpContext) => void };
type Route = EconomyView["catalog"]["explorations"][number];

/** Mining retains exploration commands and its single worker; only the station presentation is shared. */
export function WorldMiningProduction(props: MiningProps) {
  const state = props.economy.snapshot;
  if (!state || state.catalog.version < 13) return <WorldExpeditionsMenu {...props} embeddedCaves />;
  return <MiningProduction key={state.ownerPublicId} {...props} state={state} />;
}

function MiningProduction({ economy, state, initialRouteId, onOpenPantry, onOpenHelp, onHelpContextChange, onCancellationComplete, isOnline }: MiningProps & { state: EconomyView }) {
  const section = useRef<HTMLDivElement>(null), cancellationSent = useRef<string | null>(null);
  const launchFocus = useRef<{ routeId: string; element: Element | null } | null>(null);
  const pendingStart = useRef<{ owner: string; revision: number; error: string | null } | null>(null);
  const [confirmationKey, onConfirmation] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [feedback, setFeedback] = useState<{ text: string; owner: string; revision: number; jobId?: string; error: string | null } | null>(null);
  const noticeId = useId();
  const command = useFishingCommand({ economy, state });
  const jobs = state.jobs.filter(job => job.kind === "exploration" && (isMinerJob(job) || expeditionSector(job.targetId) === "caves"));
  const current = jobs.find(isMinerJob), previous = jobs.filter(job => job !== current);
  const routes = miningProductionRoutes(state);
  const notice = feedback?.owner === state.ownerPublicId && feedback.revision === state.revision && feedback.jobId === current?.id && feedback.error === (economy.error ?? null) ? feedback.text : null;
  const setNotice = (text: string) => setFeedback({ text, owner: state.ownerPublicId, revision: state.revision, jobId: current?.id, error: economy.error ?? null });
  useEffect(() => {
    const pending = pendingStart.current;
    if (pending && (pending.owner !== state.ownerPublicId || pending.revision !== state.revision || current || economy.error !== pending.error)) pendingStart.current = null;
  }, [state.ownerPublicId, state.revision, current, economy.error]);
  useEffect(() => {
    const pending = launchFocus.current;
    if (!pending || !current || current.targetId !== pending.routeId) return;
    const control = section.current?.querySelector<HTMLButtonElement>("[data-production-slot=\"1\"] button[data-production-control]");
    if (!control || control.disabled) return;
    launchFocus.current = null;
    if (pending.element?.isConnected && document.activeElement === pending.element) control.focus({ preventScroll: true });
  }, [current, economy.busy, economy.uncertain]);
  useEffect(() => {
    if (!initialRouteId || current?.targetId === initialRouteId) return;
    const button = Array.from(section.current?.querySelectorAll<HTMLButtonElement>("button[data-route]") ?? []).find(entry => entry.dataset.route === initialRouteId);
    button?.focus({ preventScroll: true }); button?.scrollIntoView({ block: "nearest" });
  }, [initialRouteId, current?.targetId]);
  useEffect(() => {
    if (!cancellationSent.current || state.jobs.some(job => job.id === cancellationSent.current)) return;
    cancellationSent.current = null;
    if (document.activeElement === document.body) {
      const target = section.current?.querySelector<HTMLButtonElement>("button[data-route]") ?? section.current;
      if (target) target.focus({ preventScroll: true }); else onCancellationComplete?.();
    }
  }, [state.jobs, onCancellationComplete]);
  function routeReason(route: Route) {
    const missing = worldMissingRequirements(state, worldRequirements(route));
    if (missing.length) return missing.map(({ id, level }) => `${stationName(state, id)} · ур. ${level}`).join(", ");
    if (state.jobs.some(job => job.kind === "construction" && job.targetId === "quarry")) return "Дождитесь улучшения шахты";
    const conflict = economyMinerConflict(state.jobs, economy.now);
    if (conflict) return conflict.message;
    if (Object.values(route.rewards).reduce((sum, amount) => sum + amount, 0) * quantity + Math.max(0, ...(route.finds?.entries.map(entry => entry.quantity) ?? [])) > state.storage.capacity) return "Уменьшите заказ: не хватает вместимости кладовой";
    if (worldCostShortfalls(state, { coins: route.cost.coins * quantity, items: Object.fromEntries(Object.entries(route.cost.items).map(([id, count]) => [id, count * quantity])) }).length) return "Не хватает припасов";
    if (isOnline === false || economy.directActionsAvailable === false) return "Нет соединения. Дождитесь восстановления";
    if (locked(economy)) return "Дождитесь подтверждения последнего действия";
    return null;
  }
  function start(route: Route) {
    onHelpContextChange?.({ intent: "expedition", routeId: route.id });
    if (economy.snapshot?.ownerPublicId !== state.ownerPublicId || economy.snapshot.revision !== state.revision) { setNotice("Данные обновились. Выберите добычу снова."); return; }
    if (pendingStart.current) { setNotice("Дождитесь подтверждения запуска."); return; }
    const reason = routeReason(route);
    if (reason) { setNotice(reason); return; }
    const accepted = command.send("start_exploration", route.id, quantity, 0);
    if (accepted) {
      pendingStart.current = { owner: state.ownerPublicId, revision: state.revision, error: economy.error ?? null };
      launchFocus.current = { routeId: route.id, element: typeof document === "undefined" ? null : document.activeElement };
    }
    setNotice(accepted ? "Запускаем добычу…" : "Действие не отправлено. Попробуйте ещё раз.");
  }
  return <div ref={section} className={styles.content} tabIndex={-1} data-mining-production>
    <section className={`${slotStyles.slots} ${slotStyles.compact}`} aria-label="Место добычи" data-production-slots="quarry" data-section-guide-target="workshop-queue">
      <header className={slotStyles.heading}><h3>Производство</h3><span aria-live="polite" aria-atomic="true">Свободно {current ? 0 : 1} из 1</span></header>
      <div className={slotStyles.track} data-slot-columns="1"><div className={`${slotStyles.slot} ${current ? slotStyles.job : ""} ${styles.slot}`} data-production-slot="1" data-state={current ? economy.now >= Date.parse(current.finishesAt) ? "ready" : "working" : "free"}>
        <span className={slotStyles.slotNumber}>Место 1</span>
        {current ? current.miningBatch ? <MiningBatchCard economy={economy} state={state} job={current} onOpenPantry={onOpenPantry} isOnline={isOnline} />
          : <ActiveExpedition economy={economy} state={state} job={current} onOpenPantry={onOpenPantry} onOpenHelp={onOpenHelp} isOnline={isOnline} compact confirmationKey={confirmationKey} onConfirmation={onConfirmation} onCancellationSent={jobId => { cancellationSent.current = jobId; }} />
          : <><Plus size={25} aria-hidden="true" /><strong>Свободно</strong><span>Выберите добычу</span></>}
      </div></div>
    </section>
    <section className={styles.catalog} aria-label="Добыча в шахте" data-section-guide-target="workshop-recipes"><h3>Что произвести?</h3>
      <div className={styles.batchOptions} role="group" aria-label="Количество добычи">
        <span>Заказать</span>{[1, 5, 10].map(count => <button type="button" key={count} aria-pressed={quantity === count} onClick={() => setQuantity(count)}>{count}</button>)}
        <label>Количество<input aria-label="Количество единиц добычи" type="number" inputMode="numeric" min={1} max={MINING_BATCH_LIMIT} value={quantity}
          onChange={event => setQuantity(Math.max(1, Math.min(MINING_BATCH_LIMIT, Math.floor(Number(event.target.value) || 1))))} /></label>
        <button type="button" onClick={() => setQuantity(Math.max(1, Math.min(MINING_BATCH_LIMIT, state.storage.capacity - 1)))}>Макс.</button>
      </div>
      <p className={styles.batchHint}>Шахтёр добывает по очереди, даже когда приложение закрыто. Готовую часть можно забрать сразу.</p>
      <div className={styles.grid}>{routes.map(route => {
        const reason = routeReason(route), duration = miningDurationLabel(tradeWorkDuration(state, route.seconds, "kamneshmyg", 0, state.catalog, economy.now) * quantity);
        const outputs = Object.entries(route.rewards), name = outputs.length === 1 ? itemName(state, outputs[0][0]) : route.name;
        const costs = [...(route.cost.coins > 0 ? [["coins", route.cost.coins] as const] : []), ...Object.entries(route.cost.items)];
        return <div key={route.id} className={cardStyles.entry}><button type="button" className={cardStyles.card} data-route={route.id} data-recipe-focused={initialRouteId === route.id || undefined} data-blocked={Boolean(reason) || undefined}
          aria-label={`Добыть: ${name}, ${duration}`} title={reason ?? undefined} aria-describedby={notice ? noticeId : undefined} onFocus={() => onHelpContextChange?.({ intent: "expedition", routeId: route.id })} onClick={() => start(route)}>
          <span className={cardStyles.header} data-production-mixed={quantity > 1 || outputs.length > 1 || undefined}><span className={cardStyles.outputs}>{outputs.map(([itemId, amount]) => <span key={itemId}><ProductIcon state={state} itemId={itemId} size={30} />{(amount * quantity !== 1 || outputs.length > 1) && <b>×{number(amount * quantity)}</b>}</span>)}</span><strong>{name}</strong></span>
          <span className={cardStyles.time}><Clock3 size={12} aria-hidden="true" />{duration}{reason && <LockKeyhole className={cardStyles.lock} size={12} aria-hidden="true" />}</span>
          <span className={cardStyles.details}>{reason && !current && <span className={cardStyles.accessReason}>{reason}</span>}{costs.length > 0 && <span className={cardStyles.costs} aria-label="Понадобится">{costs.map(([itemId, amount]) => <span key={itemId}><ProductIcon state={state} itemId={itemId} size={15} /><span>{itemId === "coins" ? "Монеты" : itemName(state, itemId)}</span><b>×{number(amount * quantity)}</b></span>)}</span>}</span>
        </button></div>;
      })}</div>
      {notice && <p id={noticeId} className={styles.notice} role="status" aria-live="polite">{notice}</p>}
      {!routes.length && <p className={styles.notice}>Добыча откроется после улучшения дома.</p>}
    </section>
    {previous.length > 0 && <section className={styles.legacy} aria-label="Ранее начатая добыча"><h3>Ранее начатая добыча</h3>{previous.map(job => <ActiveExpedition key={job.id} economy={economy} state={state} job={job} onOpenPantry={onOpenPantry} onOpenHelp={onOpenHelp} isOnline={isOnline} confirmationKey={confirmationKey} onConfirmation={onConfirmation} onCancellationSent={jobId => { cancellationSent.current = jobId; }} />)}</section>}
  </div>;
}

export function MiningBatchCard({ economy, state, job, onOpenPantry, isOnline }: Pick<MiningProps, "economy" | "onOpenPantry" | "isOnline"> & { state: EconomyView; job: EconomyJob }) {
  const progress = miningBatchProgress(job, economy.now), batch = job.miningBatch!;
  const boostPercent = jobTapBoostPercent(state, job.id, economy.now);
  const [confirming, setConfirming] = useState(false);
  const command = useFishingCommand({ economy, state });
  const blocked = locked(economy) || isOnline === false || economy.directActionsAvailable === false;
  const itemId = Object.keys(batch.unitRewards)[0], unitSize = Object.values(job.rewards).reduce((sum, count) => sum + count, 0);
  const full = state.storage.available < unitSize;
  const nextSeconds = Math.max(0, Math.ceil((progress.nextAt - economy.now) / 1000));
  return <div className={styles.batchWork} data-mining-batch data-job-id={job.id} data-ready={progress.ready > 0 || undefined} data-tap-boost-power={boostPercent || undefined}>
    <div className={styles.batchTitle}><ProductIcon state={state} itemId={itemId} size={28} /><strong>{itemName(state, itemId)} · {batch.quantity}</strong></div>
    <span>Добыто {progress.completed} из {batch.quantity} · получено {batch.claimed}</span>
    <TapBoostWorkBadge percent={boostPercent} />
    <progress aria-label="Прогресс заказа добычи" max={batch.quantity} value={progress.completed} />
    <span aria-live="polite">{progress.remaining ? `Следующая единица через ${miningDurationLabel(nextSeconds)}` : "Весь заказ готов"}</span>
    <button type="button" className={styles.batchClaim} data-production-control disabled={blocked || progress.ready === 0 || full}
      onClick={() => { if (!blocked && progress.ready > 0 && !full) command.send("claim_job", job.id, 1, 0); }}>
      {progress.ready > 0 ? `Забрать готовое · ${progress.ready}` : "Добываем…"}</button>
    {full && progress.ready > 0 && <span>Готовая добыча сохранена.<button type="button" className={styles.batchLink} onClick={onOpenPantry}>Освободить кладовую</button></span>}
    {progress.remaining > 0 && <button type="button" className={styles.batchLink} disabled={blocked} onClick={() => setConfirming(!confirming)} aria-expanded={confirming}>Остановить остаток</button>}
    {confirming && progress.remaining > 0 && <div className={styles.batchConfirmation} role="group" aria-label="Остановить оставшуюся добычу">
      <p>Готовая добыча останется здесь. Незавершённая часть будет остановлена.</p>
      <button type="button" disabled={blocked} onClick={() => { if (!blocked && command.send("cancel_exploration", job.id, 1, 0)) setConfirming(false); }}>Остановить</button>
      <button type="button" onClick={() => setConfirming(false)}>Продолжить добычу</button>
    </div>}
  </div>;
}
