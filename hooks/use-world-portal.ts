"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

const HISTORY_KEY = "zhivWorldPortal";
export function useWorldPortal(owner: string | null) {
  const [openedFor, setOpenedFor] = useState<string | null>(null);
  const [origin, setOrigin] = useState<CSSProperties>({});
  const trigger = useRef<HTMLButtonElement | null>(null);
  const entry = useRef<string | null>(null);
  const backPending = useRef(false);
  const open = Boolean(owner && openedFor === owner);
  const close = useCallback(() => {
    setOpenedFor(null);
    if (entry.current && window.history.state?.[HISTORY_KEY] === entry.current) { backPending.current = true; window.history.back(); }
    entry.current = null;
  }, []);
  const enter = useCallback((button: HTMLButtonElement, circle: HTMLElement | null) => {
    if (!owner || entry.current || backPending.current) return;
    trigger.current = button;
    const rect = circle?.getBoundingClientRect() ?? button.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const endRadius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)) + 8;
    setOrigin({ "--portal-end-radius": `${endRadius}px`, "--portal-x": `${rect.left + rect.width / 2}px`, "--portal-y": `${rect.top + rect.height / 2}px`, "--portal-radius": `${rect.width / 2}px` } as CSSProperties);
    entry.current = `${owner}:${Date.now()}`;
    try { window.history.pushState({ ...window.history.state, [HISTORY_KEY]: entry.current }, ""); } catch { entry.current = null; }
    setOpenedFor(owner);
  }, [owner]);
  useEffect(() => {
    const back = () => { backPending.current = false; if (window.history.state?.[HISTORY_KEY] !== entry.current) { entry.current = null; setOpenedFor(null); } };
    window.addEventListener("popstate", back);
    return () => window.removeEventListener("popstate", back);
  }, []);
  useEffect(() => {
    // Account changes must not leave a stale game entry in browser history.
    if (!open && entry.current && window.history.state?.[HISTORY_KEY] === entry.current) {
      const next = { ...window.history.state }; delete next[HISTORY_KEY]; window.history.replaceState(next, ""); entry.current = null;
    }
  }, [open, owner]);
  return { open, enter, close, origin, returnFocus: () => { if (trigger.current?.isConnected) trigger.current.focus(); } };
}
