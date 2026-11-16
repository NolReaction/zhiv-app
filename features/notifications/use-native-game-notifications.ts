"use client";
import { useEffect, useRef } from "react";
import type { EconomyView } from "@/features/economy/domain/model";
import { getNotificationSettings } from "./notification-api";
import { getNativeNotifications } from "./native-notifications";

export function useNativeGameNotifications({ ownerPublicId, snapshot, serverNow, confirmed = true }: {
  ownerPublicId: string | null; snapshot: EconomyView | null; serverNow: () => number; confirmed?: boolean;
}) {
  const latest = useRef({ snapshot, serverNow, confirmed });
  const scheduledGameKey = useRef("");
  useEffect(() => { latest.current = { snapshot, serverNow, confirmed }; }, [snapshot, serverNow, confirmed]);
  useEffect(() => {
    const native = getNativeNotifications();
    if (!native || !ownerPublicId) return;
    const controller = new AbortController();
    let disposed = false;
    const refresh = async () => {
      try {
        const value = await getNotificationSettings(ownerPublicId, controller.signal);
        if (disposed) return;
        await native.setPreferences(value);
        const current = latest.current;
        if (!disposed && current.snapshot && current.confirmed) await native.setGame(ownerPublicId, current.snapshot, current.serverNow());
      } catch { /* Notification settings do not block the game. The settings card exposes failures. */ }
    };
    // The owner setup also runs in useNotificationPresence; this explicitly serializes readiness.
    void native.setOwner(ownerPublicId).then(refresh).catch(() => undefined);
    const timer = window.setInterval(() => { void refresh(); }, 5 * 60_000);
    window.addEventListener("online", refresh); window.addEventListener("focus", refresh);
    return () => { disposed = true; controller.abort(); window.clearInterval(timer); window.removeEventListener("online", refresh); window.removeEventListener("focus", refresh); };
  }, [ownerPublicId]);
  useEffect(() => {
    if (!ownerPublicId || !snapshot) { scheduledGameKey.current = ""; return; }
    if (!confirmed) return;
    // Clock-only tap-boost projections change each second; native scheduling follows confirmed snapshots.
    const key = `${ownerPublicId}:${snapshot.revision}:${snapshot.serverTime}`;
    if (key === scheduledGameKey.current) return;
    scheduledGameKey.current = key;
    void getNativeNotifications()?.setGame(ownerPublicId, snapshot, serverNow()).catch(() => { scheduledGameKey.current = ""; });
  }, [ownerPublicId, snapshot, serverNow, confirmed]);
}
