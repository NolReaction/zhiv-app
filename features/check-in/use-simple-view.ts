"use client";
import { useCallback, useSyncExternalStore } from "react";
const KEY = "zhiv:appearance:simple:v1";
const EVENT = "zhiv:appearance-changed";
let fallback: boolean | undefined;
function read() {
  if (fallback !== undefined) return fallback;
  try { return window.localStorage.getItem(KEY) === "true"; } catch { return false; }
}
function subscribe(listener: () => void) {
  window.addEventListener("storage", listener); window.addEventListener(EVENT, listener);
  return () => { window.removeEventListener("storage", listener); window.removeEventListener(EVENT, listener); };
}
const server = () => null;
export function useSimpleView() {
  const value = useSyncExternalStore(subscribe, read, server);
  const change = useCallback((next: boolean) => {
    try { window.localStorage.setItem(KEY, String(next)); fallback = undefined; } catch { fallback = next; }
    window.dispatchEvent(new Event(EVENT));
  }, []);
  return { simpleView: value ?? false, appearanceReady: value !== null, setSimpleView: change };
}
