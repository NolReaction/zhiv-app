"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Check, Clock3 } from "lucide-react";
import { PlayerItemIcon } from "@/features/economy/ui/fishing/fish-discovery";
import { ECONOMY_MAX_BALANCE, ECONOMY_MAX_ITEMS, type EconomyJob } from "@/features/economy/domain/model";
import { productionStationSupported } from "@/features/economy/domain/production-slots";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { useGardenCollection } from "@/features/economy/integration/garden-collection-context";
import { berryCollectionStatus } from "@/features/economy/integration/garden-collection";
import { worldDuration, worldJobProgress } from "@/features/economy/ui/shared/world-stations";
import styles from "./production-work.module.css";

type Confirmation = { owner: string; revision: number; jobId: string; deadline: number };
const confirmationDuration = 5000;
const number = (value: number) => value.toLocaleString("ru-RU");

/** The saved paid cost is the refund, including jobs from an older catalogue. */
export function productionCancellationReason(economy: ReadyEconomy, job: EconomyJob) {
  const state = economy.snapshot;
  if (job.kind !== "production" || !productionStationSupported(job.targetId)) return "Это занятие нельзя отменить здесь";
  if (!state.jobs.some(entry => entry.id === job.id)) return "Производство уже завершено";
  if (economy.now >= Date.parse(job.finishesAt) || job.collection?.startedAt) return "Готовый результат можно забрать";
  if (locked(economy)) return "Дождитесь подтверждения последнего действия";
  const cost = job.cost ?? { coins: 0, items: {} };
  const shortfall = Math.max(0, Object.values(cost.items).reduce((sum, amount) => sum + amount, 0) - state.storage.available);
  if (shortfall) return `Освободите ${number(shortfall)} мест для возврата материалов`;
  if (cost.coins > ECONOMY_MAX_BALANCE - state.wallet.coins) return "Освободите место в кошельке для возврата монет";
  if (Object.entries(cost.items).some(([id, amount]) => (state.inventory[id] ?? 0) + amount > ECONOMY_MAX_ITEMS)) return "Освободите место для возврата материала";
  return null;
}

/** One cell is one action: claim a ready product or ask once before cancellation. */
export function ProductionWork({ economy, job, openPantry, compact = false }: { economy: ReadyEconomy; job: EconomyJob; openPantry?: () => void; compact?: boolean }) {
  const state = economy.snapshot;
  const ready = economy.now >= Date.parse(job.finishesAt);
  const settledFailure = !economy.busy && !economy.uncertain ? economy.error ?? "" : "";
  // A new confirmed context must never inherit consent or a pending click.
  // A definitive failed response also closes the local pending state. An
  // uncertain receipt remains owned by the session and blocks a fresh command.
  return <ProductionWorkCell key={`${state.ownerPublicId}:${state.revision}:${job.id}:${ready}:${job.collection?.startedAt ?? ""}:${settledFailure}`} economy={economy} job={job} openPantry={openPantry} compact={compact} />;
}

