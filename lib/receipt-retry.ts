import { ApiError } from "./check-in-api";

/** Schedule delivery of the same unacknowledged command while the tab stays online. */
export function createReceiptRetry() {
  let nextAt = Infinity, delay = 2000;
  return {
    due: () => performance.now() >= nextAt,
    sending() { nextAt = Infinity; },
    reset() { nextAt = Infinity; delay = 2000; },
    failed(error: unknown) {
      if (error instanceof ApiError) {
        if (error.status === 429) {
          nextAt = performance.now() + Math.max(1000, error.retryAfterMs ?? 60_000);
          return;
        }
        if (error.status < 500 && error.status !== 408 && error.status !== 425) return;
      }
      nextAt = performance.now() + delay;
      delay = Math.min(delay * 2, 60_000);
    },
  };
}
