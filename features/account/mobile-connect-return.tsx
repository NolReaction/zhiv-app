"use client";

import { useEffect } from "react";
import { MOBILE_CONNECT_STORAGE_KEY, restoreMobileConnect } from "./mobile-connect-state";

/** Restore only a same-tab, recent native login attempt after the provider returns. */
export function MobileConnectReturn() {
  useEffect(() => {
    if (window.location.pathname !== "/" || !new URLSearchParams(window.location.search).has("auth")) return;
    try {
      const path = restoreMobileConnect(sessionStorage.getItem(MOBILE_CONNECT_STORAGE_KEY), Date.now());
      if (path) window.location.replace(path);
      else sessionStorage.removeItem(MOBILE_CONNECT_STORAGE_KEY);
    } catch { /* Storage can be unavailable; the user can restart login from the app. */ }
  }, []);
  return null;
}