function ProductionWorkCell({ economy, job, openPantry, compact }: { economy: ReadyEconomy; job: EconomyJob; openPantry?: () => void; compact: boolean }) {
  const collection = useGardenCollection();
  const { snapshot: state } = economy;
  const renderedOwner = state.ownerPublicId, renderedRevision = state.revision;
  const status = worldJobProgress(state, job, economy.now);
  const berry = berryCollectionStatus(job, state, economy.now, collection);
  const storageShortfall = Math.max(status.storageShortfall, berry?.storageShortfall ?? 0);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [countdown, setCountdown] = useState(5);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const pending = useRef<Confirmation | null>(null);
  const armed = useRef<Confirmation | null>(null);
  const descriptionId = useId();
  const outputs = Object.entries(job.rewards);
  const name = (id: string) => state.catalog.items.find(item => item.id === id)?.name ?? id;
  const title = outputs.map(([id, amount]) => `${name(id)} ×${number(amount)}`).join(" + ") || state.catalog.recipes.find(recipe => recipe.id === job.recipeId)?.name || "Производство";
  const cancellationReason = productionCancellationReason(economy, job);
  const confirming = Boolean(confirmation && countdown > 0 && confirmation.owner === state.ownerPublicId && confirmation.revision === state.revision && confirmation.jobId === job.id && !status.ready && !job.collection?.startedAt);
  const pendingMatches = submitted && !economy.error;
  const claimDisabled = locked(economy) || !status.ready || storageShortfall > 0 || Boolean(berry?.disabled);
  const disabled = status.ready ? claimDisabled : Boolean(cancellationReason) || pendingMatches;
  const cost = job.cost ?? { coins: 0, items: {} };
  const refund = cost.coins || Object.keys(cost.items).length ? `Вернётся: ${[cost.coins > 0 ? `${number(cost.coins)} монет` : null, ...Object.entries(cost.items).map(([id, amount]) => `${name(id)} ×${number(amount)}`)].filter(Boolean).join(", ")}` : "Место освободится";

  function resetConfirmation() { armed.current = null; setConfirmation(null); }

  useEffect(() => { if (economy.error && !economy.busy) pending.current = null; }, [economy.error, economy.busy]);
  useEffect(() => {
    if (!confirmation) return;
    const update = () => {
      if (armed.current !== confirmation) return;
      const remaining = Math.ceil(Math.max(0, confirmation.deadline - performance.now()) / 1000);
      setCountdown(remaining);
      if (!remaining && armed.current === confirmation) { armed.current = null; setConfirmation(null); }
    };
    const timer = setInterval(update, 100);
    return () => clearInterval(timer);
  }, [confirmation]);
  useEffect(() => {
    if (!confirming || typeof document === "undefined") return;
    const ownerDocument = document, ownerWindow = typeof window === "undefined" ? null : window;
    const dismiss = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) resetConfirmation(); };
    const hide = () => { if (ownerDocument.hidden) resetConfirmation(); };
    const leave = () => resetConfirmation();
    ownerDocument.addEventListener("pointerdown", dismiss);
    ownerDocument.addEventListener("visibilitychange", hide);
    ownerWindow?.addEventListener("pagehide", leave);
    return () => { ownerDocument.removeEventListener("pointerdown", dismiss); ownerDocument.removeEventListener("visibilitychange", hide); ownerWindow?.removeEventListener("pagehide", leave); };
  }, [confirming]);

  function dismiss() { resetConfirmation(); button.current?.focus({ preventScroll: true }); }
  function interact() {
    if (economy.snapshot.ownerPublicId !== renderedOwner || economy.snapshot.revision !== renderedRevision) return;
    if (status.ready) {
      const currentStatus = worldJobProgress(economy.snapshot, job, economy.now);
      const currentBerry = berryCollectionStatus(job, economy.snapshot, economy.now, collection);
      if (locked(economy) || !currentStatus.ready || Math.max(currentStatus.storageShortfall, currentBerry?.storageShortfall ?? 0) > 0 || currentBerry?.disabled) return;
      const accepted = berry && collection ? collection.start(job.id)
        : economy.act(berry && !berry.started ? "start_garden_collection" : job.collection?.batchId ? "claim_garden_collection" : "claim_job", job.collection?.batchId ?? job.id);
      setFeedback(accepted === false ? "Действие не отправлено. Попробуйте ещё раз." : null);
      return;
    }
    if (productionCancellationReason(economy, job) || pendingMatches || pending.current) return;
    const current = { owner: state.ownerPublicId, revision: state.revision, jobId: job.id, deadline: performance.now() + confirmationDuration };
    const consent = armed.current;
    // Check the actual monotonic deadline on every click. Background tabs can
    // delay the interval, but can never extend permission to cancel a job.
    if (!consent || consent.owner !== current.owner || consent.revision !== current.revision || consent.jobId !== current.jobId || performance.now() >= consent.deadline) {
      armed.current = current; setCountdown(5); setFeedback(null); setConfirmation(current); return;
    }
    // The ref closes the gap before the command controller publishes busy.
    pending.current = current;
    setSubmitted(true);
    resetConfirmation();
    if (economy.act("cancel_production", job.id) === false) {
      pending.current = null; setSubmitted(false); setFeedback("Отмена не отправлена. Попробуйте ещё раз.");
    }
  }
  const label = confirming ? "Удалить?" : status.ready ? berry?.button ?? "Забрать" : pendingMatches ? "Отменяется…" : "Отменить";
  return <div ref={root} className={`${styles.work} ${compact ? styles.compact : ""}`} data-job-id={job.id} data-ready={status.ready || undefined} data-confirm-cancel={confirming || undefined}
    onKeyDown={event => { if (event.key === "Escape" && confirming) { event.preventDefault(); event.stopPropagation(); dismiss(); } }}
    onBlurCapture={event => { if (confirming && !event.currentTarget.contains(event.relatedTarget as Node | null)) resetConfirmation(); }}>
    <button ref={button} type="button" className={styles.main} data-production-control="true" disabled={disabled} aria-expanded={confirming} aria-describedby={confirming ? descriptionId : undefined}
      aria-label={`${confirming ? "Подтвердить отмену" : status.ready ? berry?.button ?? "Забрать" : "Отменить производство"}: ${title}`} title={confirming ? refund : undefined} onClick={interact}>
      <span className={styles.products}>{outputs.map(([id]) => <PlayerItemIcon key={id} state={state} itemId={id} size={compact ? 32 : 38} />)}</span>
      <strong>{title}</strong><span className={styles.time}>{berry && !berry.growing ? berry.label : status.ready ? "Готово к получению" : `Осталось ${status.seconds < 60 ? `${status.seconds} с` : worldDuration(status.seconds)}`}</span>
      <span className={`${styles.actionLine} ${confirming ? styles.confirmLabel : status.ready ? styles.action : styles.cancelHint}`} data-production-action="true">
        {confirming ? <>{label}<span className={styles.countdown} aria-hidden="true">{countdown} с</span></> : <>{status.ready && (berry?.collecting ? <Clock3 size={13} aria-hidden="true" /> : <Check size={13} aria-hidden="true" />)}{label}</>}
      </span>
      {confirming && <span id={descriptionId} className={styles.sr}>{refund}. Нажмите ещё раз в течение {countdown} секунд, чтобы отменить производство.</span>}
      <progress className={styles.progress} value={berry?.collecting ? undefined : status.progress} max={1} aria-label={berry?.collecting ? "Сбор урожая" : `Готовность: ${title}`} />
    </button>
    {feedback && <p className={styles.hint} role="status">{feedback}</p>}
    {berry?.away && status.ready && <p className={styles.hint}>{berry.awayReason}</p>}
    {((status.ready && storageShortfall > 0) || !status.ready && cancellationReason?.startsWith("Освободите")) && <p className={styles.hint}>{status.ready ? `Нужно освободить ${number(storageShortfall)} мест.` : cancellationReason}{openPantry && <button type="button" className={styles.pantry} onClick={openPantry}>К кладовой<ArrowRight size={12} aria-hidden="true" /></button>}</p>}
  </div>;
}
