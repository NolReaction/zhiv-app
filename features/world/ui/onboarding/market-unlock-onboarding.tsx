"use client";

import { useEffect, useState, type RefObject } from "react";
import { GuideCoach } from "@/features/onboarding/guide-coach";

/** Scene framing uses guidePlace="market"; the real map remains clickable. */
export function MarketUnlockOnboarding({ open, worldElement, onOpenMarket, onDismiss }: {
  open: boolean;
  worldElement: RefObject<HTMLElement | null>;
  onOpenMarket: () => void;
  onDismiss: () => void;
}) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const element = worldElement.current;
    if (!open || !element) return;
    const measure = () => setVisible(Boolean(element.querySelector('[data-ready="true"] > canvas[role="img"]'))
      && !element.closest('[aria-hidden="true"]'));
    const frame = requestAnimationFrame(measure);
    const observer = new MutationObserver(measure);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["data-ready", "aria-hidden"] });
    return () => { cancelAnimationFrame(frame); observer.disconnect(); };
  }, [open, worldElement]);
  return <GuideCoach open={open && visible} flow="world" stepId="market-unlocked" title="Рынок открыт!" pose="present"
    summary="Мост восстановлен! Теперь можно покупать товары у других игроков и продавать им свои. Нажми на выделенный рынок."
    text="Восстановленный мост открыл торговлю между игроками. На рынке можно купить недостающие припасы или выставить свои по указанной цене. Монеты придут, когда другой игрок купит твой лот. Для особых товаров у Листохвоста есть отдельная лавка на карте."
    hint="Рынок открывается нажатием на его здание на карте. Покупать или продавать ради знакомства не нужно."
    targetRoot={worldElement} onPause={onDismiss} onSkip={onDismiss}
    primary={{ label: "Открыть рынок", onClick: onOpenMarket }}
    secondary={{ label: "Понятно", onClick: onDismiss }} secondaryVisible />;
}
