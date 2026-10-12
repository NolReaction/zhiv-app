"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { Clock3, Zap } from "lucide-react";
import { ItemIcon } from "@/features/items/item-icon";
import type { EconomyJob } from "@/features/economy/domain/model";
import { constructionSpeedupPrice } from "@/features/economy/domain/rules";
import { formatPearls, pearlDisplayAmount } from "@/features/economy/domain/money";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { stationName } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration } from "@/features/economy/ui/shared/world-stations";
import styles from "./construction-speedup.module.css";

function pearlCost(price: number) {
  const display = pearlDisplayAmount(price), tail = display % 100, digit = display % 10;
  return `${formatPearls(price)} ${!Number.isInteger(display) ? "жемчужины" : tail >= 11 && tail <= 14 ? "жемчужин" : digit === 1 ? "жемчужину" : digit >= 2 && digit <= 4 ? "жемчужины" : "жемчужин"}`;
}

/** A quote is only consent to a maximum price; the server owns time and payment. */
export function ConstructionSpeedup({ economy, job }: { economy: ReadyEconomy; job: EconomyJob }) {
  const [quote, setQuote] = useState<{ owner: string; revision: number; jobId: string; price: number } | null>(null);
  const sent = useRef<typeof quote>(null);
  const latest = useRef({ economy, job, quote });
  useLayoutEffect(() => { latest.current = { economy, job, quote }; }, [economy, job, quote]);
  const trigger = useRef<HTMLButtonElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const wasConfirming = useRef(false);
  const headingId = useId(), detailId = useId(), reasonId = useId();
  const price = constructionSpeedupPrice(job, economy.now, economy.snapshot.catalog.constructionSpeedup);
  const seconds = Math.max(0, Math.ceil((Date.parse(job.finishesAt) - economy.now) / 1000));
  const pearls = economy.snapshot.wallet.pearls;
  const confirming = quote?.jobId === job.id && price > 0;
  const quoteChanged = confirming && (quote.owner !== economy.snapshot.ownerPublicId || quote.revision !== economy.snapshot.revision);
  const priceChanged = confirming && price > quote.price;
  const shortfall = Math.max(0, price - pearls);
  const disabled = locked(economy) || shortfall > 0 || Boolean(priceChanged || quoteChanged);
  const reason = economy.uncertain ? "Проверяем последнее действие."
    : economy.busy ? "Подтверждаем действие…"
    : economy.retryAt > economy.now ? "Дождитесь повторной проверки."
    : quoteChanged ? "Данные обновились. Вернитесь и проверьте стоимость ещё раз."
    : priceChanged ? "Цена изменилась. Вернитесь и проверьте её ещё раз."
    : shortfall > 0 ? `Не хватает жемчужин: ${formatPearls(shortfall)}` : null;

  function confirm() {
    const current = latest.current.economy, accepted = latest.current.quote;
    if (!quote || accepted !== quote || sent.current === quote || locked(current)) return;
    const snapshot = current.snapshot;
    if (!snapshot || snapshot.ownerPublicId !== quote.owner || snapshot.revision !== quote.revision) return;
    const active = snapshot.jobs.find(entry => entry.id === quote.jobId && entry.kind === "construction");
    if (!active || latest.current.job.id !== quote.jobId) return;
    const amount = constructionSpeedupPrice(active, current.now, snapshot.catalog.constructionSpeedup);
    if (amount <= 0 || amount > quote.price || amount > snapshot.wallet.pearls) return;
    sent.current = quote;
    void current.act("speedup_construction", active.id, 1, amount);
  }

  useEffect(() => {
    if (confirming) heading.current?.focus({ preventScroll: true });
    else if (wasConfirming.current) trigger.current?.focus({ preventScroll: true });
    wasConfirming.current = confirming;
  }, [confirming]);
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) sent.current = null;
  }, [economy.busy, economy.uncertain, economy.error, economy.snapshot.ownerPublicId, economy.snapshot.revision]);

  // Ready construction is completed with the normal free claim action.
  if (job.kind !== "construction" || price <= 0) return null;

  return <div className={styles.speedup} data-construction-speedup={job.id}>
    {confirming ? <section className={styles.confirmation} id={detailId} aria-labelledby={headingId}>
      <div className={styles.heading}><span className={styles.pearl}><ItemIcon itemId="pearls" size={29} /></span><div><h3 id={headingId} tabIndex={-1} ref={heading}>Завершить сейчас?</h3><p>{stationName(economy.snapshot, job.targetId)} · ур. {job.targetLevel}</p></div></div>
      <dl className={styles.details}><div><dt>Осталось</dt><dd><Clock3 size={14} aria-hidden="true" />{seconds < 60 ? `${seconds} с` : worldDuration(seconds)}</dd></div><div><dt>Стоимость</dt><dd><ItemIcon itemId="pearls" size={18} />{formatPearls(price)}</dd></div></dl>
      <p className={styles.balance}>Жемчужины<span>{formatPearls(pearls)}<span aria-label="останется">→</span><strong>{formatPearls(Math.max(0, pearls - price))}</strong></span></p>
      {reason && <p className={styles.reason} id={reasonId} role="status">{reason}</p>}
      <div className={styles.actions}><button type="button" className={styles.cancel} onClick={() => setQuote(null)}>Подождать</button><button type="button" className={styles.confirm} disabled={disabled} aria-describedby={reason ? reasonId : undefined} aria-label={`Подтвердить завершение за ${pearlCost(price)}`} onClick={confirm}><Zap size={14} aria-hidden="true" />{economy.busy ? "Подтверждаем…" : "Завершить"}<span><ItemIcon itemId="pearls" size={17} />{formatPearls(price)}</span></button></div>
    </section> : <>
      <button ref={trigger} type="button" className={styles.trigger} disabled={locked(economy) || shortfall > 0} aria-expanded={false} aria-controls={detailId} aria-describedby={reason ? reasonId : undefined} aria-label={`Завершить сейчас за ${pearlCost(price)}`} onClick={() => {
        if (locked(economy) || shortfall > 0) return;
        setQuote({ owner: economy.snapshot.ownerPublicId, revision: economy.snapshot.revision, jobId: job.id, price });
      }}><Zap size={17} aria-hidden="true" /><span>Завершить сейчас</span><span><ItemIcon itemId="pearls" size={20} />{formatPearls(price)}</span></button>
      {reason && <p className={styles.reason} id={reasonId}>{reason}</p>}
    </>}
  </div>;
}
