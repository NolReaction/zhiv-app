"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getEconomy, getEconomyMarket, sendEconomyCommand, sendEconomyDevCommand, sendMarketCommand } from "./api";
import { createEconomySession } from "./session";
import { getEconomyBarter, sendBarterCommand } from "./barter-api";

function receiptStorage() {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}

export function useEconomy(owner: string | null, onSessionLost: () => void, enabled = true) {
  const session = useMemo(() => createEconomySession(owner, {
    get: getEconomy, send: sendEconomyCommand,
    market: getEconomyMarket, trade: sendMarketCommand,
    barter: signal => owner ? getEconomyBarter(owner, signal) : Promise.reject(new Error("Войдите в профиль")), barterTrade: sendBarterCommand,
    dev: process.env.NODE_ENV === "development" ? sendEconomyDevCommand : undefined,
  }, () => {}, receiptStorage()), [owner]);
  useEffect(() => { session.setSessionLost(onSessionLost); }, [session, onSessionLost]);
  useEffect(() => { session.setAvailable(enabled); }, [session, enabled]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!owner) return;
    const deactivate = session.activate();
    const refresh = () => { if (!document.hidden && navigator.onLine) void session.refreshSoft(); };
    const kickoff = setTimeout(() => { if (enabled) void session.refresh(); }, 0);
    const clock = setInterval(() => { if (!document.hidden) setNow(session.now()); }, 1000);
    const polling = setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh); window.addEventListener("online", refresh);
    return () => {
      deactivate(); clearTimeout(kickoff); clearInterval(clock); clearInterval(polling);
      document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh);
    };
  }, [session, owner, enabled]);
  return { ...view, reconcile: session.reconcile, setAvailable: session.setAvailable, now: view.snapshot ? session.now() : now, act: session.act, actMarket: session.actMarket, actBarter: session.actBarter, actDev: session.actDev, devAvailable: session.devAvailable, retry: session.retry, refresh: session.refresh, refreshMarket: session.refreshMarket, refreshBarter: session.refreshBarter };
}
export type EconomyController = ReturnType<typeof useEconomy>;
