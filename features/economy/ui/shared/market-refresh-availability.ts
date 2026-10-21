/** A closed/background panel never starts refresh work. The economy session owns request deduplication and backoff. */
export function marketRefreshAvailable() {
  return typeof document !== "undefined" && !document.hidden && (typeof navigator === "undefined" || navigator.onLine);
}

export function watchMarketRefreshAvailability(refresh: () => Promise<void>) {
  if (typeof document === "undefined" || typeof window === "undefined") return;
  const check = () => { if (marketRefreshAvailable()) void refresh(); };
  document.addEventListener("visibilitychange", check);
  window.addEventListener("online", check);
  return () => { document.removeEventListener("visibilitychange", check); window.removeEventListener("online", check); };
}
