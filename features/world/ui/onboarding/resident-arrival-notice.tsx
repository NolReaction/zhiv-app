"use client";

import { useEffect, useState, type RefObject } from "react";
import { MapPin, X } from "lucide-react";
import styles from "./resident-arrival-notice.module.css";

export type ArrivalNoticeResident = "lopukh" | "kamneshmyg" | "leaftail";
const messages = {
  lopukh: { title: "Лопоух поселился на поляне", text: "Новый сосед уже у своего дома.", action: "Показать дом" },
  kamneshmyg: { title: "Камнешмыг пришёл на поляну", text: "Шахтёр обосновался у каменоломни.", action: "Показать каменоломню" },
  leaftail: { title: "Листохвост вернулся из путешествия", text: "В его фургончике теперь открыта лавка.", action: "Показать лавку" },
} satisfies Record<ArrivalNoticeResident, { title: string; text: string; action: string }>;

/** Optional, focus-neutral completion. A hidden map leaves the queued notice untouched. */
export function ResidentArrivalNotice({ resident, open, worldElement, onShow, onDismiss }: {
  resident: ArrivalNoticeResident; open: boolean; worldElement: RefObject<HTMLElement | null>;
  onShow: () => void; onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = worldElement.current;
    if (!open || !element) return;
    const measure = () => setVisible(!document.hidden && !element.closest('[aria-hidden="true"]')
      && Boolean(element.querySelector('[data-ready="true"] > canvas[role="img"]')));
    const frame = requestAnimationFrame(measure);
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready", "aria-hidden"] });
    document.addEventListener("visibilitychange", measure);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); document.removeEventListener("visibilitychange", measure); };
  }, [open, worldElement]);
  if (!open || !visible) return null;
  const message = messages[resident];
  return <aside className={styles.notice} data-resident-arrival-notice={resident}
    onPointerDown={event => event.stopPropagation()} onWheel={event => event.stopPropagation()}
    onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); onDismiss(); } }}>
    <div role="status" aria-live="polite" aria-atomic="true"><strong>{message.title}</strong><p>{message.text}</p></div>
    <button type="button" className={styles.close} onClick={onDismiss} aria-label="Закрыть сообщение о новом соседе"><X size={17} aria-hidden="true" /></button>
    <button type="button" className={styles.show} onClick={onShow}><MapPin size={16} aria-hidden="true" />{message.action}</button>
  </aside>;
}
