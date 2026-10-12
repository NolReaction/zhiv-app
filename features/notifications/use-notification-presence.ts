"use client";
import { useEffect, useRef } from "react";
import { clearPreviousNotificationOwner, setActiveNotificationOwner, parseNotificationLink, type NotificationLink, type NotificationTarget } from "./notification-browser";
import { reportNotificationPresence } from "./notification-api";

/** Authenticated owner only. The server invalidates old session subscriptions on logout. */
export function useNotificationPresence(ownerPublicId: string | null, isOnline: boolean) {
  const seenOwner = useRef<string | null>(null);
  useEffect(() => {
    // An unresolved initial session is not a logout.
    if (!ownerPublicId && !seenOwner.current) return;
    seenOwner.current = ownerPublicId;
    setActiveNotificationOwner(ownerPublicId);
    void clearPreviousNotificationOwner(ownerPublicId).catch(() => undefined);
  }, [ownerPublicId]);
  useEffect(() => {
    if (!ownerPublicId || !isOnline) return;
    const report = () => { if (document.visibilityState === "visible") void reportNotificationPresence(ownerPublicId).catch(() => undefined); };
    report();
    const timer = window.setInterval(report, 60_000);
    document.addEventListener("visibilitychange", report);
    return () => { window.clearInterval(timer); document.removeEventListener("visibilitychange", report); };
  }, [ownerPublicId, isOnline]);
}

/** ready waits for authentication/game loading; a notification only opens a view, never a command. */
export function useNotificationNavigation({ ownerPublicId, ready, onNavigate }: {
  ownerPublicId: string | null; ready: boolean; onNavigate: (target: NotificationTarget) => void;
}) {
  const pending = useRef<NotificationLink | null>(null);
  const initialRead = useRef(false);
  const latest = useRef({ ownerPublicId, ready, onNavigate });
  useEffect(() => { latest.current = { ownerPublicId, ready, onNavigate }; });
  useEffect(() => {
    const dispatch = () => {
      const current = latest.current;
      if (!pending.current || !current.ownerPublicId || !current.ready) return;
      const link = pending.current;
      pending.current = null;
      if (link.ownerPublicId === current.ownerPublicId) current.onNavigate(link.target);
    };
    if (!initialRead.current) {
      initialRead.current = true;
      pending.current = parseNotificationLink(window.location.href, window.location.origin);
      if (new URL(window.location.href).searchParams.has("notification")) {
        const url = new URL(window.location.href);
        ["notification", "section", "owner"].forEach(key => url.searchParams.delete(key));
        window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
      }
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== navigator.serviceWorker.controller || !event.data || event.data.type !== "zhiv:notification-open" || typeof event.data.url !== "string") return;
      pending.current = parseNotificationLink(event.data.url, window.location.origin);
      dispatch();
    };
    dispatch();
    navigator.serviceWorker?.addEventListener("message", onMessage);
    return () => navigator.serviceWorker?.removeEventListener("message", onMessage);
  }, [ownerPublicId, ready]);
}
