"use client";
import { useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { getMailbox, markMailRead, claimMailGift } from "./api";
import { createMailboxSession } from "./session";

function browserStorage() { try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; } }
export function useMailbox({ ownerPublicId, isOnline, enabled = true, onSessionLost, onReceived }: {
  ownerPublicId: string | null; isOnline: boolean; enabled?: boolean; onSessionLost?: () => void; onReceived?: () => void;
}) {
  const currentOwner = useRef(ownerPublicId);
  useLayoutEffect(() => { currentOwner.current = ownerPublicId; }, [ownerPublicId]);
  const session = useMemo(() => createMailboxSession(ownerPublicId, {
    list: (cursor, signal) => ownerPublicId ? getMailbox(ownerPublicId, cursor, signal) : Promise.reject(new Error("Войдите в профиль")),
    read: (id, signal) => ownerPublicId ? markMailRead(ownerPublicId, id, signal) : Promise.reject(new Error("Войдите в профиль")),
    claim: (id, signal) => ownerPublicId ? claimMailGift(ownerPublicId, id, signal) : Promise.reject(new Error("Войдите в профиль")),
  }, undefined, browserStorage()), [ownerPublicId]);
  useEffect(() => { session.setSessionLost(() => { if (currentOwner.current === ownerPublicId) onSessionLost?.(); }); }, [session, ownerPublicId, onSessionLost]);
  useEffect(() => { session.setReceived(() => { if (currentOwner.current === ownerPublicId) onReceived?.(); }); }, [session, ownerPublicId, onReceived]);
  useEffect(() => session.activate(), [session]);
  useEffect(() => {
    const sync = () => {
      const available = enabled && isOnline && navigator.onLine !== false && !document.hidden && document.hasFocus();
      session.setAvailable(available);
      if (available) void session.refreshSoft();
    };
    sync();
    const timer = window.setInterval(sync, 30_000);
    document.addEventListener("visibilitychange", sync); window.addEventListener("focus", sync); window.addEventListener("blur", sync);
    window.addEventListener("online", sync); window.addEventListener("offline", sync);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("focus", sync); window.removeEventListener("blur", sync); window.removeEventListener("online", sync); window.removeEventListener("offline", sync); };
  }, [session, enabled, isOnline]);
  const view = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  const actions = useMemo(() => ({ ...session,
    isActive: () => currentOwner.current === ownerPublicId && session.isActive(),
    isAvailable: () => currentOwner.current === ownerPublicId && session.isAvailable(),
    open: () => { if (currentOwner.current === ownerPublicId) session.open(); },
    claimGift: (id: string) => currentOwner.current === ownerPublicId ? session.claimGift(id) : Promise.resolve(),
    claimNotification: (id: string) => currentOwner.current === ownerPublicId && session.claimNotification(id),
  }), [session, ownerPublicId]);
  return { ...view, ...actions, isOnline };
}
export type MailboxController = ReturnType<typeof useMailbox>;
