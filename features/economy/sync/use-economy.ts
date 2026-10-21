"use client";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getEconomy, getEconomyMarket, sendEconomyCommand, sendEconomyDevCommand, sendFriendMarketCommand, sendMarketCommand } from "./api";
import { createEconomySession } from "./session";
import { getEconomyBarter, sendBarterCommand } from "./barter-api";
import { browserJournalCoordinator } from "./production-journal";

function journalStorage() {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}
function receiptStorage() {
  try { return typeof window === "undefined" ? undefined : window.sessionStorage; } catch { return undefined; }
}

export function useEconomy(owner: string | null, onSessionLost: () => void, enabled = true) {
  const session = useMemo(() => createEconomySession(owner, {
    get: getEconomy, send: sendEconomyCommand,
    market: getEconomyMarket, trade: sendMarketCommand, friendTrade: sendFriendMarketCommand,
    barter: signal => owner ? getEconomyBarter(owner, signal) : Promise.reject(new Error("Войдите в профиль")), barterTrade: sendBarterCommand,
    dev: process.env.NODE_ENV === "development" ? sendEconomyDevCommand : undefined,
  }, () => {}, receiptStorage(), (() => {
    const storage = journalStorage();
    return storage ? { storage, coordinate: browserJournalCoordinator } : undefined;
  })()), [owner]);
  useEffect(() => { session.setSessionLost(onSessionLost); }, [session, onSessionLost]);
  useEffect(() => { session.setAvailable(enabled); }, [session, enabled]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!owner) return;
    const deactivate = session.activate();
    const refresh = () => { if (!document.hidden && navigator.onLine) void session.refreshSoft(); };
    const kickoff = setTimeout(() => { void session.refresh(); }, 0);
    const clock = setInterval(() => {
      if (!document.hidden) {
        setNow(session.now());
        if (navigator.onLine && session.getSnapshot().pendingProductionCount > 0) void session.refreshSoft();
      }
    }, 1000);
    const polling = setInterval(refresh, 30_000);
    document.addEventListener("visibilitychange", refresh); window.addEventListener("online", refresh);
    return () => {
      deactivate(); clearTimeout(kickoff); clearInterval(clock); clearInterval(polling);
      document.removeEventListener("visibilitychange", refresh); window.removeEventListener("online", refresh);
    };
  }, [session, owner]);
  return { ...view, reconcile: session.reconcile, setAvailable: session.setAvailable, setLocalActionsAvailable: session.setLocalActionsAvailable, setDirectActionsAvailable: session.setDirectActionsAvailable, now: view.snapshot ? session.now() : now, act: session.act, actMarket: session.actMarket, actFriendMarket: session.actFriendMarket, actBarter: session.actBarter, actDev: session.actDev, devAvailable: session.devAvailable, retry: session.retry, retryGardenCollection: session.retryGardenCollection, refresh: session.refresh, refreshMarket: session.refreshMarket, refreshBarter: session.refreshBarter };
}
export type EconomyController = ReturnType<typeof useEconomy>;
