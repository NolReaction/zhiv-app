/** Coalesce expensive JSON writes while retaining a synchronous closing-page flush. */
export type DeferredSaveState = "saved" | "pending" | "unavailable";
export type DeferredSaveScheduler = (callback: () => void) => () => void;
export function createDeferredSave(write: () => boolean, changed: (state: DeferredSaveState) => void,
  schedule: DeferredSaveScheduler) {
  let pending = false, cancel: (() => void) | undefined;
  function flush() {
    cancel?.(); cancel = undefined;
    if (!pending) return true;
    pending = false;
    const success = write(); changed(success ? "saved" : "unavailable"); return success;
  }
  return {
    request() {
      pending = true; changed("pending");
      if (cancel) return;
      let completed = false;
      const cancellation = schedule(() => { completed = true; cancel = undefined; flush(); });
      if (!completed) cancel = cancellation;
    },
    flush,
  };
}
