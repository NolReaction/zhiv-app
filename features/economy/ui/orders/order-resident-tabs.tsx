"use client";

import { useRef, type KeyboardEvent } from "react";
import { LockKeyhole, Mail } from "lucide-react";
import { orderResidentIds, orderResidentUnlockHints, orderResidents, type OrderCustomer, type OrderResidentId } from "./order-residents";
import styles from "./order-resident-tabs.module.css";

export function OrderResidentTabs({ selected, available, counts, panelId, onSelect }: {
  selected: OrderCustomer;
  available: readonly OrderResidentId[];
  counts: Partial<Record<OrderCustomer, number>>;
  panelId: string;
  onSelect: (customer: OrderCustomer) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)') ?? []);
    const index = tabs.indexOf(event.currentTarget);
    if (index < 0 || tabs.length === 0) return;
    const target = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)!
      : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    event.preventDefault();
    target.focus({ preventScroll: true });
    target.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "instant" });
    onSelect(target.dataset.orderFilter as OrderCustomer);
  };
  return <div className={styles.strip} ref={list} role="tablist" aria-label="Заказчик" aria-orientation="horizontal" data-order-resident-tabs>
    {(["all", ...orderResidentIds] as const).map(customer => {
      const unlocked = customer === "all" || available.includes(customer);
      const chosen = selected === customer;
      const resident = customer === "all" ? null : orderResidents[customer];
      const label = customer === "all" ? "Все заказы" : unlocked ? resident!.name : "Незнакомый житель";
      const count = counts[customer] ?? 0;
      return <button key={customer} type="button" role="tab" id={`${panelId}-tab-${customer}`} aria-controls={panelId}
        aria-selected={chosen} aria-label={`${label}${unlocked ? `, заказов: ${count}` : `. ${orderResidentUnlockHints[customer as OrderResidentId]}`}`}
        tabIndex={chosen ? 0 : -1} disabled={!unlocked} data-order-filter={customer} data-resident-theme={customer}
        onKeyDown={move} onClick={() => { if (unlocked) onSelect(customer); }}>
        <span className={styles.photo} aria-hidden="true">{customer === "all" ? <Mail size={20} strokeWidth={1.5} />
          : unlocked && resident ? <resident.Portrait className={styles.portrait} /> : <LockKeyhole size={17} />}
          {unlocked && count > 0 && <span className={styles.count}>{count}</span>}
        </span>
        <span className={styles.name}>{customer === "all" ? "Все" : unlocked ? resident!.name : "Не знакомы"}</span>
      </button>;
    })}
  </div>;
}
