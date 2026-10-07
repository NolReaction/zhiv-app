"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { StartupSplash, SPLASH_ENTER_MS, SPLASH_EXIT_MS } from "./startup-splash";
import type { StartupPresentation } from "./startup-model";

type StartupContextValue = {
  active: boolean;
  report: (value: StartupPresentation, retry: () => void) => void;
};
const StartupContext = createContext<StartupContextValue | null>(null);
const INITIAL: StartupPresentation = { ready: false, progress: 0, message: "Находим дорогу домой", detail: null, retryAvailable: false };

/** One overlay per document entry. The real screen mounts and loads underneath. */
export function AppStartup({ children }: { children: ReactNode }) {
  const [state, setState] = useState(INITIAL);
  const [phase, setPhase] = useState<"entering" | "loading" | "leaving" | "done">("entering");
  const [logoReady, setLogoReady] = useState(false);
  const [entranceDone, setEntranceDone] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [visible, setVisible] = useState(true);
  const content = useRef<HTMLDivElement>(null);
  const retry = useRef<() => void>(() => {});
  const active = phase !== "done";
  const report = useCallback((next: StartupPresentation, onRetry: () => void) => {
    retry.current = onRetry;
    setState(previous => Object.keys(next).every(key => previous[key as keyof StartupPresentation] === next[key as keyof StartupPresentation]) ? previous : next);
  }, []);
  const onLogoReady = useCallback(() => setLogoReady(true), []);
  const context = useMemo(() => ({ active, report }), [active, report]);

  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const updateMotion = () => setReducedMotion(media.matches);
    const updateVisibility = () => setVisible(!document.hidden);
    updateMotion(); updateVisibility();
    media.addEventListener("change", updateMotion);
    document.addEventListener("visibilitychange", updateVisibility);
    return () => { media.removeEventListener("change", updateMotion); document.removeEventListener("visibilitychange", updateVisibility); };
  }, []);
  useEffect(() => {
    if (!logoReady) return;
    const timer = setTimeout(() => setEntranceDone(true), reducedMotion ? 150 : SPLASH_ENTER_MS);
    return () => clearTimeout(timer);
  }, [logoReady, reducedMotion]);
  useEffect(() => {
    if (!entranceDone || phase === "done") return;
    // Reconnection can be lost during the exit. Keep the gate until it is ready again.
    const next = state.ready && visible ? "leaving" : "loading";
    if (phase !== next) {
      const frame = requestAnimationFrame(() => setPhase(next));
      return () => cancelAnimationFrame(frame);
    }
  }, [entranceDone, state.ready, visible, phase]);
  useEffect(() => {
    if (phase !== "leaving" || !state.ready || !visible) return;
    const timer = setTimeout(() => setPhase("done"), reducedMotion ? 150 : SPLASH_EXIT_MS);
    return () => clearTimeout(timer);
  }, [phase, state.ready, visible, reducedMotion]);
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = previous; };
  }, [active]);
  useEffect(() => {
    if (active) return;
    const frame = requestAnimationFrame(() => {
      const target = content.current?.querySelector<HTMLElement>("h1, main");
      if (!target || target.contains(document.activeElement)) return;
      const hadTabIndex = target.hasAttribute("tabindex");
      if (!hadTabIndex) target.setAttribute("tabindex", "-1");
      target.focus({ preventScroll: true });
      if (!hadTabIndex) target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [active]);

  return <StartupContext.Provider value={context}>
    <div ref={content} data-app-content inert={active} aria-hidden={active || undefined}>{children}</div>
    {active && <StartupSplash phase={phase} progress={state.progress} message={state.message} detail={state.detail}
      retryAvailable={state.retryAvailable} onRetry={() => retry.current()} onLogoReady={onLogoReady} />}
  </StartupContext.Provider>;
}

export function useAppStartup() {
  const context = useContext(StartupContext);
  if (!context) throw new Error("AppStartup is missing");
  return context;
}
