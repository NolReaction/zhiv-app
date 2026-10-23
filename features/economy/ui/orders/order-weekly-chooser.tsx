"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, CalendarDays, Check, Clock3, HeartHandshake } from "lucide-react";
import { tradeRelationsState, weeklyOrderBoard } from "@/features/economy/domain/trade-relations";
import { locked, type ReadyEconomy } from "@/features/economy/sync/controller-state";
import { ItemIcon } from "@/features/items/item-icon";
import { itemName, number, ProductIcon } from "@/features/economy/ui/shared/world-economy-parts";
import { worldDuration } from "@/features/economy/ui/shared/world-stations";
import { orderResidents, type OrderCustomer, type OrderResidentId } from "./order-residents";
import styles from "./order-weekly-chooser.module.css";

type WeeklyChoice = ReturnType<typeof weeklyOrderBoard>["offers"][number];
type WeeklyQuote = { owner: string; revision: number; id: string };
const wait = (at: string, now: number) => worldDuration(Math.max(0, Math.ceil((Date.parse(at) - now) / 1000)));

/** Reviewing a complete three-stage contract never starts its seven-day clock. */
export function OrderWeeklyChooser({ economy, customer, available }: {
  economy: ReadyEconomy;
  customer: OrderCustomer;
  available: readonly OrderResidentId[];
}) {
  const [quote, setQuote] = useState<WeeklyQuote | null>(null);
  const pending = economy.busy || economy.uncertain;
  const sent = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const current = useRef<{ economy: ReadyEconomy; quote: WeeklyQuote | null; available: readonly OrderResidentId[]; customer: OrderCustomer } | null>({ economy, quote, available, customer });
  useLayoutEffect(() => { current.current = { economy, quote, available, customer }; return () => { current.current = null; }; }, [economy, quote, available, customer]);
  useEffect(() => {
    if (!economy.busy && !economy.uncertain) sent.current = false;
  }, [economy.busy, economy.uncertain, economy.error, economy.snapshot.ownerPublicId, economy.snapshot.revision]);
  const board = weeklyOrderBoard(economy.snapshot, economy.now, economy.snapshot.catalog);
  const previous = tradeRelationsState(economy.snapshot).weekly;
  const expired = previous && Date.parse(previous.expiresAt) <= economy.now;
  const candidates = board.offers.filter(offer => available.includes(offer.residentId) && (customer === "all" || customer === offer.residentId));
  const selected = quote && quote.owner === economy.snapshot.ownerPublicId ? candidates.find(offer => offer.id === quote.id) : null;
  const selectedId = selected?.id;
  const titleId = useId();
  useEffect(() => { if (selectedId) heading.current?.focus({ preventScroll: true }); }, [selectedId]);
  if (board.active) return null;
  if (!board.canChoose) return <div className={styles.waiting} data-weekly-cooldown>
    <CalendarDays size={18} aria-hidden="true" /><p>Следующее большое поручение{board.availableAt ? <> можно выбрать через <strong>{wait(board.availableAt, economy.now)}</strong>.</> : " появится позже."}<span>Репутация и награды за завершённые этапы сохраняются.</span></p>
  </div>;
  const reason = selected && quote ? locked(economy) ? economy.uncertain ? "Проверяем последнее действие." : "Дождись подтверждения действия."
    : quote.revision !== economy.snapshot.revision ? "Хозяйство обновилось. Вернись к выбору и проверь поручение ещё раз." : null : null;
  const accept = () => {
    const latest = current.current, accepted = latest?.quote;
    if (!latest || !accepted || !quote || accepted !== quote || sent.current || locked(latest.economy)
      || accepted.owner !== latest.economy.snapshot.ownerPublicId || accepted.revision !== latest.economy.snapshot.revision) return;
    const fresh = weeklyOrderBoard(latest.economy.snapshot, latest.economy.now, latest.economy.snapshot.catalog);
    const offer = fresh.offers.find(entry => entry.id === accepted.id);
    if (!fresh.canChoose || !offer || !latest.available.includes(offer.residentId)
      || latest.customer !== "all" && latest.customer !== offer.residentId) return;
    sent.current = true;
    const result = latest.economy.act("accept_weekly_order", offer.id, 1, 0);
    if (result === false) sent.current = false;
  };
  const review = (offer: WeeklyChoice) => {
    if (locked(economy) || sent.current || !board.canChoose) return;
    setQuote({ owner: economy.snapshot.ownerPublicId, revision: economy.snapshot.revision, id: offer.id });
  };
  return <div className={styles.chooser} data-weekly-chooser>
    {!selected ? <>
      {expired && <p className={styles.expired} role="status">Срок прошлого поручения закончился. Репутация и награды за сданные этапы сохранены.</p>}
      <p className={styles.intro}>Выбери, кому помочь на этой неделе. Одновременно можно взять одно поручение. На три этапа будет семь дней с момента подтверждения.</p>
      <div className={styles.choices}>{candidates.map(offer => {
        const resident = orderResidents[offer.residentId];
        return <article className={styles.choice} key={offer.id} data-weekly-choice={offer.residentId}>
          <header><resident.Portrait className={styles.portrait} /><div><p>{resident.name}</p><h4>{offer.name}</h4></div></header>
          <div className={styles.rewards}><span><ItemIcon itemId="coins" size={16} />{number(offer.coins)}</span><span><HeartHandshake size={14} aria-hidden="true" />+{number(offer.reputationXp)} реп.</span></div>
          <p className={styles.effort}><Clock3 size={13} aria-hidden="true" />Около {worldDuration(offer.effortSeconds)} работы с нуля{offer.fishingUncertain ? " · улов случаен" : ""}</p>
          <button type="button" disabled={locked(economy) || pending} onClick={() => review(offer)} aria-label={`Посмотреть поручение: ${offer.name}, ${resident.name}`}>Посмотреть три этапа</button>
        </article>;
      })}</div>
      {!candidates.length && <p className={styles.intro}>У этого жителя пока нет доступного большого поручения. Развивай хозяйство, чтобы открыть нужные товары.</p>}
    </> : <section className={styles.review} aria-labelledby={titleId} data-weekly-review>
      <button type="button" className={styles.back} disabled={pending} onClick={() => setQuote(null)}><ArrowLeft size={14} aria-hidden="true" />К выбору поручения</button>
      <header><p>{orderResidents[selected.residentId].name} · большое поручение</p><h4 id={titleId} ref={heading} tabIndex={-1}>{selected.name}</h4>{selected.description && <p>{selected.description}</p>}</header>
      <ol className={styles.stages}>{selected.stages.map((stage, index) => <li key={stage.id}>
        <div className={styles.stageHeading}><span>{index + 1}</span><h5>{stage.name}</h5></div>
        {stage.description && <p>{stage.description}</p>}
        <ul aria-label={`Товары для этапа ${index + 1}`}>{Object.entries(stage.items).map(([id, amount]) => <li key={id}><ProductIcon state={economy.snapshot} itemId={id} size={19} /><span>{itemName(economy.snapshot, id)}</span><strong>×{number(amount)}</strong></li>)}</ul>
        <div className={styles.stageReward}><span><ItemIcon itemId="coins" size={14} />{number(stage.coins)}</span><span>+{number(stage.reputationXp ?? 0)} репутации</span><span>≈ {worldDuration(stage.effortSeconds ?? 0)} работы</span></div>
      </li>)}</ol>
      <p className={styles.promise}><CalendarDays size={16} aria-hidden="true" /><span>Семь дней на все этапы. Каждый этап оплачивается отдельно; уже полученные награды сохранятся, даже если срок закончится.</span></p>
      <p className={styles.note}>Время рассчитано для подготовки без запасов. Разные производства могут работать одновременно.{selected.fishingUncertain ? " Время рыбалки зависит от улова." : ""}</p>
      {reason && <p className={styles.warning} role="status">{reason}</p>}
      <button type="button" className={styles.accept} disabled={Boolean(reason) || pending} onClick={accept}><Check size={16} aria-hidden="true" />{pending ? "Подтверждаем…" : "Взять поручение на 7 дней"}</button>
    </section>}
  </div>;
}
