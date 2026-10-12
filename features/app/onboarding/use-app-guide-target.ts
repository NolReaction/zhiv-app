"use client";

import { useEffect } from "react";

/** Reveal a new lesson's control once, after the guide has reserved its top
 * row. Manual scrolling and opening details must never keep pulling it back. */
export function useAppGuideTarget(open: boolean, target: string | undefined, stepId: string, activeView: string) {
  useEffect(() => {
    if (!open || !target) return;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        const element = document.querySelector<HTMLElement>(target);
        if (element && !element.closest('[hidden], [aria-hidden="true"], [inert]')) {
          element.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "instant" });
        }
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, target, stepId, activeView]);
}
