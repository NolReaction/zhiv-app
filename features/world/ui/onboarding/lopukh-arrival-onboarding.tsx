"use client";

import { useEffect, useState, type RefObject } from "react";
import { GuideCoach } from "@/features/onboarding/guide-coach";

/** The scene runs the arrival and frames the woodcutter’s home; the coach never grants materials. */
export function LopukhArrivalOnboarding({ open, arrived, worldElement, onMeet, onDismiss }: {
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
  return <GuideCoach open={open && visible} flow="world" stepId="lopukh-arrival" title={arrived ? "Лопоух пришёл!" : "К нам спешит лесоруб!"} pose="greet"
    summary={arrived ? "Это Лопоух. Он поселится у лесного участка и поможет заготавливать древесину." : "Лесной участок открыт, и справа на поляну уже бежит новый сосед - Лопоух!"}
    text="Лопоух знает, где найти хорошие брёвна, и не любит сидеть без дела. У его дома выбирай заготовку древесины, а готовые материалы забирай в кладовую."
    hint={arrived ? "Познакомься с Лопоухом или продолжай обустраивать поляну." : "Он сам добежит до дома. Подсказку можно закрыть."}
    targetRoot={worldElement} onPause={onDismiss} onSkip={onDismiss}
    primary={arrived ? { label: "Познакомиться", onClick: onMeet } : { label: "Понятно", onClick: onDismiss }}
    secondary={arrived ? { label: "Позже", onClick: onDismiss } : undefined} secondaryVisible={arrived} />;
}
