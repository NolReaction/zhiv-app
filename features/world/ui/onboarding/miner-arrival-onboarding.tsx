"use client";

import { useEffect, useState, type RefObject } from "react";
import { GuideCoach } from "@/features/onboarding/guide-coach";

/** The scene runs the arrival and frames the quarry; the coach never grants materials. */
export function MinerArrivalOnboarding({ open, arrived, worldElement, onMeet, onDismiss }: {
  open: boolean; arrived: boolean; worldElement: RefObject<HTMLElement | null>; onMeet: () => void; onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = worldElement.current;
    if (!open || !element) return;
    const measure = () => setVisible(Boolean(element.querySelector('[data-ready="true"] > canvas[role="img"]')) && !element.closest('[aria-hidden="true"]'));
    const frame = requestAnimationFrame(measure);
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready", "aria-hidden"] });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [open, worldElement]);
  return <GuideCoach open={open && visible} flow="world" stepId="miner-arrival" title="Камнешмыг пришёл!" pose="greet"
    summary={arrived ? "Это Камнешмыг, наш шахтёр. Он будет работать у новой каменоломни!" : "Каменоломня готова, и с северной тропы уже спешит новый житель - Камнешмыг!"}
    text="Камнешмыг знает толк в камне и любит хорошую работу. Нажимай на него, чтобы поговорить и перейти к добыче. Камень по-прежнему добывается через производство: выбери работу и забери результат, когда она закончится."
    hint={arrived ? "Познакомься с Камнешмыгом или продолжай обустраивать поляну." : "Он добежит до каменоломни сам. Подсказку можно закрыть."}
    targetRoot={worldElement} onPause={onDismiss} onSkip={onDismiss}
    primary={arrived ? { label: "Познакомиться", onClick: onMeet } : { label: "Понятно", onClick: onDismiss }}
    secondary={arrived ? { label: "Позже", onClick: onDismiss } : undefined} secondaryVisible={arrived} />;
}
