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
    summary={arrived ? "Листохвост вернулся из путешествия! Теперь открыт рынок товаров: находки и припасы в его фургончике." : "Дом достиг 3-го уровня, и Листохвост возвращается из путешествия по реке."}
    text="Ворчливый Листохвост привёз находки из дальних краёв. Вещи он бережёт, а с соседями знакомится без лишней суеты. Когда он дома, над фургончиком виден значок."
    hint={arrived ? "Открой лавку, чтобы посмотреть привезённые вещи." : "Он причалит, сойдёт на берег и сам дойдёт до фургона. Подсказку можно закрыть."}
    targetRoot={worldElement} onPause={onDismiss} onSkip={onDismiss}
    primary={arrived ? { label: "К лавке", onClick: onMeet } : { label: "Понятно", onClick: onDismiss }}
    secondary={arrived ? { label: "Позже", onClick: onDismiss } : undefined} secondaryVisible={arrived} />;
}
