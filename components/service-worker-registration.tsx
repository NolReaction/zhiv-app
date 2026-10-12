"use client";

import { useEffect } from "react";

export function ServiceWorkerRegistration() {
  useEffect(() => {
    let disposed = false;
    if ("serviceWorker" in navigator && process.env.NODE_ENV === "production") {
      void navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
        .then(() => navigator.serviceWorker.ready)
        .then(registration => {
          // Warm the optional offline shell only after the worker is active.
          // Its network/storage failures must not prevent push subscriptions.
          if (!disposed) registration.active?.postMessage({ type: "zhiv:cache-shell" });
        }).catch(() => undefined);
    }
    return () => { disposed = true; };
  }, []);

  return null;
}
