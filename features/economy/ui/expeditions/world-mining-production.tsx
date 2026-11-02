"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { Check, Clock3, LockKeyhole, PackageCheck, Pickaxe, Plus } from "lucide-react";
import type { EconomyJob, EconomyView } from "@/features/economy/domain/model";
import { miningBatchLimit, miningBatchProgress } from "@/features/economy/domain/mining-batch";
import { economyMinerConflict, isMinerJob } from "@/features/economy/domain/actor-availability";
import { skillWorkDuration } from "@/features/economy/domain/craft-skill";
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
  const quantityLimit = miningBatchLimit(state.buildings.quarry ?? 1, 1);
  const requestedQuantity = Math.min(quantity, quantityLimit);
  const [feedback, setFeedback] = useState<{ text: string; owner: string; revision: number; jobId?: string; error: string | null } | null>(null);
  const noticeId = useId();
  const command = useFishingCommand({ economy, state });
  const jobs = state.jobs.filter(job => job.kind === "exploration" && (isMinerJob(job) || expeditionSector(job.targetId) === "caves"));
  const current = jobs.find(isMinerJob), previous = jobs.filter(job => job !== current);
  const previousJob = useRef<string | null>(null);
  const routes = miningProductionRoutes(state);
  const notice = feedback?.owner === state.ownerPublicId && feedback.revision === state.revision && feedback.jobId === current?.id && feedback.error === (economy.error ?? null) ? feedback.text : null;
  const setNotice = (text: string) => setFeedback({ text, owner: state.ownerPublicId, revision: state.revision, jobId: current?.id, error: economy.error ?? null });
  useEffect(() => {
    const pending = pendingStart.current;
    if (pending && (pending.owner !== state.ownerPublicId || pending.revision !== state.revision || current || economy.error !== pending.error)) pendingStart.current = null;
  }, [state.ownerPublicId, state.revision, current, economy.error]);
  useEffect(() => {
    if (previousJob.current && !current && document.activeElement === document.body)
      section.current?.querySelector<HTMLButtonElement>("button[data-route]")?.focus({ preventScroll: true });
    previousJob.current = current?.id ?? null;
  }, [current]);
  useEffect(() => {
    const pending = launchFocus.current;
    if (!pending || !current || current.targetId !== pending.routeId) return;
    const control = section.current?.querySelector<HTMLElement>("[data-mining-batch], [data-production-slot=\"1\"] button[data-production-control]:not(:disabled)");
    if (!control) return;
    launchFocus.current = null;
    if (document.activeElement === pending.element || !pending.element?.isConnected && document.activeElement === document.body) control.focus({ preventScroll: true });
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
  const routeQuantity = (route: Route) => Math.min(requestedQuantity, miningBatchLimit(state.buildings.quarry ?? 1, route.seconds));
  function routeReason(route: Route) {
    const count = routeQuantity(route);
    const missing = worldMissingRequirements(state, worldRequirements(route));
    if (missing.length) return missing.map(({ id, level }) => `${stationName(state, id)} · ур. ${level}`).join(", ");
    if (state.jobs.some(job => job.kind === "construction" && job.targetId === "quarry")) return "Дождитесь улучшения шахты";
    const conflict = economyMinerConflict(state.jobs, economy.now);
    if (conflict) return conflict.message;
    if (Object.values(route.rewards).reduce((sum, amount) => sum + amount, 0) * count + Math.max(0, ...(route.finds?.entries.map(entry => entry.quantity) ?? [])) > state.storage.capacity) return "Уменьшите заказ: не хватает вместимости кладовой";
    if (worldCostShortfalls(state, { coins: route.cost.coins * count, items: Object.fromEntries(Object.entries(route.cost.items).map(([id, amount]) => [id, amount * count])) }).length) return "Не хватает припасов";
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
    const accepted = command.send("start_exploration", route.id, routeQuantity(route), 0);
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
        {current ? current.miningBatch ? <MiningBatchCard key={current.id} economy={economy} state={state} job={current} onOpenPantry={onOpenPantry} isOnline={isOnline} />
          : <ActiveExpedition economy={economy} state={state} job={current} onOpenPantry={onOpenPantry} onOpenHelp={onOpenHelp} isOnline={isOnline} compact confirmationKey={confirmationKey} onConfirmation={onConfirmation} onCancellationSent={jobId => { cancellationSent.current = jobId; }} />
          : <><Plus size={25} aria-hidden="true" /><strong>Свободно</strong><span>Выберите добычу</span></>}
      </div></div>
    </section>
    {!current && <section className={styles.catalog} aria-label="Добыча в шахте" data-section-guide-target="workshop-recipes"><h3>Что добывать?</h3>
      <div className={styles.batchOptions} role="group" aria-label="Количество добычи">
        <span>Заказать</span>{[1, 5, 10].filter(count => count <= quantityLimit).map(count => <button type="button" key={count} aria-pressed={requestedQuantity === count} onClick={() => setQuantity(count)}>{count}</button>)}
        <label>Количество<input aria-label="Количество единиц добычи" type="number" inputMode="numeric" min={1} max={quantityLimit} value={requestedQuantity}
          onChange={event => setQuantity(Math.max(1, Math.min(quantityLimit, Math.floor(Number(event.target.value) || 1))))} /></label>
        <button type="button" aria-label={`Максимальная партия: до ${quantityLimit}`} onClick={() => setQuantity(quantityLimit)}>Макс.</button>
      </div>
      <p className={styles.batchHint}>До {quantityLimit} единиц за заказ. Лимит долгих ресурсов указан на карточках.</p>
      <div className={styles.grid}>{routes.map(route => {
        const count = routeQuantity(route), reason = routeReason(route), duration = miningDurationLabel(skillWorkDuration(state, "mining", tradeWorkDuration(state, route.seconds, "kamneshmyg", 0, state.catalog, economy.now), state.catalog) * count);
        const outputs = Object.entries(route.rewards), name = outputs.length === 1 ? itemName(state, outputs[0][0]) : route.name;
        const costs = [...(route.cost.coins > 0 ? [["coins", route.cost.coins] as const] : []), ...Object.entries(route.cost.items)];
        return <div key={route.id} className={cardStyles.entry}><button type="button" className={cardStyles.card} data-route={route.id} data-recipe-focused={initialRouteId === route.id || undefined} data-blocked={Boolean(reason) || undefined}
          aria-label={`Добыть: ${name} ×${count}, ${duration}`} title={reason ?? undefined} aria-describedby={notice ? noticeId : undefined} onFocus={() => onHelpContextChange?.({ intent: "expedition", routeId: route.id })} onClick={() => start(route)}>
          <span className={cardStyles.header} data-production-mixed={count > 1 || outputs.length > 1 || undefined}><span className={cardStyles.outputs}>{outputs.map(([itemId, amount]) => <span key={itemId}><ProductIcon state={state} itemId={itemId} size={30} />{(amount * count !== 1 || outputs.length > 1) && <b>×{number(amount * count)}</b>}</span>)}</span><strong>{name}</strong></span>
          <span className={cardStyles.time}><Clock3 size={12} aria-hidden="true" />{duration}{reason && <LockKeyhole className={cardStyles.lock} size={12} aria-hidden="true" />}</span>
          <span className={cardStyles.details}>{count < requestedQuantity && <span className={styles.routeLimit}>Лимит этой добычи · {count}</span>}{reason && <span className={cardStyles.accessReason}>{reason}</span>}{costs.length > 0 && <span className={cardStyles.costs} aria-label="Понадобится">{costs.map(([itemId, amount]) => <span key={itemId}><ProductIcon state={state} itemId={itemId} size={15} /><span>{itemId === "coins" ? "Монеты" : itemName(state, itemId)}</span><b>×{number(amount * count)}</b></span>)}</span>}</span>
        </button></div>;
      })}</div>
      {notice && <p id={noticeId} className={styles.notice} role="status" aria-live="polite">{notice}</p>}
      {!routes.length && <p className={styles.notice}>Добыча откроется после улучшения дома.</p>}
    </section>}
    {previous.length > 0 && <section className={styles.legacy} aria-label="Ранее начатая добыча"><h3>Ранее начатая добыча</h3>{previous.map(job => <ActiveExpedition key={job.id} economy={economy} state={state} job={job} onOpenPantry={onOpenPantry} onOpenHelp={onOpenHelp} isOnline={isOnline} confirmationKey={confirmationKey} onConfirmation={onConfirmation} onCancellationSent={jobId => { cancellationSent.current = jobId; }} />)}</section>}
  </div>;
}

export function MiningBatchCard({ economy, state, job, onOpenPantry, isOnline }: Pick<MiningProps, "economy" | "onOpenPantry" | "isOnline"> & { state: EconomyView; job: EconomyJob }) {
  const card = useRef<HTMLDivElement>(null);
  const stopButton = useRef<HTMLButtonElement>(null), confirmButton = useRef<HTMLButtonElement>(null), returnFocus = useRef(false);
  const progress = miningBatchProgress(job, economy.now), batch = job.miningBatch!;
  const boostPercent = jobTapBoostPercent(state, job.id, economy.now);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus({ preventScroll: true });
    else if (returnFocus.current) { returnFocus.current = false; stopButton.current?.focus({ preventScroll: true }); }
  }, [confirming]);
  const command = useFishingCommand({ economy, state });
  const blocked = locked(economy) || isOnline === false || economy.directActionsAvailable === false;
  const itemId = Object.keys(batch.unitRewards)[0], unitSize = Object.values(job.rewards).reduce((sum, count) => sum + count, 0);
  const baseUnitSize = Object.values(batch.unitRewards).reduce((sum, count) => sum + count, 0);
  const full = state.storage.available < unitSize;
  const nextSeconds = Math.max(0, Math.ceil((progress.nextAt - economy.now) / 1000));
  const remainingSeconds = Math.max(0, Math.ceil((Date.parse(job.finishesAt) - economy.now) / 1000));
  const fitsAtMost = Math.min(progress.ready, Math.floor(state.storage.available / Math.max(1, baseUnitSize)));
  const elapsedPercent = Math.floor(progress.ratio * 100);
  return <div ref={card} className={styles.batchWork} tabIndex={-1} data-mining-batch data-job-id={job.id} data-ready={progress.ready > 0 || undefined} data-tap-boost-power={boostPercent || undefined}>
    <div className={styles.batchTitle}><span className={styles.resourceIcon}><ProductIcon state={state} itemId={itemId} size={32} /></span><div><small>Заказ шахтёра</small><strong>{itemName(state, itemId)} · {batch.quantity}</strong></div><span className={styles.batchPercent}>{progress.remaining ? `${elapsedPercent}%` : <Check size={19} aria-label="Готово" />}</span></div>
    <TapBoostWorkBadge percent={boostPercent} />
    <div className={styles.batchProgress}>
      <div className={styles.batchProgressHeading}><strong>Добыто {progress.completed} из {batch.quantity}</strong><span>{progress.remaining ? `Осталось ${progress.remaining}` : "Весь заказ готов"}</span></div>
      <div className={styles.batchMeter} role="progressbar" aria-label="Прогресс заказа добычи" aria-valuemin={0} aria-valuemax={100} aria-valuenow={elapsedPercent}
        aria-valuetext={`Добыто ${progress.completed} из ${batch.quantity}${progress.remaining ? `, осталось ${miningDurationLabel(remainingSeconds)}` : ", весь заказ готов"}`}
        style={{ "--batch-progress": `${progress.ratio * 100}%`, "--batch-collected": `${batch.claimed / batch.quantity * 100}%` } as CSSProperties}>
        <span className={styles.batchFilled} /><span className={styles.batchCollected} />
      </div>
      <div className={styles.batchClock}>{progress.remaining ? <><Clock3 size={13} aria-hidden="true" /><span>До конца заказа</span><strong>{miningDurationLabel(remainingSeconds)}</strong></> : <><PackageCheck size={14} aria-hidden="true" /><span>Можно забрать оставшуюся добычу</span></>}</div>
    </div>
    <div className={styles.batchCounts} aria-live="polite" aria-atomic="true"><span><strong>{batch.claimed}</strong>получено</span><span data-ready={progress.ready > 0 || undefined}><strong>{progress.ready}</strong>ждёт сбора</span><span><strong>{progress.remaining}</strong>в работе</span></div>
    <div className={styles.batchActions} data-mining-actions>
      {confirming && progress.remaining > 0 ? <div className={styles.batchConfirmation} role="group" aria-label="Остановить оставшуюся добычу">
        <p><strong>Остановить остаток: {progress.remaining}?</strong><span>Готовые находки сохранятся.</span></p>
        <div className={styles.batchActionRow}>
          <button ref={confirmButton} type="button" disabled={blocked} onClick={() => { if (!blocked && command.send("cancel_exploration", job.id, 1, 0)) { setConfirming(false); card.current?.focus({ preventScroll: true }); } }}>Остановить</button>
          <button type="button" onClick={() => { returnFocus.current = true; setConfirming(false); }}>Назад</button>
        </div>
      </div> : <>
        {progress.remaining > 0 && <p className={styles.nextUnit}><Pickaxe size={13} aria-hidden="true" />Следующая единица через <strong>{miningDurationLabel(nextSeconds)}</strong></p>}
        {progress.ready > 0 && <div className={styles.batchActionRow}>
          <button type="button" className={styles.batchClaim} data-production-control disabled={blocked || full}
            onClick={() => { if (!blocked && progress.ready > 0 && !full) command.send("claim_mining_batch", job.id, 1, 0); }}>
            <PackageCheck size={16} aria-hidden="true" />Забрать 1</button>
          {progress.ready > 1 && <button type="button" className={styles.batchClaimAll} disabled={blocked || full}
            aria-label={`Забрать всё готовое: ${progress.ready}`} onClick={() => { if (!blocked && progress.ready > 0 && !full) command.send("claim_job", job.id, 1, 0); }}>Всё · {progress.ready}</button>}
        </div>}
        {progress.ready > 0 && !full && fitsAtMost < progress.ready && <p className={styles.claimHint}>В кладовую поместится до {fitsAtMost} из {progress.ready}. Остальное останется здесь.</p>}
        {full && progress.ready > 0 && <p className={styles.claimHint}>Добыча сохранена. Нет места.<button type="button" className={styles.batchLink} onClick={onOpenPantry}>Освободить кладовую</button></p>}
        {progress.remaining > 0 && <button ref={stopButton} type="button" className={styles.batchLink} data-mining-stop disabled={blocked} onClick={() => setConfirming(true)} aria-expanded={false}>Остановить остаток</button>}
      </>}
    </div>
  </div>;
}
