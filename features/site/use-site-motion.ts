"use client";

import { useEffect, useState, useSyncExternalStore, type RefObject } from "react";

const subscribeReady = () => () => undefined;
const browserReady = () => true;
const serverReady = () => false;
const serverReduced = () => true;
const browserReduced = () => typeof window.matchMedia !== "function" || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
function subscribeReduced(changed: () => void) {
  if (typeof window.matchMedia !== "function") return () => undefined;
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  if (query.addEventListener) query.addEventListener("change", changed);
  else query.addListener(changed);
  return () => { if (query.removeEventListener) query.removeEventListener("change", changed); else query.removeListener(changed); };
}

/** Progressive enhancement: the server and a browser without observers show all content. */
export function useSiteMotion(root: RefObject<HTMLElement | null>) {
  const ready = useSyncExternalStore(subscribeReady, browserReady, serverReady);
  const reducedMotion = useSyncExternalStore(subscribeReduced, browserReduced, serverReduced);
  const [paused, setPaused] = useState(false);
  const motionEnabled = ready && !reducedMotion && !paused;
  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const reveals = [...element.querySelectorAll<HTMLElement>("[data-site-reveal]")];
    const resetPointer = () => { element.style.setProperty("--site-pointer-x", "0"); element.style.setProperty("--site-pointer-y", "0"); };
    resetPointer();
    element.setAttribute("data-motion", motionEnabled ? "ready" : "paused");
    if (!motionEnabled) {
      reveals.forEach(item => { item.dataset.revealed = "true"; });
      return () => { element.removeAttribute("data-motion"); };
    }
    let frame = 0, x = 0, y = 0, disposed = false;
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const flush = () => {
      frame = 0;
      if (disposed || document.hidden) return;
      element.style.setProperty("--site-pointer-x", String(x));
      element.style.setProperty("--site-pointer-y", String(y));
      const range = Math.max(1, element.scrollHeight - window.innerHeight);
      element.style.setProperty("--site-scroll", String(Math.max(0, Math.min(1, window.scrollY / range))));
    };
    const schedule = () => { if (!frame && !document.hidden) frame = window.requestAnimationFrame(flush); };
    const pointer = (event: PointerEvent) => {
      x = Math.max(-1, Math.min(1, event.clientX / Math.max(1, window.innerWidth) * 2 - 1));
      y = Math.max(-1, Math.min(1, event.clientY / Math.max(1, window.innerHeight) * 2 - 1));
      schedule();
    };
    const leave = () => { x = y = 0; schedule(); };
    const visibility = () => { if (document.hidden) { window.cancelAnimationFrame(frame); frame = 0; } else schedule(); };
    const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
      if (disposed) return;
      for (const entry of entries) if (entry.isIntersecting) { (entry.target as HTMLElement).dataset.revealed = "true"; observer?.unobserve(entry.target); }
    }, { threshold: .08, rootMargin: "0px 0px -24px 0px" });
    for (const item of reveals) {
      const bounds = item.getBoundingClientRect();
      if (!observer || bounds.top < window.innerHeight && bounds.bottom > 0) item.dataset.revealed = "true";
      else { delete item.dataset.revealed; observer.observe(item); }
    }
    const revealFocus = (event: FocusEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const item = target.closest<HTMLElement>("[data-site-reveal]");
      if (item && element.contains(item)) { item.dataset.revealed = "true"; observer?.unobserve(item); }
    };
    if (fine) { element.addEventListener("pointermove", pointer, { passive: true }); element.addEventListener("pointerleave", leave); }
    element.addEventListener("focusin", revealFocus);
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    document.addEventListener("visibilitychange", visibility);
    schedule();
    return () => {
      disposed = true; window.cancelAnimationFrame(frame); observer?.disconnect();
      element.removeEventListener("pointermove", pointer); element.removeEventListener("pointerleave", leave); element.removeEventListener("focusin", revealFocus);
      window.removeEventListener("scroll", schedule); window.removeEventListener("resize", schedule); document.removeEventListener("visibilitychange", visibility);
      reveals.forEach(item => { item.dataset.revealed = "true"; }); resetPointer(); element.removeAttribute("data-motion");
    };
  }, [motionEnabled, root]);
  return { motionEnabled, reducedMotion, toggleMotion: () => { if (!reducedMotion) setPaused(value => !value); } };
}
