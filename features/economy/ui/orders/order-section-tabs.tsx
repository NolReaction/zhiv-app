"use client";

import { useRef, type KeyboardEvent } from "react";
import { CalendarDays, ClipboardList, House } from "lucide-react";
import styles from "./world-resident-order-board.module.css";

export type OrderSection = "progression" | "requests" | "weekly";
const sections = {
  progression: { label: "К дому", Icon: House },
  requests: { label: "Просьбы", Icon: ClipboardList },
  weekly: { label: "Поручения", Icon: CalendarDays },
};

export function OrderSectionTabs({ selected, counts, panelId, onSelect }: {
  selected: OrderSection; counts: Partial<Record<OrderSection, number>>; panelId: string;
  onSelect: (section: OrderSection) => void;
}) {
  const list = useRef<HTMLDivElement>(null);
  const move = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    const tabs = Array.from(list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? []);
    const index = tabs.indexOf(event.currentTarget);
    if (index < 0 || !tabs.length) return;
    const target = event.key === "Home" ? tabs[0] : event.key === "End" ? tabs.at(-1)!
      : tabs[(index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length];
    event.preventDefault(); target.focus({ preventScroll: true });
    onSelect(target.dataset.orderSection as OrderSection);
  };
  return <div className={styles.filters} ref={list} role="tablist" aria-label="Вид заказа" data-order-section-tabs>
    {(Object.keys(sections) as OrderSection[]).filter(id => counts[id] !== undefined).map(id => {
      const { label, Icon } = sections[id];
      return <button key={id} type="button" role="tab" id={`${panelId}-tab-${id}`} aria-controls={panelId}
        aria-selected={selected === id} tabIndex={selected === id ? 0 : -1} data-order-section={id}
        onKeyDown={move} onClick={() => onSelect(id)}>
        <Icon size={14} aria-hidden="true" />{label}<span aria-label={`Заказов: ${counts[id]}`}>{counts[id]}</span>
      </button>;
    })}
  </div>;
}
