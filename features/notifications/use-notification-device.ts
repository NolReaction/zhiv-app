"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "@/lib/check-in-api";
import { getNotificationSettings } from "./notification-api";
import { connectPush, currentPushSubscription, disconnectPush, notificationSupport, preparePushConnection, type PreparedPushConnection } from "./notification-browser";
import type { NotificationSnapshot } from "./notification-contract";
import type { NotificationDeviceState } from "./notification-device-card";

function permission(): NotificationPermission | "unavailable" {
  return typeof Notification === "undefined" ? "unavailable" : Notification.permission;
}

/** Prepare outside the gesture; only the connect button may create a subscription. */
export function useNotificationDevice(owner: string, isOnline: boolean, onSnapshot: (value: NotificationSnapshot) => void, onSessionLost: () => void) {
  const [state, setState] = useState<NotificationDeviceState>({ connected: false, configured: false,
    support: { supported: false, reason: null }, permission: "unavailable", phase: "preparing",
    prepared: false, isOnline, error: "", notice: "", disabled: false });
  const [loadError, setLoadError] = useState("");
  const lifetime = useRef({ generation: 0, mounted: true });
  const refreshAbort = useRef<AbortController | null>(null);
  const prepared = useRef<PreparedPushConnection | null>(null);
  const snapshot = useRef<NotificationSnapshot | null>(null);
  const action = useRef(false);
  const paused = useRef(false);

  useEffect(() => {
    lifetime.current = { generation: lifetime.current.generation + 1, mounted: true };
    snapshot.current = null; prepared.current = null; action.current = false; paused.current = false;
    return () => { lifetime.current.mounted = false; refreshAbort.current?.abort(); };
  }, [owner]);

  const refresh = useCallback(async (clearError = false) => {
    if (action.current || paused.current) return;
    refreshAbort.current?.abort();
    const abort = new AbortController();
    refreshAbort.current = abort;
    const generation = lifetime.current.generation;
    const current = () => !abort.signal.aborted && lifetime.current.mounted && lifetime.current.generation === generation;
    const support = notificationSupport();
    prepared.current = null;
    setState(previous => ({ ...previous, support, permission: permission(), prepared: false, phase: "preparing",
      ...(clearError ? { error: "", notice: "" } : {}) }));
    try {
      const value = await getNotificationSettings(owner, abort.signal);
      if (!current()) return;
      snapshot.current = value; onSnapshot(value); setLoadError("");
      setState(previous => ({ ...previous, configured: value.delivery.configured }));
      if (!support.supported || !value.delivery.configured) {
        const subscription = await currentPushSubscription();
        if (current()) setState(previous => ({ ...previous, connected: value.subscription.subscribed && Boolean(subscription) }));
        return;
      }
      const ready = await preparePushConnection(owner, abort.signal);
      if (!current()) return;
      prepared.current = ready; snapshot.current = ready.snapshot; onSnapshot(ready.snapshot);
      setState(previous => ({ ...previous, prepared: true, configured: ready.snapshot.delivery.configured,
        permission: permission(), connected: ready.snapshot.subscription.subscribed && Boolean(ready.subscription) }));
    } catch (error) {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else {
        const message = error instanceof Error ? error.message : "Не удалось проверить подключение. Попробуйте ещё раз.";
        if (!snapshot.current) setLoadError(message);
        setState(previous => ({ ...previous, error: message }));
      }
    } finally {
      if (current()) setState(previous => ({ ...previous, phase: "idle", support: notificationSupport(), permission: permission() }));
    }
  }, [owner, onSnapshot, onSessionLost]);

  useEffect(() => {
    let disposed = false;
    queueMicrotask(() => { if (!disposed) void refresh(); });
    const restore = () => { if (document.visibilityState === "visible") void refresh(); };
    window.addEventListener("focus", restore);
    window.addEventListener("pageshow", restore);
    window.addEventListener("online", restore);
    document.addEventListener("visibilitychange", restore);
    return () => {
      disposed = true;
      refreshAbort.current?.abort();
      window.removeEventListener("focus", restore);
      window.removeEventListener("pageshow", restore);
      window.removeEventListener("online", restore);
      document.removeEventListener("visibilitychange", restore);
    };
  }, [refresh]);

  function toggle() {
    const value = snapshot.current;
    if (action.current || !isOnline || !value || value.ownerPublicId !== owner || (!state.connected && !prepared.current)) return;
    const generation = lifetime.current.generation;
    const current = () => lifetime.current.mounted && lifetime.current.generation === generation;
    action.current = true;
    refreshAbort.current?.abort();
    const disconnecting = state.connected;
    setState(previous => ({ ...previous, phase: disconnecting ? "disconnecting" : "subscribing", error: "", notice: "" }));
    // No await here: Safari must see subscribe() in this button's activation.
    const operation = disconnecting ? disconnectPush(owner) : connectPush(owner, value, prepared.current ?? undefined, phase => {
      if (current()) setState(previous => ({ ...previous, phase }));
    });
    prepared.current = null;
    void operation.then(result => {
      if (!current()) return;
      if (result) { snapshot.current = result; onSnapshot(result); }
      setState(previous => ({ ...previous, connected: !disconnecting && result?.subscription.subscribed === true,
        notice: disconnecting ? "На этом устройстве уведомления выключены" : "Уведомления подключены на этом устройстве" }));
    }).catch(error => {
      if (!current()) return;
      if (error instanceof ApiError && error.status === 401) onSessionLost();
      else setState(previous => ({ ...previous, error: error instanceof Error ? error.message : "Не удалось подключить уведомления. Попробуйте ещё раз." }));
    }).finally(() => {
      if (!current()) return;
      action.current = false;
      setState(previous => ({ ...previous, prepared: false, phase: "idle", permission: permission(), support: notificationSupport() }));
      void refresh();
    });
  }

  function pauseRefresh() {
    paused.current = true;
    refreshAbort.current?.abort();
  }
  function resumeRefresh() {
    paused.current = false;
    void refresh();
  }
  return { state: { ...state, isOnline }, loadError, refresh, toggle, pauseRefresh, resumeRefresh, busy: state.phase !== "idle" };
}
