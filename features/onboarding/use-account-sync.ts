"use client";

import { useEffect, useSyncExternalStore } from "react";
import type { createOnboardingAccountSync } from "./account-sync";

export function useOnboardingAccountSync(sync: ReturnType<typeof createOnboardingAccountSync>) {
  const ready = useSyncExternalStore(sync.subscribe, sync.getSnapshot, sync.getServerSnapshot);
  useEffect(() => {
    const disconnect = sync.connect();
    const refresh = () => { if (document.visibilityState !== "hidden" && navigator.onLine !== false) void sync.refresh(); };
    const interval = window.setInterval(refresh, 60_000);
    window.addEventListener("online", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { disconnect(); window.clearInterval(interval); window.removeEventListener("online", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [sync]);
  return ready;
}
