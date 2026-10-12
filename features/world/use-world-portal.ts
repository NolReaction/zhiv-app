"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { isWorldPortalReturn, WORLD_PORTAL_HISTORY_KEY as HISTORY_KEY } from "./world-portal-history";

export function useWorldPortal(owner: string | null) {
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const [sceneReady, setSceneReady] = useState(false);
  const [origin, setOrigin] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement | null>(null);
  const entry = useRef<string | null>(null);
  const backPending = useRef(false);
  const openedUrl = useRef<string | null>(null);
  const returnMarker = useRef<unknown>(undefined);
  const open = Boolean(owner && openedFor === owner);
  const close = useCallback(() => {
    setOpenedFor(null);
    setSceneReady(false);
    if (entry.current && window.history.state?.[HISTORY_KEY] === entry.current) { backPending.current = true; window.history.back(); }
    entry.current = null;
  }, []);
  const enter = useCallback((button: HTMLButtonElement | null, circle: HTMLElement | null) => {
    if (!owner || entry.current || backPending.current) return;
    setSceneReady(false);
    trigger.current = button;
    const rect = circle?.getBoundingClientRect() ?? button?.getBoundingClientRect()
      ?? { left: window.innerWidth / 2, top: window.innerHeight / 2, width: 0, height: 0 };
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) + 8;
    setOrigin({ "--portal-end-radius": `${endRadius}px`, "--portal-x": `${rect.left + rect.width / 2}px`, "--portal-y": `${rect.top + rect.height / 2}px`, "--portal-radius": `${rect.width / 2}px` } as CSSProperties);
    openedUrl.current = window.location.href;
    returnMarker.current = window.history.state?.[HISTORY_KEY];
    entry.current = `${owner}:${Date.now()}`;
    try { window.history.pushState({ ...window.history.state, [HISTORY_KEY]: entry.current }, ""); }
    catch { entry.current = null; openedUrl.current = null; returnMarker.current = undefined; }
    setOpenedFor(owner);
  }, [owner]);
  useEffect(() => {
    const back = (event: PopStateEvent) => {
      const restoredMarker = event.state?.[HISTORY_KEY];
      if (isWorldPortalReturn({ entry: entry.current, backPending: backPending.current,
        openedUrl: openedUrl.current, returnMarker: returnMarker.current }, window.location.href, restoredMarker)) {
        // This history step only closes a same-page dialog. Sending it through
        // Next's route restoration can leave a suspended router update behind
        // while the live forest continues publishing external-store updates.
        event.stopImmediatePropagation();
      }
      backPending.current = false;
      if (restoredMarker !== entry.current) {
        entry.current = null; openedUrl.current = null; returnMarker.current = undefined;
        setOpenedFor(null); setSceneReady(false);
      }
    };
    window.addEventListener("popstate", back, true);
    return () => window.removeEventListener("popstate", back, true);
  }, []);
  useEffect(() => {
    // Account changes must not leave a stale game entry in browser history.
    if (!open && entry.current && window.history.state?.[HISTORY_KEY] === entry.current) {
      const next = { ...window.history.state }; delete next[HISTORY_KEY]; window.history.replaceState(next, ""); entry.current = null;
      openedUrl.current = null; returnMarker.current = undefined;
    }
  }, [open, owner]);
  const reportSceneReady = useCallback(() => setSceneReady(true), []);
  return { open, enter, close, origin, sceneReady: open && sceneReady, reportSceneReady,
    returnFocus: () => { if (trigger.current?.isConnected) trigger.current.focus(); } };
}
