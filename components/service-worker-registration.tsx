"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
        .catch(() => undefined);
    }
  }, []);

  return null;
}

/** Installing from /site must not fetch the game shell and its assets. */
export function ServiceWorkerShellWarmup() {
  useEffect(() => {
    let disposed = false;
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.ready.then(registration => {
        if (!disposed) registration.active?.postMessage({ type: "zhiv:cache-shell" });
      }).catch(() => undefined);
    }
    return () => { disposed = true; };
  }, []);
  return null;
}
