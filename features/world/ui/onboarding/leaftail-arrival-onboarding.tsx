"use client";

import { useEffect, useState, type RefObject } from "react";
import { GuideCoach } from "@/features/onboarding/guide-coach";

/** The camera follows a real boat and landing; the coach owns no unlocks. */
export function LeaftailArrivalOnboarding({ open, arrived, worldElement, onMeet, onDismiss }: {
  open: boolean; arrived: boolean; worldElement: RefObject<HTMLElement | null>; onMeet: () => void; onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = worldElement.current;
    if (!open || !element) return;
    const measure = () => setVisible(Boolean(element.querySelector('[data-ready="true"] > canvas[role="img"]')) && !element.closest('[aria-hidden="true"]'));
    const frame = requestAnimationFrame(measure);
    const observer = new MutationObserver(measure);
    observer.observe(element, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready", "aria-hidden"] });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [open, worldElement]);
  return <GuideCoach open={open && visible} flow="world" stepId="leaftail-arrival" title={arrived ? "Листохвост вернулся!" : "Лодка с находками!"} pose="greet"
    summary={arrived ? "Листохвост добрался до своей лавки. Теперь здесь можно покупать находки и припасы." : "Дом достиг 3-го уровня, и Листохвост возвращается из путешествия по реке."}
    text="Торговец привёз интересные вещи для поселения. Его лавка находится в фургончике. Соседи могут заглядывать к нему в окно, а сам он иногда выходит прогуляться."
    hint={arrived ? "Открой лавку, чтобы посмотреть привезённые вещи." : "Он причалит, сойдёт на берег и сам дойдёт до фургона. Подсказку можно закрыть."}
    targetRoot={worldElement} onPause={onDismiss} onSkip={onDismiss}
    primary={arrived ? { label: "К лавке", onClick: onMeet } : { label: "Понятно", onClick: onDismiss }}
    secondary={arrived ? { label: "Позже", onClick: onDismiss } : undefined} secondaryVisible={arrived} />;
}
