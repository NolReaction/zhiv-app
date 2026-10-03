"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getEconomy, getEconomyMarket, sendEconomyCommand, sendEconomyDevCommand, sendMarketCommand } from "./api";
import { createEconomySession } from "./session";

function receiptStorage() {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}

export function useEconomy(owner: string | null, onSessionLost: () => void) {
  const session = useMemo(() => createEconomySession(owner, {
    get: getEconomy, send: sendEconomyCommand,
    market: getEconomyMarket, trade: sendMarketCommand,
    dev: process.env.NODE_ENV === "development" ? sendEconomyDevCommand : undefined,
  }, () => {}, receiptStorage()), [owner]);
  useEffect(() => { session.setSessionLost(onSessionLost); }, [session, onSessionLost]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!owner) return;
    const deactivate = session.activate();
    const refresh = () => { if (!document.hidden) void session.refreshSoft(); };
    const kickoff = setTimeout(refresh, 0);
    const clock = setInterval(() => { if (!document.hidden) setNow(session.now()); }, 1000);
    const polling = setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh); window.addEventListener("online", refresh);
    return () => {
      deactivate(); clearTimeout(kickoff); clearInterval(clock); clearInterval(polling);
      document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh);
    };
  }, [session, owner]);
  return { ...view, now: view.snapshot ? session.now() : now, act: session.act, actMarket: session.actMarket, actDev: session.actDev, devAvailable: session.devAvailable, retry: session.retry, refresh: session.refresh, refreshMarket: session.refreshMarket };
}
export type EconomyController = ReturnType<typeof useEconomy>;
